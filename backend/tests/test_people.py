"""Reported impact figures and the /people endpoint's input checks (no database needed)."""
import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.catalog import CATALOG_DIR, load_references

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
