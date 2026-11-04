"""Check that the generic screening reproduces the original flood screening exactly.

Compares, feature by feature, the statuses from screening_results with those from the original
asset_hazard_screening and settlement_hazard_screening tables, at several "near" distances.

Run from the project root, after run_screening.py:  python scripts/check_screening.py
"""
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.catalog import load_catalog  # noqa: E402
from app.screening import status_sql  # noqa: E402
from db import get_engine  # noqa: E402

HAZARD_ID = "flood_2023_observed"        # ID in the original tables
HAZARD_LAYER = "flood-2023-observed"     # ID in the catalogue
NEAR_DISTANCES = [100, 250, 500, 1000]

# The original rules, written out as they are in the API (main.py)
OLD_ASSETS = """
    SELECT a.asset_id::text AS feature_id,
           CASE WHEN t.category = 'water' THEN 'context'
                WHEN s.dist_flooded_m = 0 THEN 'in_primary'
                WHEN s.dist_ambiguous_m = 0 THEN 'in_secondary'
                WHEN LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near THEN 'near'
                ELSE 'not_flagged' END AS status
    FROM asset_hazard_screening s
    JOIN assets a USING (asset_id)
    JOIN asset_types t USING (asset_type)
    WHERE s.hazard_id = :hid
"""
OLD_SETTLEMENTS = """
    SELECT r.settlement_id::text AS feature_id,
           CASE WHEN r.flooded_m2 > 0 THEN 'in_primary'
                WHEN r.ambiguous_m2 > 0 THEN 'in_secondary'
                WHEN r.dist_m <= :near THEN 'near'
                ELSE 'not_flagged' END AS status
    FROM settlement_hazard_screening r
    WHERE r.hazard_id = :hid
"""


def new_sql(exposure):
    st = exposure.storage
    return f"""
        SELECT r.feature_id, {status_sql(exposure)} AS status
        FROM screening_results r
        JOIN "{st.table}" x ON x."{st.id_column}"::text = r.feature_id
        WHERE r.hazard_layer = :hz AND r.exposure_layer = :ex
    """


def main():
    cat = load_catalog()
    engine = get_engine()
    failures = 0
    with engine.connect() as conn:
        for exposure_id, old_sql in (("osm-assets", OLD_ASSETS), ("grid3-settlements", OLD_SETTLEMENTS)):
            exposure = cat.layers[exposure_id]
            print(f"\n{exposure_id} against {HAZARD_LAYER}")
            print(f"  {'near':>6}  {'status':<12} {'original':>9} {'generic':>9}")
            for near in NEAR_DISTANCES:
                old = dict(conn.execute(text(old_sql), {"hid": HAZARD_ID, "near": near}).fetchall())
                new = dict(conn.execute(text(new_sql(exposure)),
                                        {"hz": HAZARD_LAYER, "ex": exposure_id, "near": near}).fetchall())
                for status in ("in_primary", "in_secondary", "near", "not_flagged", "context"):
                    a = sum(1 for v in old.values() if v == status)
                    b = sum(1 for v in new.values() if v == status)
                    if a or b:
                        print(f"  {near:>5}m  {status:<12} {a:>9,} {b:>9,}{'' if a == b else '   <- differs'}")
                diff = [f for f in set(old) | set(new) if old.get(f) != new.get(f)]
                if diff:
                    failures += len(diff)
                    print(f"  {len(diff)} features differ at {near} m, e.g. IDs {', '.join(sorted(diff)[:5])}")
    print("\nAll statuses match the original screening." if not failures
          else f"\n{failures} differences found: send this output for review.")


if __name__ == "__main__":
    main()
