"""Map the observed 2023 Lower Volta flood extent from Sentinel-1 radar (Google Earth Engine).

Method adapted from UN-SPIDER's Recommended Practice for flood mapping with Sentinel-1:
  1. Per orbit track: median pre-event image vs single-date flood image (VV, dB), speckle-smoothed.
  2. Flood = strong darkening (flood/pre ratio > RATIO_THRESHOLD) AND dark flood image (< WATER_DB_MAX).
  3. Remove permanent water (JRC GSW seasonality), slopes > MAX_SLOPE_DEG, clusters < MIN_CONNECTED_PIXELS.
  4. Label new water inside recurrent seasonal water bodies (JRC GSW occurrence) as ambiguous.
  5. Combine tracks; report areas per district; save GeoTIFF (tiled download) + metadata.

Run from the project root:  python scripts/s1_flood_extent.py
"""
import json
import os
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError

import ee
import geopandas as gpd
import rasterio
from dotenv import load_dotenv
from rasterio.merge import merge
from sqlalchemy import text

from db import get_engine

PILOT_ID = "lower_volta"

# ---- Event definition (see docs/data-inventory.md, D-07 / D-08) ----
PRE_START, PRE_END = "2023-07-15", "2023-09-15"   # ends before VRA spillage began (15 Sep 2023)
TRACKS = {147: "2023-10-16", 74: "2023-10-23"}     # relative orbit -> flood image date

# ---- Method parameters (starting values; recorded in the metadata file) ----
RATIO_THRESHOLD = 1.25            # flood/pre ratio of dB values (UN-SPIDER default)
WATER_DB_MAX = -15                # flood image must also be dark, i.e. likely open water
SMOOTHING_RADIUS_M = 50           # speckle reduction
MAX_SLOPE_DEG = 5
MIN_CONNECTED_PIXELS = 8
PERMANENT_WATER_MONTHS = 10       # JRC GSW seasonality >= this = permanent water
RECURRENT_WATER_OCCURRENCE = 10   # JRC GSW occurrence (%) >= this = recurrent seasonal water body
DEM_ASSET = "COPERNICUS/DEM/GLO30_2024_1"

# ---- Output grid ----
RES_DEG = 0.00018                 # about 20 m at this latitude
DOWNLOAD_TILES = 3                # 3 x 3 tiles keeps each request within Earth Engine limits
STATS_SCALE_M = 20

OUT_DIR = Path("data/processed/flood_2023")
RASTER_CODES = {
    0: "outside pilot area",
    1: "flooded (observed)",
    2: "observed, not flooded",
    3: "no Sentinel-1 coverage",
    4: "permanent water (JRC GSW)",
    5: "new water in recurrent seasonal water body (lagoon/pans) - not attributable to the event",
}
QUICKLOOK_PALETTE = ["ffffff", "00a6ff", "e4e7eb", "616e7c", "08306b", "f39c12"]


def load_districts():
    """Pilot districts from PostGIS: an Earth Engine collection plus the overall bounds."""
    sql = text("""
        SELECT b.pcode, b.name, ST_SimplifyPreserveTopology(b.geom, 0.0005) AS geom
        FROM admin_boundaries b
        JOIN pilot_districts p USING (pcode)
        WHERE p.pilot_id = :pid
        ORDER BY b.pcode
    """)
    gdf = gpd.read_postgis(sql, get_engine(), geom_col="geom", params={"pid": PILOT_ID})
    fc = ee.FeatureCollection(json.loads(gdf.to_json(drop_id=True)))
    return fc, tuple(gdf.total_bounds)


def ancillary_masks(aoi):
    """Masks from JRC Global Surface Water and the Copernicus DEM."""
    gsw = ee.Image("JRC/GSW1_4/GlobalSurfaceWater")
    permanent = gsw.select("seasonality").gte(PERMANENT_WATER_MONTHS).unmask(0)
    recurrent = gsw.select("occurrence").gte(RECURRENT_WATER_OCCURRENCE).unmask(0)

    dem_coll = ee.ImageCollection(DEM_ASSET).filterBounds(aoi).select("DEM")
    dem = dem_coll.mosaic().setDefaultProjection(dem_coll.first().projection())
    slope = ee.Terrain.slope(dem)

    plausible = permanent.Not().And(slope.lte(MAX_SLOPE_DEG))
    return plausible, permanent, recurrent


