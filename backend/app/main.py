"""GeoPulse Intelligence API.

Run from the backend folder:  uvicorn app.main:app --reload
Interactive docs:             http://127.0.0.1:8000/docs
"""
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .db import engine

app = FastAPI(
    title="GeoPulse Intelligence API",
    version="0.2.0",
    description=(
        "Spatial decision-support API. Pilot area: Lower Volta corridor, Ghana. "
        "All outputs are preliminary screening information, not engineering "
        "certification or regulatory advice."
    ),
)

# Allow our local frontend (Vite dev server) to call the API from the browser
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- system

@app.get("/health", tags=["system"])
def health():
    """Check that the API is running and can reach PostGIS."""
    try:
        with engine.connect() as conn:
            postgis = conn.execute(text("SELECT postgis_lib_version()")).scalar()
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ok", "database": "connected", "postgis": postgis}


# ---------------------------------------------------------------- assets

@app.get("/asset-types", tags=["assets"])
def asset_types():
    """List asset types with category, display label, count and coverage warning."""
    sql = text("""
        SELECT t.asset_type, t.category, t.label, t.coverage_warning,
               count(a.asset_id) AS count
        FROM asset_types t
        LEFT JOIN assets a USING (asset_type)
        GROUP BY t.asset_type, t.category, t.label, t.coverage_warning
        ORDER BY t.category, t.asset_type
    """)
    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(sql).mappings()]


@app.get("/assets", tags=["assets"])
def assets(
    asset_type: str | None = Query(None, description="e.g. road, bridge, health, power_line"),
    pcode: str | None = Query(None, max_length=20, description="District P-code, e.g. GH1416"),
    limit: int = Query(1000, ge=1, le=5000, description="Maximum features to return"),
):
    """Return assets as a GeoJSON FeatureCollection, optionally filtered."""
    # Build the WHERE clause from fixed text only; user values are passed as
    # bound parameters (never pasted into SQL), which prevents SQL injection.
    conditions, params = [], {"limit": limit}
    if asset_type:
        conditions.append("a.asset_type = :asset_type")
        params["asset_type"] = asset_type
    if pcode:
        conditions.append("a.adm2_pcode = :pcode")
        params["pcode"] = pcode
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = text(f"""
        WITH sel AS (
            SELECT a.asset_id, a.asset_type, t.category, t.label, a.subtype, a.name,
                   a.adm2_pcode, a.source_id, a.source_ref, a.source_date, a.geom
            FROM assets a
            JOIN asset_types t USING (asset_type)
            {where}
            ORDER BY a.asset_id
            LIMIT :limit
        )
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'numberReturned', count(*),
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', asset_id,
                'geometry', ST_AsGeoJSON(geom, 6)::json,
                'properties', json_build_object(
                    'asset_id', asset_id, 'asset_type', asset_type,
                    'category', category, 'label', label, 'subtype', subtype,
                    'name', name, 'adm2_pcode', adm2_pcode,
                    'source_id', source_id, 'source_ref', source_ref,
                    'source_date', source_date
                )
            )), '[]'::json)
        )
        FROM sel
    """)
    with engine.connect() as conn:
        return conn.execute(sql, params).scalar()


# ---------------------------------------------------------------- geography

@app.get("/pilots/{pilot_id}/districts", tags=["geography"])
def pilot_districts(pilot_id: str):
    """Return a pilot's districts as GeoJSON, with a bounding box for zooming."""
    sql = text("""
        WITH sel AS (
            SELECT b.pcode, b.name, b.parent_name, b.geom
            FROM admin_boundaries b
            JOIN pilot_districts p USING (pcode)
            WHERE p.pilot_id = :pid
        )
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'bbox', json_build_array(
                ST_XMin(ST_Extent(geom)), ST_YMin(ST_Extent(geom)),
                ST_XMax(ST_Extent(geom)), ST_YMax(ST_Extent(geom))
            ),
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geom, 5)::json,
                'properties', json_build_object(
                    'pcode', pcode, 'name', name, 'region', parent_name
                )
            )), '[]'::json)
        )
        FROM sel
    """)
    with engine.connect() as conn:
        result = conn.execute(sql, {"pid": pilot_id}).scalar()
    if not result["features"]:
        raise HTTPException(status_code=404, detail=f"Unknown pilot: {pilot_id}")
    return result


