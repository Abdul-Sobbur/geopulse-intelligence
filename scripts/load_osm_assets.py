"""Load selected OpenStreetMap features for a pilot area into the PostGIS 'assets' table.

Run from the project root:
    python scripts/load_osm_assets.py
    python scripts/load_osm_assets.py --pilot-config config/pilot_lower_volta.json
"""
import argparse
import json
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
from pyogrio import read_dataframe
from shapely.geometry import Polygon
from sqlalchemy import text

from db import get_engine

SOURCE_ID = "D-02"  # OpenStreetMap; see docs/data-inventory.md

MAJOR_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary"}
EDUCATION = {"school", "college", "university"}
HEALTH = {"hospital", "clinic", "doctors"}

# asset_type, category, display label, coverage warning (None = no warning)
ASSET_TYPES = [
    ("road", "transport", "Major road", None),
    ("bridge", "transport", "Bridge", None),
    ("waterway", "water", "River / stream / canal", None),
    ("water_body", "water", "Water body", None),
    ("place", "settlement", "Named place", None),
    ("education", "social", "Education facility",
     "OpenStreetMap coverage of education facilities here is not verified; some may be missing."),
    ("health", "social", "Health facility",
     "Few health facilities are mapped in OpenStreetMap here; absence on the map is not absence on the ground."),
    ("power_plant", "energy", "Power plant",
     "Only publicly mapped OpenStreetMap features; power infrastructure coverage here is incomplete."),
    ("power_substation", "energy", "Power substation",
     "Only publicly mapped OpenStreetMap features; power infrastructure coverage here is incomplete."),
    ("power_line", "energy", "Power line",
     "Only publicly mapped OpenStreetMap features; power infrastructure coverage here is incomplete."),
]


# ---------- helpers ----------

def tag_value(other_tags, key):
    """Pull one tag out of GDAL's 'other_tags' text, e.g. '"power"=>"line"'."""
    if not isinstance(other_tags, str):
        return None
    match = re.search(rf'"{key}"=>"([^"]*)"', other_tags)
    return match.group(1) if match else None


def ensure_tag(df, key):
    """Make sure a tag is available as its own column."""
    if key not in df.columns:
        if "other_tags" in df.columns:
            df[key] = df["other_tags"].map(lambda s: tag_value(s, key))
        else:
            df[key] = None
    return df


def add_source_ref(df, layer):
    """Record the exact OSM object each feature came from (e.g. 'way/12345')."""
    if layer == "points":
        df["source_ref"] = "node/" + df["osm_id"].astype(str)
    elif layer == "lines":
        df["source_ref"] = "way/" + df["osm_id"].astype(str)
    else:  # multipolygons: closed ways carry osm_way_id, relations carry osm_id
        df["source_ref"] = df["osm_way_id"].apply(lambda v: f"way/{v}" if pd.notna(v) else None)
        no_ref = df["source_ref"].isna()
        df.loc[no_ref, "source_ref"] = "relation/" + df.loc[no_ref, "osm_id"].astype(str)
    return df


def load_pilot_area(engine, pilot_id):
    sql = text("""
        SELECT ST_Union(b.geom) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
    """)
    pilot = gpd.read_postgis(sql, engine, geom_col="geom", params={"pid": pilot_id})
    return pilot.geometry.iloc[0]


def read_layer(pbf, layer, area, where=None):
    print(f"  reading '{layer}' ...", flush=True)
    gdf = read_dataframe(pbf, layer=layer, bbox=area.bounds, where=where)
    gdf = gdf[gdf.intersects(area)].copy()
    for key in ("amenity", "power", "bridge", "natural", "water"):
        ensure_tag(gdf, key)
    return add_source_ref(gdf, layer)


def make_assets(df, asset_type, subtype_col):
    """Convert OSM features into the common asset structure."""
    return gpd.GeoDataFrame(
        {
            "asset_type": asset_type,
            "subtype": df[subtype_col].values,
            "name": df["name"].values,
            "source_ref": df["source_ref"].values,
        },
        geometry=df.geometry.values,
        crs=df.crs,
    )


def closed_lines_to_areas(df):
    """GDAL puts some OSM areas (e.g. power=substation) in the 'lines' layer.
    Turn closed rings back into polygons."""
    closed = df[df.geometry.is_closed]
    return closed.set_geometry(
        closed.geometry.apply(lambda g: Polygon(g.coords) if len(g.coords) >= 4 else g)
    )


def facility_assets(points, polys, key, values, asset_type, extra_areas=None):
    """Facilities as points; drop a point if the same type is also mapped as an area around it."""
    pts = points[points[key].isin(values)]
    pls = polys[polys[key].isin(values)]
    if extra_areas is not None:
        pls = pd.concat([pls, extra_areas[extra_areas[key].isin(values)]])
    if len(pts) and len(pls):
        inside = gpd.sjoin(pts, pls[["geometry"]], predicate="within", how="inner").index.unique()
        pts = pts.drop(index=inside)
    pls = pls.set_geometry(pls.representative_point())
    return pd.concat(
        [make_assets(pts, asset_type, key), make_assets(pls, asset_type, key)],
        ignore_index=True,
    )

