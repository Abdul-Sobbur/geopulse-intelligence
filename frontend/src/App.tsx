import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FilterSpecification, LayerSpecification, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./App.css";

import DashboardView from "./components/DashboardView";
import Legend from "./components/Legend";
import Segmented from "./components/Segmented";
import TopBar from "./components/TopBar";
import {
  API_URL, BASEMAPS, type BasemapId, CATEGORY_COLOURS, CLICKABLE_ASSET_LAYERS, FILTERED_LAYERS,
  FLOOD_COLOURS, FLOOD_LAYER, HAZARD_ID, LAYERS_OFF_AT_START, LAYER_TYPES, MAP_LAYER_GROUPS, PILOT_ID,
  POPULATION_LAYER, SITE_LETTERS,
} from "./config";
import {
  comparisonQuery, dashboardQuery, errorMessage, fetchJson, loadBasemap, loadFloodScreening, peopleQuery, waitForApi,
} from "./lib/api";
import { anchorPoint, circleRing, geometryBounds } from "./lib/geo";
import {
  DIMMED, FLAGGED, STATUS, type SourceData, categoryColour, categoryColours, densityColour, expr, filterExpr, layerFilter,
  overlayLayers, settlementFilter, statusColour, withOverlays,
} from "./lib/mapStyle";
import { assetPopupHtml, nationalPopupHtml, settlementPopupHtml } from "./lib/popups";
import type {
  AssetType, Bounds, CandidateSite, CatalogResponse, PeopleResponse, ComparisonResponse, DashboardResponse, District, DistrictProperties,
  ExposureCounts, Feature, FeatureCollection, HazardLayer, NationalDistrictProperties, NationalResponse, PickTarget,
  ProximityFeature, ProximityResponse,
  ScreeningAsset, ScreeningResponse, SettlementScreening, SummaryRow, Workspace,
} from "./types";
import AssetsPanel from "./workspaces/AssetsPanel";
import LayersPanel from "./workspaces/LayersPanel";
import ComparePanel from "./workspaces/ComparePanel";
import FloodPanel from "./workspaces/FloodPanel";
import NearbyPanel from "./workspaces/NearbyPanel";
import ReportsPanel from "./workspaces/ReportsPanel";

// Tell MapLibre where its worker file is: in a production build it is not next to the bundled code
maplibregl.setWorkerUrl(workerUrl);

