"""Preliminary flood exposure screening of assets against an observed flood hazard layer.

For every asset, records the distance (metres) to the nearest attributable-flood polygon and to the
nearest ambiguous-water polygon, and for line assets the length lying inside attributable flood.

Run from the project root:  python scripts/screen_flood_exposure.py
Re-run it whenever assets or the hazard layer are reloaded (asset IDs change on reload).
"""
from sqlalchemy import text

from db import get_engine

HAZARD_ID = "flood_2023_observed"
NEAR_M = 250   # "near" distance for the summary; distances are stored, so this can change later

SCREEN_SQL = """
INSERT INTO asset_hazard_screening
    (hazard_id, asset_id, dist_flooded_m, dist_ambiguous_m, flooded_length_m)
SELECT
    :hid,
    a.asset_id,
    (SELECT min(ST_Distance(a.geom::geography, k.geom::geography))
       FROM (SELECT f.geom FROM hazard_features f
             WHERE f.hazard_id = :hid AND f.class_code = 1
             ORDER BY f.geom <-> a.geom LIMIT 5) k),
    (SELECT min(ST_Distance(a.geom::geography, k.geom::geography))
       FROM (SELECT f.geom FROM hazard_features f
             WHERE f.hazard_id = :hid AND f.class_code = 5
             ORDER BY f.geom <-> a.geom LIMIT 5) k),
    CASE WHEN GeometryType(a.geom) IN ('LINESTRING', 'MULTILINESTRING') THEN
        COALESCE((SELECT sum(ST_Length(ST_Intersection(a.geom, f.geom)::geography))
                  FROM hazard_features f
                  WHERE f.hazard_id = :hid AND f.class_code = 1
                    AND ST_Intersects(a.geom, f.geom)), 0)
    END
FROM assets a
"""

SUMMARY_SQL = """
SELECT a.asset_type,
       count(*) AS total,
       count(*) FILTER (WHERE s.dist_flooded_m = 0) AS in_flood,
       count(*) FILTER (WHERE s.dist_flooded_m > 0 AND s.dist_ambiguous_m = 0) AS in_ambiguous,
       count(*) FILTER (WHERE s.dist_flooded_m > 0 AND s.dist_ambiguous_m > 0
                          AND LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near) AS near,
       round((sum(s.flooded_length_m) / 1000)::numeric, 2) AS flooded_km
FROM assets a
JOIN asset_hazard_screening s USING (asset_id)
WHERE s.hazard_id = :hid
GROUP BY a.asset_type
ORDER BY a.asset_type
"""

NAMED_SQL = """
SELECT a.asset_type, a.name,
       round(LEAST(s.dist_flooded_m, s.dist_ambiguous_m)::numeric) AS dist_m,
       CASE WHEN s.dist_flooded_m = 0 THEN 'in flood'
            WHEN s.dist_ambiguous_m = 0 THEN 'in ambiguous'
            ELSE 'near' END AS status
FROM assets a
JOIN asset_hazard_screening s USING (asset_id)
WHERE s.hazard_id = :hid
  AND a.name IS NOT NULL
  AND a.asset_type IN ('place', 'bridge', 'education', 'health', 'power_substation', 'power_plant')
  AND LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near
ORDER BY dist_m, a.asset_type, a.name
LIMIT 30
"""


def main():
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS asset_hazard_screening (
                hazard_id        TEXT NOT NULL REFERENCES hazard_layers (hazard_id) ON DELETE CASCADE,
                asset_id         BIGINT NOT NULL,
                dist_flooded_m   DOUBLE PRECISION,
                dist_ambiguous_m DOUBLE PRECISION,
                flooded_length_m DOUBLE PRECISION,
                screened_at      TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (hazard_id, asset_id)
            )
        """))
        conn.execute(text("DELETE FROM asset_hazard_screening WHERE hazard_id = :hid"), {"hid": HAZARD_ID})
        print("Screening assets (may take a minute) ...", flush=True)
        conn.execute(text(SCREEN_SQL), {"hid": HAZARD_ID})

        summary = conn.execute(text(SUMMARY_SQL), {"hid": HAZARD_ID, "near": NEAR_M}).fetchall()
        named = conn.execute(text(NAMED_SQL), {"hid": HAZARD_ID, "near": NEAR_M}).fetchall()

    print(f"\nFlood exposure screening — hazard '{HAZARD_ID}', near = within {NEAR_M} m\n")
    print(f"  {'asset_type':<17} {'total':>6} {'in flood':>9} {'in ambig.':>10} {'near':>6} {'flooded km':>11}")
    for r in summary:
        km = "-" if r.flooded_km is None else r.flooded_km
        print(f"  {r.asset_type:<17} {r.total:>6} {r.in_flood:>9} {r.in_ambiguous:>10} {r.near:>6} {km:>11}")

    print(f"\nNamed places, bridges and facilities in or within {NEAR_M} m of observed new water:")
    if not named:
        print("  (none)")
    for r in named:
        print(f"  {r.status:<13} {r.dist_m:>5} m  {r.asset_type:<17} {r.name}")

    print("\nPreliminary screening only: proximity to observed water is not a measure of damage, "
          "and assets not flagged are not confirmed safe.")


if __name__ == "__main__":
    main()