def track_flood(s1, rel_orbit, flood_date, plausible):
    """Flood result for one orbit track: 1 flooded, 0 observed not flooded, masked = no data."""
    track = s1.filter(ee.Filter.eq("relativeOrbitNumber_start", rel_orbit))
    pre_coll = track.filterDate(PRE_START, PRE_END)
    next_day = (date.fromisoformat(flood_date) + timedelta(days=1)).isoformat()
    post_coll = track.filterDate(flood_date, next_day)

    pre = pre_coll.median().focal_mean(SMOOTHING_RADIUS_M, "circle", "meters")
    post = post_coll.mosaic().focal_mean(SMOOTHING_RADIUS_M, "circle", "meters")
    observed = pre.mask().gt(0).And(post.mask().gt(0))

    flooded = (
        post.divide(pre).gt(RATIO_THRESHOLD)
        .And(post.lt(WATER_DB_MAX))
        .And(plausible)
    )
    flooded = flooded.updateMask(flooded)
    flooded = flooded.updateMask(flooded.connectedPixelCount(100, True).gte(MIN_CONNECTED_PIXELS))

    result = flooded.unmask(0).updateMask(observed).rename("flood")
    scene_ids = {
        "pre_event": pre_coll.aggregate_array("system:index").getInfo(),
        "flood": post_coll.aggregate_array("system:index").getInfo(),
    }
    return result, scene_ids


def download_geotiff(image, bounds, out_path):
    """Download in tiles on one aligned pixel grid, then stitch them into a single GeoTIFF."""
    minx, miny, maxx, maxy = bounds
    tile_w = (maxx - minx) / DOWNLOAD_TILES
    tile_h = (maxy - miny) / DOWNLOAD_TILES
    grid = [RES_DEG, 0, minx, 0, -RES_DEG, maxy]   # same grid for every tile

    tile_paths = []
    for i in range(DOWNLOAD_TILES):
        for j in range(DOWNLOAD_TILES):
            region = ee.Geometry.Rectangle(
                [minx + i * tile_w, miny + j * tile_h, minx + (i + 1) * tile_w, miny + (j + 1) * tile_h],
                proj="EPSG:4326", geodesic=False,
            )
            url = image.getDownloadURL({
                "region": region, "crs": "EPSG:4326", "crs_transform": grid, "format": "GEO_TIFF",
            })
            tile_path = out_path.parent / f"_tile_{i}_{j}.tif"
            print(f"  tile {i * DOWNLOAD_TILES + j + 1} of {DOWNLOAD_TILES ** 2}", flush=True)
            try:
                urllib.request.urlretrieve(url, tile_path)
            except HTTPError as err:
                detail = err.read().decode("utf-8", errors="replace")
                raise SystemExit(f"Download failed for tile {i},{j}: {detail}")
            tile_paths.append(tile_path)

    sources = [rasterio.open(p) for p in tile_paths]
    try:
        mosaic, transform = merge(sources)
        profile = sources[0].profile.copy()
    finally:
        for src in sources:
            src.close()

    profile.update(
        height=mosaic.shape[1], width=mosaic.shape[2], transform=transform,
        compress="deflate", nodata=None,
    )
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(mosaic)
    for p in tile_paths:
        p.unlink()


