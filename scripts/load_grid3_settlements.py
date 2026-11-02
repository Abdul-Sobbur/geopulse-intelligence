"""Load GRID3 settlement extents (D-04) for a pilot area into PostGIS.

A settlement is kept if a point guaranteed to lie inside its polygon falls inside the pilot.
This excludes very large polygons centred elsewhere (e.g. the Greater Accra built-up area)
while keeping corridor settlements that cross a district line.

Run from the project root:
    python scripts/load_grid3_settlements.py
    python scripts/load_grid3_settlements.py --pilot-config config/pilot_lower_volta.json
"""
import argparse
import json
from pathlib import Path

import geopandas as gpd
import pyogrio
from shapely.geometry import MultiPolygon
from sqlalchemy import text

from db import get_engine

GPKG = Path("data/raw/grid3/GRID3_GHA_settlement_extents_v3_0.gpkg")
LAYER = "GRID3_GHA_Settlement_Extents_v3_0"
SOURCE_ID = "D-04"  # GRID3 GHA Settlement Extents v3.0; see docs/data-inventory.md


def to_multipolygon(geom):
    return MultiPolygon([geom]) if geom.geom_type == "Polygon" else geom


def load_pilot_area(engine, pilot_id):
    sql = text("""
        SELECT ST_Union(b.geom) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
    """)
    pilot = gpd.read_postgis(sql, engine, geom_col="geom", params={"pid": pilot_id})
    return pilot.geometry.iloc[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot-config", default="config/pilot_lower_volta.json")
    args = parser.parse_args()
    config = json.loads(Path(args.pilot_config).read_text(encoding="utf-8"))

    if not GPKG.exists():
        raise SystemExit(f"Missing {GPKG} - download and unzip GRID3 first.")

    engine = get_engine()
    area = load_pilot_area(engine, config["pilot_id"])

    print("Reading GRID3 settlements around the pilot ...", flush=True)
    gdf = pyogrio.read_dataframe(GPKG, layer=LAYER, bbox=area.bounds, fid_as_index=True)
    print(f"  {len(gdf):,} polygons in the bounding box")

    inside = gdf[gdf.representative_point().within(area)].copy()
    excluded = len(gdf[gdf.intersects(area)]) - len(inside)
    print(f"  {len(inside):,} settlements centred inside the pilot "
          f"({excluded:,} edge polygons centred outside were excluded)")

    invalid = ~inside.is_valid
    if invalid.any():
        inside.loc[invalid, "geometry"] = inside.loc[invalid, "geometry"].buffer(0)
    print(f"  {int(invalid.sum())} invalid geometries repaired")

    settlements = gpd.GeoDataFrame(
        {
            "source_ref": ("fid/" + inside.index.astype(str)).values,
            "settlement_type": inside["type"].values,
            "building_count": inside["building_count"].values,
            "building_area_m2": inside["building_area"].values,
            "probability": inside["probability"].values,
            "data_year": inside["date"].astype(str).values,
            "source_id": SOURCE_ID,
        },
        geometry=inside.geometry.apply(to_multipolygon).values,
        crs="EPSG:4326",
    ).rename_geometry("geom")

    settlements.to_postgis("settlements", engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE settlements ADD COLUMN settlement_id BIGSERIAL PRIMARY KEY"))
        has_gist = conn.execute(text(
            "SELECT count(*) FROM pg_indexes WHERE tablename = 'settlements' AND indexdef ILIKE '%gist%'"
        )).scalar()
        if not has_gist:
            conn.execute(text("CREATE INDEX settlements_geom_idx ON settlements USING GIST (geom)"))

        conn.execute(text("ALTER TABLE settlements ADD COLUMN adm2_pcode TEXT"))
        conn.execute(text("""
            UPDATE settlements s SET adm2_pcode = b.pcode
            FROM admin_boundaries b
            WHERE ST_Intersects(b.geom, ST_PointOnSurface(s.geom))
        """))

        by_type = conn.execute(text("""
            SELECT settlement_type, count(*) AS n, sum(building_count) AS buildings,
                   round(avg(probability)::numeric, 2) AS mean_prob
            FROM settlements GROUP BY settlement_type ORDER BY n DESC
        """)).fetchall()
        by_district = conn.execute(text("""
            SELECT s.adm2_pcode, b.name, count(*) AS n, sum(s.building_count) AS buildings
            FROM settlements s JOIN admin_boundaries b ON b.pcode = s.adm2_pcode
            GROUP BY s.adm2_pcode, b.name ORDER BY s.adm2_pcode
        """)).fetchall()

    print(f"\nLoaded {len(settlements):,} settlements into 'settlements'\n")
    print(f"  {'type':<24} {'count':>6} {'buildings':>10} {'mean prob.':>11}")
    for r in by_type:
        print(f"  {r.settlement_type:<24} {r.n:>6,} {int(r.buildings):>10,} {r.mean_prob:>11}")
    print(f"\n  {'pcode':<7} {'district':<15} {'count':>6} {'buildings':>10}")
    for r in by_district:
        print(f"  {r.adm2_pcode:<7} {r.name:<15} {r.n:>6,} {int(r.buildings):>10,}")


if __name__ == "__main__":
    main()
