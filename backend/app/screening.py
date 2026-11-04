"""Generic exposure screening: any hazard layer against any exposure layer in the catalogue.

For every exposure feature it stores measurements, not verdicts:
  - distance to the nearest primary hazard feature (e.g. attributable flooding)
  - distance to the nearest secondary hazard feature (e.g. ambiguous seasonal water)
  - overlap with each: length inside (lines, metres) or area inside (polygons, square metres)

The status (in primary, in secondary, near, not flagged, context) is decided at query time, so the
"near" distance can change without re-running anything. Table and column names come from the
catalogue, where they are checked against a strict identifier pattern before being quoted in here.
"""
from sqlalchemy import text

from .catalog import Layer

RESULTS_DDL = """
CREATE TABLE IF NOT EXISTS screening_runs (
    run_id            BIGSERIAL PRIMARY KEY,
    hazard_layer      TEXT NOT NULL,
    exposure_layer    TEXT NOT NULL,
    hazard_version    TEXT NOT NULL,
    exposure_version  TEXT NOT NULL,
    features          INTEGER,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS screening_results (
    hazard_layer       TEXT NOT NULL,
    exposure_layer     TEXT NOT NULL,
    feature_id         TEXT NOT NULL,
    dist_primary_m     DOUBLE PRECISION,
    dist_secondary_m   DOUBLE PRECISION,
    overlap_primary    DOUBLE PRECISION,
    overlap_secondary  DOUBLE PRECISION,
    overlap_unit       TEXT CHECK (overlap_unit IN ('m', 'm2')),
    run_id             BIGINT REFERENCES screening_runs (run_id) ON DELETE CASCADE,
    PRIMARY KEY (hazard_layer, exposure_layer, feature_id)
);
"""

STATUSES = ("in_primary", "in_secondary", "near", "not_flagged", "context")


def q(identifier: str) -> str:
    """Quote an identifier that the catalogue has already checked (letters, digits, underscore)."""
    return '"' + identifier + '"'


def screen_sql(hazard: Layer, exposure: Layer) -> tuple[str, dict]:
    """The INSERT that measures every exposure feature against one hazard layer."""
    h, e = hazard.storage, exposure.storage
    hg, eg = q(h.geom_column), q(e.geom_column)
    params = {
        "hz": hazard.id, "ex": exposure.id,
        "primary": [str(v) for v in hazard.class_values("primary")],
        "secondary": [str(v) for v in hazard.class_values("secondary")],
    }
    hazard_rows = f"{q(h.class_column)}::text = ANY(:{{level}})"
    if h.filter:
        hazard_rows += f" AND {q(h.filter.column)} = :hfilter"
        params["hfilter"] = h.filter.value

    def nearest(level: str) -> str:
        # Nearest 5 candidates by bounding box (index-assisted), then the exact geodesic distance
        return (f"(SELECT min(ST_Distance(x.{eg}::geography, k.g::geography)) FROM "
                f"(SELECT hz.{hg} AS g FROM {q(h.table)} hz WHERE {hazard_rows.format(level=level)} "
                f"ORDER BY hz.{hg} <-> x.{eg} LIMIT 5) k)")

    def overlap(level: str) -> str:
        inside = (f"FROM {q(h.table)} hz WHERE {hazard_rows.format(level=level)} "
                  f"AND ST_Intersects(x.{eg}, hz.{hg})")
        return (f"CASE GeometryType(x.{eg}) "
                f"WHEN 'LINESTRING' THEN COALESCE((SELECT sum(ST_Length(ST_Intersection(x.{eg}, hz.{hg})::geography)) {inside}), 0) "
                f"WHEN 'MULTILINESTRING' THEN COALESCE((SELECT sum(ST_Length(ST_Intersection(x.{eg}, hz.{hg})::geography)) {inside}), 0) "
                f"WHEN 'POLYGON' THEN COALESCE((SELECT sum(ST_Area(ST_Intersection(x.{eg}, hz.{hg})::geography)) {inside}), 0) "
                f"WHEN 'MULTIPOLYGON' THEN COALESCE((SELECT sum(ST_Area(ST_Intersection(x.{eg}, hz.{hg})::geography)) {inside}), 0) "
                f"END")

    has_secondary = bool(params["secondary"])
    sql = f"""
        INSERT INTO screening_results
            (hazard_layer, exposure_layer, feature_id, dist_primary_m, dist_secondary_m,
             overlap_primary, overlap_secondary, overlap_unit, run_id)
        SELECT :hz, :ex, x.{q(e.id_column)}::text,
               {nearest('primary')},
               {nearest('secondary') if has_secondary else 'NULL'},
               {overlap('primary')},
               {overlap('secondary') if has_secondary else 'NULL'},
               CASE WHEN GeometryType(x.{eg}) IN ('LINESTRING', 'MULTILINESTRING') THEN 'm'
                    WHEN GeometryType(x.{eg}) IN ('POLYGON', 'MULTIPOLYGON') THEN 'm2' END,
               :run_id
        FROM {q(e.table)} x
    """
    if e.filter:
        sql += f" WHERE x.{q(e.filter.column)} = :efilter"
        params["efilter"] = e.filter.value
    return sql, params


