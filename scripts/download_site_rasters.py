"""Download terrain (Copernicus DEM) and land-cover (ESA WorldCover) rasters for the pilot.

Used by the site-comparison API (Module 6). Rasters are clipped to the pilot bounding box
plus a margin, downloaded from Earth Engine in tiles on one aligned grid, and stitched locally.

Run from the project root:  python scripts/download_site_rasters.py
"""
import json
import os
import urllib.request
from datetime import date
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
MARGIN_DEG = 0.05            # extra margin so site circles near the edge still have data
DOWNLOAD_TILES = 3
OUT_DIR = Path("data/processed/site_rasters")

DEM_ASSET = "COPERNICUS/DEM/GLO30_2024_1"
WORLDCOVER_ASSET = "ESA/WorldCover/v200"

RASTERS = {
    "dem": {
        "path": OUT_DIR / "dem_glo30_pilot.tif",
        "res_deg": 0.00027,    # about 30 m
        "nodata": -9999,
        "source": f"{DEM_ASSET} (D-05)",
        "note": "Elevation in metres (rounded), bilinear resampling. Digital SURFACE model: "
                "includes trees and buildings.",
    },
    "landcover": {
        "path": OUT_DIR / "worldcover2021_pilot.tif",
        "res_deg": 0.00018,    # about 20 m (native 10 m; nearest-neighbour resampling)
        "nodata": 0,
        "source": f"{WORLDCOVER_ASSET} (D-06)",
        "note": "ESA WorldCover 2021 class codes (10 tree cover ... 95 mangroves), nearest-neighbour "
                "resampled from 10 m to about 20 m.",
    },
}


def pilot_bounds():
    sql = text("""
        SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
        FROM (
            SELECT ST_Extent(b.geom) AS e
            FROM admin_boundaries b JOIN pilot_districts p USING (pcode)
            WHERE p.pilot_id = :pid
        ) x
    """)
    with get_engine().connect() as conn:
        r = conn.execute(sql, {"pid": PILOT_ID}).mappings().first()
    return (r["minx"] - MARGIN_DEG, r["miny"] - MARGIN_DEG, r["maxx"] + MARGIN_DEG, r["maxy"] + MARGIN_DEG)


def dem_image(region):
    coll = ee.ImageCollection(DEM_ASSET).filterBounds(region).select("DEM")
    dem = coll.mosaic().setDefaultProjection(coll.first().projection()).resample("bilinear")
    return dem.round().toInt16().unmask(RASTERS["dem"]["nodata"])


def landcover_image():
    return ee.ImageCollection(WORLDCOVER_ASSET).first().select("Map").unmask(0).toByte()


def download_geotiff(image, bounds, out_path, res_deg, nodata):
    """Download in tiles on one aligned pixel grid, then stitch them into a single GeoTIFF."""
    minx, miny, maxx, maxy = bounds
    tile_w = (maxx - minx) / DOWNLOAD_TILES
    tile_h = (maxy - miny) / DOWNLOAD_TILES
    grid = [res_deg, 0, minx, 0, -res_deg, maxy]

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
            tile_path = out_path.parent / f"_tile_{out_path.stem}_{i}_{j}.tif"
            print(f"    tile {i * DOWNLOAD_TILES + j + 1} of {DOWNLOAD_TILES ** 2}", flush=True)
            try:
                urllib.request.urlretrieve(url, tile_path)
            except HTTPError as err:
                detail = err.read().decode("utf-8", errors="replace")
                raise SystemExit(f"Download failed for tile {i},{j}: {detail}")
            tile_paths.append(tile_path)

    sources = [rasterio.open(p) for p in tile_paths]
    try:
        mosaic, transform = merge(sources, nodata=nodata)
        profile = sources[0].profile.copy()
    finally:
        for src in sources:
            src.close()

    profile.update(
        height=mosaic.shape[1], width=mosaic.shape[2], transform=transform,
        compress="deflate", nodata=nodata,
    )
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(mosaic)
    for p in tile_paths:
        p.unlink()


def main():
    load_dotenv()
    ee.Initialize(project=os.environ["GEE_PROJECT"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    bounds = pilot_bounds()
    region = ee.Geometry.Rectangle(list(bounds), proj="EPSG:4326", geodesic=False)
    print(f"Pilot bounds with margin: {[round(b, 4) for b in bounds]}")

    images = {"dem": dem_image(region), "landcover": landcover_image()}
    for key, cfg in RASTERS.items():
        print(f"\nDownloading {key} ...", flush=True)
        download_geotiff(images[key], bounds, cfg["path"], cfg["res_deg"], cfg["nodata"])
        with rasterio.open(cfg["path"]) as src:
            print(f"  saved {cfg['path']}  {src.width} x {src.height} px, {src.dtypes[0]}, nodata={src.nodata}")

    metadata = {
        "created": date.today().isoformat(),
        "pilot_id": PILOT_ID,
        "bounds_with_margin": bounds,
        "crs": "EPSG:4326",
        "rasters": {
            k: {"file": str(v["path"]), "resolution_deg": v["res_deg"], "nodata": v["nodata"],
                "source": v["source"], "note": v["note"]}
            for k, v in RASTERS.items()
        },
    }
    meta_path = OUT_DIR / "site_rasters_metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"\nSaved metadata to {meta_path}")


if __name__ == "__main__":
    main()