# ---------------------------------------------------------------- hazards

def _require_hazard(conn, hazard_id: str):
    exists = conn.execute(
        text("SELECT 1 FROM hazard_layers WHERE hazard_id = :hid"), {"hid": hazard_id}
    ).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Unknown hazard layer: {hazard_id}")


@app.get("/hazards", tags=["hazards"])
def hazards():
    """List hazard layers with their source, dates, method, parameters and limitations."""
    sql = text("""
        SELECT hazard_id, title, hazard_type, source_id, observed_dates, method,
               metadata -> 'pre_event_window' AS pre_event_window,
               metadata -> 'parameters'       AS parameters,
               metadata -> 'limitations'      AS limitations,
               loaded_at
        FROM hazard_layers
        ORDER BY hazard_id
    """)
    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(sql).mappings()]


@app.get("/hazards/{hazard_id}/features", tags=["hazards"])
def hazard_features(hazard_id: str):
    """Hazard polygons as GeoJSON, lightly simplified for display (about 5 m tolerance)."""
    sql = text("""
        WITH sel AS (
            SELECT feature_id, class_code, class_name,
                   ST_SimplifyPreserveTopology(geom, 0.00005) AS geom
            FROM hazard_features
            WHERE hazard_id = :hid
        )
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', feature_id,
                'geometry', ST_AsGeoJSON(geom, 5)::json,
                'properties', json_build_object('class_code', class_code, 'class_name', class_name)
            )), '[]'::json)
        )
        FROM sel
    """)
    with engine.connect() as conn:
        _require_hazard(conn, hazard_id)
        return conn.execute(sql, {"hid": hazard_id}).scalar()


# ---------------------------------------------------------------- screening

@app.get("/screening/{hazard_id}", tags=["screening"])
def screening(
    hazard_id: str,
    near_m: float = Query(250, ge=0, le=5000, description="Distance in metres that counts as 'near'"),
):
    """Preliminary exposure status of every asset against a hazard layer.

    Statuses: in_flood, in_ambiguous, near, not_flagged, and context (water features,
    which are reference layers rather than exposed assets).
    """
    sql = text("""
        SELECT a.asset_id, a.asset_type, t.category,
               CASE
                   WHEN t.category = 'water' THEN 'context'
                   WHEN s.dist_flooded_m = 0 THEN 'in_flood'
                   WHEN s.dist_ambiguous_m = 0 THEN 'in_ambiguous'
                   WHEN LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near THEN 'near'
                   ELSE 'not_flagged'
               END AS status,
               round(LEAST(s.dist_flooded_m, s.dist_ambiguous_m)::numeric, 1)::float8 AS distance_m,
               round(s.flooded_length_m::numeric, 1)::float8 AS flooded_length_m
        FROM asset_hazard_screening s
        JOIN assets a USING (asset_id)
        JOIN asset_types t USING (asset_type)
        WHERE s.hazard_id = :hid
        ORDER BY a.asset_id
    """)
    with engine.connect() as conn:
        _require_hazard(conn, hazard_id)
        rows = [dict(r) for r in conn.execute(sql, {"hid": hazard_id, "near": near_m}).mappings()]

    summary = {}
    for r in rows:
        if r["status"] == "context":
            continue
        s = summary.setdefault(r["asset_type"], {
            "asset_type": r["asset_type"], "total": 0, "in_flood": 0, "in_ambiguous": 0, "near": 0,
        })
        s["total"] += 1
        if r["status"] in ("in_flood", "in_ambiguous", "near"):
            s[r["status"]] += 1

    return {
        "hazard_id": hazard_id,
        "near_m": near_m,
        "note": "Preliminary screening only. Proximity to observed water is not a measure of "
                "damage, and assets not flagged are not confirmed safe.",
        "summary": list(summary.values()),
        "assets": rows,
    }


