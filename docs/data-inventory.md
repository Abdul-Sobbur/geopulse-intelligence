# GeoPulse Intelligence — Data Inventory

**Pilot:** Lower Volta corridor, Ghana (Akosombo → Ada estuary)
**Status:** v1.0 (2 Nov 2026). All datasets used in the platform (D-01, D-02, D-04 to D-08) downloaded or produced and inspected. Open item: confirm the D-04 licence. Fields marked *(confirm on download)* must be filled in from the actual files.
**Rule:** No dataset enters PostGIS until its row below is complete.

---

## 1. Pilot extent (agreed)

Eight riparian districts, defined by official P-codes from D-01 (see `config/pilot_lower_volta.json`). Total area ≈ 5,110 km² (geodesic, computed in PostGIS).

| P-code | District (as named in D-01) | Region |
|---|---|---|
| GH0608 | Asuogyaman | Eastern |
| GH0624 | Lower Manya | Eastern |
| GH0726 | Shai Osudoku | Greater Accra |
| GH0705 | Ada East | Greater Accra |
| GH0706 | Ada West | Greater Accra |
| GH1416 | North Tongu | Volta |
| GH1407 | Central Tongu | Volta |
| GH1418 | South Tongu | Volta |

> **Known coverage gap:** Humanitarian reports on the 2023 spillage list **Anlo** among the affected districts (lagoon overflow near Keta). It is outside the current extent by decision; it can be added later by editing the pilot config.

---

## 2. Release 1 datasets (Use case A — flood exposure screening)

| ID | Dataset | Provider | Access route | Licence / terms | Temporal ref. | Resolution / scale | Native CRS | Role in platform |
|---|---|---|---|---|---|---|---|---|
| D-01 | Ghana Subnational Administrative Boundaries (COD-AB), admin 0–2 | Ghana Statistical Service; published by OCHA/HDX | data.humdata.org/dataset/cod-ab-gha — file `ghana_admin_boundaries.shp.zip`, layer `gha_admin2.shp` (standard, not `_em`); acquired 2026-11-01 | CC BY-IGO 3.0 *(re-confirm on HDX page — dataset was recently republished)* | See `valid_on` / `version` fields | Admin level 2 = 260 districts; 0 invalid geometries | EPSG:4326 (confirmed) | Pilot extent; geography IDs (P-codes) for national scaling. Loaded to PostGIS table `admin_boundaries` |
| D-02 | OpenStreetMap Ghana extract (roads, waterways, water bodies, places, POIs) | OpenStreetMap contributors via Geofabrik | download.geofabrik.de/africa/ghana — file `ghana-261031.osm.pbf` (~117 MB); acquired 2026-11-01 | ODbL 1.0 (attribution + share-alike for derived databases) | Snapshot 2026-10-31 | Variable (crowd-sourced) | EPSG:4326 (confirmed) | Asset inventory (M1), proximity targets (M3) |
| D-03 | OSM power infrastructure (plants, substations, high-voltage lines) | OpenStreetMap contributors (from D-02 or Overpass) | As D-02 | ODbL 1.0 | As D-02 | Variable | EPSG:4326 | Energy assets — **public, already-mapped features only**, screening-level detail |
| D-04 | GRID3 GHA Settlement Extents v3.0 | GRID3 / CIESIN, Columbia University | HDX dataset "GRID3 GHA - Settlement Extents v3.0" — file `grid3_gha_settlement_extents_v3_0.zip`, layer `GRID3_GHA_Settlement_Extents_v3_0` (GeoPackage, 228,980 polygons nationally); acquired 2026-11-02 | **To confirm from the release notes.** Other countries' v3 releases are CC BY-SA 4.0; treat as attribution + share-alike until confirmed | `date` field = 2024 | Settlement polygons (generalised, ~100 m); types: Built-up Area, Small Settlement Area, Hamlet; per-polygon building count, building area and probability | EPSG:4326 (confirmed) | Settlement footprints for exposure screening. Loaded to PostGIS table `settlements` (4,705 polygons whose interior point lies in the pilot; 0 invalid geometries) |
| D-05 | Copernicus DEM GLO-30 (release 2024_1) | ESA / Copernicus (© DLR, Airbus) | Earth Engine `COPERNICUS/DEM/GLO30_2024_1` (supersedes `COPERNICUS/DEM/GLO30`) | Copernicus WorldDEM-30 free licence; attribution notice required | Acquired 2011–2015 | 30 m | EPSG:4326 | Slope mask for D-08 (M2); terrain criteria (M6). Local copy for site comparison: `data/processed/site_rasters/dem_glo30_pilot.tif` (~30 m, int16, pilot bbox + 0.05°) via `scripts/download_site_rasters.py` |
| D-06 | ESA WorldCover 10 m 2021 (v200) | ESA WorldCover consortium | Earth Engine `ESA/WorldCover/v200` | CC BY 4.0 | 2021 | 10 m | EPSG:4326 | Land-cover criteria (M6). Local copy: `data/processed/site_rasters/worldcover2021_pilot.tif` (nearest-neighbour resampled to ~20 m, pilot bbox + 0.05°) via `scripts/download_site_rasters.py` |
| D-07 | Sentinel-1 GRD (SAR), IW mode, VV | ESA / Copernicus (Sentinel-1A only in 2023) | Earth Engine `COPERNICUS/S1_GRD`, project `ee-aasobbur`; scene list from `scripts/s1_scene_inventory.py` | Copernicus Sentinel data — free and open *(record exact terms)* | Two ascending tracks (rel. orbits 74 and 147), each covering ~65–69% of the pilot. Pre-event: 5 scenes per track, 19 Jul – 10 Sep 2023. Flood: track 147 on 2023-10-16, track 74 on 2023-10-23 | 10 m | EPSG:4326 | Input to D-08 |
| D-08 | **2023 Lower Volta observed flood extent (derived)** | GeoPulse (own processing of D-07) | `scripts/s1_flood_extent.py` (Earth Engine, project `ee-aasobbur`); outputs `data/processed/flood_2023/` (GeoTIFF + metadata JSON with all parameters and scene IDs) | Derived from D-07; ancillary JRC Global Surface Water 1.4 and D-05 | Union of two observation dates: 2023-10-16 (track 147) and 2023-10-23 (track 74) — not a single-date snapshot and not necessarily peak extent | 20 m grid (0.00018°) | EPSG:4326 | Hazard overlay for screening (M2). Classes: 1 flooded, 2 observed dry, 3 no coverage, 4 permanent water, 5 new water in recurrent seasonal water body (ambiguous) |

