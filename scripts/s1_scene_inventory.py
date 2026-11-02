"""List Sentinel-1 scenes covering a pilot area before and during the 2023 Lower Volta flood.

Read-only. Run from the project root:  python scripts/s1_scene_inventory.py
"""
import os

import ee
import geopandas as gpd
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import text

from db import get_engine

PILOT_ID = "lower_volta"

# Pre-event ends before VRA's controlled spillage began (15 Sep 2023);
# the flood window covers the reported mid-October peak.
WINDOWS = {
    "pre_event": ("2023-07-15", "2023-09-15"),  # end date is exclusive
    "flood": ("2023-10-01", "2023-11-16"),
}


def pilot_geometry():
    """Pilot outline from PostGIS, lightly simplified to keep Earth Engine requests small."""
    sql = text("""
        SELECT ST_SimplifyPreserveTopology(ST_Union(b.geom), 0.001) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
    """)
    gdf = gpd.read_postgis(sql, get_engine(), geom_col="geom", params={"pid": PILOT_ID})
    return ee.Geometry(gdf.geometry.iloc[0].__geo_interface__)


def main():
    load_dotenv()
    ee.Initialize(project=os.environ["GEE_PROJECT"])

    aoi = pilot_geometry()
    aoi_area = aoi.area(maxError=100)

    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(aoi)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
    )

    def describe(img):
        covered = img.geometry().intersection(aoi, ee.ErrorMargin(100)).area(maxError=100)
        return ee.Feature(None, {
            "date": img.date().format("YYYY-MM-dd"),
            "pass": img.get("orbitProperties_pass"),
            "rel_orbit": img.get("relativeOrbitNumber_start"),
            "platform": ee.String("S1").cat(ee.String(img.get("platform_number"))),
            "aoi_cover_pct": covered.divide(aoi_area).multiply(100).round(),
        })

    frames = []
    for window, (start, end) in WINDOWS.items():
        fc = ee.FeatureCollection(s1.filterDate(start, end).map(describe))
        rows = [f["properties"] for f in fc.getInfo()["features"]]
        df = pd.DataFrame(rows)
        if not df.empty:
            df.insert(0, "window", window)
        frames.append(df)

    scenes = pd.concat(frames, ignore_index=True)
    if scenes.empty:
        raise SystemExit("No Sentinel-1 scenes found - check dates and pilot geometry.")

    scenes = scenes.sort_values(["window", "date"], ascending=[False, True])
    print("Sentinel-1 IW scenes intersecting the pilot area:\n")
    print(scenes.to_string(index=False))

    print("\nScenes per orbit track (pass + relative orbit) and window:")
    summary = (
        scenes.groupby(["pass", "rel_orbit", "window"]).size()
        .unstack(fill_value=0)
    )
    print(summary.to_string())


if __name__ == "__main__":
    main()