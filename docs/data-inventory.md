# GeoPulse Intelligence — Data Inventory

**Pilot:** Lower Volta corridor, Ghana (Akosombo → Ada estuary)
**Status:** Draft v0.1 — sources identified and licences checked at desk level (1 Nov 2026). Fields marked *(confirm on download)* must be filled in from the actual files.
**Rule:** No dataset enters PostGIS until its row below is complete.

---

## 1. Pilot extent (agreed)

Eight riparian districts, selected from the official boundary dataset (D-01):

| Region | District |
|---|---|
| Eastern | Asuogyaman, Lower Manya Krobo |
| Greater Accra | Shai-Osudoku, Ada East, Ada West |
| Volta | North Tongu, Central Tongu, South Tongu |

> **Open point:** Humanitarian reports on the 2023 spillage list **Anlo** among the affected districts (lagoon overflow near Keta). It is outside the current extent. Decision needed: add it, or record it as a known coverage gap.

---

## 2. Release 1 datasets (Use case A — flood exposure screening)

| ID | Dataset | Provider | Access route | Licence / terms | Temporal ref. | Resolution / scale | Native CRS | Role in platform |
|---|---|---|---|---|---|---|---|---|
| D-01 | Ghana Subnational Administrative Boundaries (COD-AB), admin 0–2 | Ghana Statistical Service; published by OCHA/HDX | data.humdata.org/dataset/cod-ab-gha | CC BY-IGO 3.0 | Boundaries file dated 2021-03-08 | Admin level 2 = 260 districts | *(confirm on download)* | Pilot extent; geography IDs (P-codes) for national scaling |
| D-02 | OpenStreetMap Ghana extract (roads, waterways, water bodies, places, POIs, buildings) | OpenStreetMap contributors via Geofabrik | download.geofabrik.de/africa/ghana | ODbL 1.0 (attribution + share-alike for derived databases) | Daily snapshot — record extract date | Variable (crowd-sourced) | EPSG:4326 | Asset inventory (M1), proximity targets (M3) |
| D-03 | OSM power infrastructure (plants, substations, high-voltage lines) | OpenStreetMap contributors (from D-02 or Overpass) | As D-02 | ODbL 1.0 | As D-02 | Variable | EPSG:4326 | Energy assets — **public, already-mapped features only**, screening-level detail |
| D-04 | GRID3 Ghana Settlement Extents v3 | GRID3 / CIESIN, Columbia University | grid3.org / HDX | *(confirm in release notes)* | Imagery mostly 2019–2020+; v3 published 2024 | Settlement polygons | *(confirm on download)* | Settlements for exposure and proximity |
| D-05 | Copernicus DEM GLO-30 | ESA / Copernicus (© DLR, Airbus) | Earth Engine `COPERNICUS/DEM/GLO30` | Copernicus WorldDEM-30 free licence; attribution notice required | Acquired 2011–2015 | 30 m | EPSG:4326 | Terrain/elevation context (M2, M6) |
| D-06 | ESA WorldCover 10 m 2021 (v200) | ESA WorldCover consortium | Earth Engine `ESA/WorldCover/v200` | CC BY 4.0 | 2021 | 10 m | EPSG:4326 | Land-cover context (M2, M6) |
| D-07 | Sentinel-1 GRD (SAR) | ESA / Copernicus | Earth Engine `COPERNICUS/S1_GRD` | Copernicus Sentinel data — free and open *(record exact terms)* | Sep–Nov 2023 (event) + pre-event baseline | 10 m | EPSG:4326 | Input to D-08 |
| D-08 | **2023 Lower Volta observed flood extent (derived)** | GeoPulse (own processing of D-07) | Produced in `notebooks/`, project `ee-aasobbur` | Derived from D-07; own method documented | Specific image dates — record | ~10–20 m | EPSG:4326 | Hazard overlay for screening (M2) |

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
- **D-01 boundaries:** dated 2021. Check whether any district changes since then affect the pilot.

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
