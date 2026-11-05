"""Reported impact figures and the /people endpoint's input checks (no database needed)."""
import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.catalog import CATALOG_DIR, load_catalog, load_references

client = TestClient(main.app)


def test_reported_figures_load_with_sources():
    refs = load_references("flood-2023-observed")
    assert refs and all(r.url and r.reported_by and r.published for r in refs)
    assert {r.within_pilot for r in refs} <= {"yes", "partly", "no"}


def test_layer_without_references_returns_empty():
    assert load_references("no-such-layer") == []


def test_reported_figure_without_source_is_refused(tmp_path):
    (tmp_path / "references").mkdir()
    record = json.loads((CATALOG_DIR / "references" / "flood-2023-observed.json").read_text(encoding="utf-8"))[0]
    record.pop("url")
    (tmp_path / "references" / "x.json").write_text(json.dumps([record]), encoding="utf-8")
    with pytest.raises(ValueError):
        load_references("x", tmp_path)


def test_people_rejects_overlong_pcode():
    assert client.get("/people?pcode=" + "X" * 30).status_code == 422


def _district(pcode, population, area, *, in_pilot=False, x=0.0):
    return {
        "pcode": pcode, "name": pcode, "region": "Volta", "population": population, "buildings": 10.4,
        "area_km2": area, "in_pilot": in_pilot,
        "geometry": '{"type":"Polygon","coordinates":[[[0,5],[1,5],[1,6],[0,5]]]}',
        "xmin": x, "ymin": 5.0, "xmax": x + 1, "ymax": 6.0,
    }


def test_national_collection_computes_density_and_totals():
    body = main.national_collection([_district("GH1", 1000.4, 10, in_pilot=True), _district("GH2", 500, 50, x=2)])
    first, second = (f["properties"] for f in body["features"])
    assert first["density"] == 100.0 and first["population"] == 1000 and first["in_pilot"] is True
    assert second["density"] == 10.0 and second["in_pilot"] is False
    assert body["bbox"] == [0.0, 5.0, 3.0, 6.0]
    assert body["totals"] == {"districts": 2, "with_estimates": 2, "population": 1500, "buildings": 21,
                              "area_km2": 60, "density": 25.0}


def test_national_collection_keeps_districts_without_estimates():
    body = main.national_collection([_district("GH1", None, 10)])
    props = body["features"][0]["properties"]
    assert props["population"] is None and props["density"] is None
    assert body["totals"]["with_estimates"] == 0 and body["totals"]["density"] is None


def test_national_density_ignores_districts_without_estimates():
    body = main.national_collection([_district("GH1", 1000, 10), _district("GH2", None, 990)])
    assert body["totals"]["density"] == 100.0 and body["totals"]["area_km2"] == 1000


def test_national_layer_is_in_the_catalogue():
    layer = load_catalog().layers["district-population"]
    assert layer.coverage.scope == "national" and layer.evidence == "Modelled estimate"
    assert any("census" in limit for limit in layer.limitations)
