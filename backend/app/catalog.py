"""GeoPulse layer catalogue.

Every map layer the platform serves is described by one JSON file in `catalog/layers/`, and every
dataset it draws on by one entry in `catalog/sources.json`. The models below are the rules those
files must follow: the catalogue refuses a layer without a licensed source, an evidence label or at
least one stated limitation. The app, the API and later the pipelines all read layers from here.
"""
import json
import os
import re
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

CATALOG_DIR = Path(os.environ.get("CATALOG_DIR", Path(__file__).resolve().parents[1] / "catalog"))

Theme = Literal["boundaries", "people", "infrastructure", "water", "land", "climate", "terrain"]
Role = Literal["hazard", "exposure", "vulnerability", "capacity", "context"]
Evidence = Literal["Observation", "Modelled estimate", "Derived"]
Geometry = Literal["polygon", "line", "point", "mixed", "raster"]
Status = Literal["live", "planned", "retired"]

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
SLUG = r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$"


class Strict(BaseModel):
    """Unknown keys are errors, so a typo in a catalogue file cannot pass silently."""
    model_config = ConfigDict(extra="forbid")


class Source(Strict):
    id: str = Field(pattern=r"^D-\d{2}$", description="Data inventory ID, e.g. D-08")
    title: str
    provider: str
    url: HttpUrl | None = None
    licence: str = Field(min_length=2, description="Licence or terms; say 'to confirm' rather than guess")
    licence_confirmed: bool = Field(description="False until checked against the provider's own terms")
    attribution: str = Field(min_length=2, description="The credit line the provider asks for")
    acquired: date | None = None


class Coverage(Strict):
    scope: Literal["pilot", "national"]
    pilot_id: str | None = None
    country: str = Field(default="GH", pattern=r"^[A-Z]{2}$", description="ISO 3166-1 alpha-2")

    @model_validator(mode="after")
    def pilot_needs_id(self):
        if self.scope == "pilot" and not self.pilot_id:
            raise ValueError("a pilot-scope layer must name its pilot_id")
        return self


class Temporal(Strict):
    kind: Literal["static", "snapshot", "event", "period"]
    start: date | None = None
    end: date | None = None
    note: str | None = None

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.kind != "static" and self.start is None:
            raise ValueError(f"a '{self.kind}' layer needs a start date")
        if self.start and self.end and self.end < self.start:
            raise ValueError("end date is before start date")
        return self


class LayerClass(Strict):
    value: str | int
    label: str
    colour: str
    description: str | None = None

    @field_validator("colour")
    @classmethod
    def is_hex(cls, v):
        if not HEX.match(v):
            raise ValueError("colour must be #RRGGBB")
        return v


class Storage(Strict):
    kind: Literal["postgis", "raster", "pmtiles"]
    table: str | None = None
    where: str | None = Field(default=None, description="Fixed filter, e.g. hazard_id = 'flood_2023_observed'")
    path: str | None = None

    @model_validator(mode="after")
    def has_location(self):
        if self.kind == "postgis" and not self.table:
            raise ValueError("postgis storage needs a table")
        if self.kind in ("raster", "pmtiles") and not self.path:
            raise ValueError(f"{self.kind} storage needs a path")
        return self


class Style(Strict):
    colour: str | None = None
    opacity: float | None = Field(default=None, ge=0, le=1)
    dashed: bool = False

    @field_validator("colour")
    @classmethod
    def is_hex(cls, v):
        if v is not None and not HEX.match(v):
            raise ValueError("colour must be #RRGGBB")
        return v


class Layer(Strict):
    id: str = Field(pattern=SLUG)
    title: str
    summary: str = Field(description="One sentence a non-specialist can read")
    theme: Theme
    role: Role
    evidence: Evidence
    geometry: Geometry
    status: Status
    version: str
    coverage: Coverage
    temporal: Temporal
    sources: list[str] = Field(min_length=1, description="Source IDs from sources.json")
    method: str
    limitations: list[str] = Field(min_length=1, description="What this layer cannot tell you; never empty")
    storage: Storage
    style: Style = Style()
    classes: list[LayerClass] = []
    screening: Literal["hazard", "exposure"] | None = Field(
        default=None, description="Whether the screening engine may use it, and on which side")

    @model_validator(mode="after")
    def screening_matches_role(self):
        if self.screening == "hazard" and self.role != "hazard":
            raise ValueError("only a hazard layer can be screened as a hazard")
        if self.screening == "exposure" and self.role != "exposure":
            raise ValueError("only an exposure layer can be screened as exposure")
        return self


class Catalog(Strict):
    sources: dict[str, Source]
    layers: dict[str, Layer]

    @model_validator(mode="after")
    def references_resolve(self):
        for layer in self.layers.values():
            missing = [s for s in layer.sources if s not in self.sources]
            if missing:
                raise ValueError(f"layer '{layer.id}' cites unknown sources: {', '.join(missing)}")
        return self


def load_catalog(directory: Path = CATALOG_DIR) -> Catalog:
    """Read and validate every catalogue file; raise with the file name on the first error."""
    raw_sources = json.loads((directory / "sources.json").read_text(encoding="utf-8"))
    sources = {s["id"]: Source(**s) for s in raw_sources}
    if len(sources) != len(raw_sources):
        raise ValueError("sources.json has a duplicate ID")

    layers: dict[str, Layer] = {}
    for path in sorted((directory / "layers").glob("*.json")):
        try:
            layer = Layer(**json.loads(path.read_text(encoding="utf-8")))
        except Exception as err:  # noqa: BLE001 - re-raised with the file name for a readable error
            raise ValueError(f"{path.name}: {err}") from err
        if layer.id != path.stem:
            raise ValueError(f"{path.name}: id '{layer.id}' must match the file name")
        if layer.id in layers:
            raise ValueError(f"{path.name}: duplicate layer id '{layer.id}'")
        layers[layer.id] = layer
    return Catalog(sources=sources, layers=layers)


@lru_cache(maxsize=1)
def get_catalog() -> Catalog:
    return load_catalog()


if __name__ == "__main__":
    # From the backend folder:  python -m app.catalog   (checks every file and prints a summary)
    cat = load_catalog()
    print(f"Catalogue OK: {len(cat.layers)} layers, {len(cat.sources)} sources\n")
    for layer in cat.layers.values():
        print(f"  {layer.id:<22} {layer.theme:<15} {layer.role:<9} {layer.evidence:<18} {layer.status}")
    unconfirmed = [s.id for s in cat.sources.values() if not s.licence_confirmed]
    if unconfirmed:
        print(f"\nLicences still to confirm: {', '.join(unconfirmed)}")