@app.get("/screening/{hazard_id}/settlements", tags=["screening"])
def settlement_screening(
    hazard_id: str,
    near_m: float = Query(250, ge=0, le=5000, description="Distance in metres that counts as 'near'"),
):
    """Preliminary flood status of every settlement footprint (GRID3).

    Statuses: in_flood (footprint intersects attributable flood), in_ambiguous, near, not_flagged.
    building_count covers the whole settlement, not only the part near water.
    """
    sql = text("""
        SELECT s.settlement_id, s.adm2_pcode, s.settlement_type, s.building_count,
               CASE
                   WHEN r.flooded_m2 > 0 THEN 'in_flood'
                   WHEN r.ambiguous_m2 > 0 THEN 'in_ambiguous'
                   WHEN r.dist_m <= :near THEN 'near'
                   ELSE 'not_flagged'
               END AS status,
               round(r.dist_m::numeric, 1)::float8 AS distance_m,
               round(r.flooded_m2::numeric)::float8 AS flooded_m2
        FROM settlement_hazard_screening r
        JOIN settlements s USING (settlement_id)
        WHERE r.hazard_id = :hid
        ORDER BY s.settlement_id
    """)
    with engine.connect() as conn:
        _require_hazard(conn, hazard_id)
        rows = [dict(r) for r in conn.execute(sql, {"hid": hazard_id, "near": near_m}).mappings()]
    return {
        "hazard_id": hazard_id,
        "near_m": near_m,
        "note": "Preliminary screening only. building_count covers the whole settlement and is "
                "not a count of flooded buildings. Radar under-detects water among buildings.",
        "settlements": rows,
    }


# ---------------------------------------------------------------- settlements

@app.get("/settlements", tags=["settlements"])
def settlements(
    pcode: str | None = Query(None, max_length=20, description="District P-code, e.g. GH1416"),
):
    """GRID3 settlement footprints as GeoJSON, lightly simplified for display."""
    where, params = "", {}
    if pcode:
        where, params = "WHERE adm2_pcode = :pcode", {"pcode": pcode}
    sql = text(f"""
        WITH sel AS (
            SELECT settlement_id, settlement_type, building_count, building_area_m2,
                   probability, data_year, adm2_pcode, source_id, source_ref,
                   ST_SimplifyPreserveTopology(geom, 0.00005) AS geom
            FROM settlements
            {where}
        )
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', settlement_id,
                'geometry', ST_AsGeoJSON(geom, 5)::json,
                'properties', json_build_object(
                    'settlement_id', settlement_id, 'settlement_type', settlement_type,
                    'building_count', building_count,
                    'building_area_m2', round(building_area_m2::numeric),
                    'probability', round(probability::numeric, 3),
                    'data_year', data_year, 'adm2_pcode', adm2_pcode,
                    'source_id', source_id, 'source_ref', source_ref
                )
            )), '[]'::json)
        )
        FROM sel
    """)
    with engine.connect() as conn:
        return conn.execute(sql, params).scalar()


# ---------------------------------------------------------------- proximity

# The click point, built from bound parameters (never from user text pasted into SQL)
_POINT = "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)"


