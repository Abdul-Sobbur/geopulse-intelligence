"""GeoPulse Intelligence API.

Run from the backend folder:  uvicorn app.main:app --reload
Interactive docs:             http://127.0.0.1:8000/docs
"""
import csv
import html
import io
import json
import math
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from rasterio.windows import Window
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .db import engine

app = FastAPI(
    title="GeoPulse Intelligence API",
    version="1.0.0",
    description=(
        "Spatial decision-support API. Pilot area: Lower Volta corridor, Ghana. "
        "All outputs are preliminary screening information, not engineering "
        "certification or regulatory advice."
    ),
)

# Browser origins allowed to call the API: the Vite dev server by default; Docker sets CORS_ORIGINS
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
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


# ---------------------------------------------------------------- reports (Module 5)

PILOT_LABEL = "Lower Volta corridor pilot, Ghana"

STATUS_DEFINITIONS = {
    "in_flood": "Touches observed new water attributable to the 2023 event (for settlements: the "
                "footprint intersects it).",
    "in_ambiguous": "Touches new water in a recurrent seasonal water body (e.g. lagoon, salt pans); "
                    "not attributable to the event.",
    "near": "Within the chosen distance of observed new water (either class) but not touching it.",
    "not_flagged": "Not in or near observed new water. This does NOT mean the feature was unaffected.",
    "context": "Water feature used as a reference layer, not an exposed asset.",
}
STATUS_ORDER = {"in_flood": 1, "in_ambiguous": 2, "near": 3, "not_flagged": 4, "context": 5}
FLAGGED_STATUSES = ("in_flood", "in_ambiguous", "near")

REPORT_COLUMNS = [
    "record_type", "id", "type", "label", "category", "name", "adm2_pcode", "district_name",
    "status", "distance_m", "flooded_length_m", "flooded_area_m2", "building_count",
    "source_id", "source_ref", "source_date", "lon", "lat",
]

REPORT_CAVEATS = [
    "Preliminary screening information only: not engineering certification, regulatory advice, "
    "an official flood map or a damage assessment.",
    "The flood layer shows water observed by Sentinel-1 radar on two dates; it is not peak extent "
    "and is likely an under-estimate (radar misses water under vegetation and among buildings).",
    "Distances are straight-line (geodesic) distances to the nearest edge of each feature, "
    "not travel distances.",
    "Settlement building counts cover the whole settlement; they are not counts of flooded buildings.",
    "OpenStreetMap coverage of health facilities and power infrastructure in the pilot is sparse; "
    "absence of a feature is not evidence of absence on the ground.",
]


def _report_rows(conn, hazard_id: str, near_m: float, pcode: str | None):
    """Every screened asset and settlement, with its status for the chosen distance."""
    where, params = "", {"hid": hazard_id, "near": near_m}
    if pcode:
        where, params["pcode"] = "WHERE u.adm2_pcode = :pcode", pcode
    sql = text(f"""
        WITH a AS (
            SELECT 'asset' AS record_type, a.asset_id AS id, a.asset_type AS type, t.label,
                   t.category, a.name, a.adm2_pcode,
                   CASE
                       WHEN t.category = 'water' THEN 'context'
                       WHEN s.dist_flooded_m = 0 THEN 'in_flood'
                       WHEN s.dist_ambiguous_m = 0 THEN 'in_ambiguous'
                       WHEN LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near THEN 'near'
                       ELSE 'not_flagged'
                   END AS status,
                   round(LEAST(s.dist_flooded_m, s.dist_ambiguous_m)::numeric, 1)::float8 AS distance_m,
                   round(s.flooded_length_m::numeric, 1)::float8 AS flooded_length_m,
                   NULL::float8 AS flooded_area_m2,
                   NULL::bigint AS building_count,
                   a.source_id, a.source_ref, a.source_date::text AS source_date,
                   a.geom
            FROM asset_hazard_screening s
            JOIN assets a USING (asset_id)
            JOIN asset_types t USING (asset_type)
            WHERE s.hazard_id = :hid
        ),
        st AS (
            SELECT 'settlement', st.settlement_id, st.settlement_type, st.settlement_type,
                   'settlement', NULL::text, st.adm2_pcode,
                   CASE
                       WHEN r.flooded_m2 > 0 THEN 'in_flood'
                       WHEN r.ambiguous_m2 > 0 THEN 'in_ambiguous'
                       WHEN r.dist_m <= :near THEN 'near'
                       ELSE 'not_flagged'
                   END,
                   round(r.dist_m::numeric, 1)::float8,
                   NULL::float8,
                   round(r.flooded_m2::numeric)::float8,
                   st.building_count::bigint,
                   st.source_id, st.source_ref, st.data_year::text,
                   st.geom
            FROM settlement_hazard_screening r
            JOIN settlements st USING (settlement_id)
            WHERE r.hazard_id = :hid
        )
        SELECT u.record_type, u.id, u.type, u.label, u.category, u.name, u.adm2_pcode,
               b.name AS district_name, u.status, u.distance_m, u.flooded_length_m,
               u.flooded_area_m2, u.building_count, u.source_id, u.source_ref, u.source_date,
               round(ST_X(ST_PointOnSurface(u.geom))::numeric, 6)::float8 AS lon,
               round(ST_Y(ST_PointOnSurface(u.geom))::numeric, 6)::float8 AS lat,
               ST_AsGeoJSON(u.geom, 6) AS geojson
        FROM (SELECT * FROM a UNION ALL SELECT * FROM st) u
        LEFT JOIN admin_boundaries b ON b.pcode = u.adm2_pcode
        {where}
    """)
    rows = [dict(r) for r in conn.execute(sql, params).mappings()]
    rows.sort(key=lambda r: (
        STATUS_ORDER.get(r["status"], 9),
        r["distance_m"] if r["distance_m"] is not None else float("inf"),
    ))
    return rows