### Observed OSM coverage inside the pilot (snapshot 2026-10-31, `scripts/inspect_osm.py`)

| Feature type | Count | Fitness for Release 1 |
|---|---|---|
| Road segments (all) | 10,605 | Strong |
| — major (motorway–tertiary) | 341 | Strong |
| — tagged bridges | 68 | Usable; check key crossings are present |
| Waterway lines | 230 | Usable |
| Water-body polygons | 197 | Usable |
| Places (village 202, town 39, hamlet 39, other 26) | 306 | Usable; complement with GRID3 extents (D-04) |
| Education facilities | 126 | Moderate; completeness unknown |
| Health facilities | 17 | **Sparse — likely incomplete**; show with a visible coverage warning |
| Power plants / substations / line segments | 1 / 7 / 43 | **Sparse — likely incomplete**; public features only, coverage warning |

Counts are raw OSM features: road and power counts are way *segments*, not route-km; facilities may be double-counted where mapped as both point and area.

### D-08 first results (run 2026-11-02)

Sentinel-1 coverage: 100% of every pilot district (two tracks combined).

| P-code | District | Flooded km² (attributable) | Ambiguous km² (recurrent seasonal water) |
|---|---|---|---|
| GH0608 | Asuogyaman | 1.1 | 0.9 |
| GH0624 | Lower Manya | 0.5 | 0.1 |
| GH0705 | Ada East | 5.8 | 8.8 |
| GH0706 | Ada West | 1.7 | 16.1 |
| GH0726 | Shai Osudoku | 5.8 | 1.1 |
| GH1407 | Central Tongu | 4.1 | 4.2 |
| GH1416 | North Tongu | 11.7 | 5.9 |
| GH1418 | South Tongu | 7.7 | 3.0 |
| | **Total** | **38.4** | **40.1** |

Interpretation: observed new water is best reported as a **range of ~38–78 km²**. The lower bound counts only attributable flooding; the upper bound adds new water in places that historically held water at least 10% of the time (JRC GSW occurrence). In Ada West the ambiguous class is dominated by the Songor lagoon / salt-pan area; along the Tongu floodplain much of the ambiguous class may be genuine event flooding on ground that has flooded before. Both bounds are likely under-estimates (radar misses water under vegetation and among buildings).

### D-04 settlement screening against D-08 (run 2026-11-02, near = 250 m)

| Settlement type | In pilot | Footprint intersects attributable flood | Intersects ambiguous water | Near (≤250 m) |
|---|---|---|---|---|
| Hamlet | 4,155 | 92 | 12 | 366 |
| Small Settlement Area | 534 | 67 | 5 | 82 |
| Built-up Area | 16 | 6 | 0 | 5 |
| **Total** | **4,705** | **165** | **17** | **453** |

By district, settlements intersecting attributable flood: North Tongu 42, South Tongu 25, Ada East 23, Shai Osudoku 22, Asuogyaman 21, Central Tongu 18, Ada West 12, Lower Manya 2. No intersecting settlement has GRID3 probability < 0.5.

Interpretation: the **count of settlements intersecting observed water** is the meaningful figure. Flooded area *inside* settlements (≈0.7 km²) is an under-estimate because radar misses water among buildings. Buildings in intersecting settlements (≈84,700) is an upper-bound context figure only, dominated by six built-up areas, and must never be reported as "buildings flooded".

