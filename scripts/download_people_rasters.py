"""Download population and building-count rasters for the pilot from Earth Engine (Wave 1).

One 4-band GeoTIFF on the WorldPop 100 m grid, so every band can be summed cell by cell:
  1 population_worldpop_2023   WorldPop R2025A, people per cell, year 2023          (D-09)
  2 population_ghspop_2020     GHS-POP R2023A epoch 2020, moved onto the WorldPop grid (D-10)
  3 population_ghspop_2025     GHS-POP R2023A epoch 2025 (projection), same treatment (D-10)
  4 buildings_065              Open Buildings v3 footprints per cell, confidence >= 0.65 (D-11)
  5 buildings_075              Open Buildings v3 footprints per cell, confidence >= 0.75 (D-11)

GHS-POP is published on a 100 m Mollweide grid. It is converted to people per square metre, sampled
onto the WorldPop grid and multiplied by each cell's area; the script prints the pilot total before
and after so the size of that approximation is visible.

Run from the project root:  python scripts/download_people_rasters.py
"""
import json
import os
import urllib.request
from datetime import date
from pathlib import Path
from urllib.error import HTTPError

import ee
import rasterio
from dotenv import load_dotenv
from rasterio.merge import merge
from sqlalchemy import text

from db import get_engine

PILOT_ID = "lower_volta"
MARGIN_DEG = 0.02
DOWNLOAD_TILES = 3
OUT_PATH = Path("data/processed/people/people_pilot.tif")

WORLDPOP = "WorldPop/GP/100m/R2025A/v1/pop"
GHSPOP = "JRC/GHSL/P2023A/GHS_POP"
BUILDINGS = "GOOGLE/Research/open-buildings/v3/polygons"
BANDS = ["population_worldpop_2023", "population_ghspop_2020", "population_ghspop_2025",
         "buildings_065", "buildings_075"]


def pilot_bounds():
    sql = text("""
        SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
        FROM (SELECT ST_Extent(b.geom) AS e FROM admin_boundaries b
              JOIN pilot_districts p USING (pcode) WHERE p.pilot_id = :pid) x
    """)
    with get_engine().connect() as conn:
        r = conn.execute(sql, {"pid": PILOT_ID}).mappings().first()
    return (r["minx"] - MARGIN_DEG, r["miny"] - MARGIN_DEG, r["maxx"] + MARGIN_DEG, r["maxy"] + MARGIN_DEG)


def worldpop_2023():
    coll = (ee.ImageCollection(WORLDPOP)
            .filter(ee.Filter.eq("country", "GHA"))
            .filter(ee.Filter.eq("year", 2023)))
    if coll.size().getInfo() != 1:
        raise SystemExit("Expected exactly one WorldPop image for GHA 2023: check the collection in the catalogue.")
    return ee.Image(coll.first()).select("population")


def ghspop_on_grid(epoch, grid_proj):
    """GHS-POP people per cell, moved to another grid by way of density (people per m2)."""
    img = ee.Image(f"{GHSPOP}/{epoch}").select("population_count")
    native = img.projection()
    density = img.divide(ee.Image.pixelArea().reproject(native))
    return density.reproject(grid_proj).multiply(ee.Image.pixelArea().reproject(grid_proj)), img


def buildings_count(region, min_conf):
    fc = (ee.FeatureCollection(BUILDINGS)
          .filterBounds(region)
          .filter(ee.Filter.gte("confidence", min_conf))
          .map(lambda f: ee.Feature(f.geometry().centroid(1), {"one": 1})))
    return fc.reduceToImage(["one"], ee.Reducer.sum()).unmask(0)


