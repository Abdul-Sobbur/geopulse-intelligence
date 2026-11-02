import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const PILOT_ID = "lower_volta";
const HAZARD_ID = "flood_2023_observed";
// Free basemap, no API key needed (OpenFreeMap, built on OpenStreetMap data)
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

const CATEGORY_COLOURS: Record<string, string> = {
  transport: "#d95f02",
  water: "#1f78b4",
  settlement: "#6a3d9a",
  social: "#33a02c",
  energy: "#e31a1c",
};

const FLOOD_COLOURS = { flooded: "#00a6ff", ambiguous: "#f39c12" };
const STATUS_COLOURS = { in_flood: "#b42318", in_ambiguous: "#f39c12", near: "#d4a72c" };
const STATUS_LABELS: Record<string, string> = {
  in_flood: "In observed flood",
  in_ambiguous: "In ambiguous seasonal water",
  near: "Near observed water",
  not_flagged: "Not flagged",
  context: "Water feature (context)",
};
const NEAR_OPTIONS = [100, 250, 500, 1000];

// Which asset types each map layer draws
const LAYER_TYPES: Record<string, string[]> = {
  "asset-areas": ["water_body"],
  "asset-lines": ["road", "bridge", "waterway", "power_line"],
  "asset-points": ["place", "education", "health", "power_plant", "power_substation"],
};
// Layers whose filters follow the category and district selections
const FILTERED_LAYERS: Record<string, string[]> = {
  ...LAYER_TYPES,
  "asset-lines-halo": LAYER_TYPES["asset-lines"],
};

const MAX_RESULTS = 20;

type Bounds = [number, number, number, number];

type AssetType = {
  asset_type: string;
  category: string;
  label: string;
  coverage_warning: string | null;
  count: number;
};

type Feature = {
  type: "Feature";
  id?: number;
  geometry: { type: string; coordinates: any };
  properties: Record<string, any>;
};

type FeatureCollection = { type: "FeatureCollection"; features: Feature[]; bbox?: Bounds };

type District = { pcode: string; name: string; region: string; bounds: Bounds };

type HazardLayer = {
  hazard_id: string;
  title: string;
  source_id: string;
  observed_dates: string | null;
  method: string | null;
  pre_event_window: string[] | null;
  limitations: string[] | null;
};

type ScreeningAsset = {
  asset_id: number;
  asset_type: string;
  category: string;
  status: string;
  distance_m: number | null;
  flooded_length_m: number | null;
};

type ScreeningResponse = { hazard_id: string; near_m: number; assets: ScreeningAsset[] };

type SettlementScreening = {
  settlement_id: number;
  adm2_pcode: string | null;
  settlement_type: string;
  building_count: number | null;
  status: string;
  distance_m: number | null;
  flooded_m2: number | null;
};

type SettlementScreeningResponse = { settlements: SettlementScreening[] };

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  in_flood: "Footprint intersects observed flood",
  in_ambiguous: "Footprint intersects ambiguous seasonal water",
  near: "Near observed water",
  not_flagged: "Not flagged",
};

type SummaryRow = { asset_type: string; total: number; in_flood: number; in_ambiguous: number; near: number };

function expr(value: unknown): ExpressionSpecification {
  return value as ExpressionSpecification;
}

// Colour each feature by its category
const categoryColour = expr([
  "match", ["get", "category"],
  ...Object.entries(CATEGORY_COLOURS).flat(),
  "#666666",
]);

// Screening status lives in MapLibre "feature state" (set without reloading data)
const STATUS = ["coalesce", ["feature-state", "status"], "none"];
const FLAGGED = ["in_flood", "in_ambiguous", "near"];
const DIMMED = ["not_flagged", "context"];
const statusColour = expr([
  "match", STATUS,
  "in_flood", STATUS_COLOURS.in_flood,
  "in_ambiguous", STATUS_COLOURS.in_ambiguous,
  "near", STATUS_COLOURS.near,
  "#ffffff",
]);