@app.get("/proximity", tags=["proximity"])
def proximity(
    lon: float = Query(..., ge=-180, le=180, description="Longitude of the point (WGS84)"),
    lat: float = Query(..., ge=-90, le=90, description="Latitude of the point (WGS84)"),
    radius_m: float = Query(1000, ge=10, le=10000, description="Search radius in metres"),
    hazard_id: str = Query("flood_2023_observed", description="Hazard layer to summarise inside the radius"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum features listed (summary counts use all)"),
):
    """Everything mapped within a straight-line (geodesic) distance of a point.

    Returns assets and settlement footprints sorted by distance to their nearest edge,
    counts by type, the district containing the point, and the area of observed hazard
    water inside the radius. Distances are not travel distances.
    """
    # Bounding-box margin in degrees for the index pre-filter (generous: 1 degree ~ 111 km)
    params = {
        "lon": lon, "lat": lat, "r": radius_m, "deg": radius_m / 111_000 * 1.5,
        "hid": hazard_id,
    }

    features_sql = text(f"""
        SELECT 'asset' AS kind, a.asset_id AS id, a.asset_type AS type, t.label, t.category,
               a.name, a.adm2_pcode, NULL::bigint AS building_count,
               round(ST_Distance(a.geom::geography, {_POINT}::geography)::numeric, 1)::float8 AS distance_m,
               ST_X(ST_ClosestPoint(a.geom, {_POINT})) AS lon,
               ST_Y(ST_ClosestPoint(a.geom, {_POINT})) AS lat
        FROM assets a
        JOIN asset_types t USING (asset_type)
        WHERE a.geom && ST_Expand({_POINT}, :deg)
          AND ST_DWithin(a.geom::geography, {_POINT}::geography, :r)
        UNION ALL
        SELECT 'settlement' AS kind, s.settlement_id AS id, s.settlement_type AS type,
               s.settlement_type AS label, 'settlement' AS category,
               NULL::text AS name, s.adm2_pcode, s.building_count::bigint,
               round(ST_Distance(s.geom::geography, {_POINT}::geography)::numeric, 1)::float8 AS distance_m,
               ST_X(ST_ClosestPoint(s.geom, {_POINT})) AS lon,
               ST_Y(ST_ClosestPoint(s.geom, {_POINT})) AS lat
        FROM settlements s
        WHERE s.geom && ST_Expand({_POINT}, :deg)
          AND ST_DWithin(s.geom::geography, {_POINT}::geography, :r)
        ORDER BY distance_m
    """)

    district_sql = text(f"""
        SELECT pcode, name FROM admin_boundaries
        WHERE ST_Contains(geom, {_POINT})
        LIMIT 1
    """)

    hazard_sql = text(f"""
        WITH buf AS (SELECT ST_Buffer({_POINT}::geography, :r)::geometry AS g)
        SELECT f.class_name, sum(ST_Area(ST_Intersection(f.geom, buf.g)::geography)) AS m2
        FROM hazard_features f, buf
        WHERE f.hazard_id = :hid AND f.geom && buf.g AND ST_Intersects(f.geom, buf.g)
        GROUP BY f.class_name
    """)

    with engine.connect() as conn:
        rows = [dict(r) for r in conn.execute(features_sql, params).mappings()]
        district = conn.execute(district_sql, params).mappings().first()
        hazard_rows = conn.execute(hazard_sql, params).mappings().all()

    summary = {}
    for r in rows:
        s = summary.setdefault((r["kind"], r["type"]), {
            "kind": r["kind"], "type": r["type"], "label": r["label"], "count": 0,
            "buildings": 0 if r["kind"] == "settlement" else None,
        })
        s["count"] += 1
        if r["kind"] == "settlement":
            s["buildings"] += int(r["building_count"] or 0)

    hazard_m2 = {h["class_name"]: float(h["m2"] or 0) for h in hazard_rows}

    return {
        "center": [lon, lat],
        "radius_m": radius_m,
        "district": dict(district) if district else None,
        "hazard": {
            "hazard_id": hazard_id,
            "flooded_m2": round(hazard_m2.get("flooded", 0.0)),
            "ambiguous_m2": round(hazard_m2.get("ambiguous", 0.0)),
        },
        "total": len(rows),
        "summary": sorted(summary.values(), key=lambda s: -s["count"]),
        "features": rows[:limit],
        "note": "Straight-line (geodesic) distances to the nearest edge of each feature, not travel "
                "distance. Settlement building counts cover whole settlements.",
    }