def download(image, bounds, transform, crs):
    """Download on the native WorldPop grid, in tiles, then stitch."""
    minx, miny, maxx, maxy = bounds
    tw, th = (maxx - minx) / DOWNLOAD_TILES, (maxy - miny) / DOWNLOAD_TILES
    tiles = []
    for i in range(DOWNLOAD_TILES):
        for j in range(DOWNLOAD_TILES):
            region = ee.Geometry.Rectangle([minx + i * tw, miny + j * th, minx + (i + 1) * tw, miny + (j + 1) * th],
                                           proj="EPSG:4326", geodesic=False)
            url = image.getDownloadURL({"region": region, "crs": crs, "crs_transform": transform,
                                        "format": "GEO_TIFF"})
            path = OUT_PATH.parent / f"_tile_{i}_{j}.tif"
            print(f"    tile {i * DOWNLOAD_TILES + j + 1} of {DOWNLOAD_TILES ** 2}", flush=True)
            try:
                urllib.request.urlretrieve(url, path)
            except HTTPError as err:
                raise SystemExit(f"Download failed for tile {i},{j}: {err.read().decode('utf-8', 'replace')}")
            tiles.append(path)
    sources = [rasterio.open(p) for p in tiles]
    try:
        mosaic, out_transform = merge(sources, nodata=-1)
        profile = sources[0].profile.copy()
    finally:
        for s in sources:
            s.close()
    profile.update(height=mosaic.shape[1], width=mosaic.shape[2], transform=out_transform,
                   compress="deflate", nodata=-1, dtype="float32")
    with rasterio.open(OUT_PATH, "w", **profile) as dst:
        dst.write(mosaic.astype("float32"))
        for k, name in enumerate(BANDS, start=1):
            dst.set_band_description(k, name)
    for p in tiles:
        p.unlink()


def main():
    load_dotenv()
    ee.Initialize(project=os.environ["GEE_PROJECT"])
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    bounds = pilot_bounds()
    region = ee.Geometry.Rectangle(list(bounds), proj="EPSG:4326", geodesic=False)
    wp = worldpop_2023()
    proj = wp.projection().getInfo()
    crs, transform = proj["crs"], proj["transform"]
    print(f"WorldPop grid: {crs}, transform {transform}")

    ghs20, ghs20_native = ghspop_on_grid(2020, wp.projection())
    ghs25, ghs25_native = ghspop_on_grid(2025, wp.projection())
    image = ee.Image.cat([
        wp.unmask(0),
        ghs20.unmask(0),
        ghs25.unmask(0),
        buildings_count(region, 0.65),
        buildings_count(region, 0.75),
    ]).rename(BANDS).toFloat()

    # How much does moving GHS-POP onto the WorldPop grid change its pilot total?
    def total(img, proj):
        return img.reduceRegion(ee.Reducer.sum(), region, crs=proj, scale=proj.nominalScale(),
                                maxPixels=1e9).values().get(0)
    check = ee.Dictionary({
        "ghs2025_native": total(ghs25_native, ghs25_native.projection()),
        "ghs2025_on_grid": total(ghs25, wp.projection()),
    }).getInfo()
    change = 100 * (check["ghs2025_on_grid"] / check["ghs2025_native"] - 1)
    print(f"GHS-POP 2025 in the pilot box: {check['ghs2025_native']:,.0f} native, "
          f"{check['ghs2025_on_grid']:,.0f} on the WorldPop grid ({change:+.1f}%)")

    print("Downloading (5 bands) ...", flush=True)
    download(image, bounds, transform, crs)
    with rasterio.open(OUT_PATH) as src:
        print(f"Saved {OUT_PATH}: {src.width} x {src.height} px, {src.count} bands")

    meta = {
        "created": date.today().isoformat(), "pilot_id": PILOT_ID, "bounds": bounds, "crs": crs,
        "transform": transform, "bands": BANDS,
        "sources": {"D-09": WORLDPOP + " (GHA, 2023)", "D-10": GHSPOP + " (2020, 2025)", "D-11": BUILDINGS},
        "ghspop_regrid_check": {**check, "percent_change": round(change, 2)},
        "notes": [
            "Building bands count footprint centroids per cell.",
            "GHS-POP moved to the WorldPop grid by density x cell area (nearest cell); see the regrid check.",
        ],
    }
    OUT_PATH.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"Saved {OUT_PATH.with_suffix('.json')}")


if __name__ == "__main__":
    main()