const EMPTY: SourceData = { type: "FeatureCollection", features: [] };
const PROXIMITY_LAYERS = ["proximity-fill", "proximity-line", "proximity-centre"];
const SITE_LAYERS = ["sites-fill", "sites-line"];

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pilotBoundsRef = useRef<Bounds | null>(null);
  const warningByTypeRef = useRef(new Map<string, string | null>());
  const districtNamesRef = useRef(new Map<string, string>());
  const screeningRef = useRef(new Map<number, ScreeningAsset>());
  const settlementScreeningRef = useRef(new Map<number, SettlementScreening>());
  const pickModeRef = useRef(false);
  const pickTargetRef = useRef<PickTarget>("proximity");
  const radiusRef = useRef(1000);
  const sitesRef = useRef<CandidateSite[]>([]);
  const siteMarkersRef = useRef(new Map<string, maplibregl.Marker>());
  // Latest data in each of our map sources, so it survives a basemap change
  const overlayDataRef = useRef<Record<string, SourceData>>({});

  const [workspace, setWorkspace] = useState<Workspace>("flood");
  const [basemap, setBasemap] = useState<BasemapId>("dark");
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [assetsData, setAssetsData] = useState<FeatureCollection | null>(null);
  const [settlementPcodes, setSettlementPcodes] = useState<(string | null)[] | null>(null);
  const [districts, setDistricts] = useState<District[]>([]);
  const [hazard, setHazard] = useState<HazardLayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [slowStart, setSlowStart] = useState(false);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [selectedPcode, setSelectedPcode] = useState("");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<string[]>(LAYERS_OFF_AT_START);
  const [national, setNational] = useState<{ data: NationalResponse | null; error: string | null } | null>(null);
  const [highlightExposure, setHighlightExposure] = useState(true);
  const [nearM, setNearM] = useState(250);
  const [screeningResult, setScreeningResult] = useState<{
    key: string;
    data: ScreeningResponse;
    settlements: SettlementScreening[] | null;
  } | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [radiusM, setRadiusM] = useState(1000);
  const [proximity, setProximity] = useState<ProximityResponse | null>(null);
  const [proximityLoading, setProximityLoading] = useState(false);
  const [sites, setSites] = useState<CandidateSite[]>([]);
  const [siteRadius, setSiteRadius] = useState(1000);
  const [comparisonResult, setComparisonResult] = useState<{ key: string; data: ComparisonResponse } | null>(null);
  const [peopleResult, setPeopleResult] = useState<{ key: string; data: PeopleResponse | null } | null>(null);
  const [dashboardResult, setDashboardResult] = useState<{ key: string; data: DashboardResponse } | null>(null);

  // Derived during render: a result is shown only if it matches the current settings
  const screeningOn = workspace === "flood" && highlightExposure && !!hazard;
  const screeningKey = String(nearM);
  const currentScreening = screeningOn && screeningResult?.key === screeningKey ? screeningResult : null;
  const screening = currentScreening?.data ?? null;
  const settlementScreening = currentScreening?.settlements ?? null;

  const comparisonKey = comparisonQuery(sites, siteRadius);
  const comparison = sites.length > 0 && comparisonResult?.key === comparisonKey ? comparisonResult.data : null;
  const comparisonLoading = sites.length > 0 && comparison === null;

  const dashboardWanted = workspace === "dashboard" || workspace === "flood";
  const dashboardKey = dashboardQuery(nearM, selectedPcode);
  const dashboard = dashboardResult?.key === dashboardKey ? dashboardResult.data : null;
  const peopleKey = peopleQuery(selectedPcode);
  const people = peopleResult?.key === peopleKey ? peopleResult.data : null;
  const kpiValue = (id: string) => dashboard?.kpis.find((k) => k.id === id)?.value ?? null;

  const showFlood = !hiddenLayers.includes(FLOOD_LAYER);
  const pickTarget: PickTarget = workspace === "compare" ? "site" : "proximity";
  const colours = categoryColours(basemap);

  const districtNameByPcode = useMemo(() => new Map(districts.map((d) => [d.pcode, d.name])), [districts]);

  function setOverlayData(id: string, data: SourceData) {
    overlayDataRef.current[id] = data;
    const source = mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  }

  function openPopup(lngLat: maplibregl.LngLatLike, html: string) {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ maxWidth: "320px", className: "gp-popup" })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
  }

  function showAssetPopup(lngLat: maplibregl.LngLatLike, properties: Record<string, unknown>) {
    const screeningInfo = screeningRef.current.get(Number(properties.asset_id));
    openPopup(lngLat, assetPopupHtml(properties, warningByTypeRef.current, districtNamesRef.current, screeningInfo));
  }

  function setCursor(value: string) {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = value;
  }

  function endPickMode() {
    pickModeRef.current = false;
    setPickMode(false);
    setCursor("");
  }

  function togglePickMode() {
    if (pickMode) {
      endPickMode();
      return;
    }
    pickModeRef.current = true;
    setPickMode(true);
    popupRef.current?.remove();
    setCursor("crosshair");
  }

  function changeWorkspace(next: Workspace) {
    if (next === workspace) return;
    endPickMode();
    pickTargetRef.current = next === "compare" ? "site" : "proximity";
    setWorkspace(next);
  }

  // Query everything within the chosen radius of a point and draw the search circle
  async function runProximity(lon: number, lat: number) {
    endPickMode();
    const radius = radiusRef.current;
    setOverlayData("proximity", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { role: "area" }, geometry: { type: "Polygon", coordinates: [circleRing(lon, lat, radius)] } },
        { type: "Feature", properties: { role: "centre" }, geometry: { type: "Point", coordinates: [lon, lat] } },
      ],
    });

    setProximityLoading(true);
    try {
      const data = await fetchJson<ProximityResponse>(
        `${API_URL}/proximity?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&radius_m=${radius}&hazard_id=${HAZARD_ID}&limit=100`,
      );
      setProximity(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProximityLoading(false);
    }
  }

  function clearProximity() {
    setProximity(null);
    setOverlayData("proximity", EMPTY);
  }

  function changeRadius(value: number) {
    setRadiusM(value);
    radiusRef.current = value;
    if (proximity) runProximity(proximity.center[0], proximity.center[1]);
  }

  // Add a candidate site (A to D) where the map was clicked
  function addSite(lon: number, lat: number) {
    const map = mapRef.current;
    endPickMode();
    if (!map) return;
    const used = new Set(sitesRef.current.map((s) => s.id));
    const id = SITE_LETTERS.find((letter) => !used.has(letter));
    if (!id) return;

    const element = document.createElement("div");
    element.className = "site-marker";
    element.innerHTML = `<span>${id}</span>`;
    element.setAttribute("aria-label", `Candidate site ${id}`);
    siteMarkersRef.current.set(
      id,
      new maplibregl.Marker({ element, anchor: "bottom" }).setLngLat([lon, lat]).addTo(map),
    );

    const next = [...sitesRef.current, { id, lon, lat }].sort((a, b) => a.id.localeCompare(b.id));
    sitesRef.current = next;
    setSites(next);
  }

  function removeSite(id: string) {
    siteMarkersRef.current.get(id)?.remove();
    siteMarkersRef.current.delete(id);
    const next = sitesRef.current.filter((s) => s.id !== id);
    sitesRef.current = next;
    setSites(next);
  }

  function clearSites() {
    for (const marker of siteMarkersRef.current.values()) marker.remove();
    siteMarkersRef.current.clear();
    sitesRef.current = [];
    setSites([]);
  }

  function focusSite(site: CandidateSite) {
    mapRef.current?.flyTo({ center: [site.lon, site.lat], zoom: Math.max(mapRef.current.getZoom(), 13) });
  }

  // Save the comparison table as CSV (built in the browser from what is on screen)
  function downloadComparisonCsv() {
    if (!comparison) return;
    const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = [
      "criterion", "group", "unit", "note",
      ...sites.map((s) => `site ${s.id} (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})`),
    ];
    const lines = [
      `# GeoPulse Intelligence candidate site comparison, generated ${new Date().toISOString()}`,
      `# Assessment radius ${comparison.radius_m} m. ${comparison.note}`,
      header.map(quote).join(","),
      ...comparison.criteria.map((c) =>
        [c.label, c.group, c.unit, c.note, ...comparison.sites.map((s) => s.values[c.id] ?? "")].map(quote).join(","),
      ),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `geopulse_site_comparison_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // Load a basemap style, keeping our layers on top; fall back to a plain background if it fails
  function applyStyle(map: MapLibreMap, style: StyleSpecification) {
    const layers: LayerSpecification[] = overlayLayers(map.getStyle());
    map.setStyle(style, {
      transformStyle: (_previous: StyleSpecification | undefined, next: StyleSpecification) =>
        withOverlays(next, layers, overlayDataRef.current),
    });
  }

  function changeBasemap(next: BasemapId) {
    const map = mapRef.current;
    if (!map || next === basemap) return;
    setBasemap(next);
    loadBasemap(next).then(({ style, ok }) => {
      setBasemapFailed(!ok);
      applyStyle(map, style);
    });
  }

  // Map click while picking a point: runs a proximity search or adds a candidate site
  const onMapPick = useEffectEvent((lng: number, lat: number) => {
    if (pickTargetRef.current === "site") addSite(lng, lat);
    else runProximity(lng, lat);
  });

  // Popups opened from map clicks (always read the latest screening and names)
  const onAssetClick = useEffectEvent((lngLat: maplibregl.LngLat, properties: Record<string, unknown>) => {
    showAssetPopup(lngLat, properties);
  });
  const onSettlementClick = useEffectEvent((lngLat: maplibregl.LngLat, p: Record<string, unknown>) => {
    openPopup(lngLat, settlementPopupHtml(
      p, districtNamesRef.current, settlementScreeningRef.current.get(Number(p.settlement_id)),
    ));
  });
  const onNationalClick = useEffectEvent((lngLat: maplibregl.LngLat, p: Record<string, unknown>) => {
    openPopup(lngLat, nationalPopupHtml(p as unknown as NationalDistrictProperties));
  });
  const onEscape = useEffectEvent(() => endPickMode());

  // Create the map (after fetching the basemap style) and load data once
  useEffect(() => {
    const container = mapContainer.current;
    if (!container) return;
    let cancelled = false;
    let created: MapLibreMap | null = null;
    let observer: ResizeObserver | null = null;

    const setup = (style: StyleSpecification): MapLibreMap => {
      const map = new maplibregl.Map({
        container,
        style,
        center: [0.3, 6.05],
        zoom: 8.5,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      const cursor = (value: string) => { map.getCanvas().style.cursor = value; };
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      // Our overlays need re-applying (feature state, colours) whenever a basemap style loads
      map.on("style.load", () => setStyleEpoch((n) => n + 1));

      // The map resizes when the layout around it changes
      observer = new ResizeObserver(() => map.resize());
      observer.observe(container);

      map.on("load", async () => {
        try {
          // The hosted API sleeps when idle; give it time to wake before loading data
          await waitForApi();
          const [districtsFc, assetsFc, typeList, hazardList, floodFc, settlementsFc, catalogData]: [
            FeatureCollection<DistrictProperties>,
            FeatureCollection,
            AssetType[],
            HazardLayer[] | null,
            SourceData | null,
            FeatureCollection<{ adm2_pcode: string | null }> | null,
            CatalogResponse | null,
          ] = await Promise.all([
            fetchJson<FeatureCollection<DistrictProperties>>(`${API_URL}/pilots/${PILOT_ID}/districts`),
            fetchJson<FeatureCollection>(`${API_URL}/assets?limit=5000`),
            fetchJson<AssetType[]>(`${API_URL}/asset-types`),
            // Hazard and settlement data are optional: the asset map still works without them
            fetchJson<HazardLayer[]>(`${API_URL}/hazards`).catch(() => null),
            fetchJson<SourceData>(`${API_URL}/hazards/${HAZARD_ID}/features`).catch(() => null),
            fetchJson<FeatureCollection<{ adm2_pcode: string | null }>>(`${API_URL}/settlements`).catch(() => null),
            // The layer catalogue: optional, so an older API still works
            fetchJson<CatalogResponse>(`${API_URL}/catalog`).catch(() => null),
          ]);

          warningByTypeRef.current = new Map(typeList.map((t) => [t.asset_type, t.coverage_warning]));
          districtNamesRef.current = new Map(districtsFc.features.map((f) => [f.properties.pcode, f.properties.name]));
          pilotBoundsRef.current = districtsFc.bbox ?? null;

          const addData = (id: string, data: SourceData) => {
            overlayDataRef.current[id] = data;
            map.addSource(id, { type: "geojson", data });
          };
          addData("districts", districtsFc as unknown as SourceData);
          addData("assets", assetsFc as unknown as SourceData);

          // Layers are drawn in this order (first = bottom).
          // The national map is empty and hidden until it is switched on in the Layers tab.
          addData("national", { type: "FeatureCollection", features: [] });
          map.addLayer({
            id: "national-fill", type: "fill", source: "national", layout: { visibility: "none" },
            paint: { "fill-color": densityColour("dark"), "fill-opacity": 0.78 },
          });
          map.addLayer({
            id: "national-line", type: "line", source: "national", layout: { visibility: "none" },
            paint: { "line-color": "#0e1b26", "line-width": 0.5, "line-opacity": 0.7 },
          });
          // District popup on the national map, unless a pilot feature was clicked at the same spot
          map.on("click", "national-fill", (e) => {
            if (pickModeRef.current) return;
            const above = [...CLICKABLE_ASSET_LAYERS, "settlement-fill"].filter((id) => map.getLayer(id));
            if (map.queryRenderedFeatures(e.point, { layers: above }).length) return;
            const feature = e.features?.[0];
            if (feature) onNationalClick(e.lngLat, feature.properties as Record<string, unknown>);
          });
          map.on("mouseenter", "national-fill", () => { if (!pickModeRef.current) cursor("pointer"); });
          map.on("mouseleave", "national-fill", () => { if (!pickModeRef.current) cursor(""); });

          map.addLayer({
            id: "district-fill", type: "fill", source: "districts",
            paint: { "fill-color": "#9fb3c2", "fill-opacity": 0.04 },
          });
          map.addLayer({
            id: "asset-areas", type: "fill", source: "assets",
            filter: layerFilter(LAYER_TYPES["asset-areas"], [], ""),
            paint: {
              "fill-color": categoryColour("dark"),
              "fill-opacity": expr(["match", STATUS, DIMMED, 0.08, 0.28]),
            },
          });

          if (floodFc) {
            addData("hazard", floodFc);
            const floodColour = expr([
              "match", ["get", "class_name"],
              "flooded", FLOOD_COLOURS.flooded,
              "ambiguous", FLOOD_COLOURS.ambiguous,
              "#999999",
            ]);
            map.addLayer({
              id: "hazard-fill", type: "fill", source: "hazard",
              paint: { "fill-color": floodColour, "fill-opacity": 0.55 },
            });
            map.addLayer({
              id: "hazard-line", type: "line", source: "hazard",
              paint: { "line-color": floodColour, "line-width": 0.6, "line-opacity": 0.9 },
            });
          }

          if (settlementsFc) {
            addData("settlements", settlementsFc as unknown as SourceData);
            const settlementColour = statusColour(CATEGORY_COLOURS.settlement);
            map.addLayer({
              id: "settlement-fill", type: "fill", source: "settlements",
              filter: settlementFilter([], ""),
              paint: {
                "fill-color": settlementColour,
                "fill-opacity": expr(["match", STATUS, FLAGGED, 0.5, DIMMED, 0.06, 0.22]),
              },
            });
            map.addLayer({
              id: "settlement-outline", type: "line", source: "settlements",
              filter: settlementFilter([], ""),
              paint: {
                "line-color": settlementColour,
                "line-width": expr(["match", STATUS, FLAGGED, 1.5, 0.5]),
                "line-opacity": expr(["match", STATUS, DIMMED, 0.2, 0.8]),
              },
            });

            // Settlement popup, unless an asset was clicked at the same spot
            map.on("click", "settlement-fill", (e) => {
              if (pickModeRef.current) return;
              const assetHits = map.queryRenderedFeatures(e.point, {
                layers: CLICKABLE_ASSET_LAYERS.filter((id) => map.getLayer(id)),
              });
              if (assetHits.length) return;
              const feature = e.features?.[0];
              if (!feature) return;
              onSettlementClick(e.lngLat, feature.properties as Record<string, unknown>);
            });
            map.on("mouseenter", "settlement-fill", () => { if (!pickModeRef.current) cursor("pointer"); });
            map.on("mouseleave", "settlement-fill", () => { if (!pickModeRef.current) cursor(""); });
          }

          map.addLayer({
            id: "district-outline", type: "line", source: "districts",
            paint: { "line-color": "#6e8496", "line-width": 1.2, "line-dasharray": [3, 2] },
          });
          map.addLayer({
            id: "district-selected", type: "line", source: "districts",
            filter: filterExpr(["==", ["get", "pcode"], ""]),
            paint: { "line-color": "#e6eef3", "line-width": 2.5 },
          });
          map.addLayer({
            id: "asset-lines-halo", type: "line", source: "assets",
            filter: layerFilter(FILTERED_LAYERS["asset-lines-halo"], [], ""),
            paint: {
              "line-color": statusColour("#000000"),
              // Graded so the observed flood stays the brightest thing on the map
              "line-width": expr(["match", STATUS, "in_flood", 7, "in_ambiguous", 6, "near", 4.5, 0]),
              "line-blur": 1,
              "line-opacity": expr(["match", STATUS, "in_flood", 0.75, "in_ambiguous", 0.55, "near", 0.32, 0]),
            },
          });
          map.addLayer({
            id: "asset-lines", type: "line", source: "assets",
            filter: layerFilter(LAYER_TYPES["asset-lines"], [], ""),
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": categoryColour("dark"),
              "line-width": expr([
                "case",
                ["==", ["get", "asset_type"], "bridge"], 5,
                ["==", ["get", "asset_type"], "road"], 1.8,
                1.4,
              ]),
              "line-opacity": expr(["match", STATUS, DIMMED, 0.25, 0.95]),
            },
          });
          // Power lines are dashed as well as coloured, so they read apart from rivers
          map.addLayer({
            id: "asset-power-lines", type: "line", source: "assets",
            filter: layerFilter(LAYER_TYPES["asset-power-lines"], [], ""),
            paint: {
              "line-color": CATEGORY_COLOURS.energy,
              "line-width": 1.6,
              "line-dasharray": [3, 2],
              "line-opacity": expr(["match", STATUS, DIMMED, 0.25, 0.95]),
            },
          });
          map.addLayer({
            id: "asset-points", type: "circle", source: "assets",
            filter: layerFilter(LAYER_TYPES["asset-points"], [], ""),
            paint: {
              "circle-color": categoryColour("dark"),
              "circle-radius": expr(["case", ["==", ["get", "asset_type"], "place"], 3.5, 5]),
              "circle-stroke-color": statusColour("#0e1b26"),
              "circle-stroke-width": expr(["match", STATUS, "in_flood", 3, "in_ambiguous", 3, "near", 2, 1]),
              "circle-opacity": expr(["match", STATUS, DIMMED, 0.3, 1]),
              "circle-stroke-opacity": expr(["match", STATUS, DIMMED, 0.3, 1]),
            },
          });

          // Click an asset to see its details, provenance and screening status
          for (const layerId of CLICKABLE_ASSET_LAYERS) {
            map.on("click", layerId, (e) => {
              if (pickModeRef.current) return;
              const feature = e.features?.[0];
              if (feature) onAssetClick(e.lngLat, feature.properties as Record<string, unknown>);
            });
            map.on("mouseenter", layerId, () => { if (!pickModeRef.current) cursor("pointer"); });
            map.on("mouseleave", layerId, () => { if (!pickModeRef.current) cursor(""); });
          }

          // Proximity search circle and candidate site circles (drawn on top of everything)
          addData("proximity", EMPTY);
          map.addLayer({
            id: "proximity-fill", type: "fill", source: "proximity",
            filter: filterExpr(["==", ["get", "role"], "area"]),
            paint: { "fill-color": "#e6eef3", "fill-opacity": 0.05 },
          });
          map.addLayer({
            id: "proximity-line", type: "line", source: "proximity",
            filter: filterExpr(["==", ["get", "role"], "area"]),
            paint: { "line-color": "#e6eef3", "line-width": 1.5, "line-dasharray": [2, 2] },
          });
          map.addLayer({
            id: "proximity-centre", type: "circle", source: "proximity",
            filter: filterExpr(["==", ["get", "role"], "centre"]),
            paint: {
              "circle-radius": 6, "circle-color": "#e6eef3",
              "circle-stroke-color": "#0e1b26", "circle-stroke-width": 2,
            },
          });

          addData("sites", EMPTY);
          map.addLayer({
            id: "sites-fill", type: "fill", source: "sites",
            paint: { "fill-color": "#e6eef3", "fill-opacity": 0.05 },
          });
          map.addLayer({
            id: "sites-line", type: "line", source: "sites",
            paint: { "line-color": "#e6eef3", "line-width": 1.5, "line-dasharray": [1, 1.5] },
          });

          // In "pick a point" mode, a click on the map runs a proximity search or adds a site
          map.on("click", (e) => {
            if (pickModeRef.current) onMapPick(e.lngLat.lng, e.lngLat.lat);
          });

          setAssetTypes(typeList);
          setCatalog(catalogData);
          setAssetsData(assetsFc);
          setSettlementPcodes(settlementsFc ? settlementsFc.features.map((f) => f.properties.adm2_pcode) : null);
          setHazard((hazardList ?? []).find((h) => h.hazard_id === HAZARD_ID) ?? null);
          setDistricts(
            districtsFc.features
              .map((f) => ({
                pcode: f.properties.pcode,
                name: f.properties.name,
                region: f.properties.region,
                bounds: geometryBounds(f.geometry),
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          setMapReady(true);
        } catch (err) {
          setError(errorMessage(err));
        }
      });
      return map;
    };

    loadBasemap("dark").then(({ style, ok }) => {
      if (cancelled) return;
      if (!ok) setBasemapFailed(true);
      created = setup(style);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      created?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // If loading takes a while, explain why (the free hosted API may be waking up)
  useEffect(() => {
    if (mapReady || error) return;
    const timer = setTimeout(() => setSlowStart(true), 6000);
    return () => clearTimeout(timer);
  }, [mapReady, error]);

  // Escape cancels "click the map" mode
  useEffect(() => {
    if (!pickMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickMode]);

  // Category colours follow the basemap (roads are pale on dark, slate on light)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const colour = categoryColour(basemap);
    map.setPaintProperty("asset-areas", "fill-color", colour);
    map.setPaintProperty("asset-lines", "line-color", colour);
    map.setPaintProperty("asset-points", "circle-color", colour);
    map.setPaintProperty("asset-points", "circle-stroke-color", statusColour(basemap === "light" ? "#ffffff" : "#0e1b26"));
    map.setPaintProperty("district-selected", "line-color", basemap === "light" ? "#132433" : "#e6eef3");
    map.setPaintProperty("national-fill", "fill-color", densityColour(basemap));
    map.setPaintProperty("national-line", "line-color", basemap === "light" ? "#ffffff" : "#0e1b26");
  }, [basemap, mapReady, styleEpoch]);

  // Update asset layer filters when categories or district change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const [layerId, types] of Object.entries(FILTERED_LAYERS)) {
      map.setFilter(layerId, layerFilter(types, hiddenCategories, selectedPcode));
    }
    if (map.getLayer("settlement-fill")) {
      const filter = settlementFilter([], selectedPcode);
      map.setFilter("settlement-fill", filter);
      map.setFilter("settlement-outline", filter);
    }
  }, [hiddenCategories, selectedPcode, mapReady, styleEpoch]);

  // Highlight and zoom to the selected district (or back to the whole pilot)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setFilter("district-selected", ["==", ["get", "pcode"], selectedPcode] as unknown as FilterSpecification);
    const target = selectedPcode ? districts.find((d) => d.pcode === selectedPcode)?.bounds : pilotBoundsRef.current;
    if (target) map.fitBounds(target, { padding: 48, duration: 800 });
  }, [selectedPcode, mapReady, districts]);

  // Show each workspace's own overlays only
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const show = (ids: string[], on: boolean) => {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    };
    show(PROXIMITY_LAYERS, workspace === "nearby");
    show(SITE_LAYERS, workspace === "compare");
    for (const [layer, mapLayers] of Object.entries(MAP_LAYER_GROUPS)) show(mapLayers, !hiddenLayers.includes(layer));
    for (const marker of siteMarkersRef.current.values()) {
      marker.getElement().style.display = workspace === "compare" ? "" : "none";
    }
  }, [workspace, hiddenLayers, mapReady, styleEpoch, sites]);

  // Load screening results and apply them as feature state (re-applied after a basemap change)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    const hasSettlements = !!map.getSource("settlements");
    map.removeFeatureState({ source: "assets" });
    if (hasSettlements) map.removeFeatureState({ source: "settlements" });
    screeningRef.current = new Map();
    settlementScreeningRef.current = new Map();

    if (!screeningOn) return;

    const key = String(nearM);
    loadFloodScreening(nearM)
      .then(({ assets, settlements }) => {
        if (cancelled) return;
        const data: ScreeningResponse = { hazard_id: HAZARD_ID, near_m: nearM, assets };
        screeningRef.current = new Map(assets.map((a) => [a.asset_id, a]));
        for (const a of assets) {
          map.setFeatureState({ source: "assets", id: a.asset_id }, { status: a.status });
        }
        if (settlements && hasSettlements) {
          settlementScreeningRef.current = new Map(settlements.map((st) => [st.settlement_id, st]));
          for (const st of settlements) {
            map.setFeatureState({ source: "settlements", id: st.settlement_id }, { status: st.status });
          }
        }
        setScreeningResult({ key, data, settlements: hasSettlements ? settlements : null });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [screeningOn, nearM, mapReady, styleEpoch]);

  // Draw site circles and re-run the comparison whenever sites or the radius change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const data: SourceData = {
      type: "FeatureCollection",
      features: sites.map((s) => ({
        type: "Feature" as const,
        properties: { id: s.id },
        geometry: { type: "Polygon" as const, coordinates: [circleRing(s.lon, s.lat, siteRadius)] },
      })),
    };
    overlayDataRef.current.sites = data;
    (map.getSource("sites") as maplibregl.GeoJSONSource | undefined)?.setData(data);

    if (sites.length === 0) return;

    let cancelled = false;
    const key = comparisonQuery(sites, siteRadius);
    fetchJson<ComparisonResponse>(`${API_URL}/sites/compare?${key}`)
      .then((result) => {
        if (!cancelled) setComparisonResult({ key, data: result });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [sites, siteRadius, mapReady]);

  // People near observed flooding (optional: an API without /people simply shows nothing)
  useEffect(() => {
    if (!dashboardWanted || !mapReady) return;
    let cancelled = false;
    const key = peopleQuery(selectedPcode);
    fetchJson<PeopleResponse>(`${API_URL}/people?${key}`)
      .then((data) => { if (!cancelled) setPeopleResult({ key, data }); })
      .catch(() => { if (!cancelled) setPeopleResult({ key, data: null }); });
    return () => {
      cancelled = true;
    };
  }, [dashboardWanted, selectedPcode, mapReady]);

  // Dashboard figures (also used for the flood readouts)
  useEffect(() => {
    if (!dashboardWanted || !mapReady) return;
    let cancelled = false;
    const key = dashboardQuery(nearM, selectedPcode);
    fetchJson<DashboardResponse>(`${API_URL}/dashboard?${key}`)
      .then((data) => {
        if (!cancelled) setDashboardResult({ key, data });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardWanted, nearM, selectedPcode, mapReady]);

  // Asset counts for the current district selection
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const f of assetsData?.features ?? []) {
      if (selectedPcode && f.properties.adm2_pcode !== selectedPcode) continue;
      const type = f.properties.asset_type;
      result.set(type, (result.get(type) ?? 0) + 1);
    }
    return result;
  }, [assetsData, selectedPcode]);

  const settlementCount = useMemo(() => {
    if (!settlementPcodes) return null;
    return selectedPcode ? settlementPcodes.filter((p) => p === selectedPcode).length : settlementPcodes.length;
  }, [settlementPcodes, selectedPcode]);

  // Screening summary, respecting the district filter (water features excluded)
  const screeningSummary = useMemo(() => {
    if (!screening || !assetsData) return [];
    const pcodeById = new Map(assetsData.features.map((f) => [f.properties.asset_id, f.properties.adm2_pcode]));
    const rows = new Map<string, SummaryRow>();
    for (const a of screening.assets) {
      if (a.status === "context") continue;
      if (selectedPcode && pcodeById.get(a.asset_id) !== selectedPcode) continue;
      const row = rows.get(a.asset_type) ?? { asset_type: a.asset_type, total: 0, in_flood: 0, in_ambiguous: 0, near: 0 };
      row.total += 1;
      if (a.status === "in_flood") row.in_flood += 1;
      else if (a.status === "in_ambiguous") row.in_ambiguous += 1;
      else if (a.status === "near") row.near += 1;
      rows.set(a.asset_type, row);
    }
    return [...rows.values()].sort(
      (x, y) => (y.in_flood + y.in_ambiguous + y.near) - (x.in_flood + x.in_ambiguous + x.near),
    );
  }, [screening, assetsData, selectedPcode]);

  const settlementSummary = useMemo((): ExposureCounts | null => {
    if (!settlementScreening) return null;
    const rows = settlementScreening.filter((s) => !selectedPcode || s.adm2_pcode === selectedPcode);
    return {
      in_flood: rows.filter((s) => s.status === "in_flood").length,
      in_ambiguous: rows.filter((s) => s.status === "in_ambiguous").length,
      near: rows.filter((s) => s.status === "near").length,
    };
  }, [settlementScreening, selectedPcode]);

  // Name search, respecting the district and category filters
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!assetsData || q.length < 2) return [];
    return assetsData.features.filter((f) => {
      const p = f.properties;
      if (!p.name || !p.name.toLowerCase().includes(q)) return false;
      if (selectedPcode && p.adm2_pcode !== selectedPcode) return false;
      if (hiddenCategories.includes(p.category)) return false;
      return true;
    });
  }, [assetsData, query, selectedPcode, hiddenCategories]);

  function openFeature(feature: Feature) {
    const map = mapRef.current;
    if (!map) return;
    if (workspace === "dashboard") changeWorkspace("layers");
    const b = geometryBounds(feature.geometry);
    if (b[0] === b[2] && b[1] === b[3]) map.flyTo({ center: [b[0], b[1]], zoom: 14 });
    else map.fitBounds(b, { padding: 60, maxZoom: 15 });
    showAssetPopup(anchorPoint(feature.geometry), feature.properties);
  }

  function openProximityFeature(f: ProximityFeature) {
    if (f.kind === "asset") {
      const feature = assetsData?.features.find((a) => a.properties.asset_id === f.id);
      if (feature) {
        openFeature(feature);
        return;
      }
    }
    mapRef.current?.flyTo({ center: [f.lon, f.lat], zoom: 15 });
  }

  function toggleLayer(id: string) {
    const turningOn = hiddenLayers.includes(id);
    setHiddenLayers((current) => (current.includes(id) ? current.filter((l) => l !== id) : [...current, id]));
    if (id === POPULATION_LAYER) {
      if (turningOn) void showNational();
      else fitToSelection();
    }
  }

  // The national map: load all districts the first time it is switched on, then zoom out to Ghana
  async function showNational() {
    const fit = (data: NationalResponse) => {
      if (data.bbox) mapRef.current?.fitBounds(data.bbox, { padding: 40, duration: 900 });
    };
    if (national?.data) {
      fit(national.data);
      return;
    }
    setNational({ data: null, error: null });
    try {
      const data = await fetchJson<NationalResponse>(`${API_URL}/national/districts?pilot_id=${PILOT_ID}`);
      setOverlayData("national", data as unknown as SourceData);
      setNational({ data, error: null });
      fit(data);
    } catch (err) {
      setNational({ data: null, error: errorMessage(err) });
    }
  }

  // Back to the selected district, or the whole pilot
  function fitToSelection() {
    const target = selectedPcode ? districts.find((d) => d.pcode === selectedPcode)?.bounds : pilotBoundsRef.current;
    if (target) mapRef.current?.fitBounds(target, { padding: 48, duration: 800 });
  }

  function setShowFlood(on: boolean) {
    setHiddenLayers((current) => (on ? current.filter((l) => l !== FLOOD_LAYER) : [...current, FLOOD_LAYER]));
  }

  function toggleCategory(category: string) {
    setHiddenCategories((current) =>
      current.includes(category) ? current.filter((c) => c !== category) : [...current, category],
    );
  }

  const labelFor = (assetType: string) => assetTypes.find((t) => t.asset_type === assetType)?.label ?? assetType;
  const scopeLabel = selectedPcode
    ? districtNameByPcode.get(selectedPcode) ?? selectedPcode
    : "the eight pilot districts";
  const categories = [...new Set(assetTypes.map((t) => t.category))];
  const nextSite = SITE_LETTERS.find((l) => !sites.some((s) => s.id === l));

  // One line under the national layer in the Layers tab
  const nationalOn = !hiddenLayers.includes(POPULATION_LAYER);
  let nationalStatus = "Switch on to load all 260 districts and zoom out to Ghana.";
  if (national?.error) nationalStatus = `Couldn't load the national map: ${national.error}`;
  else if (national && !national.data) nationalStatus = "Loading all districts…";
  else if (national?.data) {
    const t = national.data.totals;
    nationalStatus = `About ${(t.population / 1e6).toFixed(1)} million people in ${t.with_estimates} districts, ` +
      `${Math.round(t.density ?? 0)} per km² on average. Click a district for its figures.`;
  }

  let panel = null;
  if (mapReady) {
    switch (workspace) {
      case "layers":
        // The catalogue view needs the /catalog endpoint; an older API falls back to the asset list
        panel = catalog ? (
          <LayersPanel
            catalog={catalog} hiddenLayers={hiddenLayers} onToggleLayer={toggleLayer}
            assetTypes={assetTypes} counts={counts} colours={colours}
            hiddenCategories={hiddenCategories} onToggleCategory={toggleCategory}
            settlementFootprints={settlementCount} scopeLabel={scopeLabel}
            layerStatus={{ [POPULATION_LAYER]: nationalStatus }}
          />
        ) : (
          <AssetsPanel
            assetTypes={assetTypes} counts={counts} colours={colours} hidden={hiddenCategories}
            onToggle={toggleCategory} scopeLabel={scopeLabel} settlementFootprints={settlementCount}
          />
        );
        break;
      case "flood":
        panel = (
          <FloodPanel
            hazard={hazard}
            floodedKm2={kpiValue("flooded_km2")}
            ambiguousKm2={kpiValue("ambiguous_km2")}
            showFlood={showFlood} onShowFlood={setShowFlood}
            highlight={highlightExposure} onHighlight={setHighlightExposure}
            nearM={nearM} onNearM={setNearM}
            loading={screeningOn && !screening}
            summary={screeningSummary}
            settlementSummary={settlementSummary}
            labelFor={labelFor}
            scopeLabel={scopeLabel}
            people={people}
          />
        );
        break;
      case "nearby":
        panel = (
          <NearbyPanel
            radiusM={radiusM} onRadius={changeRadius} picking={pickMode} onTogglePick={togglePickMode}
            loading={proximityLoading} result={proximity} onOpen={openProximityFeature} onClear={clearProximity}
          />
        );
        break;
      case "compare":
        panel = (
          <ComparePanel
            sites={sites} radiusM={siteRadius} onRadius={setSiteRadius} picking={pickMode}
            onTogglePick={togglePickMode} onRemove={removeSite} onClear={clearSites} onFocus={focusSite}
            loading={comparisonLoading} comparison={comparison} onDownload={downloadComparisonCsv}
          />
        );
        break;
      case "reports":
        panel = <ReportsPanel nearM={nearM} onNearM={setNearM} selectedPcode={selectedPcode} scopeLabel={scopeLabel} />;
        break;
    }
  }

  return (
    <div className="app">
      <TopBar
        workspace={workspace}
        onWorkspace={changeWorkspace}
        districts={districts}
        selectedPcode={selectedPcode}
        onSelectPcode={setSelectedPcode}
        query={query}
        onQuery={setQuery}
        matches={matches}
        onOpenMatch={openFeature}
        districtNames={districtNameByPcode}
        ready={mapReady}
      />

      <div className="workspace">
        <aside className="panel" aria-label="Workspace tools">
          {error && (
            <div className="alert" role="alert">
              <strong>{mapReady ? "A request failed." : `Couldn't reach the GeoPulse API at ${API_URL}.`}</strong>
              <p>{mapReady ? "Check that the API is still running, then try again." : "Start the API, then reload this page."}</p>
              <p className="alert-detail">{error}</p>
              {mapReady && <button type="button" className="btn btn-quiet" onClick={() => setError(null)}>Dismiss</button>}
            </div>
          )}
          {!error && !mapReady && <p className="loading-line">Loading pilot data…</p>}
          {!error && !mapReady && slowStart && (
            <p className="hint">
              The server goes to sleep when nobody is using it, so the first visit can take up to a minute.
            </p>
          )}
          {panel}
        </aside>

        <main className="map-area">
          <div ref={mapContainer} className="map" />

          <div className="map-tools">
            <Segmented
              label="Basemap"
              value={basemap}
              options={(Object.keys(BASEMAPS) as BasemapId[]).map((id) => ({ value: id, label: BASEMAPS[id].label }))}
              onChange={changeBasemap}
            />
            {basemapFailed && <span className="map-note">Basemap unavailable, showing data only</span>}
          </div>

          {pickMode && (
            <div className="pick-banner" role="status">
              {pickTarget === "site" ? `Click the map to place site ${nextSite}.` : "Click the map to choose a point."}
              <span className="muted"> Press Esc to cancel.</span>
            </div>
          )}

          {mapReady && (
            <Legend
              categories={categories}
              colours={colours}
              hidden={hiddenCategories}
              onToggle={toggleCategory}
              showFlood={showFlood}
              floodAvailable={!!hazard}
              screeningOn={screeningOn}
              densityOn={nationalOn && !!national?.data}
              basemap={basemap}
            />
          )}
        </main>

        {workspace === "dashboard" && (
          <DashboardView
            data={dashboard}
            loading={dashboard === null}
            selectedPcode={selectedPcode}
            onSelectPcode={setSelectedPcode}
            nearM={nearM}
            onNearM={setNearM}
            people={people}
          />
        )}
      </div>
    </div>
  );
}
