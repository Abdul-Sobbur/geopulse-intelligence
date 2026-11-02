"""Preliminary flood screening of GRID3 settlement footprints against an observed flood layer.

For each settlement: area inside attributable flood, area inside ambiguous water,
and distance to the nearest observed new water (either class).

Run from the project root:  python scripts/screen_settlement_flood.py
Re-run whenever settlements or the hazard layer are reloaded.
"""
from sqlalchemy import text

from db import get_engine

HAZARD_ID = "flood_2023_observed"
NEAR_M = 250

SCREEN_SQL = """
INSERT INTO settlement_hazard_screening
    (hazard_id, settlement_id, flooded_m2, ambiguous_m2, dist_m)
SELECT
    :hid,
    s.settlement_id,
    COALESCE((SELECT sum(ST_Area(ST_Intersection(s.geom, f.geom)::geography))
              FROM hazard_features f
              WHERE f.hazard_id = :hid AND f.class_code = 1 AND ST_Intersects(s.geom, f.geom)), 0),
    COALESCE((SELECT sum(ST_Area(ST_Intersection(s.geom, f.geom)::geography))
              FROM hazard_features f
              WHERE f.hazard_id = :hid AND f.class_code = 5 AND ST_Intersects(s.geom, f.geom)), 0),
    (SELECT min(ST_Distance(s.geom::geography, k.geom::geography))
       FROM (SELECT f.geom FROM hazard_features f
             WHERE f.hazard_id = :hid AND f.class_code IN (1, 5)
             ORDER BY f.geom <-> s.geom LIMIT 5) k)
FROM settlements s
"""

BY_TYPE_SQL = """
SELECT s.settlement_type,
       count(*) AS total,
       count(*) FILTER (WHERE r.flooded_m2 > 0) AS touch_flood,
       count(*) FILTER (WHERE r.flooded_m2 = 0 AND r.ambiguous_m2 > 0) AS touch_ambig,
       count(*) FILTER (WHERE r.flooded_m2 = 0 AND r.ambiguous_m2 = 0 AND r.dist_m <= :near) AS near,
       COALESCE(sum(s.building_count) FILTER (WHERE r.flooded_m2 > 0), 0) AS bldg_touch_flood,
       round((sum(r.flooded_m2) / 1e6)::numeric, 3) AS flooded_km2
FROM settlements s
JOIN settlement_hazard_screening r USING (settlement_id)
WHERE r.hazard_id = :hid
GROUP BY s.settlement_type
ORDER BY total DESC
"""

BY_DISTRICT_SQL = """
SELECT s.adm2_pcode, b.name,
       count(*) FILTER (WHERE r.flooded_m2 > 0) AS touch_flood,
       count(*) FILTER (WHERE r.flooded_m2 = 0 AND r.ambiguous_m2 > 0) AS touch_ambig,
       count(*) FILTER (WHERE r.flooded_m2 = 0 AND r.ambiguous_m2 = 0 AND r.dist_m <= :near) AS near,
       COALESCE(sum(s.building_count) FILTER (WHERE r.flooded_m2 > 0), 0) AS bldg_touch_flood
FROM settlements s
JOIN settlement_hazard_screening r USING (settlement_id)
JOIN admin_boundaries b ON b.pcode = s.adm2_pcode
WHERE r.hazard_id = :hid
GROUP BY s.adm2_pcode, b.name
ORDER BY s.adm2_pcode
"""

LOW_CONFIDENCE_SQL = """
SELECT count(*) AS n
FROM settlements s
JOIN settlement_hazard_screening r USING (settlement_id)
WHERE r.hazard_id = :hid AND r.flooded_m2 > 0 AND s.probability < 0.5
"""


def main():
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS settlement_hazard_screening (
                hazard_id     TEXT NOT NULL REFERENCES hazard_layers (hazard_id) ON DELETE CASCADE,
                settlement_id BIGINT NOT NULL,
                flooded_m2    DOUBLE PRECISION,
                ambiguous_m2  DOUBLE PRECISION,
                dist_m        DOUBLE PRECISION,
                screened_at   TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (hazard_id, settlement_id)
            )
        """))
        conn.execute(text("DELETE FROM settlement_hazard_screening WHERE hazard_id = :hid"), {"hid": HAZARD_ID})
        print("Screening settlements (may take a minute or two) ...", flush=True)
        conn.execute(text(SCREEN_SQL), {"hid": HAZARD_ID})

        params = {"hid": HAZARD_ID, "near": NEAR_M}
        by_type = conn.execute(text(BY_TYPE_SQL), params).fetchall()
        by_district = conn.execute(text(BY_DISTRICT_SQL), params).fetchall()
        low_conf = conn.execute(text(LOW_CONFIDENCE_SQL), {"hid": HAZARD_ID}).scalar()

    print(f"\nSettlement flood screening — hazard '{HAZARD_ID}', near = within {NEAR_M} m\n")
    print(f"  {'type':<24} {'total':>6} {'touch flood':>12} {'touch ambig.':>13} {'near':>6} "
          f"{'bldgs in touching':>18} {'flooded km2':>12}")
    for r in by_type:
        print(f"  {r.settlement_type:<24} {r.total:>6,} {r.touch_flood:>12,} {r.touch_ambig:>13,} "
              f"{r.near:>6,} {int(r.bldg_touch_flood):>18,} {r.flooded_km2:>12}")

    print(f"\n  {'pcode':<7} {'district':<15} {'touch flood':>12} {'touch ambig.':>13} {'near':>6} "
          f"{'bldgs in touching':>18}")
    for r in by_district:
        print(f"  {r.adm2_pcode:<7} {r.name:<15} {r.touch_flood:>12,} {r.touch_ambig:>13,} "
              f"{r.near:>6,} {int(r.bldg_touch_flood):>18,}")

    print(f"\nSettlements touching flood with GRID3 probability < 0.5: {low_conf}")
    print("\n'Buildings in touching settlements' counts every building in a settlement that "
          "intersects observed flooding; it is NOT a count of flooded buildings.")
    print("Preliminary screening only. Radar under-detects water among buildings.")


if __name__ == "__main__":
    main()
