"""Load Ghana admin-2 (district) boundaries into PostGIS and register a pilot area.

Run from the project root:
    python scripts/load_admin_boundaries.py
    python scripts/load_admin_boundaries.py --pilot-config config/pilot_lower_volta.json
"""
import argparse
import json
import os
from pathlib import Path

import geopandas as gpd
from dotenv import load_dotenv
from shapely.geometry import MultiPolygon
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

SHAPEFILE = Path("data/raw/boundaries/gha_admin2.shp")
SOURCE_ID = "D-01"  # COD-AB boundaries; see docs/data-inventory.md


def get_engine():
    """Build a database connection from the settings in .env."""
    load_dotenv()
    url = URL.create(
        drivername="postgresql+psycopg",
        username=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        database=os.environ["DB_NAME"],
    )
    return create_engine(url)


def to_multipolygon(geom):
    """Store every district as a MultiPolygon so the column has one consistent type."""
    return MultiPolygon([geom]) if geom.geom_type == "Polygon" else geom


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot-config", default="config/pilot_lower_volta.json")
    args = parser.parse_args()

    config = json.loads(Path(args.pilot_config).read_text(encoding="utf-8"))
    pilot_id = config["pilot_id"]
    pilot_pcodes = config["district_pcodes"]

    # 1. Read the boundaries and check the pilot P-codes exist BEFORE touching the database
    gdf = gpd.read_file(SHAPEFILE)
    missing = set(pilot_pcodes) - set(gdf["adm2_pcode"])
    if missing:
        raise SystemExit(f"Pilot P-codes not found in boundary file: {sorted(missing)}")

    # 2. Keep the useful columns and give them clear, generic names
    districts = gdf[[
        "adm2_pcode", "adm2_name", "adm1_pcode", "adm1_name", "adm0_pcode",
        "valid_on", "version", "geometry",
    ]].rename(columns={
        "adm2_pcode": "pcode",
        "adm2_name": "name",
        "adm1_pcode": "parent_pcode",
        "adm1_name": "parent_name",
        "adm0_pcode": "country_pcode",
    })
    districts["admin_level"] = 2
    districts["source_id"] = SOURCE_ID
    districts = districts.set_geometry(districts.geometry.apply(to_multipolygon))
    districts = districts.rename_geometry("geom")

    # 3. Write to PostGIS (replaces the table on each run, so the script is repeatable)
    engine = get_engine()
    districts.to_postgis("admin_boundaries", engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE admin_boundaries ADD PRIMARY KEY (pcode)"))

        # Make sure a spatial index exists (geopandas usually creates one)
        has_gist = conn.execute(text(
            "SELECT count(*) FROM pg_indexes "
            "WHERE tablename = 'admin_boundaries' AND indexdef ILIKE '%gist%'"
        )).scalar()
        if not has_gist:
            conn.execute(text(
                "CREATE INDEX admin_boundaries_geom_idx ON admin_boundaries USING GIST (geom)"
            ))

        # 4. Register which districts belong to this pilot
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS pilot_districts (
                pilot_id TEXT NOT NULL,
                pcode    TEXT NOT NULL,
                PRIMARY KEY (pilot_id, pcode)
            )
        """))
        conn.execute(text("DELETE FROM pilot_districts WHERE pilot_id = :pid"), {"pid": pilot_id})
        conn.execute(
            text("INSERT INTO pilot_districts (pilot_id, pcode) VALUES (:pid, :pcode)"),
            [{"pid": pilot_id, "pcode": p} for p in pilot_pcodes],
        )

        # 5. Verify
        total = conn.execute(text("SELECT count(*) FROM admin_boundaries")).scalar()
        rows = conn.execute(text("""
            SELECT b.pcode, b.name, b.parent_name,
                   round((ST_Area(b.geom::geography) / 1e6)::numeric, 1) AS area_km2
            FROM admin_boundaries b
            JOIN pilot_districts p ON p.pcode = b.pcode
            WHERE p.pilot_id = :pid
            ORDER BY b.pcode
        """), {"pid": pilot_id}).fetchall()

    print(f"Loaded {total} districts into admin_boundaries")
    print(f"\nPilot '{pilot_id}' — {len(rows)} districts:")
    for r in rows:
        print(f"  {r.pcode}  {r.name:<15} {r.parent_name:<14} {r.area_km2:>8} km²")
    print(f"  Total pilot area: {sum(r.area_km2 for r in rows):,.1f} km²")


if __name__ == "__main__":
    main()