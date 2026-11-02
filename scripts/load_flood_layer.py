"""Vectorise the 2023 flood raster (D-08) and load it into PostGIS as a hazard layer.

Run from the project root:  python scripts/load_flood_layer.py
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape
from sqlalchemy import text

from db import get_engine

HAZARD_ID = "flood_2023_observed"
SOURCE_ID = "D-08"
TITLE = "Observed new water, Lower Volta, Oct 2023 (Sentinel-1)"
TIF = Path("data/processed/flood_2023/flood_2023_lower_volta_codes.tif")
META = Path("data/processed/flood_2023/flood_2023_lower_volta_metadata.json")

# Raster classes kept as polygons (see raster_codes in the metadata file)
KEEP_CLASSES = {1: "flooded", 5: "ambiguous"}


def vectorise():
    """Turn the selected raster classes into polygons."""
    with rasterio.open(TIF) as src:
        codes = src.read(1).astype(np.uint8)
        transform = src.transform
        crs = src.crs

    records = []
    for code, class_name in KEEP_CLASSES.items():
        for geom, _value in shapes(codes, mask=(codes == code), transform=transform):
            records.append({"class_code": code, "class_name": class_name, "geometry": shape(geom)})

    gdf = gpd.GeoDataFrame(records, crs=crs or "EPSG:4326").to_crs("EPSG:4326")
    return gdf


def main():
    for path in (TIF, META):
        if not path.exists():
            raise SystemExit(f"Missing {path} - run scripts/s1_flood_extent.py first.")
    meta = json.loads(META.read_text(encoding="utf-8"))

    print("Vectorising flood raster ...", flush=True)
    polygons = vectorise()
    polygons["hazard_id"] = HAZARD_ID
    polygons = polygons.rename_geometry("geom")
    print(f"  {len(polygons):,} polygons")

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS hazard_layers (
                hazard_id      TEXT PRIMARY KEY,
                title          TEXT NOT NULL,
                hazard_type    TEXT NOT NULL,
                source_id      TEXT NOT NULL,
                observed_dates TEXT,
                method         TEXT,
                metadata       JSONB,
                loaded_at      TIMESTAMPTZ DEFAULT now()
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS hazard_features (
                feature_id  BIGSERIAL PRIMARY KEY,
                hazard_id   TEXT NOT NULL REFERENCES hazard_layers (hazard_id) ON DELETE CASCADE,
                class_code  SMALLINT NOT NULL,
                class_name  TEXT NOT NULL,
                geom        geometry(Polygon, 4326) NOT NULL
            )
        """))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS hazard_features_geom_idx ON hazard_features USING GIST (geom)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS hazard_features_layer_idx ON hazard_features (hazard_id, class_code)"
        ))

        # Replace this hazard layer (its features are removed by ON DELETE CASCADE)
        conn.execute(text("DELETE FROM hazard_layers WHERE hazard_id = :hid"), {"hid": HAZARD_ID})
        dates = ", ".join(t["flood_date"] for t in meta["tracks"].values())
        conn.execute(text("""
            INSERT INTO hazard_layers (hazard_id, title, hazard_type, source_id, observed_dates, method, metadata)
            VALUES (:hid, :title, 'flood_observed', :src, :dates, :method, CAST(:meta AS jsonb))
        """), {
            "hid": HAZARD_ID, "title": TITLE, "src": SOURCE_ID,
            "dates": dates, "method": meta["method"], "meta": json.dumps(meta),
        })

    print("Writing polygons to PostGIS ...", flush=True)
    polygons[["hazard_id", "class_code", "class_name", "geom"]].to_postgis(
        "hazard_features", engine, if_exists="append", index=False,
    )

    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT class_name, count(*) AS n,
                   round((sum(ST_Area(geom::geography)) / 1e6)::numeric, 1) AS km2
            FROM hazard_features
            WHERE hazard_id = :hid
            GROUP BY class_name
            ORDER BY class_name
        """), {"hid": HAZARD_ID}).fetchall()

    print(f"\nHazard layer '{HAZARD_ID}' loaded:")
    for r in rows:
        print(f"  {r.class_name:<10} {r.n:>7,} polygons  {r.km2:>7} km²")
    print("\nCompare with the Earth Engine totals (flooded 38.4 km², ambiguous 40.1 km²).")


if __name__ == "__main__":
    main()