def _summarise(rows):
    """Counts by record type and type: total, in flood, in ambiguous, near (context excluded)."""
    summary = {}
    for r in rows:
        if r["status"] == "context":
            continue
        s = summary.setdefault((r["record_type"], r["type"]), {
            "record_type": r["record_type"], "type": r["type"], "label": r["label"],
            "total": 0, "in_flood": 0, "in_ambiguous": 0, "near": 0,
        })
        s["total"] += 1
        if r["status"] in FLAGGED_STATUSES:
            s[r["status"]] += 1
    return sorted(summary.values(), key=lambda s: (
        s["record_type"] != "settlement", -(s["in_flood"] + s["in_ambiguous"] + s["near"]),
    ))


def _by_district(rows):
    """Flagged settlements and assets per district."""
    districts = {}
    for r in rows:
        if r["status"] not in FLAGGED_STATUSES:
            continue
        d = districts.setdefault(r["adm2_pcode"] or "unknown", {
            "pcode": r["adm2_pcode"] or "unknown", "name": r["district_name"] or "",
            "settlements_in_flood": 0, "settlements_ambiguous_or_near": 0, "assets_flagged": 0,
        })
        if r["record_type"] == "settlement":
            key = "settlements_in_flood" if r["status"] == "in_flood" else "settlements_ambiguous_or_near"
            d[key] += 1
        else:
            d["assets_flagged"] += 1
    return sorted(districts.values(), key=lambda d: d["pcode"])


def _report_metadata(conn, hazard_id: str, near_m: float, pcode: str | None):
    layer = conn.execute(text("""
        SELECT title, source_id, observed_dates, method, metadata
        FROM hazard_layers WHERE hazard_id = :hid
    """), {"hid": hazard_id}).mappings().first()
    layer_meta = layer["metadata"] or {}
    district_name = (
        conn.execute(text("SELECT name FROM admin_boundaries WHERE pcode = :p"), {"p": pcode}).scalar()
        if pcode else None
    )
    osm_snapshot = conn.execute(
        text("SELECT max(source_date)::text FROM assets WHERE source_id = 'D-02'")
    ).scalar()

    return {
        "title": "GeoPulse Intelligence: preliminary flood exposure screening",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "software": f"GeoPulse Intelligence API {app.version}",
        "scope": {
            "area": f"{district_name} ({pcode})" if pcode else f"All districts in the {PILOT_LABEL}",
            "near_distance_m": near_m,
        },
        "hazard": {
            "hazard_id": hazard_id,
            "title": layer["title"],
            "source_id": layer["source_id"],
            "observed_dates": layer["observed_dates"],
            "method": layer["method"],
            "pre_event_window": layer_meta.get("pre_event_window"),
            "parameters": layer_meta.get("parameters"),
            "limitations": layer_meta.get("limitations", []),
        },
        "status_definitions": STATUS_DEFINITIONS,
        "data_sources": [
            {"id": "D-01", "name": "Ghana Subnational Administrative Boundaries (COD-AB)",
             "provider": "Ghana Statistical Service via OCHA HDX", "licence": "CC BY-IGO 3.0"},
            {"id": "D-02", "name": f"OpenStreetMap Ghana extract (snapshot {osm_snapshot})",
             "provider": "OpenStreetMap contributors via Geofabrik", "licence": "ODbL 1.0"},
            {"id": "D-04", "name": "GRID3 GHA Settlement Extents v3.0",
             "provider": "CIESIN, Columbia University (GRID3)",
             "licence": "To be confirmed from the release notes"},
            {"id": "D-08", "name": layer["title"],
             "provider": "Derived in GeoPulse from Copernicus Sentinel-1 data (D-07)",
             "licence": "Derived; contains modified Copernicus Sentinel data (2023)"},
        ],
        "caveats": REPORT_CAVEATS,
    }