# ---------- main ----------

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot-config", default="config/pilot_lower_volta.json")
    args = parser.parse_args()

    config = json.loads(Path(args.pilot_config).read_text(encoding="utf-8"))
    pbf = Path(config["sources"]["osm_pbf"])
    snapshot_date = config["sources"]["osm_snapshot_date"]
    if not pbf.exists():
        raise SystemExit(f"OSM file not found: {pbf}")

    engine = get_engine()
    area = load_pilot_area(engine, config["pilot_id"])

    print("Reading OpenStreetMap layers (can take a few minutes):")
    points = read_layer(pbf, "points", area)
    lines = read_layer(pbf, "lines", area)
    polys = read_layer(pbf, "multipolygons", area, where="building IS NULL")

    # Roads and bridges
    highways = lines[lines["highway"].notna()]
    is_bridge = highways["bridge"].notna() & (highways["bridge"] != "no")
    roads = highways[highways["highway"].isin(MAJOR_ROADS) & ~is_bridge]
    bridges = highways[is_bridge]

    power_line_areas = closed_lines_to_areas(lines[lines["power"].isin({"plant", "substation"})])

    parts = [
        make_assets(roads, "road", "highway"),
        make_assets(bridges, "bridge", "highway"),
        make_assets(lines[lines["waterway"].notna()], "waterway", "waterway"),
        make_assets(polys[polys["natural"] == "water"], "water_body", "water"),
        make_assets(points[points["place"].notna()], "place", "place"),
        facility_assets(points, polys, "amenity", EDUCATION, "education"),
        facility_assets(points, polys, "amenity", HEALTH, "health"),
        facility_assets(points, polys, "power", {"plant"}, "power_plant", extra_areas=power_line_areas),
        facility_assets(points, polys, "power", {"substation"}, "power_substation", extra_areas=power_line_areas),
        make_assets(lines[lines["power"] == "line"], "power_line", "power"),
    ]
    assets = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs="EPSG:4326")
    assets = assets.drop_duplicates(subset=["asset_type", "source_ref"])
    assets["source_id"] = SOURCE_ID
    assets["source_date"] = snapshot_date
    assets = assets.rename_geometry("geom")

    # Write (replaces the table each run, so the script is repeatable)
    assets.to_postgis("assets", engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE assets ADD COLUMN asset_id BIGSERIAL PRIMARY KEY"))
        has_gist = conn.execute(text(
            "SELECT count(*) FROM pg_indexes "
            "WHERE tablename = 'assets' AND indexdef ILIKE '%gist%'"
        )).scalar()
        if not has_gist:
            conn.execute(text("CREATE INDEX assets_geom_idx ON assets USING GIST (geom)"))

        # Which district each asset falls in (a point guaranteed to lie on the feature)
        conn.execute(text("ALTER TABLE assets ADD COLUMN adm2_pcode TEXT"))
        conn.execute(text("""
            UPDATE assets a SET adm2_pcode = b.pcode
            FROM admin_boundaries b
            WHERE ST_Intersects(b.geom, ST_PointOnSurface(a.geom))
        """))

        # Asset type lookup, including coverage warnings
        conn.execute(text("DROP TABLE IF EXISTS asset_types"))
        conn.execute(text("""
            CREATE TABLE asset_types (
                asset_type       TEXT PRIMARY KEY,
                category         TEXT NOT NULL,
                label            TEXT NOT NULL,
                coverage_warning TEXT
            )
        """))
        conn.execute(
            text("INSERT INTO asset_types VALUES (:t, :c, :l, :w)"),
            [{"t": t, "c": c, "l": l, "w": w} for t, c, l, w in ASSET_TYPES],
        )

        # Verify
        rows = conn.execute(text("""
            SELECT t.category, a.asset_type, count(*) AS n, count(a.name) AS named,
                   (t.coverage_warning IS NOT NULL) AS warn
            FROM assets a JOIN asset_types t USING (asset_type)
            GROUP BY t.category, a.asset_type, t.coverage_warning
            ORDER BY t.category, a.asset_type
        """)).fetchall()
        no_district = conn.execute(text(
            "SELECT count(*) FROM assets WHERE adm2_pcode IS NULL"
        )).scalar()

    print(f"\nLoaded {len(assets):,} assets (OSM snapshot {snapshot_date})\n")
    print(f"  {'category':<11} {'asset_type':<17} {'count':>6} {'named':>6}  warning")
    for r in rows:
        print(f"  {r.category:<11} {r.asset_type:<17} {r.n:>6} {r.named:>6}  {'yes' if r.warn else ''}")
    print(f"\nAssets without a district: {no_district}")


if __name__ == "__main__":
    main()