"""People and buildings in the pilot districts, and how many lay in observed 2023 flood water (Wave 1).

Reads the 5-band raster from download_people_rasters.py and the flood class raster from
s1_flood_extent.py, and writes one row per district and indicator to the district_indicators table.

How exposure is estimated: the 20 m flood raster is averaged onto the 100 m population grid, giving
the share of each cell covered by observed flooding (class 1) or ambiguous seasonal water (class 5).
People (or buildings) in flood water = sum over cells of (people in the cell x flooded share). This
assumes people are spread evenly within each 100 m cell. Two population models (WorldPop and
GHS-POP) and two building-confidence thresholds give ranges rather than single numbers.

A second, community-level estimate counts everyone living in GRID3 settlements whose footprint the
screening flagged (in observed flooding, in ambiguous water, or within NEAR_M). Radar cannot see water
among buildings, so the cell overlay is a lower bound; the community figure is closer to what
displacement reports count. Population inside each footprint is area-weighted on a 4x finer grid.

Run from the project root, after download_people_rasters.py and run_screening.py:
    python scripts/people_exposure.py
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.warp import Resampling, reproject
from sqlalchemy import text

from db import get_engine

PILOT_ID = "lower_volta"
PEOPLE = Path("data/processed/people/people_pilot.tif")
FLOOD = Path("data/processed/flood_2023/flood_2023_lower_volta_codes.tif")
FLOODED, AMBIGUOUS = 1, 5
NEAR_M = 250
SUPERSAMPLE = 4      # settlement footprints are rasterised on a grid 4 x 4 finer than the population grid
BUFFERS_M = (100, 250)  # "living near the water": within these distances of observed flooding

# Indicator definitions: id -> (label, unit, evidence, sources)
INDICATORS = {
    "population_worldpop_2023": ("Population, WorldPop 2023", "people", "Modelled estimate", "D-09"),
    "population_ghspop_2023": ("Population, GHS-POP 2023 (interpolated)", "people", "Modelled estimate", "D-10"),
    "buildings_065": ("Building footprints, confidence 0.65 or more", "buildings", "Modelled estimate", "D-11"),
    "buildings_075": ("Building footprints, confidence 0.75 or more", "buildings", "Modelled estimate", "D-11"),
}
EXPOSURE = {  # exposure indicator id -> (base indicator, flood class)
    f"{base}_in_{name}": (base, cls)
    for base in INDICATORS
    for name, cls in (("flood", FLOODED), ("ambiguous", AMBIGUOUS))
}


def class_share(flood_path, cls, grid_transform, grid_shape, grid_crs):
    """Share (0-1) of each population cell covered by one flood class."""
    with rasterio.open(flood_path) as src:
        codes = src.read(1)
        mask = (codes == cls).astype("float32")
        share = np.zeros(grid_shape, dtype="float32")
        reproject(mask, share, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=grid_transform, dst_crs=grid_crs, resampling=Resampling.average)
    return share


def near_share(flood_path, cls, radius_m, grid_transform, grid_shape, grid_crs):
    """Share (0-1) of each population cell lying within radius_m of one flood class (inside included).

    The class mask is grown by a disc of radius_m on the 20 m flood grid, then averaged onto the
    population grid. Pixel sizes in metres are taken at the raster's middle latitude.
    """
    with rasterio.open(flood_path) as src:
        mask = src.read(1) == cls
        res_x, res_y = src.transform.a, -src.transform.e
        lat = (src.bounds.top + src.bounds.bottom) / 2
        crs, transform = src.crs, src.transform
    mx = res_x * 111_320 * np.cos(np.radians(lat))
    my = res_y * 110_574
    rx, ry = int(radius_m // mx), int(radius_m // my)
    grown = mask.copy()
    h, w = mask.shape
    for dy in range(-ry, ry + 1):
        for dx in range(-rx, rx + 1):
            if (dx * mx) ** 2 + (dy * my) ** 2 > radius_m ** 2 or (dx == 0 and dy == 0):
                continue
            src_rows = slice(max(0, -dy), h - max(0, dy))
            dst_rows = slice(max(0, dy), h - max(0, -dy))
            src_cols = slice(max(0, -dx), w - max(0, dx))
            dst_cols = slice(max(0, dx), w - max(0, -dx))
            grown[dst_rows, dst_cols] |= mask[src_rows, src_cols]
    share = np.zeros(grid_shape, dtype="float32")
    reproject(grown.astype("float32"), share, src_transform=transform, src_crs=crs,
              dst_transform=grid_transform, dst_crs=grid_crs, resampling=Resampling.average)
    return share


NEAR = {  # near-water indicator id -> (base band, radius in metres)
    f"{base}_within_{r}m": (base, r)
    for base in ("population_worldpop_2023", "population_ghspop_2023", "buildings_075")
    for r in BUFFERS_M
}


def compute(bands, shares, district_masks):
    """Sum every band, and every band x flood share, per district. Pure function, for testing."""
    rows = {}
    for pcode, inside in district_masks.items():
        values = {k: float(v[inside].sum()) for k, v in bands.items()}
        for exp_id, (base, cls) in EXPOSURE.items():
            values[exp_id] = float((bands[base] * shares[cls])[inside].sum())
        rows[pcode] = values
    return rows


COMMUNITY = {  # community indicator id -> (base band, screening status)
    f"{base}_in_settlements_{status}": (base, status)
    for base in ("population_worldpop_2023", "buildings_075")
    for status in ("flood", "ambiguous", "near")
}


def settlement_sums(band, ids_fine, n):
    """Area-weighted total of a band inside each settlement (index 1..n); ids_fine is the finer id grid."""
    total = np.zeros(n + 1)
    share = band / SUPERSAMPLE ** 2
    for dy in range(SUPERSAMPLE):
        for dx in range(SUPERSAMPLE):
            ids = ids_fine[dy::SUPERSAMPLE, dx::SUPERSAMPLE]
            total += np.bincount(ids.ravel(), weights=share[: ids.shape[0], : ids.shape[1]].ravel(),
                                 minlength=n + 1)
    return total


def main():
    for p in (PEOPLE, FLOOD):
        if not p.exists():
            raise SystemExit(f"Missing {p}: run the script that makes it first.")

    with rasterio.open(PEOPLE) as src:
        raw = {name: src.read(i + 1).astype("float64") for i, name in enumerate(src.descriptions)}
        transform, shape, crs = src.transform, (src.height, src.width), src.crs
    for v in raw.values():
        v[v < 0] = 0  # nodata -> 0
    bands = {
        "population_worldpop_2023": raw["population_worldpop_2023"],
        # GHS-POP has 2020 estimates and 2025 projections: interpolate to the flood year
        "population_ghspop_2023": 0.4 * raw["population_ghspop_2020"] + 0.6 * raw["population_ghspop_2025"],
        "buildings_065": raw["buildings_065"],
        "buildings_075": raw["buildings_075"],
    }
    shares = {cls: class_share(FLOOD, cls, transform, shape, crs) for cls in (FLOODED, AMBIGUOUS)}

    engine = get_engine()
    with engine.connect() as conn:
        districts = conn.execute(text("""
            SELECT b.pcode, b.name, ST_AsGeoJSON(b.geom) AS g
            FROM admin_boundaries b JOIN pilot_districts p USING (pcode)
            WHERE p.pilot_id = :pid ORDER BY b.pcode
        """), {"pid": PILOT_ID}).mappings().all()
    names = {d["pcode"]: d["name"] for d in districts}
    # A cell belongs to the district that contains its centre
    masks = {d["pcode"]: rasterize([(json.loads(d["g"]), 1)], out_shape=shape, transform=transform,
                                   fill=0, dtype="uint8").astype(bool) for d in districts}
    rows = compute(bands, shares, masks)

    # Living near the water: people and buildings within 100 m and 250 m of observed flooding
    for r in BUFFERS_M:
        print(f"Measuring cells within {r} m of observed flooding ...", flush=True)
        share = near_share(FLOOD, FLOODED, r, transform, shape, crs)
        for pc, inside in masks.items():
            for k, (base, radius) in NEAR.items():
                if radius == r:
                    rows[pc][k] = float((bands[base] * share)[inside].sum())

    # Community level: people and buildings inside settlements flagged by the flood screening
    with engine.connect() as conn:
        settlements = conn.execute(text("""
            SELECT s.adm2_pcode AS pcode, ST_AsGeoJSON(s.geom) AS g,
                   CASE WHEN r.overlap_primary > 0 THEN 'flood'
                        WHEN r.overlap_secondary > 0 THEN 'ambiguous'
                        WHEN LEAST(r.dist_primary_m, r.dist_secondary_m) <= :near THEN 'near'
                   END AS status
            FROM screening_results r
            JOIN settlements s ON s.settlement_id::text = r.feature_id
            WHERE r.hazard_layer = 'flood-2023-observed' AND r.exposure_layer = 'grid3-settlements'
        """), {"near": NEAR_M}).mappings().all()
    if not settlements:
        raise SystemExit("No settlement screening found: run python scripts/run_screening.py first.")
    fine_transform = transform * transform.scale(1 / SUPERSAMPLE)
    ids_fine = rasterize(((json.loads(st["g"]), i + 1) for i, st in enumerate(settlements)),
                         out_shape=(shape[0] * SUPERSAMPLE, shape[1] * SUPERSAMPLE),
                         transform=fine_transform, fill=0, dtype="int32")
    per_settlement = {b: settlement_sums(bands[b], ids_fine, len(settlements))
                      for b in ("population_worldpop_2023", "buildings_075")}
    for pc in rows:
        for k in COMMUNITY:
            rows[pc][k] = 0.0
    for i, st in enumerate(settlements):
        if st["status"] and st["pcode"] in rows:
            for k, (base, status) in COMMUNITY.items():
                if status == st["status"]:
                    rows[st["pcode"]][k] += per_settlement[base][i + 1]

    labels = {**{k: v for k, v in INDICATORS.items()},
              **{k: (f"{INDICATORS[b][0]}, in {'observed flooding' if c == FLOODED else 'ambiguous seasonal water'}",
                     INDICATORS[b][1], "Derived", f"{INDICATORS[b][3]}, D-08")
                 for k, (b, c) in EXPOSURE.items()},
              **{k: (f"{INDICATORS[b][0]}, in settlements "
                     + {"flood": "touching observed flooding", "ambiguous": "touching ambiguous seasonal water",
                        "near": f"within {NEAR_M} m of observed water"}[st],
                     INDICATORS[b][1], "Derived", f"{INDICATORS[b][3]}, D-04, D-08")
                 for k, (b, st) in COMMUNITY.items()},
              **{k: (f"{INDICATORS[b][0]}, within {r} m of observed flooding (inside included)",
                     INDICATORS[b][1], "Derived", f"{INDICATORS[b][3]}, D-08")
                 for k, (b, r) in NEAR.items()}}
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS district_indicators (
                pcode        TEXT NOT NULL,
                indicator    TEXT NOT NULL,
                value        DOUBLE PRECISION NOT NULL,
                label        TEXT NOT NULL,
                unit         TEXT NOT NULL,
                evidence     TEXT NOT NULL,
                sources      TEXT NOT NULL,
                computed_at  TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (pcode, indicator)
            )
        """))
        conn.execute(text("DELETE FROM district_indicators WHERE pcode = ANY(:p) AND indicator = ANY(:i)"),
                     {"p": list(rows), "i": list(labels)})
        conn.execute(text("""
            INSERT INTO district_indicators (pcode, indicator, value, label, unit, evidence, sources, computed_at)
            VALUES (:pcode, :ind, :value, :label, :unit, :evidence, :sources, :at)
        """), [{"pcode": pc, "ind": k, "value": v, "label": labels[k][0], "unit": labels[k][1],
                "evidence": labels[k][2], "sources": labels[k][3], "at": now}
               for pc, vals in rows.items() for k, v in vals.items()])

    def fmt(x):
        return f"{x:>10,.0f}"
    print(f"\nPeople and buildings, {PILOT_ID} pilot (rounded; modelled estimates)\n")
    print(f"  {'district':<16}{'WorldPop':>10}{'GHS-POP':>10}{'bldg .65':>10}{'bldg .75':>10}"
          f"  | in observed flooding: {'WorldPop':>9}{'GHS-POP':>9}{'bldg .65':>9}{'bldg .75':>9}")
    totals = {}
    for pc in sorted(rows):
        r = rows[pc]
        for k, v in r.items():
            totals[k] = totals.get(k, 0) + v
        print(f"  {names[pc][:15]:<16}{fmt(r['population_worldpop_2023'])}{fmt(r['population_ghspop_2023'])}"
              f"{fmt(r['buildings_065'])}{fmt(r['buildings_075'])}  | {'':>22}"
              f"{r['population_worldpop_2023_in_flood']:>9,.0f}{r['population_ghspop_2023_in_flood']:>9,.0f}"
              f"{r['buildings_065_in_flood']:>9,.0f}{r['buildings_075_in_flood']:>9,.0f}")
    t = totals
    print(f"  {'TOTAL':<16}{fmt(t['population_worldpop_2023'])}{fmt(t['population_ghspop_2023'])}"
          f"{fmt(t['buildings_065'])}{fmt(t['buildings_075'])}  | {'':>22}"
          f"{t['population_worldpop_2023_in_flood']:>9,.0f}{t['population_ghspop_2023_in_flood']:>9,.0f}"
          f"{t['buildings_065_in_flood']:>9,.0f}{t['buildings_075_in_flood']:>9,.0f}")

    print(f"\nNear the water and community level (WorldPop; screening near = {NEAR_M} m):")
    print(f"  {'district':<16}{'within 100 m':>13}{'within 250 m':>13}{'settl. touching':>16}{'settl. near':>12}")
    for pc in sorted(rows):
        r = rows[pc]
        print(f"  {names[pc][:15]:<16}{r['population_worldpop_2023_within_100m']:>13,.0f}"
              f"{r['population_worldpop_2023_within_250m']:>13,.0f}"
              f"{r['population_worldpop_2023_in_settlements_flood']:>16,.0f}"
              f"{r['population_worldpop_2023_in_settlements_near']:>12,.0f}")
    print(f"  {'TOTAL':<16}{t['population_worldpop_2023_within_100m']:>13,.0f}"
          f"{t['population_worldpop_2023_within_250m']:>13,.0f}"
          f"{t['population_worldpop_2023_in_settlements_flood']:>16,.0f}"
          f"{t['population_worldpop_2023_in_settlements_near']:>12,.0f}")

    in_flood = t["population_worldpop_2023_in_settlements_flood"]
    with_ambiguous = in_flood + t["population_worldpop_2023_in_settlements_ambiguous"]
    with_near = with_ambiguous + t["population_worldpop_2023_in_settlements_near"]
    print("\nHeadline (WorldPop, which tracks the 2021 census closely; GHS-POP shown as a second model):")
    print(f"  Lower bound, people in cells where radar saw flooding: {t['population_worldpop_2023_in_flood']:,.0f}"
          f"  (GHS-POP {t['population_ghspop_2023_in_flood']:,.0f})")
    print(f"  People within 100 m of observed flooding:              "
          f"{t['population_worldpop_2023_within_100m']:,.0f}  (GHS-POP {t['population_ghspop_2023_within_100m']:,.0f})")
    print(f"  People within 250 m of observed flooding:              "
          f"{t['population_worldpop_2023_within_250m']:,.0f}  (GHS-POP {t['population_ghspop_2023_within_250m']:,.0f})")
    print(f"  Ceiling, everyone in settlements touching flooding:    {in_flood:,.0f}")
    print(f"  ... adding settlements in ambiguous water:             {with_ambiguous:,.0f}")
    print(f"  ... and settlements within {NEAR_M} m:                     {with_near:,.0f}")
    print(f"  Buildings within 100 m / 250 m of observed flooding: "
          f"{t['buildings_075_within_100m']:,.0f} / {t['buildings_075_within_250m']:,.0f} (confidence 0.75)")
    print(f"  Buildings in cells where radar saw flooding: {t['buildings_075_in_flood']:,.0f} to "
          f"{t['buildings_065_in_flood']:,.0f} (confidence 0.75 to 0.65)")
    print("\nModelled estimates of where people live, overlaid on water seen by radar on two dates: not a count of\n"
          "people displaced or buildings damaged. Radar misses water among buildings, so these are likely low.")


if __name__ == "__main__":
    main()
