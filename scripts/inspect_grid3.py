"""Inspect GRID3 settlement extents before loading them (read-only).

Lists every layer in the downloaded file(s), its columns and coordinate system,
and how many settlement polygons fall inside the pilot area.

Run from the project root:  python scripts/inspect_grid3.py
"""
from pathlib import Path

import geopandas as gpd
import pyogrio
from sqlalchemy import text

from db import get_engine

RAW_DIR = Path("data/raw/grid3")
PILOT_ID = "lower_volta"


def pilot_area():
    sql = text("""
        SELECT ST_Union(b.geom) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
    """)
    gdf = gpd.read_postgis(sql, get_engine(), geom_col="geom", params={"pid": PILOT_ID})
    return gdf.geometry.iloc[0]


def main():
    files = sorted(list(RAW_DIR.rglob("*.gpkg")) + list(RAW_DIR.rglob("*.shp")))
    if not files:
        raise SystemExit(f"No .gpkg or .shp found under {RAW_DIR} - check the download and unzip.")

    area = pilot_area()

    for path in files:
        print(f"\n=== {path} ===")
        for layer_name, geom_type in pyogrio.list_layers(path):
            info = pyogrio.read_info(path, layer=layer_name)
            print(f"\nLayer '{layer_name}'  geometry: {geom_type}  features: {info['features']:,}")
            print(f"  CRS: {info['crs']}")
            print(f"  Columns: {list(info['fields'])}")

            if geom_type is None or "Polygon" not in str(geom_type):
                continue

            gdf = pyogrio.read_dataframe(path, layer=layer_name, bbox=area.bounds)
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs("EPSG:4326")
            inside = gdf[gdf.intersects(area)]
            print(f"  Polygons intersecting the pilot: {len(inside):,}")
            if len(inside):
                cols = [c for c in inside.columns if c != "geometry"][:8]
                print("  First rows:")
                print(inside[cols].head(5).to_string(index=False))
                for col in inside.columns:
                    if col != "geometry" and inside[col].dtype == object and inside[col].nunique() <= 10:
                        print(f"  Values of '{col}': {inside[col].value_counts().to_dict()}")


if __name__ == "__main__":
    main()