def main():
    load_dotenv()
    ee.Initialize(project=os.environ["GEE_PROJECT"])

    districts, bounds = load_districts()
    aoi = districts.union(10).geometry()

    s1 = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(aoi)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
        .filter(ee.Filter.eq("orbitProperties_pass", "ASCENDING"))
        .select("VV")
    )

    plausible, permanent, recurrent = ancillary_masks(aoi)

    print("Building flood layers per track ...", flush=True)
    track_images, scenes = [], {}
    for rel_orbit, flood_date in TRACKS.items():
        img, ids = track_flood(s1, rel_orbit, flood_date, plausible)
        track_images.append(img)
        scenes[str(rel_orbit)] = {"flood_date": flood_date, **ids}
        print(f"  track {rel_orbit}: {len(ids['pre_event'])} pre-event scenes, "
              f"{len(ids['flood'])} flood-date scene(s)")

    combined = ee.ImageCollection(track_images).max()   # flooded in either track -> 1

    codes = (
        ee.Image(3)
        .where(combined.eq(0), 2)
        .where(combined.eq(1), 1)
        .where(combined.eq(1).And(recurrent), 5)
        .where(permanent.eq(1), 4)
        .clip(aoi)
        .unmask(0)
        .toByte()
        .rename("code")
    )

    # ---- Per-district statistics ----
    print("Calculating per-district statistics (can take a minute or two) ...", flush=True)
    pixel_area = ee.Image.pixelArea()
    stats_image = ee.Image.cat(
        codes.eq(1).multiply(pixel_area).rename("flooded_m2"),
        codes.eq(5).multiply(pixel_area).rename("ambiguous_m2"),
        combined.mask().gt(0).unmask(0).multiply(pixel_area).rename("observed_m2"),
        pixel_area.rename("total_m2"),
    )
    stats = stats_image.reduceRegions(
        collection=districts, reducer=ee.Reducer.sum(), scale=STATS_SCALE_M, tileScale=4,
    ).getInfo()

    rows = []
    for f in stats["features"]:
        p = f["properties"]
        total, observed = p["total_m2"] / 1e6, p["observed_m2"] / 1e6
        flooded, ambiguous = p["flooded_m2"] / 1e6, p["ambiguous_m2"] / 1e6
        rows.append({
            "pcode": p["pcode"], "name": p["name"],
            "area_km2": round(total, 1),
            "observed_pct": round(100 * observed / total, 1) if total else 0,
            "flooded_km2": round(flooded, 1),
            "flooded_pct_of_observed": round(100 * flooded / observed, 1) if observed else None,
            "ambiguous_km2": round(ambiguous, 1),
        })

    print(f"\n{'pcode':<7} {'district':<15} {'area km2':>9} {'observed %':>11} "
          f"{'flooded km2':>12} {'% observed':>11} {'ambiguous km2':>14}")
    for r in rows:
        pct = "n/a" if r["flooded_pct_of_observed"] is None else r["flooded_pct_of_observed"]
        print(f"{r['pcode']:<7} {r['name']:<15} {r['area_km2']:>9} {r['observed_pct']:>11} "
              f"{r['flooded_km2']:>12} {pct:>11} {r['ambiguous_km2']:>14}")
    print(f"\nTotal flooded (attributable): {sum(r['flooded_km2'] for r in rows):,.1f} km²")
    print(f"Total ambiguous (recurrent seasonal water): {sum(r['ambiguous_km2'] for r in rows):,.1f} km²")

    # ---- Quick-look image ----
    quicklook = codes.visualize(min=0, max=5, palette=QUICKLOOK_PALETTE).getThumbURL(
        {"region": aoi.bounds(), "dimensions": 1200, "format": "png"}
    )
    print("\nQuick-look (light blue = flooded, orange = ambiguous seasonal water, "
          "dark blue = permanent water, light grey = observed dry, dark grey = no coverage):")
    print(quicklook)

    # ---- Save GeoTIFF + metadata ----
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tif_path = OUT_DIR / "flood_2023_lower_volta_codes.tif"
    print(f"\nDownloading GeoTIFF in {DOWNLOAD_TILES ** 2} tiles ...", flush=True)
    download_geotiff(codes, bounds, tif_path)
    print(f"Saved {tif_path}")

    metadata = {
        "product": "D-08 Lower Volta observed flood extent 2023 (derived from D-07 Sentinel-1)",
        "pilot_id": PILOT_ID,
        "created": date.today().isoformat(),
        "method": "Sentinel-1 VV change detection, adapted from UN-SPIDER Recommended Practice",
        "pre_event_window": [PRE_START, PRE_END],
        "tracks": scenes,
        "parameters": {
            "ratio_threshold": RATIO_THRESHOLD,
            "water_db_max": WATER_DB_MAX,
            "smoothing_radius_m": SMOOTHING_RADIUS_M,
            "max_slope_deg": MAX_SLOPE_DEG,
            "min_connected_pixels": MIN_CONNECTED_PIXELS,
            "permanent_water_months": PERMANENT_WATER_MONTHS,
            "recurrent_water_occurrence_pct": RECURRENT_WATER_OCCURRENCE,
            "grid": {"crs": "EPSG:4326", "resolution_deg": RES_DEG},
            "ancillary": ["JRC/GSW1_4/GlobalSurfaceWater", DEM_ASSET],
        },
        "raster_codes": RASTER_CODES,
        "district_stats": rows,
        "limitations": [
            "Water observed on two dates (16 and 23 Oct 2023), not peak extent and not a single moment.",
            "Radar under-detects flooding beneath dense vegetation and in built-up areas; "
            "the extent is likely an under-estimate.",
            "New water in recurrent seasonal water bodies (e.g. lagoons, salt pans) is reported "
            "separately as ambiguous, not as event flooding.",
            "Rainy-season baseline may hide some flooding of already-wet ground (conservative).",
            "Thresholds are standard starting values and have not been validated against field data.",
            "Preliminary screening information, not an official flood map or hazard model.",
        ],
    }
    meta_path = OUT_DIR / "flood_2023_lower_volta_metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Saved metadata to {meta_path}")


if __name__ == "__main__":
    main()