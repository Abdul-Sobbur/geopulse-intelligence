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
| `storage` | Where the data is and which columns matter | postgis (`table`, `id_column`, `pcode_column`, `type_column`, `class_column` or `class_lookup`, optional `filter`), raster or pmtiles (`path`) |
| `style`, `classes` | How it is drawn and what each value means; hazard classes carry `screening_level` (primary or secondary), exposure classes can be `screened: false` | hex colours |
| `screening` | Whether the screening engine may use it | hazard or exposure (must match `role`) |

Sources record the licence, whether it has been confirmed (`licence_confirmed`), and the exact
attribution line the provider asks for.

## Adding a layer

1. Add any new dataset to `sources.json` with its licence and attribution (and to `docs/data-inventory.md`).
2. Copy an existing layer file, rename it to the new `id`, and fill in every field.
3. Check it from the `backend` folder: `python -m app.catalog`.
4. Run `pytest`; commit when it passes.

## Screening any hazard against any exposure

A hazard layer with `"screening": "hazard"` and an exposure layer with `"screening": "exposure"` can be
screened against each other with no new code:

```
python scripts/run_screening.py                                    # every live pair
python scripts/run_screening.py --hazard flood-2023-observed --exposure osm-assets
python scripts/check_screening.py                                  # compare with the original flood screening
```

For each exposure feature the `screening_results` table stores the distance to the nearest primary
and secondary hazard feature and the length or area inside each; `screening_runs` records when and
with which layer versions. The API's `/screen?hazard=…&exposure=…&near_m=…` turns those into
statuses at query time:

| Status | Rule |
| --- | --- |
| `in_primary` | Polygons: some area inside a primary class. Points and lines: touching one |
| `in_secondary` | The same for a secondary class, when not `in_primary` |
| `near` | Within `near_m` of either |
| `not_flagged` | Everything else; this does not mean safe |
| `context` | Features of a class marked `screened: false` (e.g. rivers and water bodies) |
