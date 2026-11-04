"""The layer catalogue must always load: CI fails if any catalogue file breaks the rules."""
import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.catalog import CATALOG_DIR, load_catalog

client = TestClient(main.app)


def test_catalogue_loads_and_is_consistent():
    cat = load_catalog()
    assert cat.layers, "the catalogue has no layers"
    for layer in cat.layers.values():
        assert layer.limitations, f"{layer.id} states no limitations"
        assert all(s in cat.sources for s in layer.sources)


def test_screening_layers_are_live_in_postgis():
    cat = load_catalog()
    for layer in cat.layers.values():
        if layer.screening and layer.status == "live":
            assert layer.storage.kind == "postgis", f"{layer.id} is screened but not stored in PostGIS"


def test_catalogue_endpoint_filters_by_role():
    body = client.get("/catalog?role=hazard").json()
    assert body["layers"] and all(layer["role"] == "hazard" for layer in body["layers"])
    cited = {s for layer in body["layers"] for s in layer["sources"]}
    assert cited == {s["id"] for s in body["sources"]}


def test_catalogue_layer_endpoint():
    assert client.get("/catalog/layers/flood-2023-observed").status_code == 200
    assert client.get("/catalog/layers/no-such-layer").status_code == 404


@pytest.mark.parametrize("change, message", [
    (lambda d: d.update(limitations=[]), "limitations"),
    (lambda d: d.update(sources=["D-99"]), "unknown sources"),
    (lambda d: d.update(evidence="Guess"), "evidence"),
    (lambda d: d.update(colour="#22D3EE"), "Extra inputs"),
])
def test_catalogue_rejects_bad_layers(tmp_path, change, message):
    (tmp_path / "layers").mkdir()
    (tmp_path / "sources.json").write_text((CATALOG_DIR / "sources.json").read_text(encoding="utf-8"), encoding="utf-8")
    record = json.loads((CATALOG_DIR / "layers" / "flood-2023-observed.json").read_text(encoding="utf-8"))
    change(record)
    (tmp_path / "layers" / "flood-2023-observed.json").write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        load_catalog(tmp_path)
