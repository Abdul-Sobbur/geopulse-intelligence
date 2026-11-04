"""Generic screening: the SQL it builds and the endpoint's checks (no database needed).

The match with the original flood screening is checked against real data by
scripts/check_screening.py.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.catalog import CATALOG_DIR, load_catalog
from app.screening import screen_sql, status_sql

client = TestClient(main.app)
cat = load_catalog()
FLOOD, ASSETS, SETTLEMENTS = (cat.layers[i] for i in ("flood-2023-observed", "osm-assets", "grid3-settlements"))


def test_screen_sql_uses_catalogue_classes_and_filter():
    sql, params = screen_sql(FLOOD, SETTLEMENTS)
    assert params["primary"] == ["flooded"] and params["secondary"] == ["ambiguous"]
    assert params["hfilter"] == "flood_2023_observed"
    assert '"hazard_features"' in sql and '"settlements"' in sql and ":hfilter" in sql


def test_water_assets_are_context_via_lookup():
    sql = status_sql(ASSETS)
    assert "'context'" in sql and '"asset_types"' in sql and "'water'" in sql


def test_settlements_have_no_context_status():
    assert "'context'" not in status_sql(SETTLEMENTS)


@pytest.mark.parametrize("query", [
    "hazard=osm-assets&exposure=grid3-settlements",          # an exposure layer is not a hazard
    "hazard=flood-2023-observed&exposure=dem-glo30",         # a raster is not screenable exposure
    "hazard=no-such-layer&exposure=osm-assets",
])
def test_screen_rejects_unscreenable_pairs(query):
    assert client.get(f"/screen?{query}").status_code == 404


def test_screen_rejects_out_of_range_near():
    assert client.get("/screen?hazard=flood-2023-observed&exposure=osm-assets&near_m=99999").status_code == 422


def test_hazard_without_primary_class_is_refused(tmp_path):
    (tmp_path / "layers").mkdir()
    (tmp_path / "sources.json").write_text((CATALOG_DIR / "sources.json").read_text(encoding="utf-8"), encoding="utf-8")
    record = json.loads((CATALOG_DIR / "layers" / "flood-2023-observed.json").read_text(encoding="utf-8"))
    for c in record["classes"]:
        c.pop("screening_level", None)
    (tmp_path / "layers" / "flood-2023-observed.json").write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ValueError, match="primary"):
        load_catalog(tmp_path)


def test_unsafe_column_name_is_refused(tmp_path):
    (tmp_path / "layers").mkdir()
    (tmp_path / "sources.json").write_text((CATALOG_DIR / "sources.json").read_text(encoding="utf-8"), encoding="utf-8")
    record = json.loads((CATALOG_DIR / "layers" / "osm-assets.json").read_text(encoding="utf-8"))
    record["storage"]["table"] = 'assets"; DROP TABLE assets; --'
    (tmp_path / "layers" / "osm-assets.json").write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ValueError, match="pattern"):
        load_catalog(tmp_path)