// Filter for an asset layer: its own types, minus hidden categories, optionally one district
function layerFilter(types: string[], hidden: string[], pcode: string): FilterSpecification {
  const conditions: unknown[] = [
    ["in", ["get", "asset_type"], ["literal", types]],
    ["!", ["in", ["get", "category"], ["literal", hidden]]],
  ];
  if (pcode) conditions.push(["==", ["get", "adm2_pcode"], pcode]);
  return ["all", ...conditions] as unknown as FilterSpecification;
}

// Filter for settlement footprints: follows the 'settlement' category toggle and the district
function settlementFilter(hidden: string[], pcode: string): FilterSpecification {
  const conditions: unknown[] = [!hidden.includes("settlement")];
  if (pcode) conditions.push(["==", ["get", "adm2_pcode"], pcode]);
  return ["all", ...conditions] as unknown as FilterSpecification;
}

// Bounding box of any GeoJSON geometry
function geometryBounds(geometry: Feature["geometry"]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords: any): void => {
    if (typeof coords[0] === "number") {
      minX = Math.min(minX, coords[0]); minY = Math.min(minY, coords[1]);
      maxX = Math.max(maxX, coords[0]); maxY = Math.max(maxY, coords[1]);
    } else {
      for (const part of coords) visit(part);
    }
  };
  visit(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

// A sensible place to anchor a popup on a feature
function anchorPoint(geometry: Feature["geometry"]): [number, number] {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as [number, number][];
    return coords[Math.floor(coords.length / 2)];
  }
  const [minX, minY, maxX, maxY] = geometryBounds(geometry);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
  return response.json();
}

// OSM names are user-entered text, so escape them before putting them into HTML
function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => replacements[c]);
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function popupHtml(
  p: Record<string, unknown>,
  warningByType: Map<string, string | null>,
  districtNames: Map<string, string>,
  screening?: ScreeningAsset,
): string {
  const name = text(p.name) ?? "(unnamed)";
  const subtype = text(p.subtype);
  const pcode = text(p.adm2_pcode);
  const ref = text(p.source_ref);
  const warning = warningByType.get(String(p.asset_type));
  const district = pcode ? `${districtNames.get(pcode) ?? ""} (${pcode})` : "–";
  const refLink = ref
    ? `<a href="https://www.openstreetmap.org/${escapeHtml(ref)}" target="_blank" rel="noopener">${escapeHtml(ref)}</a>`
    : "";

  let screeningLine = "";
  if (screening && screening.status !== "context") {
    const parts = [STATUS_LABELS[screening.status] ?? screening.status];
    if (screening.distance_m !== null && screening.distance_m > 0) {
      parts.push(`${Math.round(screening.distance_m)} m from observed water`);
    }
    if (screening.flooded_length_m) parts.push(`${Math.round(screening.flooded_length_m)} m inside flood`);
    screeningLine = `<p><strong>Flood screening:</strong> ${escapeHtml(parts.join(" · "))}</p>`;
  }

  return `
    <div class="popup">
      <h3>${escapeHtml(name)}</h3>
      <p>${escapeHtml(text(p.label) ?? "")}${subtype ? " · " + escapeHtml(subtype) : ""}</p>
      <p>District: ${escapeHtml(district)}</p>
      ${screeningLine}
      <p>Source: ${escapeHtml(text(p.source_id) ?? "")} · ${refLink} · ${escapeHtml(text(p.source_date) ?? "")}</p>
      ${warning ? `<p class="warning">⚠ ${escapeHtml(warning)}</p>` : ""}
    </div>`;
}