REPORT_CSS = """
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2933;
       max-width: 900px; margin: 24px auto; padding: 0 16px; line-height: 1.45; }
h1 { font-size: 22px; margin-bottom: 4px; }
h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #e4e7eb; padding-bottom: 4px; }
.meta { color: #616e7c; font-size: 13px; }
.banner { background: #fff8e1; border-left: 4px solid #f0b400; padding: 8px 12px; font-size: 13px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
th, td { border-bottom: 1px solid #e4e7eb; padding: 4px 6px; text-align: right; }
th:first-child, td:first-child, td.text, th.text { text-align: left; }
th { background: #f5f7fa; }
ul { font-size: 13px; }
.print { margin: 12px 0; padding: 6px 12px; font: inherit; cursor: pointer; }
@media print { .print { display: none; } body { margin: 0; } }
"""


def _html_report(meta, summary, districts, rows) -> str:
    e = lambda v: html.escape("" if v is None else str(v))  # noqa: E731
    hz = meta["hazard"]

    summary_rows = "".join(
        f"<tr><td>{e(s['label'])}{' (footprint)' if s['record_type'] == 'settlement' else ''}</td>"
        f"<td>{s['total']}</td><td>{s['in_flood']}</td><td>{s['in_ambiguous']}</td><td>{s['near']}</td></tr>"
        for s in summary
    )
    district_rows = "".join(
        f"<tr><td>{e(d['name'])} ({e(d['pcode'])})</td><td>{d['settlements_in_flood']}</td>"
        f"<td>{d['settlements_ambiguous_or_near']}</td><td>{d['assets_flagged']}</td></tr>"
        for d in districts
    ) or '<tr><td colspan="4">No flagged features in scope.</td></tr>'

    flagged = [r for r in rows if r["status"] in FLAGGED_STATUSES][:60]
    feature_rows = "".join(
        f"<tr><td>{e(r['name'] or (r['label'] + ' footprint' if r['record_type'] == 'settlement' else '(unnamed)'))}</td>"
        f"<td class='text'>{e(r['label'])}</td><td class='text'>{e(r['district_name'])}</td>"
        f"<td class='text'>{e(r['status'])}</td>"
        f"<td>{'' if r['distance_m'] is None else round(r['distance_m'])}</td>"
        f"<td>{'' if r['building_count'] is None else r['building_count']}</td></tr>"
        for r in flagged
    ) or '<tr><td colspan="6">No flagged features in scope.</td></tr>'

    params = hz.get("parameters") or {}
    param_items = "".join(
        f"<li><strong>{e(k)}:</strong> {e(json.dumps(v) if isinstance(v, (dict, list)) else v)}</li>"
        for k, v in params.items()
    )
    limitation_items = "".join(f"<li>{e(x)}</li>" for x in hz.get("limitations") or [])
    caveat_items = "".join(f"<li>{e(x)}</li>" for x in meta["caveats"])
    definition_items = "".join(
        f"<li><strong>{e(k)}:</strong> {e(v)}</li>" for k, v in meta["status_definitions"].items()
    )
    source_rows = "".join(
        f"<tr><td>{e(s['id'])}</td><td class='text'>{e(s['name'])}</td>"
        f"<td class='text'>{e(s['provider'])}</td><td class='text'>{e(s['licence'])}</td></tr>"
        for s in meta["data_sources"]
    )
    window = " to ".join(hz.get("pre_event_window") or [])

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(meta['title'])}</title><style>{REPORT_CSS}</style></head>
<body>
<h1>{e(meta['title'])}</h1>
<p class="meta">Scope: {e(meta['scope']['area'])} · "Near" = within {e(meta['scope']['near_distance_m'])} m<br>
Generated {e(meta['generated_at'])} (UTC) · {e(meta['software'])}</p>
<p class="banner"><strong>Preliminary screening only.</strong> Proximity to observed water is not a measure
of damage, and features that are not flagged are not confirmed safe. See caveats below.</p>
<button class="print" onclick="window.print()">Print / Save as PDF</button>

<h2>1. Summary</h2>
<p>Hazard layer: {e(hz['title'])}, observed {e(hz['observed_dates'])}.</p>
<table><tr><th class="text">Feature type</th><th>Screened</th><th>In flood</th><th>In ambiguous water</th><th>Near</th></tr>
{summary_rows}</table>

<h2>2. Flagged features by district</h2>
<table><tr><th class="text">District</th><th>Settlements intersecting flood</th>
<th>Settlements ambiguous / near</th><th>Assets flagged</th></tr>{district_rows}</table>

<h2>3. Flagged features (nearest first, up to 60)</h2>
<table><tr><th class="text">Name</th><th class="text">Type</th><th class="text">District</th>
<th class="text">Status</th><th>Distance (m)</th><th>Buildings*</th></tr>{feature_rows}</table>
<p class="meta">* Settlement building counts cover the whole settlement, not only the part near water.
The full list is available in the CSV and GeoJSON exports.</p>

<h2>4. Method</h2>
<p>{e(hz['method'])}. Pre-event baseline: {e(window)}. Observation dates: {e(hz['observed_dates'])}.
Source: {e(hz['source_id'])}.</p>
<ul>{param_items}</ul>

<h2>5. Status definitions</h2><ul>{definition_items}</ul>

<h2>6. Limitations of the hazard layer</h2><ul>{limitation_items}</ul>

