"""GeoPulse Intelligence API.

Run from the backend folder:  uvicorn app.main:app --reload
Interactive docs:             http://127.0.0.1:8000/docs
"""
from fastapi import FastAPI, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .db import engine

app = FastAPI(
    title="GeoPulse Intelligence API",
    version="0.1.0",
    description=(
        "Spatial decision-support API. Pilot area: Lower Volta corridor, Ghana. "
        "All outputs are preliminary screening information, not engineering "
        "certification or regulatory advice."
    ),
)


@app.get("/health", tags=["system"])
def health():
    """Check that the API is running and can reach PostGIS."""
    try:
        with engine.connect() as conn:
            postgis = conn.execute(text("SELECT postgis_lib_version()")).scalar()
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ok", "database": "connected", "postgis": postgis}


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