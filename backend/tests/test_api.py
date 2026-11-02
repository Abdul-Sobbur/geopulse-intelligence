"""Unit tests for the GeoPulse API that need no database.

They cover input validation, the report summaries, the site-comparison rounding rules and the
terrain / land-cover raster calculations (checked against synthetic rasters with known answers).
"""
import math

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from app import main

client = TestClient(main.app)


# ---------------------------------------------------------------- endpoints

def test_health_reports_database_unavailable():
    assert client.get("/health").status_code == 503


@pytest.mark.parametrize("query", [
    "site=abc",
    "site=200,6",
    "site=0,0&site=0,0&site=0,0&site=0,0&site=0,0",
])
def test_compare_sites_rejects_invalid_input(query):
    assert client.get(f"/sites/compare?{query}").status_code == 422


def test_report_rejects_unknown_format():
    assert client.get("/reports/screening/flood_2023_observed?format=pdf").status_code == 422


def test_proximity_rejects_out_of_range_radius():
    assert client.get("/proximity?lon=0.4&lat=6.0&radius_m=50000").status_code == 422


# ---------------------------------------------------------------- report summaries

ROWS = [
    {"record_type": "settlement", "type": "Hamlet", "label": "Hamlet", "status": "in_flood",
     "adm2_pcode": "GH1416", "district_name": "North Tongu"},
    {"record_type": "asset", "type": "health", "label": "Health facility", "status": "near",
     "adm2_pcode": "GH1416", "district_name": "North Tongu"},
    {"record_type": "asset", "type": "road", "label": "Major road", "status": "not_flagged",
     "adm2_pcode": "GH1418", "district_name": "South Tongu"},
    {"record_type": "asset", "type": "waterway", "label": "River", "status": "context",
     "adm2_pcode": "GH1418", "district_name": "South Tongu"},
]


def test_summary_excludes_context_and_lists_settlements_first():
    summary = main._summarise(ROWS)
    assert [s["type"] for s in summary] == ["Hamlet", "health", "road"]
    assert summary[0]["in_flood"] == 1 and summary[1]["near"] == 1 and summary[2]["total"] == 1


def test_by_district_counts_only_flagged_features():
    districts = main._by_district(ROWS)
    assert districts == [{
        "pcode": "GH1416", "name": "North Tongu",
        "settlements_in_flood": 1, "settlements_ambiguous_or_near": 0, "assets_flagged": 1,
    }]


# ---------------------------------------------------------------- site comparison

def test_site_values_are_rounded_by_unit():
    assert main._round_site_value("nearest_major_road_m", 1234.56) == 1235
    assert main._round_site_value("flood_within_radius_ha", 1.23456) == 1.23
    assert main._round_site_value("buildings_within_radius", 210.0) == 210
    assert main._round_site_value("nearest_health_m", None) is None


def test_every_criterion_value_has_a_definition():
    ids = {c["id"] for c in main.SITE_CRITERIA}
    assert {"elevation_m", "slope_mean_deg", "landcover", "nearest_flood_m", "district"} <= ids


LAT0, LON0 = 6.0, 0.4


@pytest.fixture
def synthetic_rasters(tmp_path, monkeypatch):
    """A DEM rising 10 m per 100 m eastwards (slope 5.71 deg) and a half-cropland, half-forest grid."""
    m_lon = 111_320.0 * math.cos(math.radians(LAT0))

    res, n = 0.00027, 400
    west, north = LON0 - n / 2 * res, LAT0 + n / 2 * res
    xs_m = (west + (np.arange(n) + 0.5) * res - LON0) * m_lon
    dem = np.tile(100 + 0.1 * xs_m, (n, 1)).astype("int16")
    dem_path = tmp_path / "dem.tif"
    with rasterio.open(dem_path, "w", driver="GTiff", height=n, width=n, count=1, dtype="int16",
                       crs="EPSG:4326", transform=from_origin(west, north, res, res), nodata=-9999) as dst:
        dst.write(dem, 1)

    res2, n2 = 0.00018, 600
    west2, north2 = LON0 - n2 / 2 * res2, LAT0 + n2 / 2 * res2
    landcover = np.full((n2, n2), 40, dtype="uint8")
    landcover[:, n2 // 2:] = 10
    lc_path = tmp_path / "landcover.tif"
    with rasterio.open(lc_path, "w", driver="GTiff", height=n2, width=n2, count=1, dtype="uint8",
                       crs="EPSG:4326", transform=from_origin(west2, north2, res2, res2), nodata=0) as dst:
        dst.write(landcover, 1)

    monkeypatch.setattr(main, "DEM_PATH", dem_path)
    monkeypatch.setattr(main, "LANDCOVER_PATH", lc_path)


def test_terrain_recovers_known_slope(synthetic_rasters):
    terrain = main._terrain(LON0, LAT0, 1000)
    assert abs(terrain["elevation_m"] - 100) <= 3
    assert abs(terrain["slope_mean_deg"] - math.degrees(math.atan(0.1))) < 0.3


def test_landcover_recovers_known_shares(synthetic_rasters):
    shares = main._landcover(LON0, LAT0, 1000)
    assert "Cropland 50%" in shares and "Tree cover 50%" in shares


def test_rasters_return_empty_outside_their_extent(synthetic_rasters):
    assert main._terrain(5.0, 10.0, 1000)["elevation_m"] is None
    assert main._landcover(5.0, 10.0, 1000) is None


def test_missing_rasters_are_handled(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DEM_PATH", tmp_path / "missing.tif")
    monkeypatch.setattr(main, "LANDCOVER_PATH", tmp_path / "missing.tif")
    assert main._terrain(LON0, LAT0, 1000)["slope_mean_deg"] is None
    assert main._landcover(LON0, LAT0, 1000) is None