<h2>7. Caveats for this report</h2><ul>{caveat_items}</ul>

<h2>8. Data sources</h2>
<table><tr><th class="text">ID</th><th class="text">Dataset</th><th class="text">Provider</th><th class="text">Licence</th></tr>
{source_rows}</table>
<p class="meta">© OpenStreetMap contributors. Contains modified Copernicus Sentinel data (2023).
Settlement footprints: CIESIN, Columbia University (2024), GRID3 GHA Settlement Extents v3.0.</p>
</body></html>"""


@app.get("/reports/screening/{hazard_id}", tags=["reports"])
def screening_report(
    hazard_id: str,
    fmt: Literal["html", "csv", "geojson"] = Query(
        "html", alias="format", description="html (printable, save as PDF), csv (zip with metadata) or geojson",
    ),
    near_m: float = Query(250, ge=0, le=5000, description="Distance in metres that counts as 'near'"),
    pcode: str | None = Query(None, max_length=20, description="Limit to one district P-code"),
    include: Literal["flagged", "all"] = Query("flagged", description="Flagged features only, or everything screened"),
):
    """Download a screening report with its scope, date, sources, method and limitations (FR-06)."""
    with engine.connect() as conn:
        _require_hazard(conn, hazard_id)
        rows = _report_rows(conn, hazard_id, near_m, pcode)
        meta = _report_metadata(conn, hazard_id, near_m, pcode)

    summary = _summarise(rows)
    districts = _by_district(rows)
    selected = [r for r in rows if include == "all" or r["status"] in FLAGGED_STATUSES]
    meta["record_counts"] = {"screened": len(rows), "included": len(selected), "include": include}
    meta["summary"] = summary
    meta["by_district"] = districts

    stem = f"geopulse_flood_screening_{pcode or 'pilot'}_{int(near_m)}m_{datetime.now(timezone.utc):%Y%m%d}"

    if fmt == "html":
        return HTMLResponse(_html_report(meta, summary, districts, selected))

    if fmt == "geojson":
        collection = {
            "type": "FeatureCollection",
            "metadata": meta,
            "features": [
                {
                    "type": "Feature",
                    "geometry": json.loads(r["geojson"]),
                    "properties": {c: r[c] for c in REPORT_COLUMNS},
                }
                for r in selected
            ],
        }
        return Response(
            json.dumps(collection),
            media_type="application/geo+json",
            headers={"Content-Disposition": f'attachment; filename="{stem}.geojson"'},
        )

    # CSV: a zip containing the table, its metadata and a plain-text README
    table = io.StringIO()
    writer = csv.DictWriter(table, fieldnames=REPORT_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(selected)

    readme = "\n".join([
        meta["title"],
        f"Scope: {meta['scope']['area']}; 'near' = within {near_m} m",
        f"Generated: {meta['generated_at']} (UTC) by {meta['software']}",
        f"Hazard layer: {meta['hazard']['title']} (observed {meta['hazard']['observed_dates']})",
        "",
        "Status definitions:",
        *[f"  {k}: {v}" for k, v in STATUS_DEFINITIONS.items()],
        "",
        "Caveats:",
        *[f"  - {c}" for c in REPORT_CAVEATS],
        "",
        "Data sources:",
        *[f"  {s['id']}: {s['name']} ({s['provider']}; {s['licence']})" for s in meta["data_sources"]],
        "",
        "Full method, parameters and limitations: metadata.json",
    ])

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{stem}.csv", table.getvalue().encode("utf-8-sig"))
        zf.writestr("metadata.json", json.dumps(meta, indent=2))
        zf.writestr("README.txt", readme)
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{stem}.zip"'},
    )


# ---------------------------------------------------------------- site comparison (Module 6)

# Rasters written by scripts/download_site_rasters.py (backend/app/main.py -> project root)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RASTER_DIR = Path(os.environ.get("RASTER_DIR", PROJECT_ROOT / "data" / "processed" / "site_rasters"))
DEM_PATH = RASTER_DIR / "dem_glo30_pilot.tif"
LANDCOVER_PATH = RASTER_DIR / "worldcover2021_pilot.tif"

WORLDCOVER_CLASSES = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
    60: "Bare / sparse vegetation", 70: "Snow and ice", 80: "Permanent water",
    90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen",
}

# Criteria are shown separately; there is deliberately no composite score or ranking.
SITE_CRITERIA = [
    {"id": "district", "label": "District", "unit": "", "group": "Location",
     "note": "District containing the site (COD-AB)."},
    {"id": "elevation_m", "label": "Elevation at site", "unit": "m_asl", "group": "Terrain",
     "note": "Copernicus DEM GLO-30, a surface model (includes trees and buildings)."},
    {"id": "slope_mean_deg", "label": "Mean slope within radius", "unit": "deg", "group": "Terrain",
     "note": "Derived from the DEM at about 30 m."},
    {"id": "slope_max_deg", "label": "Maximum slope within radius", "unit": "deg", "group": "Terrain",
     "note": "Derived from the DEM at about 30 m; sensitive to DEM noise."},
    {"id": "landcover", "label": "Land cover within radius", "unit": "", "group": "Land cover",
     "note": "ESA WorldCover 2021, resampled to about 20 m. Shares of classes covering at least 1%."},
    {"id": "nearest_major_road_m", "label": "Nearest major road or bridge", "unit": "m", "group": "Access",
     "note": "OpenStreetMap (motorway to tertiary); straight-line distance."},
    {"id": "nearest_settlement_m", "label": "Nearest settlement footprint", "unit": "m", "group": "Communities",
     "note": "GRID3 settlement extents."},
    {"id": "settlements_within_radius", "label": "Settlements within radius", "unit": "count", "group": "Communities",
     "note": "GRID3 footprints within the radius."},
    {"id": "buildings_within_radius", "label": "Buildings in those settlements", "unit": "count",
     "group": "Communities", "note": "Whole-settlement GRID3 building counts."},
    {"id": "nearest_school_m", "label": "Nearest mapped school", "unit": "m", "group": "Services",
     "note": "OpenStreetMap; completeness not verified."},
    {"id": "nearest_health_m", "label": "Nearest mapped health facility", "unit": "m", "group": "Services",
     "note": "OpenStreetMap; coverage in the pilot is sparse."},
    {"id": "nearest_power_m", "label": "Nearest mapped power infrastructure", "unit": "m", "group": "Services",
     "note": "OpenStreetMap power lines, substations and plants; coverage is sparse."},
    {"id": "nearest_water_m", "label": "Nearest mapped river or water body", "unit": "m", "group": "Water",
     "note": "OpenStreetMap waterways and water bodies."},
    {"id": "nearest_flood_m", "label": "Nearest observed 2023 flooding", "unit": "m", "group": "Flood constraint",
     "note": "Sentinel-1, 16 and 23 Oct 2023; likely an under-estimate of extent."},
    {"id": "flood_within_radius_ha", "label": "Observed 2023 flooding within radius", "unit": "ha",
     "group": "Flood constraint", "note": "Attributable class only."},
    {"id": "ambiguous_within_radius_ha", "label": "Ambiguous seasonal water within radius", "unit": "ha",
     "group": "Flood constraint", "note": "New water in recurrent seasonal water bodies."},
]


def _nearest_assets_sql(types_sql: str) -> str:
    """Distance (m) from the point to the nearest asset of the given (fixed) types."""
    return f"""(SELECT min(ST_Distance(k.geom::geography, {_POINT}::geography))
               FROM (SELECT a.geom FROM assets a WHERE a.asset_type IN {types_sql}
                     ORDER BY a.geom <-> {_POINT} LIMIT 5) k)"""


def _hazard_area_sql(class_code: int) -> str:
    """Hectares of a hazard class inside the circle around the point."""
    buffer = f"ST_Buffer({_POINT}::geography, :r)::geometry"
    return f"""(SELECT COALESCE(sum(ST_Area(ST_Intersection(f.geom, {buffer})::geography)), 0) / 10000.0
               FROM hazard_features f
               WHERE f.hazard_id = :hid AND f.class_code = {class_code}
                 AND f.geom && ST_Expand({_POINT}, :deg) AND ST_Intersects(f.geom, {buffer}))"""


SITE_SQL = text(f"""
    SELECT
        (SELECT b.pcode FROM admin_boundaries b WHERE ST_Contains(b.geom, {_POINT}) LIMIT 1) AS pcode,
        (SELECT b.name FROM admin_boundaries b WHERE ST_Contains(b.geom, {_POINT}) LIMIT 1) AS district_name,
        {_nearest_assets_sql("('road', 'bridge')")} AS nearest_major_road_m,
        {_nearest_assets_sql("('education')")} AS nearest_school_m,
        {_nearest_assets_sql("('health')")} AS nearest_health_m,
        {_nearest_assets_sql("('power_line', 'power_substation', 'power_plant')")} AS nearest_power_m,
        {_nearest_assets_sql("('waterway', 'water_body')")} AS nearest_water_m,
        (SELECT min(ST_Distance(k.geom::geography, {_POINT}::geography))
           FROM (SELECT s.geom FROM settlements s ORDER BY s.geom <-> {_POINT} LIMIT 5) k) AS nearest_settlement_m,
        (SELECT count(*) FROM settlements s
           WHERE s.geom && ST_Expand({_POINT}, :deg)
             AND ST_DWithin(s.geom::geography, {_POINT}::geography, :r)) AS settlements_within_radius,
        (SELECT COALESCE(sum(s.building_count), 0) FROM settlements s
           WHERE s.geom && ST_Expand({_POINT}, :deg)
             AND ST_DWithin(s.geom::geography, {_POINT}::geography, :r)) AS buildings_within_radius,
        (SELECT min(ST_Distance(k.geom::geography, {_POINT}::geography))
           FROM (SELECT f.geom FROM hazard_features f
                 WHERE f.hazard_id = :hid AND f.class_code = 1
                 ORDER BY f.geom <-> {_POINT} LIMIT 5) k) AS nearest_flood_m,
        {_hazard_area_sql(1)} AS flood_within_radius_ha,
        {_hazard_area_sql(5)} AS ambiguous_within_radius_ha