def class_sql(exposure: Layer, feature: str = "x") -> str | None:
    """SQL expression for a feature's class value, from its own table or a lookup table."""
    st = exposure.storage
    if st.class_column:
        return f"{feature}.{q(st.class_column)}::text"
    if st.class_lookup:
        lk = st.class_lookup
        return (f"(SELECT lk.{q(lk.value_column)}::text FROM {q(lk.table)} lk "
                f"WHERE lk.{q(lk.key_column)} = {feature}.{q(lk.key_column)})")
    return None


def status_sql(exposure: Layer, alias: str = "r", feature: str = "x") -> str:
    """SQL expression for a feature's status. Polygons count as 'in' only if some area is inside;
    points and lines count as 'in' when they touch the hazard. Needs the :near parameter."""
    context = ""
    unscreened = [str(c.value) for c in exposure.classes if not c.screened]
    if unscreened:
        values = ", ".join("'" + v.replace("'", "''") + "'" for v in unscreened)
        context = f"WHEN {class_sql(exposure, feature)} IN ({values}) THEN 'context' "
    inside = (f"CASE WHEN {alias}.overlap_unit = 'm2' THEN {alias}.overlap_{{lvl}} > 0 "
              f"ELSE {alias}.dist_{{lvl}}_m = 0 END")
    return (f"CASE {context}"
            f"WHEN {inside.format(lvl='primary')} THEN 'in_primary' "
            f"WHEN {inside.format(lvl='secondary')} THEN 'in_secondary' "
            f"WHEN LEAST({alias}.dist_primary_m, {alias}.dist_secondary_m) <= :near THEN 'near' "
            f"ELSE 'not_flagged' END")


def run(conn, hazard: Layer, exposure: Layer) -> int:
    """Replace the stored results for one hazard and exposure pair. Returns the features screened."""
    for statement in RESULTS_DDL.split(";"):
        if statement.strip():
            conn.execute(text(statement))
    conn.execute(text("DELETE FROM screening_results WHERE hazard_layer = :hz AND exposure_layer = :ex"),
                 {"hz": hazard.id, "ex": exposure.id})
    run_id = conn.execute(text("""
        INSERT INTO screening_runs (hazard_layer, exposure_layer, hazard_version, exposure_version)
        VALUES (:hz, :ex, :hv, :ev) RETURNING run_id
    """), {"hz": hazard.id, "ex": exposure.id, "hv": hazard.version, "ev": exposure.version}).scalar()
    sql, params = screen_sql(hazard, exposure)
    count = conn.execute(text(sql), {**params, "run_id": run_id}).rowcount
    conn.execute(text("UPDATE screening_runs SET features = :n, finished_at = now() WHERE run_id = :id"),
                 {"n": count, "id": run_id})
    return count
