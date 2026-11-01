"""Inspect what OpenStreetMap contains inside a pilot area.

Read-only: nothing is written to the database.
Run from the project root:  python scripts/inspect_osm.py
"""
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
from pyogrio import read_dataframe
from sqlalchemy import text

from db import get_engine

PBF = Path("data/raw/osm/ghana-261031.osm.pbf")
PILOT_ID = "lower_volta"

MAJOR_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary"}
HEALTH = {"hospital", "clinic", "doctors"}
EDUCATION = {"school", "college", "university"}


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


def load_pilot_area():
    """Get the pilot area as one merged polygon from PostGIS."""
    sql = text("""
        SELECT ST_Union(b.geom) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
    """)
    pilot = gpd.read_postgis(sql, get_engine(), geom_col="geom", params={"pid": PILOT_ID})
    return pilot.geometry.iloc[0]


def read_layer(layer, area, where=None):
    """Read one OSM layer, keeping only features that touch the pilot area."""
    print(f"  reading '{layer}' ...", flush=True)
    gdf = read_dataframe(PBF, layer=layer, bbox=area.bounds, where=where)
    return gdf[gdf.intersects(area)].copy()


def main():
    if not PBF.exists():
        raise SystemExit(f"OSM file not found: {PBF}")

    area = load_pilot_area()
    print("Reading OpenStreetMap layers inside the pilot area (can take a few minutes):")
    points = read_layer("points", area)
    lines = read_layer("lines", area)
    polys = read_layer("multipolygons", area, where="building IS NULL")  # skip buildings for now

    for df in (points, lines, polys):
        for key in ("amenity", "power", "bridge", "natural"):
            ensure_tag(df, key)

    roads = lines[lines["highway"].notna()]
    amenities = pd.concat([points["amenity"], polys["amenity"]])
    power = pd.concat([points["power"], lines["power"], polys["power"]])

    summary = [
        ("Road segments (all types)", len(roads)),
        ("  of which major (motorway to tertiary)", int(roads["highway"].isin(MAJOR_ROADS).sum())),
        ("  of which tagged as bridges", int((roads["bridge"].notna() & (roads["bridge"] != "no")).sum())),
        ("Waterway lines (rivers, streams, canals)", int(lines["waterway"].notna().sum())),
        ("Water-body polygons", int((polys["natural"] == "water").sum())),
        ("Places (city/town/village/hamlet...)", int(points["place"].notna().sum())),
        ("Health facilities (hospital/clinic/doctors)", int(amenities.isin(HEALTH).sum())),
        ("Education (school/college/university)", int(amenities.isin(EDUCATION).sum())),
        ("Power plants", int((power == "plant").sum())),
        ("Power substations", int((power == "substation").sum())),
        ("Power line segments", int((power == "line").sum())),
    ]

    print(f"\nOSM features inside pilot '{PILOT_ID}':")
    for label, count in summary:
        print(f"  {label:<48} {count:>7,}")

    print("\nPlace types:")
    print(points["place"].value_counts().to_string())
    print("\nRoad types (top 10):")
    print(roads["highway"].value_counts().head(10).to_string())


if __name__ == "__main__":
    main()