# GeoPulse Intelligence

[![CI](https://github.com/Abdul-Sobbur/geopulse-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/Abdul-Sobbur/geopulse-intelligence/actions/workflows/ci.yml)

**A geospatial decision-support platform for infrastructure, environmental and climate-risk screening.**
Pilot area: the **Lower Volta corridor, Ghana** (Akosombo to the Ada estuary, eight districts, ≈5,110 km²), on an architecture designed to scale nationally.

> **Status: working prototype (v1.0, local development).** This is a portfolio project. Outputs are *preliminary screening information*, not engineering certification, regulatory advice, an official flood map or a damage assessment. See [Limitations](#limitations).

![GeoPulse map showing the observed 2023 flood layer and asset exposure screening](docs/images/geopulse-screening.png)

---

## What it does

GeoPulse brings asset locations, settlement footprints, an observed flood layer, terrain, land cover and source information together, so that planners, engineers and environmental analysts can answer questions like:

- *Which roads, bridges, facilities and settlements lay in or near water observed during the 2023 Akosombo/Kpong dam spillage flooding?*
- *What lies within 1 km of this point, and how much observed flooding is inside that circle?*
- *How do three candidate sites compare on slope, land cover, access, nearby communities and flood exposure?*
- *Where did each number come from, what kind of number is it, and what are its limits?*

### All six modules are implemented

| Module | What works |
|---|---|
| **1. Infrastructure Asset Intelligence** | Interactive map of 1,296 OpenStreetMap assets (roads, bridges, waterways, water bodies, places, schools, health facilities, power infrastructure) and 4,705 GRID3 settlement footprints; category toggles; district filter; name search with zoom-to-result; popups with source links, snapshot dates and coverage warnings |
| **2. Environmental Risk Screening** | Observed flood layer for October 2023 derived from Sentinel-1 radar, with an "ambiguous seasonal water" class; exposure screening of assets and settlement footprints (in flood / in ambiguous water / near / not flagged); method, dates and limitations shown in the interface |
| **3. Spatial Proximity** | Click any point and list everything within 250 m – 5 km, nearest first, with counts by type and observed flood hectares inside the circle; user-selected screening distance (100 m – 1 km) |
| **4. Environmental & Operational Dashboard** | Headline indicators, per-district bar charts and tables, assets by type, and a **metric definitions** table that labels every figure as an observation, a modelled estimate or a derived value |
| **5. Monitoring & Reporting** | Screening reports as a printable page (save as PDF), a CSV + metadata zip, or GeoJSON, each recording scope, generation time, software version, sources, method, status definitions and limitations |
| **6. Project & Site Comparison** | Compare up to four candidate sites on 16 separately displayed criteria (elevation, slope, land cover, access, communities, services, water, flood constraint), downloadable as CSV. **No composite score or ranking is calculated**, because whether a value is favourable depends on the project |

---

## Example results: 2023 flood screening

Using the observed flood layer and a 250 m "near" distance:

- **Observed new water ≈38–78 km².** The lower bound counts only flooding attributable to the event. The upper bound adds new water in places that historically hold water seasonally (e.g. the Songor lagoon and salt pans in Ada West).
- **165 settlement footprints intersect attributable flooding**, a further 17 intersect ambiguous seasonal water, and 453 lie within 250 m. The most affected are North Tongu (42), South Tongu (25) and Ada East (23), consistent with reports naming the Tongu districts as worst affected.
- **2 hospitals** (Battor Catholic Mission Hospital and Comboni Hospital) and **5 education facilities** lie within ~250 m of observed new water. **56 major road segments** are near it, and 2 lie partly inside it.
- When settlements were represented only as **village-centre points, none intersected the flood**. Footprints revealed 165. This is a concrete example of why representation matters in exposure screening.

All figures are preliminary, likely under-estimates (radar misses water under vegetation and among buildings), and have not been validated against field data.

---

## Architecture

```
Source data ──► Python processing & validation ──► PostgreSQL + PostGIS ──► FastAPI ──► React + MapLibre
(HDX, OSM, GRID3,  (geopandas, pyogrio, rasterio,      (spatial tables,          (GeoJSON,    (map, panels,
 Sentinel-1, DEM,   Google Earth Engine)                 indexes, screening)       reports)     dashboard)
 WorldCover)
```

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript (Vite), MapLibre GL JS, OpenFreeMap basemap |
| API | Python, FastAPI, SQLAlchemy, rasterio |
| Spatial database | PostgreSQL 17 + PostGIS |
| Data processing | geopandas, pyogrio, rasterio, Google Earth Engine Python API |
| Packaging | Docker + Docker Compose |
| Automation | GitHub Actions: ruff, pytest, ESLint, production build, Docker image builds |

**Design principles:**
- **The pilot is data, not code.** The pilot is a list of official district P-codes in `config/pilot_lower_volta.json`. All 260 districts of Ghana are loaded, so extending coverage is a configuration change.
- **Traceability.** Every asset stores its source dataset, its exact OpenStreetMap object reference and its snapshot date. Every settlement stores its GRID3 reference. The flood layer stores its full method metadata: parameters, dates and Sentinel-1 scene IDs.
- **Uncertainty is visible.** Coverage warnings, the "ambiguous water" class, metric kinds and the limitations panel are stored as data and shown in the interface and in every report.
- **Distances are geodesic.** Data is stored in EPSG:4326, and distances and areas use PostGIS `geography`. The pilot straddles UTM zones 30N/31N, so a single UTM zone would not scale nationally.
- **Index-assisted spatial queries.** Proximity uses a bounding-box pre-filter on the spatial index, then exact geodesic distances; nearest-neighbour searches use the PostGIS `<->` operator.

### Database tables

| Table | Contents |
|---|---|
| `admin_boundaries` | All 260 Ghana districts (COD-AB) with P-codes |
| `pilot_districts` | Which districts belong to which pilot |
| `assets` / `asset_types` | Unified asset table with source, reference, snapshot date and district; type lookup with coverage warnings |
| `settlements` | GRID3 settlement footprints with type, building count, probability and district |
| `hazard_layers` / `hazard_features` | Hazard layer metadata (method, dates, parameters, limitations) and polygons by class |
| `asset_hazard_screening` / `settlement_hazard_screening` | Per-feature distances to hazard classes, flooded length (assets) and flooded area (settlements) |

### API endpoints

| Endpoint | Returns |
|---|---|
| `GET /health` | API and database status |
| `GET /asset-types` | Asset types with counts and coverage warnings |
| `GET /assets?asset_type=&pcode=&limit=` | Assets as GeoJSON |
| `GET /settlements?pcode=` | Settlement footprints as GeoJSON |
| `GET /pilots/{pilot_id}/districts` | Pilot districts as GeoJSON with bounding box |
| `GET /hazards` / `GET /hazards/{id}/features` | Hazard layers with method and limitations; hazard polygons |
| `GET /screening/{id}?near_m=` | Exposure status of every asset |
| `GET /screening/{id}/settlements?near_m=` | Exposure status of every settlement footprint |
| `GET /proximity?lon=&lat=&radius_m=` | Everything within a radius of a point, plus flood area inside it |
| `GET /sites/compare?site=lon,lat&site=…&radius_m=` | Candidate site comparison (1–4 sites) |
| `GET /dashboard?near_m=&pcode=` | Indicators by district and asset type, with metric definitions |
| `GET /reports/screening/{id}?format=html\|csv\|geojson&near_m=&pcode=` | Screening report with full metadata |

Interactive API documentation is at `http://127.0.0.1:8000/docs` when the API is running.

---

## Data sources

| ID | Dataset | Provider | Licence | Use |
|---|---|---|---|---|
| D-01 | Ghana Subnational Administrative Boundaries (COD-AB) | Ghana Statistical Service via OCHA HDX | CC BY-IGO 3.0 | Districts, P-codes, pilot extent |
| D-02 | OpenStreetMap Ghana extract (snapshot 2026-10-31) | OpenStreetMap contributors via Geofabrik | ODbL 1.0 | Assets |
| D-04 | GRID3 GHA Settlement Extents v3.0 | CIESIN, Columbia University (GRID3) | To be confirmed from the release notes | Settlement footprints |
| D-05 | Copernicus DEM GLO-30 (2024_1) | ESA / Copernicus | Copernicus DEM licence | Slope mask; terrain criteria |
| D-06 | ESA WorldCover 10 m 2021 (v200) | ESA WorldCover consortium | CC BY 4.0 | Land-cover criteria |
| D-07 | Sentinel-1 GRD | ESA / Copernicus | Copernicus open data | Flood mapping input |
| D-08 | Observed new water, Oct 2023 | Derived in this project from D-07 | Derived | Hazard layer |
| — | JRC Global Surface Water 1.4 | European Commission JRC | See provider terms | Permanent / recurrent water masks |
| — | Basemap | OpenFreeMap (OpenStreetMap data) | See provider terms | Background map |

Full metadata, coverage findings and known limitations for each dataset are in [`docs/data-inventory.md`](docs/data-inventory.md).

**Attribution:** © OpenStreetMap contributors. Contains modified Copernicus Sentinel data (2023). Boundaries: Ghana Statistical Service via OCHA HDX. Settlement footprints: CIESIN, Columbia University (2024), GRID3 GHA Settlement Extents v3.0. © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.

---

## Flood mapping method (summary)

Sentinel-1 VV radar change detection in Google Earth Engine, adapted from UN-SPIDER's Recommended Practice:

1. For each of two ascending orbit tracks (relative orbits 147 and 74), compare a single flood-date image (16 and 23 Oct 2023 respectively) with the **median of five pre-event scenes** (19 Jul – 10 Sep 2023, before the controlled spillage began on 15 Sep 2023).
2. Flag pixels with strong darkening (ratio > 1.25) that are also dark in the flood image (< −15 dB).
3. Remove permanent water (JRC GSW), slopes > 5°, and clusters smaller than 8 pixels.
4. Classify new water in places that historically hold water ≥10% of the time as **ambiguous**, rather than counting it as event flooding.
5. Combine both tracks, which together give 100% coverage of the pilot.

All parameters and scene IDs are recorded in the output metadata. Thresholds are standard starting values and have not been validated against field data.

---

## Limitations

- **The flood layer shows water observed on two dates**, not peak extent and not a single moment in time.
- **Radar under-detects flooding** under dense vegetation and among buildings, so the flood extent is likely an **under-estimate**. Flooded area *inside* settlements is especially under-counted.
- **OpenStreetMap coverage is uneven.** Health facilities and power infrastructure are sparsely mapped in the pilot, and the interface warns about this. **Absence of a feature on the map is not absence on the ground.**
- **Source tagging errors exist.** For example, Kpong Generating Station is tagged in OSM as a substation. Source data is kept as published, with its reference, rather than silently corrected.
- **Settlement building counts cover whole settlements.** "Buildings in settlements touching flood" is context, never a count of flooded buildings.
- **The DEM is a surface model** (it includes trees and buildings), so elevation and slope are indicative only.
- **Distances are straight-line**, not travel distances.
- **Screening flags proximity, not damage.** Features that are not flagged are not confirmed safe.

---

## Running it locally

### Prerequisites
- PostgreSQL 17 with PostGIS
- [Miniforge](https://github.com/conda-forge/miniforge) (conda with conda-forge)
- Node.js 24 and npm
- Git
- A Google Earth Engine cloud project registered for non-commercial use (for the flood and raster steps)

### 1. Clone and set up the Python environment
```bash
git clone https://github.com/Abdul-Sobbur/geopulse-intelligence.git
cd geopulse-intelligence
conda env create -f environment.yml
conda activate geopulse
```

### 2. Configure settings
Copy `.env.example` to `.env` and fill in your values. `.env` is ignored by Git and never committed.
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=geopulse
DB_USER=postgres
DB_PASSWORD=change_me
GEE_PROJECT=your-earth-engine-project-id
```

### 3. Create the database
```bash
psql -U postgres -c "CREATE DATABASE geopulse;"
psql -U postgres -d geopulse -c "CREATE EXTENSION postgis;"
```

### 4. Download source data (not included in the repository)
- **Boundaries:** the shapefile zip from the HDX dataset *Ghana – Subnational Administrative Boundaries*, extracted into `data/raw/boundaries/`.
- **OpenStreetMap:** a Ghana `.osm.pbf` extract from Geofabrik in `data/raw/osm/`; set its path and snapshot date in `config/pilot_lower_volta.json`.
- **Settlements:** *GRID3 GHA – Settlement Extents v3.0* from HDX, extracted into `data/raw/grid3/`.

### 5. Run the data pipeline (from the project root)
```bash
python scripts/load_admin_boundaries.py     # districts + pilot definition
python scripts/load_osm_assets.py           # OSM assets
python scripts/load_grid3_settlements.py    # GRID3 settlement footprints
earthengine authenticate                    # one-time
python scripts/s1_flood_extent.py           # flood layer (Earth Engine)
python scripts/load_flood_layer.py          # flood polygons into PostGIS
python scripts/screen_flood_exposure.py     # asset exposure screening
python scripts/screen_settlement_flood.py   # settlement exposure screening
python scripts/download_site_rasters.py     # DEM + land cover for site comparison
```
Optional inspection scripts: `inspect_boundaries.py`, `inspect_osm.py`, `inspect_grid3.py`, `s1_scene_inventory.py`.

### 6. Start the API and the web app (two terminals)
```bash
cd backend && uvicorn app.main:app --reload
```
```bash
cd frontend && npm install && npm run dev
```
Open `http://localhost:5173`.

---

## Run with Docker

Docker Compose starts the database, API and web app together. The database is loaded from a one-time export of your local database, and the site-comparison rasters are mounted read-only.

```bash
# 1. Export the local database (after running the pipeline above)
mkdir -p data/processed/db_dump
pg_dump -U postgres -d geopulse --no-owner --no-privileges -f data/processed/db_dump/geopulse.sql

# 2. Build and start everything (DB_PASSWORD is read from .env)
docker compose up --build
```
Open `http://localhost:8080`. The API is on `http://localhost:8000` and the database on port `5433`. Stop any locally running API first, so that port 8000 is free.

---

## Tests and automated checks

GitHub Actions runs on every push to `main` and on every pull request:

| Job | Checks |
|---|---|
| Backend | `ruff check` (lint) and `pytest`: input validation, report summaries, rounding rules, and terrain / land-cover calculations against synthetic rasters with known answers |
| Frontend | `npm run lint` (ESLint), then the type-check and production build |
| Docker | Builds the API and web images |

Run the backend checks locally:
```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
ruff check . && pytest -q
```

---

## Project structure

```
geopulse-intelligence/
├── backend/
│   ├── app/                 FastAPI application (main.py, db.py)
│   ├── tests/               Unit tests (no database needed)
│   ├── Dockerfile
│   └── requirements*.txt
├── frontend/                React + TypeScript + MapLibre app (Vite) and its Dockerfile
├── scripts/                 Data loading, inspection, flood mapping, screening and raster downloads
├── config/                  Pilot definition and data source settings
├── docs/                    Data inventory and images
├── data/                    Raw and processed data (ignored by Git)
├── docker-compose.yml
├── .github/workflows/ci.yml
├── environment.yml          Python environment for the data pipeline
└── .env.example             Settings template
```

---

## Roadmap

- [x] Module 1: asset map, search, filters, provenance
- [x] Module 2: observed flood layer and exposure screening (assets and settlement footprints)
- [x] Module 3: proximity queries
- [x] Module 4: dashboard with metric definitions
- [x] Module 5: printable, CSV and GeoJSON screening reports
- [x] Module 6: candidate site comparison
- [x] Docker Compose and automated checks (GitHub Actions)
- [ ] Confirm the GRID3 v3.0 licence and record it in the data inventory
- [ ] Validate the flood layer against reported affected communities
- [ ] Secondary use cases: road-access screening, land-cover change, Ada shoreline change
- [ ] Hosted demonstration (after security, licensing and cost review)

---

## Licence

Code: MIT (see `LICENSE`). Data remains under the licences of its original providers (see [Data sources](#data-sources)). Derived OpenStreetMap data is subject to the ODbL.

## Author

**Abdul-Sobbur**: civil engineering, GIS and remote sensing.
