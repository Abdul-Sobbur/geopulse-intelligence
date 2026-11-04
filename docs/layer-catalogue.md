# Layer catalogue

Every map layer in GeoPulse is described by one JSON file in `backend/catalog/layers/`, and every
dataset by one entry in `backend/catalog/sources.json`. The rules live in `backend/app/catalog.py`;
CI fails if any file breaks them. The API serves the catalogue at `/catalog` and
`/catalog/layers/{id}`.

## Fields

| Field | Meaning | Allowed values |
| --- | --- | --- |
| `id` | Short name; must match the file name | lower case, digits, `-` or `_` |
| `title`, `summary` | Name and one plain sentence for non-specialists | text |
| `theme` | Where it sits in the menus | boundaries, people, infrastructure, water, land, climate, terrain |
| `role` | Its part in risk = hazard × exposure × vulnerability, reduced by capacity | hazard, exposure, vulnerability, capacity, context |
| `evidence` | How much to trust it | Observation, Modelled estimate, Derived |
| `geometry` | What it is drawn as | polygon, line, point, mixed, raster |
| `status`, `version` | Whether it is in use | live, planned, retired |
| `coverage` | Where it applies | `scope` pilot (with `pilot_id`) or national; `country` ISO code |
| `temporal` | When it describes | static, snapshot, event, period, with dates |
| `sources` | Which datasets it comes from | IDs from `sources.json`, at least one |
| `method` | How it was made | text |
| `limitations` | What it cannot tell you | at least one; never empty |
| `storage` | Where the data is | postgis (`table`, optional `where`), raster or pmtiles (`path`) |
| `style`, `classes` | How it is drawn and what each value means | hex colours |
| `screening` | Whether the screening engine may use it | hazard or exposure (must match `role`) |

Sources record the licence, whether it has been confirmed (`licence_confirmed`), and the exact
attribution line the provider asks for.

## Adding a layer

1. Add any new dataset to `sources.json` with its licence and attribution (and to `docs/data-inventory.md`).
2. Copy an existing layer file, rename it to the new `id`, and fill in every field.
3. Check it from the `backend` folder: `python -m app.catalog`.
4. Run `pytest`; commit when it passes.