""")


def _circle_window(src, lon: float, lat: float, radius_m: float):
    """Read the raster window around a point and a mask of pixels whose centres lie within the radius."""
    m_lat = 110_574.0
    m_lon = 111_320.0 * math.cos(math.radians(lat))
    half_w, half_h = radius_m / m_lon, radius_m / m_lat
    r0, c0 = src.index(lon - half_w, lat + half_h)
    r1, c1 = src.index(lon + half_w, lat - half_h)
    r0, c0 = max(r0, 0), max(c0, 0)
    r1, c1 = min(r1, src.height - 1), min(c1, src.width - 1)
    if r1 < r0 or c1 < c0:
        return None  # the circle lies outside the raster
    data = src.read(1, window=Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1), masked=True)
    rows, cols = np.mgrid[r0:r1 + 1, c0:c1 + 1]
    t = src.transform
    xs = t.c + (cols + 0.5) * t.a
    ys = t.f + (rows + 0.5) * t.e
    inside = ((xs - lon) * m_lon) ** 2 + ((ys - lat) * m_lat) ** 2 <= radius_m ** 2
    pixel_size_m = (abs(t.a) * m_lon, abs(t.e) * m_lat)
    return data, inside, pixel_size_m, (r0, c0)


def _terrain(lon: float, lat: float, radius_m: float) -> dict:
    """Elevation at the point and slope statistics within the radius, from the local DEM."""
    empty = {"elevation_m": None, "slope_mean_deg": None, "slope_max_deg": None}
    if not DEM_PATH.exists():
        return empty
    with rasterio.open(DEM_PATH) as src:
        window = _circle_window(src, lon, lat, radius_m)
        if window is None:
            return empty
        data, inside, (px_m, py_m), (r0, c0) = window
        z = data.astype("float64").filled(np.nan)
        row, col = src.index(lon, lat)

    result = dict(empty)
    if 0 <= row - r0 < z.shape[0] and 0 <= col - c0 < z.shape[1] and not np.isnan(z[row - r0, col - c0]):
        result["elevation_m"] = round(float(z[row - r0, col - c0]), 1)
    if z.shape[0] >= 2 and z.shape[1] >= 2:
        gy, gx = np.gradient(z, py_m, px_m)
        slope = np.degrees(np.arctan(np.hypot(gx, gy)))
        values = slope[inside & ~np.isnan(slope)]
        if values.size:
            result["slope_mean_deg"] = round(float(values.mean()), 1)
            result["slope_max_deg"] = round(float(values.max()), 1)
    return result


def _landcover(lon: float, lat: float, radius_m: float) -> str | None:
    """Land-cover class shares within the radius, e.g. 'Cropland 45% · Tree cover 30%'."""
    if not LANDCOVER_PATH.exists():
        return None
    with rasterio.open(LANDCOVER_PATH) as src:
        window = _circle_window(src, lon, lat, radius_m)
    if window is None:
        return None
    data, inside, _, _ = window
    values = np.asarray(data.filled(0))[inside]
    values = values[values > 0]
    if values.size == 0:
        return None
    classes, counts = np.unique(values, return_counts=True)
    shares = sorted(
        ((WORLDCOVER_CLASSES.get(int(k), f"class {int(k)}"), c / values.size) for k, c in zip(classes, counts)),
        key=lambda item: -item[1],
    )
    return " · ".join(f"{name} {round(100 * share)}%" for name, share in shares if share >= 0.01)


def _round_site_value(key: str, value):
    if value is None:
        return None
    if key.endswith("_m"):
        return round(float(value))
    if key.endswith("_ha"):
        return round(float(value), 2)
    if key in ("settlements_within_radius", "buildings_within_radius"):
        return int(value)
    return value


@app.get("/sites/compare", tags=["site comparison"])
def compare_sites(
    site: list[str] = Query(..., description="One to four sites as 'lon,lat', e.g. site=0.47,6.0&site=0.3,6.1"),
    radius_m: float = Query(1000, ge=100, le=5000, description="Assessment radius around each site, in metres"),
    hazard_id: str = Query("flood_2023_observed", description="Hazard layer used as the flood constraint"),
):
    """Compare candidate sites on separately displayed criteria (no composite score or ranking)."""
    if not 1 <= len(site) <= 4:
        raise HTTPException(status_code=422, detail="Provide between 1 and 4 sites.")
    points = []
    for s in site:
        try:
            lon_text, lat_text = s.split(",")
            lon, lat = float(lon_text), float(lat_text)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"Invalid site '{s}': expected 'lon,lat'.")
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise HTTPException(status_code=422, detail=f"Site '{s}' is outside valid coordinates.")
        points.append((lon, lat))

    results = []
    with engine.connect() as conn:
        for lon, lat in points:
            params = {"lon": lon, "lat": lat, "r": radius_m, "deg": radius_m / 111_000 * 1.5, "hid": hazard_id}
            row = dict(conn.execute(SITE_SQL, params).mappings().first())
            values = {k: _round_site_value(k, v) for k, v in row.items() if k not in ("pcode", "district_name")}
            values["district"] = (
                f"{row['district_name']} ({row['pcode']})" if row["district_name"] else "Outside mapped districts"
            )
            values.update(_terrain(lon, lat, radius_m))
            values["landcover"] = _landcover(lon, lat, radius_m)
            results.append({"lon": lon, "lat": lat, "values": values})

    return {
        "radius_m": radius_m,
        "hazard_id": hazard_id,
        "criteria": SITE_CRITERIA,
        "sites": results,
        "rasters": {"dem": DEM_PATH.exists(), "landcover": LANDCOVER_PATH.exists()},
        "note": "Criteria are shown separately. No composite score or ranking is calculated: whether a "
                "value is favourable depends on the project. Preliminary screening only; distances are "
                "straight-line.",
    }


# ---------------------------------------------------------------- dashboard (Module 4)

# Every metric shown on the dashboard, with what kind of number it is and where it comes from
METRIC_DEFINITIONS = [
    {"id": "area_km2", "label": "District area", "unit": "km²", "kind": "Observation",
     "definition": "Geodesic area of the district boundary.", "source": "D-01 COD-AB boundaries"},
    {"id": "assets", "label": "Mapped assets", "unit": "count", "kind": "Observation",
     "definition": "OpenStreetMap features loaded as assets (roads, bridges, places, facilities, "
                   "power), excluding water features. Counts mapped features, not all that exist.",
     "source": "D-02 OpenStreetMap"},
    {"id": "settlements", "label": "Settlement footprints", "unit": "count", "kind": "Modelled estimate",
     "definition": "GRID3 settlement polygons whose interior point lies in the district.",
     "source": "D-04 GRID3 v3.0"},
    {"id": "buildings", "label": "Buildings in settlements", "unit": "count", "kind": "Modelled estimate",
     "definition": "Sum of GRID3 building counts for those settlements (detected from imagery).",
     "source": "D-04 GRID3 v3.0"},
    {"id": "flooded_km2", "label": "Observed flooding", "unit": "km²", "kind": "Derived",
     "definition": "Area of new water attributable to the Oct 2023 event (Sentinel-1, two dates). "
                   "Likely an under-estimate.", "source": "D-08 (GeoPulse analysis)"},
    {"id": "ambiguous_km2", "label": "Ambiguous seasonal water", "unit": "km²", "kind": "Derived",
     "definition": "New water in places that historically hold water at least 10% of the time "
                   "(e.g. lagoons, salt pans); not attributable to the event.",
     "source": "D-08 (GeoPulse analysis)"},
    {"id": "settlements_in_flood", "label": "Settlements intersecting observed flooding", "unit": "count",
     "kind": "Derived", "definition": "Settlement footprints that intersect attributable flooding.",
     "source": "D-04 x D-08"},
    {"id": "settlements_ambiguous_or_near", "label": "Settlements in ambiguous water or near",
     "unit": "count", "kind": "Derived",
     "definition": "Settlements not intersecting attributable flooding but touching ambiguous water, "
                   "or within the chosen 'near' distance of observed new water.",
     "source": "D-04 x D-08"},
    {"id": "assets_flagged", "label": "Assets flagged", "unit": "count", "kind": "Derived",
     "definition": "Non-water assets in, or within the chosen 'near' distance of, observed new water.",
     "source": "D-02 x D-08"},
]


@app.get("/dashboard", tags=["dashboard"])
def dashboard(
    pilot_id: str = Query("lower_volta"),
    hazard_id: str = Query("flood_2023_observed"),
    near_m: float = Query(250, ge=0, le=5000, description="Distance in metres that counts as 'near'"),
    pcode: str | None = Query(None, max_length=20, description="Limit the headline figures and asset table to one district"),
):
    """Summary indicators by district and asset type, each with a metric definition (FR-05)."""
    district_sql = text("""
        WITH d AS (
            SELECT b.pcode, b.name, b.parent_name AS region,
                   ST_Area(b.geom::geography) / 1e6 AS area_km2
            FROM admin_boundaries b
            JOIN pilot_districts p USING (pcode)
            WHERE p.pilot_id = :pid
        ),
        a AS (
            SELECT a.adm2_pcode AS pcode,
                   count(*) FILTER (WHERE t.category <> 'water') AS assets,
                   count(*) FILTER (
                       WHERE t.category <> 'water'
                         AND (s.dist_flooded_m = 0 OR s.dist_ambiguous_m = 0
                              OR LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near)
                   ) AS assets_flagged
            FROM assets a
            JOIN asset_types t USING (asset_type)
            LEFT JOIN asset_hazard_screening s ON s.asset_id = a.asset_id AND s.hazard_id = :hid
            GROUP BY a.adm2_pcode
        ),
        st AS (
            SELECT s.adm2_pcode AS pcode,
                   count(*) AS settlements,
                   COALESCE(sum(s.building_count), 0) AS buildings,
                   count(*) FILTER (WHERE r.flooded_m2 > 0) AS settlements_in_flood,
                   count(*) FILTER (
                       WHERE r.flooded_m2 = 0 AND (r.ambiguous_m2 > 0 OR r.dist_m <= :near)
                   ) AS settlements_ambiguous_or_near
            FROM settlements s
            LEFT JOIN settlement_hazard_screening r
                   ON r.settlement_id = s.settlement_id AND r.hazard_id = :hid
            GROUP BY s.adm2_pcode
        )
        SELECT d.pcode, d.name, d.region, d.area_km2,
               COALESCE(a.assets, 0) AS assets,
               COALESCE(a.assets_flagged, 0) AS assets_flagged,
               COALESCE(st.settlements, 0) AS settlements,
               COALESCE(st.buildings, 0) AS buildings,
               COALESCE(st.settlements_in_flood, 0) AS settlements_in_flood,
               COALESCE(st.settlements_ambiguous_or_near, 0) AS settlements_ambiguous_or_near
        FROM d
        LEFT JOIN a USING (pcode)
        LEFT JOIN st USING (pcode)
        ORDER BY d.pcode
    """)

    type_filter = "AND a.adm2_pcode = :pcode" if pcode else ""
    asset_type_sql = text(f"""
        SELECT t.asset_type, t.label, t.category, t.coverage_warning,
               count(*) AS total,
               count(*) FILTER (WHERE s.dist_flooded_m = 0) AS in_flood,
               count(*) FILTER (WHERE s.dist_flooded_m > 0 AND s.dist_ambiguous_m = 0) AS in_ambiguous,
               count(*) FILTER (
                   WHERE s.dist_flooded_m > 0 AND s.dist_ambiguous_m > 0
                     AND LEAST(s.dist_flooded_m, s.dist_ambiguous_m) <= :near
               ) AS near
        FROM assets a
        JOIN asset_types t USING (asset_type)
        LEFT JOIN asset_hazard_screening s ON s.asset_id = a.asset_id AND s.hazard_id = :hid
        WHERE t.category <> 'water' {type_filter}
        GROUP BY t.asset_type, t.label, t.category, t.coverage_warning
        ORDER BY t.category, t.asset_type
    """)

    params = {"pid": pilot_id, "hid": hazard_id, "near": near_m, "pcode": pcode}
    with engine.connect() as conn:
        _require_hazard(conn, hazard_id)
        districts = [dict(r) for r in conn.execute(district_sql, params).mappings()]
        asset_types = [dict(r) for r in conn.execute(asset_type_sql, params).mappings()]
        layer = conn.execute(text("""
            SELECT title, observed_dates, metadata -> 'district_stats' AS district_stats
            FROM hazard_layers WHERE hazard_id = :hid
        """), {"hid": hazard_id}).mappings().first()

    if not districts:
        raise HTTPException(status_code=404, detail=f"Unknown pilot: {pilot_id}")

    # Flooded area per district comes from the Earth Engine statistics stored with the flood layer
    flood_stats = {s["pcode"]: s for s in (layer["district_stats"] or [])}
    for d in districts:
        stats = flood_stats.get(d["pcode"], {})
        d["area_km2"] = round(float(d["area_km2"]), 1)
        d["flooded_km2"] = stats.get("flooded_km2")
        d["ambiguous_km2"] = stats.get("ambiguous_km2")
        for key in ("assets", "assets_flagged", "settlements", "buildings",
                    "settlements_in_flood", "settlements_ambiguous_or_near"):
            d[key] = int(d[key])

    scope = [d for d in districts if d["pcode"] == pcode] if pcode else districts
    if pcode and not scope:
        raise HTTPException(status_code=404, detail=f"District {pcode} is not in pilot {pilot_id}")

    def total(key):
        values = [d[key] for d in scope if d[key] is not None]
        return round(sum(values), 1) if values else None

    kpis = [
        {"id": k, "value": total(k)}
        for k in ("area_km2", "assets", "settlements", "buildings", "flooded_km2",
                  "ambiguous_km2", "settlements_in_flood", "assets_flagged")
    ]

    return {
        "pilot_id": pilot_id,
        "scope": {"pcode": pcode, "name": scope[0]["name"] if pcode else "All pilot districts"},
        "near_m": near_m,
        "hazard": {"hazard_id": hazard_id, "title": layer["title"], "observed_dates": layer["observed_dates"]},
        "kpis": kpis,
        "districts": districts,
        "asset_types": [{**t, "total": int(t["total"]), "in_flood": int(t["in_flood"]),
                         "in_ambiguous": int(t["in_ambiguous"]), "near": int(t["near"])} for t in asset_types],
        "definitions": METRIC_DEFINITIONS,
        "note": "Preliminary screening information. Counts of mapped features are not counts of all "
                "features that exist; see each metric's definition and kind.",
    }