### Required attribution strings
- **D-01:** Ghana Statistical Service, via OCHA HDX (CC BY-IGO).
- **D-02/D-03:** © OpenStreetMap contributors (ODbL).
- **D-04:** Center for International Earth Science Information Network (CIESIN), Columbia University. 2024. GRID3 GHA - Settlement Extents v3.0. New York: GRID3.
- **D-05:** "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" *(verify exact wording against licence before publishing)*.
- **D-06:** © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.
- **D-07/D-08:** Contains modified Copernicus Sentinel data (2023).

---

## 2b. Wave 1 datasets (people and buildings)

| ID | Dataset | Provider | Access route | Licence / terms | Temporal ref. | Resolution | Role in platform |
|---|---|---|---|---|---|---|---|
| D-09 | WorldPop Global2 population, R2025A v1 | WorldPop, University of Southampton | Earth Engine `WorldPop/GP/100m/R2025A/v1/pop`, country GHA, year 2023 | CC BY 4.0 | 2023 (annual series 2015-2030) | 100 m (3 arc-seconds) | Population per district and in observed flood water; the grid all Wave 1 rasters are aligned to |
| D-10 | GHS-POP R2023A | European Commission, JRC | Earth Engine `JRC/GHSL/P2023A/GHS_POP/2020` and `/2025` | Free reuse with acknowledgement *(record exact terms)* | 2020 estimate and 2025 projection, linearly interpolated to 2023 | 100 m Mollweide, moved to the D-09 grid by density x cell area | Second, independent population model, so exposure is reported as a range |
| D-11 | Google Open Buildings v3 | Google Research | Earth Engine `GOOGLE/Research/open-buildings/v3/polygons` | CC BY 4.0 | Imagery inference May 2023 | Building polygons, counted per 100 m cell by centroid | Buildings per district and in observed flood water, at confidence 0.65 and 0.75 |

Produced by `scripts/download_people_rasters.py` (Earth Engine) and `scripts/people_exposure.py` (local), into the `district_indicators` table.

## 3. Known limitations (must be visible in the app)

- **D-02/D-03 OSM:** completeness varies by area; a missing road, facility or power line is not proof of absence. Attribute quality is uneven.
- **D-03 power assets:** only already-public OSM features; no attempt to locate or detail unmapped critical infrastructure.
- **D-04 GRID3:** settlement extents are modelled from imagery; they are not administrative boundaries, and they contain false positives and omissions.
- **D-05 DEM:** it is a surface model (includes trees and buildings), not bare earth; vertical error is significant in flat floodplains. It is not suitable for flood-depth estimation.
- **D-06 WorldCover:** 2020 (v100) and 2021 (v200) use different algorithms, so differencing them is **not** valid change detection (relevant to Use case D).
- **D-09/D-10 population:** modelled estimates of where people usually live, not counts; the two models disagree, so exposure is shown as a range. Exposure assumes people are spread evenly within each 100 m cell. GHS-POP for 2023 is interpolated between a 2020 estimate and a 2025 projection.
- **D-11 buildings:** machine-detected footprints with false positives and misses; results at two confidence thresholds bracket the count. A building in flood water is not a damaged building.
- **D-08 flood extent:** shows water observed on specific satellite pass dates only. It is not a hazard model, not a return-period map, and not peak extent. SAR misses flooding under dense vegetation and in built-up areas. It needs validation against reported affected communities.
- **D-01 boundaries:** check whether any district changes since the boundaries' validity date affect the pilot. Names differ from common usage (e.g. "Lower Manya" for Lower Manya Krobo) — always join on P-code, never on name.
- **D-02 health and power coverage:** very few features are mapped inside the pilot. Absence on the map must not be read as absence on the ground.

---

## 4. Later releases (not Release 1)

| Dataset | For | Note |
|---|---|---|
| WorldPop / GRID3 population estimates | Exposure counts (M4) | Report as modelled estimates, aggregated |
| Sentinel-2 / Landsat time series | Use case D — land-cover change | Consistent own classification across years |
| Multi-date imagery, coastline | Use case E — Ada shoreline | Specialist method; stretch goal |
| Routable road network (from OSM) | Use case B — access | Only if network connectivity checks pass |

---

## 5. Storage and CRS decision (proposed)

- Store all vectors in PostGIS as **EPSG:4326**.
- Calculate distances and areas with PostGIS **geography** (geodesic) casts. Reason: the corridor straddles UTM zones 30N/31N and Ghana as a whole spans both, so a single UTM zone would not scale nationally.
- Keep rasters (DEM, land cover, flood extent) clipped to the pilot extent plus a buffer.

---

## 6. Metadata record template (one per dataset)

```
id:
title:
provider / publisher:
source URL / access route:
licence / terms:
date acquired:
temporal reference:
spatial resolution / scale:
coordinate reference system:
processing history:
known limitations:
maintainer:
```
