# GeoPulse Intelligence — Data Inventory

**Pilot:** Lower Volta corridor, Ghana (Akosombo → Ada estuary)
**Status:** Draft v0.2 (1 Nov 2026). D-01 and D-02 downloaded and inspected; other rows are desk-checked only. Fields marked *(confirm on download)* must be filled in from the actual files.
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
| D-04 | GRID3 Ghana Settlement Extents v3 | GRID3 / CIESIN, Columbia University | grid3.org / HDX | *(confirm in release notes)* | Imagery mostly 2019–2020+; v3 published 2024 | Settlement polygons | *(confirm on download)* | Settlements for exposure and proximity |
| D-05 | Copernicus DEM GLO-30 | ESA / Copernicus (© DLR, Airbus) | Earth Engine `COPERNICUS/DEM/GLO30` | Copernicus WorldDEM-30 free licence; attribution notice required | Acquired 2011–2015 | 30 m | EPSG:4326 | Terrain/elevation context (M2, M6) |
| D-06 | ESA WorldCover 10 m 2021 (v200) | ESA WorldCover consortium | Earth Engine `ESA/WorldCover/v200` | CC BY 4.0 | 2021 | 10 m | EPSG:4326 | Land-cover context (M2, M6) |
| D-07 | Sentinel-1 GRD (SAR), IW mode, VV | ESA / Copernicus (Sentinel-1A only in 2023) | Earth Engine `COPERNICUS/S1_GRD`, project `ee-aasobbur`; scene list from `scripts/s1_scene_inventory.py` | Copernicus Sentinel data — free and open *(record exact terms)* | Two ascending tracks (rel. orbits 74 and 147), each covering ~65–69% of the pilot. Pre-event: 5 scenes per track, 19 Jul – 10 Sep 2023. Flood: track 147 on 2023-10-16, track 74 on 2023-10-23 | 10 m | EPSG:4326 | Input to D-08 |
| D-08 | **2023 Lower Volta observed flood extent (derived)** | GeoPulse (own processing of D-07) | Earth Engine processing, project `ee-aasobbur` | Derived from D-07; own method documented | Union of two observation dates: 2023-10-16 (track 147) and 2023-10-23 (track 74) — not a single-date snapshot and not necessarily peak extent | ~10–20 m | EPSG:4326 | Hazard overlay for screening (M2) |

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

### Required attribution strings
- **D-01:** Ghana Statistical Service, via OCHA HDX (CC BY-IGO).
- **D-02/D-03:** © OpenStreetMap contributors (ODbL).
- **D-05:** "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" *(verify exact wording against licence before publishing)*.
- **D-06:** © ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.
- **D-07/D-08:** Contains modified Copernicus Sentinel data (2023).

---

## 3. Known limitations (must be visible in the app)

- **D-02/D-03 OSM:** completeness varies by area; a missing road, facility or power line is not proof of absence. Attribute quality is uneven.
- **D-03 power assets:** only already-public OSM features; no attempt to locate or detail unmapped critical infrastructure.
- **D-04 GRID3:** settlement extents are modelled from imagery; they are not administrative boundaries, and they contain false positives and omissions.
- **D-05 DEM:** it is a surface model (includes trees and buildings), not bare earth; vertical error is significant in flat floodplains. It is not suitable for flood-depth estimation.
- **D-06 WorldCover:** 2020 (v100) and 2021 (v200) use different algorithms, so differencing them is **not** valid change detection (relevant to Use case D).
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