function settlementPopupHtml(
  p: Record<string, unknown>,
  districtNames: Map<string, string>,
  screening?: SettlementScreening,
): string {
  const pcode = text(p.adm2_pcode);
  const district = pcode ? `${districtNames.get(pcode) ?? ""} (${pcode})` : "–";
  const buildings = Number(p.building_count ?? 0).toLocaleString();
  const probability = p.probability === null || p.probability === undefined
    ? "–"
    : Number(p.probability).toFixed(2);

  let screeningLine = "";
  if (screening) {
    const parts = [SETTLEMENT_STATUS_LABELS[screening.status] ?? screening.status];
    if (screening.flooded_m2) {
      parts.push(`${Math.round(screening.flooded_m2).toLocaleString()} m² inside observed flood`);
    } else if (screening.distance_m !== null && screening.distance_m > 0) {
      parts.push(`${Math.round(screening.distance_m)} m from observed water`);
    }
    screeningLine = `<p><strong>Flood screening:</strong> ${escapeHtml(parts.join(" · "))}</p>`;
  }

  return `
    <div class="popup">
      <h3>${escapeHtml(text(p.settlement_type) ?? "Settlement")}</h3>
      <p>Settlement footprint · ${escapeHtml(buildings)} buildings · GRID3 probability ${escapeHtml(probability)}</p>
      <p>District: ${escapeHtml(district)}</p>
      ${screeningLine}
      <p>Source: ${escapeHtml(text(p.source_id) ?? "")} · GRID3 GHA Settlement Extents v3.0 · ${escapeHtml(text(p.source_ref) ?? "")} · ${escapeHtml(text(p.data_year) ?? "")}</p>
      <p class="warning">⚠ The building count covers the whole settlement, not only the part near water.</p>
    </div>`;
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pilotBoundsRef = useRef<Bounds | null>(null);
  const warningByTypeRef = useRef(new Map<string, string | null>());
  const districtNamesRef = useRef(new Map<string, string>());
  const screeningRef = useRef(new Map<number, ScreeningAsset>());
  const settlementScreeningRef = useRef(new Map<number, SettlementScreening>());

  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [assetsData, setAssetsData] = useState<FeatureCollection | null>(null);
  const [districts, setDistricts] = useState<District[]>([]);
  const [hazard, setHazard] = useState<HazardLayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [selectedPcode, setSelectedPcode] = useState("");
  const [query, setQuery] = useState("");
  const [showFlood, setShowFlood] = useState(true);
  const [screeningOn, setScreeningOn] = useState(false);
  const [nearM, setNearM] = useState(250);
  const [screening, setScreening] = useState<ScreeningResponse | null>(null);
  const [settlementsLoaded, setSettlementsLoaded] = useState(false);
  const [settlementScreening, setSettlementScreening] = useState<SettlementScreening[] | null>(null);

  function showPopup(lngLat: maplibregl.LngLatLike, properties: Record<string, unknown>) {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    const screeningInfo = screeningRef.current.get(Number(properties.asset_id));
    popupRef.current = new maplibregl.Popup({ maxWidth: "300px" })
      .setLngLat(lngLat)
      .setHTML(popupHtml(properties, warningByTypeRef.current, districtNamesRef.current, screeningInfo))
      .addTo(map);
  }

  // Create the map and load data once
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: BASEMAP_STYLE,
      center: [0.3, 6.05],
      zoom: 8.5,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", async () => {
      try {
        const [districtsFc, assetsFc, types, hazardList, floodFc, settlementsFc] = await Promise.all([
          fetchJson(`${API_URL}/pilots/${PILOT_ID}/districts`),
          fetchJson(`${API_URL}/assets?limit=5000`),
          fetchJson(`${API_URL}/asset-types`),
          // Hazard and settlement data are optional: the asset map still works without them
          fetchJson(`${API_URL}/hazards`).catch(() => null),
          fetchJson(`${API_URL}/hazards/${HAZARD_ID}/features`).catch(() => null),
          fetchJson(`${API_URL}/settlements`).catch(() => null),
        ]);
        const typeList = types as AssetType[];

        warningByTypeRef.current = new Map(typeList.map((t) => [t.asset_type, t.coverage_warning]));
        districtNamesRef.current = new Map(
          (districtsFc as FeatureCollection).features.map((f) => [f.properties.pcode, f.properties.name]),
        );
        pilotBoundsRef.current = districtsFc.bbox as Bounds;

        map.addSource("districts", { type: "geojson", data: districtsFc });
        map.addSource("assets", { type: "geojson", data: assetsFc });

        // Layers are drawn in this order (first = bottom)
        map.addLayer({
          id: "district-fill", type: "fill", source: "districts",
          paint: { "fill-color": "#000000", "fill-opacity": 0.03 },
        });
        map.addLayer({
          id: "asset-areas", type: "fill", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-areas"], [], ""),
          paint: {
            "fill-color": categoryColour,
            "fill-opacity": expr(["match", STATUS, DIMMED, 0.1, 0.35]),
          },
        });

        if (floodFc) {
          map.addSource("hazard", { type: "geojson", data: floodFc });
          map.addLayer({
            id: "hazard-fill", type: "fill", source: "hazard",
            paint: {
              "fill-color": expr([
                "match", ["get", "class_name"],
                "flooded", FLOOD_COLOURS.flooded,
                "ambiguous", FLOOD_COLOURS.ambiguous,
                "#999999",
              ]),
              "fill-opacity": 0.6,
            },
          });
        }

        if (settlementsFc) {
          const settlementColour = expr([
            "match", STATUS,
            "in_flood", STATUS_COLOURS.in_flood,
            "in_ambiguous", STATUS_COLOURS.in_ambiguous,
            "near", STATUS_COLOURS.near,
            CATEGORY_COLOURS.settlement,
          ]);
          map.addSource("settlements", { type: "geojson", data: settlementsFc });
          map.addLayer({
            id: "settlement-fill", type: "fill", source: "settlements",
            filter: settlementFilter([], ""),
            paint: {
              "fill-color": settlementColour,
              "fill-opacity": expr(["match", STATUS, FLAGGED, 0.45, DIMMED, 0.08, 0.2]),
            },
          });
          map.addLayer({
            id: "settlement-outline", type: "line", source: "settlements",
            filter: settlementFilter([], ""),
            paint: {
              "line-color": settlementColour,
              "line-width": expr(["match", STATUS, FLAGGED, 1.5, 0.5]),
              "line-opacity": expr(["match", STATUS, DIMMED, 0.2, 0.7]),
            },
          });

          // Settlement popup, unless an asset was clicked at the same spot
          map.on("click", "settlement-fill", (e) => {
            const assetHits = map.queryRenderedFeatures(e.point, { layers: Object.keys(LAYER_TYPES) });
            if (assetHits.length) return;
            const feature = e.features?.[0];
            if (!feature) return;
            const p = feature.properties as Record<string, unknown>;
            popupRef.current?.remove();
            popupRef.current = new maplibregl.Popup({ maxWidth: "300px" })
              .setLngLat(e.lngLat)
              .setHTML(settlementPopupHtml(
                p, districtNamesRef.current, settlementScreeningRef.current.get(Number(p.settlement_id)),
              ))
              .addTo(map);
          });
          map.on("mouseenter", "settlement-fill", () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", "settlement-fill", () => { map.getCanvas().style.cursor = ""; });
        }

        map.addLayer({
          id: "district-outline", type: "line", source: "districts",
          paint: { "line-color": "#3e4c59", "line-width": 1.5, "line-dasharray": [3, 2] },
        });
        map.addLayer({
          id: "district-selected", type: "line", source: "districts",
          filter: ["==", ["get", "pcode"], ""] as unknown as FilterSpecification,
          paint: { "line-color": "#1f2933", "line-width": 3.5 },
        });
        map.addLayer({
          id: "asset-lines-halo", type: "line", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-lines"], [], ""),
          paint: {
            "line-color": statusColour,
            "line-width": 8,
            "line-blur": 1,
            "line-opacity": expr(["match", STATUS, FLAGGED, 0.55, 0]),
          },
        });
        map.addLayer({
          id: "asset-lines", type: "line", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-lines"], [], ""),
          paint: {
            "line-color": categoryColour,
            "line-width": expr([
              "case",
              ["==", ["get", "asset_type"], "bridge"], 5,
              ["==", ["get", "asset_type"], "road"], 2,
              1.5,
            ]),
            "line-opacity": expr(["match", STATUS, DIMMED, 0.2, 1]),
          },
        });
        map.addLayer({
          id: "asset-points", type: "circle", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-points"], [], ""),
          paint: {
            "circle-color": categoryColour,
            "circle-radius": expr(["case", ["==", ["get", "asset_type"], "place"], 3.5, 5]),
            "circle-stroke-color": statusColour,
            "circle-stroke-width": expr(["match", STATUS, FLAGGED, 3, 1]),
            "circle-opacity": expr(["match", STATUS, DIMMED, 0.25, 1]),
            "circle-stroke-opacity": expr(["match", STATUS, DIMMED, 0.25, 1]),
          },
        });

        // Click an asset to see its details, provenance and screening status
        for (const layerId of Object.keys(LAYER_TYPES)) {
          map.on("click", layerId, (e) => {
            const feature = e.features?.[0];
            if (feature) showPopup(e.lngLat, feature.properties as Record<string, unknown>);
          });
          map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
        }

        setAssetTypes(typeList);
        setAssetsData(assetsFc as FeatureCollection);
        setSettlementsLoaded(!!settlementsFc);
        setHazard(
          ((hazardList as HazardLayer[] | null) ?? []).find((h) => h.hazard_id === HAZARD_ID) ?? null,
        );
        setDistricts(
          (districtsFc as FeatureCollection).features
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
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Update asset layer filters when categories or district change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const [layerId, types] of Object.entries(FILTERED_LAYERS)) {
      map.setFilter(layerId, layerFilter(types, hiddenCategories, selectedPcode));
    }
    if (map.getLayer("settlement-fill")) {
      const filter = settlementFilter(hiddenCategories, selectedPcode);
      map.setFilter("settlement-fill", filter);
      map.setFilter("settlement-outline", filter);
    }
  }, [hiddenCategories, selectedPcode, mapReady]);

  // Highlight and zoom to the selected district (or back to the whole pilot)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setFilter("district-selected", ["==", ["get", "pcode"], selectedPcode] as unknown as FilterSpecification);
    const target = selectedPcode
      ? districts.find((d) => d.pcode === selectedPcode)?.bounds
      : pilotBoundsRef.current;
    if (target) map.fitBounds(target, { padding: 40 });
  }, [selectedPcode, mapReady, districts]);

  // Show or hide the flood layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer("hazard-fill")) return;
    map.setLayoutProperty("hazard-fill", "visibility", showFlood ? "visible" : "none");
  }, [showFlood, mapReady]);

  // Load screening results and apply them as feature state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    const hasSettlements = !!map.getSource("settlements");
    map.removeFeatureState({ source: "assets" });
    if (hasSettlements) map.removeFeatureState({ source: "settlements" });
    screeningRef.current = new Map();
    settlementScreeningRef.current = new Map();

    if (!screeningOn) {
      setScreening(null);
      setSettlementScreening(null);
      return;
    }

    Promise.all([
      fetchJson(`${API_URL}/screening/${HAZARD_ID}?near_m=${nearM}`),
      hasSettlements
        ? fetchJson(`${API_URL}/screening/${HAZARD_ID}/settlements?near_m=${nearM}`).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([data, settlementData]: [ScreeningResponse, SettlementScreeningResponse | null]) => {
        if (cancelled) return;
        screeningRef.current = new Map(data.assets.map((a) => [a.asset_id, a]));
        for (const a of data.assets) {
          map.setFeatureState({ source: "assets", id: a.asset_id }, { status: a.status });
        }
        if (settlementData) {
          settlementScreeningRef.current = new Map(
            settlementData.settlements.map((s) => [s.settlement_id, s]),
          );
          for (const s of settlementData.settlements) {
            map.setFeatureState({ source: "settlements", id: s.settlement_id }, { status: s.status });
          }
        }
        setScreening(data);
        setSettlementScreening(settlementData ? settlementData.settlements : null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [screeningOn, nearM, mapReady]);

  // Asset counts for the current district selection
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const f of assetsData?.features ?? []) {
      if (selectedPcode && f.properties.adm2_pcode !== selectedPcode) continue;
      const type = f.properties.asset_type as string;
      result.set(type, (result.get(type) ?? 0) + 1);
    }
    return result;
  }, [assetsData, selectedPcode]);

  // Screening summary, respecting the district filter (water features excluded)
  const screeningSummary = useMemo(() => {
    if (!screening || !assetsData) return [];
    const pcodeById = new Map(
      assetsData.features.map((f) => [f.properties.asset_id as number, f.properties.adm2_pcode as string]),
    );
    const rows = new Map<string, SummaryRow>();
    for (const a of screening.assets) {
      if (a.status === "context") continue;
      if (selectedPcode && pcodeById.get(a.asset_id) !== selectedPcode) continue;
      const row = rows.get(a.asset_type) ?? {
        asset_type: a.asset_type, total: 0, in_flood: 0, in_ambiguous: 0, near: 0,
      };
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

  // Settlement footprint screening summary, respecting the district filter
  const settlementSummary = useMemo(() => {
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
      if (!p.name || !String(p.name).toLowerCase().includes(q)) return false;
      if (selectedPcode && p.adm2_pcode !== selectedPcode) return false;
      if (hiddenCategories.includes(p.category)) return false;
      return true;
    });
  }, [assetsData, query, selectedPcode, hiddenCategories]);

  function openFeature(feature: Feature) {
    const map = mapRef.current;
    if (!map) return;
    const b = geometryBounds(feature.geometry);
    if (b[0] === b[2] && b[1] === b[3]) {
      map.flyTo({ center: [b[0], b[1]], zoom: 14 });
    } else {
      map.fitBounds(b, { padding: 60, maxZoom: 15 });
    }
    showPopup(anchorPoint(feature.geometry), feature.properties);
  }

  function toggleCategory(category: string) {
    setHiddenCategories((current) =>
      current.includes(category)
        ? current.filter((c) => c !== category)
        : [...current, category],
    );
  }

  const labelFor = (assetType: string) =>
    assetTypes.find((t) => t.asset_type === assetType)?.label ?? assetType;

  const scopeLabel = selectedPcode
    ? districts.find((d) => d.pcode === selectedPcode)?.name ?? selectedPcode
    : "all pilot districts";

  return (
    <div className="app">
      <aside className="panel">
        <h1>GeoPulse Intelligence</h1>
        <p className="subtitle">Pilot: Lower Volta corridor, Ghana</p>

        {error && <p className="error">Could not load data: {error}. Is the API running?</p>}
        {!error && !mapReady && <p className="subtitle">Loading…</p>}

        {mapReady && (
          <>
            <label className="field">
              <span>District</span>
              <select value={selectedPcode} onChange={(e) => setSelectedPcode(e.target.value)}>
                <option value="">All pilot districts</option>
                {districts.map((d) => (
                  <option key={d.pcode} value={d.pcode}>
                    {d.name} ({d.region})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Search by name</span>
              <input
                type="search"
                value={query}
                placeholder="e.g. Kpong, Ada"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>

            {query.trim().length >= 2 && (
              <ul className="results">
                {matches.length === 0 && <li className="empty">No named assets match.</li>}
                {matches.slice(0, MAX_RESULTS).map((f) => (
                  <li key={f.properties.asset_id}>
                    <button type="button" onClick={() => openFeature(f)}>
                      <strong>{f.properties.name}</strong>
                      <span>
                        {f.properties.label} · {districtNamesRef.current.get(f.properties.adm2_pcode) ?? ""}
                      </span>
                    </button>
                  </li>
                ))}
                {matches.length > MAX_RESULTS && (
                  <li className="empty">
                    Showing {MAX_RESULTS} of {matches.length}. Type more to narrow down.
                  </li>
                )}
              </ul>
            )}

            {hazard && (
              <section className="section">
                <h2 className="section-title">Flood screening · 2023 spillage</h2>

                <label className="check">
                  <input type="checkbox" checked={showFlood} onChange={(e) => setShowFlood(e.target.checked)} />
                  Show observed new water (Oct 2023)
                </label>
                <div className="legend-inline">
                  <span><i className="box" style={{ background: FLOOD_COLOURS.flooded }} /> Flooding</span>
                  <span><i className="box" style={{ background: FLOOD_COLOURS.ambiguous }} /> Ambiguous (lagoons/seasonal water)</span>
                </div>

                <label className="check">
                  <input type="checkbox" checked={screeningOn} onChange={(e) => setScreeningOn(e.target.checked)} />
                  Highlight asset exposure
                </label>

                {screeningOn && (
                  <>
                    <label className="field inline">
                      <span>"Near" means within</span>
                      <select value={nearM} onChange={(e) => setNearM(Number(e.target.value))}>
                        {NEAR_OPTIONS.map((m) => (
                          <option key={m} value={m}>{m >= 1000 ? `${m / 1000} km` : `${m} m`}</option>
                        ))}
                      </select>
                    </label>
                    <div className="legend-inline">
                      <span><i className="ring" style={{ borderColor: STATUS_COLOURS.in_flood }} /> In flood</span>
                      <span><i className="ring" style={{ borderColor: STATUS_COLOURS.in_ambiguous }} /> In ambiguous</span>
                      <span><i className="ring" style={{ borderColor: STATUS_COLOURS.near }} /> Near</span>
                    </div>

                    {!screening && <p className="subtitle">Loading screening…</p>}
                    {screening && (
                      <>
                        <p className="counts-scope">Flagged assets in {scopeLabel}</p>
                        <table className="summary-table">
                          <thead>
                            <tr>
                              <th>Asset type</th>
                              <th title="In observed flood">In</th>
                              <th title="In ambiguous seasonal water">Amb.</th>
                              <th title={`Within ${nearM} m`}>Near</th>
                            </tr>
                          </thead>
                          <tbody>
                            {settlementSummary && (
                              <tr>
                                <td><strong>Settlement footprints</strong></td>
                                <td>{settlementSummary.in_flood}</td>
                                <td>{settlementSummary.in_ambiguous}</td>
                                <td>{settlementSummary.near}</td>
                              </tr>
                            )}
                            {screeningSummary.map((r) => (
                              <tr key={r.asset_type}>
                                <td>{labelFor(r.asset_type)}</td>
                                <td>{r.in_flood}</td>
                                <td>{r.in_ambiguous}</td>
                                <td>{r.near}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="warning">
                          Preliminary screening only. Proximity to observed water is not a measure of
                          damage, and assets not flagged are not confirmed safe.
                        </p>
                      </>
                    )}
                  </>
                )}

                <details className="method">
                  <summary>Method &amp; limitations</summary>
                  <p>
                    <strong>Observed:</strong> {hazard.observed_dates} (Sentinel-1 radar, source {hazard.source_id})
                  </p>
                  {hazard.pre_event_window && (
                    <p><strong>Baseline:</strong> {hazard.pre_event_window.join(" to ")}</p>
                  )}
                  <p><strong>Method:</strong> {hazard.method}</p>
                  <ul>
                    {(hazard.limitations ?? []).map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </details>
              </section>
            )}

            <p className="hint">
              Click a category to show or hide it. Click a map feature for details.
              {settlementsLoaded && " Settlement footprints (light purple) follow the settlement toggle."}
            </p>
            <p className="counts-scope">Counts for {scopeLabel}</p>
          </>
        )}

        {Object.keys(CATEGORY_COLOURS).map((category) => {
          const rows = assetTypes.filter((t) => t.category === category);
          if (rows.length === 0) return null;
          const isHidden = hiddenCategories.includes(category);
          const warnings = [
            ...new Set(rows.map((r) => r.coverage_warning).filter((w): w is string => !!w)),
          ];
          return (
            <div className={`category${isHidden ? " is-hidden" : ""}`} key={category}>
              <h2>
                <button
                  type="button"
                  className="category-toggle"
                  onClick={() => toggleCategory(category)}
                  aria-pressed={!isHidden}
                >
                  <span
                    className="swatch"
                    style={{ background: isHidden ? "#cbd2d9" : CATEGORY_COLOURS[category] }}
                  />
                  {category}
                  <span className="toggle-state">{isHidden ? "hidden" : "shown"}</span>
                </button>
              </h2>
              {rows.map((t) => (
                <div className="type-row" key={t.asset_type}>
                  <span>{t.label}</span>
                  <span>{counts.get(t.asset_type) ?? 0}</span>
                </div>
              ))}
              {warnings.map((w) => (
                <div className="warning" key={w}>⚠ {w}</div>
              ))}
            </div>
          );
        })}

        <p className="notice">
          Preliminary screening information only. Assets: © OpenStreetMap contributors (ODbL),
          snapshot 2026-10-31. Boundaries: Ghana Statistical Service via OCHA HDX. Settlement
          footprints: GRID3 GHA Settlement Extents v3.0 (CIESIN, Columbia University, 2024). Flood layer:
          derived from Copernicus Sentinel-1 data (2023). Absence of a feature on this map is not
          evidence of absence on the ground.
        </p>
      </aside>
      <div ref={mapContainer} className="map" />
    </div>
  );
}
