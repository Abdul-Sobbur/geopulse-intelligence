"""Population and buildings for every district in Ghana, from Earth Engine (Wave 1, national view).

For each of the districts in admin_boundaries it sums, inside the district boundary:
  population_worldpop_2023   WorldPop R2025A, Ghana, 2023 (D-09), at its native 100 m grid
  buildings_065 / _075       Google Open Buildings v3 footprints by centroid, confidence >= 0.65 / 0.75 (D-11)
and stores them, with the district's area, in district_indicators. Districts are sent to Earth Engine
one region at a time, simplified to about 50 m, so each request stays small.

Run from the project root:  python scripts/national_indicators.py
"""
import json
import os
import time
from datetime import datetime, timezone

import ee
from dotenv import load_dotenv
from sqlalchemy import text

from db import get_engine

WORLDPOP = "WorldPop/GP/100m/R2025A/v1/pop"
BUILDINGS = "GOOGLE/Research/open-buildings/v3/polygons"
SIMPLIFY_DEG = 0.0005          # about 50 m: keeps requests small; population sums barely change
CENSUS_2021_GHANA = 30_832_019  # Ghana 2021 Population and Housing Census, national total (for a sanity check)

LABELS = {
    "population_worldpop_2023": ("Population, WorldPop 2023", "people", "Modelled estimate", "D-09"),
    "buildings_065": ("Building footprints, confidence 0.65 or more", "buildings", "Modelled estimate", "D-11"),
    "buildings_075": ("Building footprints, confidence 0.75 or more", "buildings", "Modelled estimate", "D-11"),
    "area_km2": ("District area", "km²", "Observation", "D-01"),
}


def districts_by_region(conn):
    rows = conn.execute(text(f"""
        SELECT pcode, name, parent_name AS region,
               ST_Area(geom::geography) / 1e6 AS area_km2,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {SIMPLIFY_DEG}), 6) AS g
        FROM admin_boundaries ORDER BY parent_name, pcode
    """)).mappings().all()
    regions: dict[str, list] = {}
    for r in rows:
        regions.setdefault(r["region"], []).append(r)
    return regions


def sums_for(rows, wp, wp_proj):
    """Population and building counts for a batch of districts (one Earth Engine request per kind)."""
    fc = ee.FeatureCollection([ee.Feature(ee.Geometry(json.loads(r["g"]), None, False), {"pcode": r["pcode"]})
                               for r in rows])
    pop = wp.reduceRegions(collection=fc, reducer=ee.Reducer.sum(), crs=wp_proj, tileScale=4)
    pop = {f["properties"]["pcode"]: f["properties"].get("sum") or 0 for f in pop.getInfo()["features"]}

    buildings = ee.FeatureCollection(BUILDINGS).filterBounds(fc.geometry())

    def count(f):
        inside = buildings.filterBounds(f.geometry())
        return f.set({
            "b065": inside.filter(ee.Filter.gte("confidence", 0.65)).size(),
            "b075": inside.filter(ee.Filter.gte("confidence", 0.75)).size(),
        })
    counted = fc.map(count).getInfo()["features"]
    bld = {f["properties"]["pcode"]: (f["properties"]["b065"], f["properties"]["b075"]) for f in counted}
    return pop, bld


def main():
    load_dotenv()
    ee.Initialize(project=os.environ["GEE_PROJECT"])
    wp = ee.Image(ee.ImageCollection(WORLDPOP).filter(ee.Filter.eq("country", "GHA"))
                  .filter(ee.Filter.eq("year", 2023)).first()).select("population")
    wp_proj = wp.projection()

    engine = get_engine()
    with engine.connect() as conn:
        regions = districts_by_region(conn)
    total_districts = sum(len(v) for v in regions.values())
    print(f"{total_districts} districts in {len(regions)} regions\n")

    results = {}
    for region, rows in regions.items():
        start = time.perf_counter()
        # Building counts are the heavy part: send large regions in smaller batches
        for i in range(0, len(rows), 8):
            batch = rows[i:i + 8]
            for attempt in range(3):
                try:
                    pop, bld = sums_for(batch, wp, wp_proj)
                    break
                except ee.EEException as err:
                    if attempt == 2:
                        raise SystemExit(f"Earth Engine failed for {region}: {err}")
                    print(f"  retrying after: {err}", flush=True)
                    time.sleep(10)
            for r in batch:
                results[r["pcode"]] = {
                    "name": r["name"], "region": region, "area_km2": r["area_km2"],
                    "population_worldpop_2023": pop[r["pcode"]],
                    "buildings_065": bld[r["pcode"]][0], "buildings_075": bld[r["pcode"]][1],
                }
        people = sum(results[r["pcode"]]["population_worldpop_2023"] for r in rows)
        print(f"  {region:<16} {len(rows):>3} districts  {people:>12,.0f} people  "
              f"({time.perf_counter() - start:.0f} s)", flush=True)

    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS district_indicators (
                pcode TEXT NOT NULL, indicator TEXT NOT NULL, value DOUBLE PRECISION NOT NULL,
                label TEXT NOT NULL, unit TEXT NOT NULL, evidence TEXT NOT NULL, sources TEXT NOT NULL,
                computed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (pcode, indicator))
        """))
        conn.execute(text("DELETE FROM district_indicators WHERE indicator = ANY(:i)"), {"i": list(LABELS)})
        conn.execute(text("""
            INSERT INTO district_indicators (pcode, indicator, value, label, unit, evidence, sources, computed_at)
            VALUES (:pcode, :ind, :value, :label, :unit, :evidence, :sources, :at)
        """), [{"pcode": pc, "ind": k, "value": float(v[k]), "label": LABELS[k][0], "unit": LABELS[k][1],
                "evidence": LABELS[k][2], "sources": LABELS[k][3], "at": now}
               for pc, v in results.items() for k in LABELS])

    nat_pop = sum(v["population_worldpop_2023"] for v in results.values())
    nat_b75 = sum(v["buildings_075"] for v in results.values())
    print(f"\nGhana: {nat_pop:,.0f} people (WorldPop 2023), {nat_b75:,.0f} buildings (confidence 0.75)")
    print(f"2021 census: {CENSUS_2021_GHANA:,}  ->  WorldPop 2023 is {100 * (nat_pop / CENSUS_2021_GHANA - 1):+.1f}%"
          " (two years of growth at about 2% a year would be about +4%)")
    densest = sorted(results.items(), key=lambda kv: -kv[1]["population_worldpop_2023"] / kv[1]["area_km2"])[:5]
    print("\nMost densely populated districts:")
    for pc, v in densest:
        print(f"  {v['name']:<28} {v['region']:<14} {v['population_worldpop_2023'] / v['area_km2']:>8,.0f} per km²")


if __name__ == "__main__":
    main()
