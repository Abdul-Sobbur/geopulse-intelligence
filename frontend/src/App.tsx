import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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

type ProximityFeature = {
  kind: "asset" | "settlement";
  id: number;
  type: string;
  label: string;
  category: string;
  name: string | null;
  adm2_pcode: string | null;
  building_count: number | null;
  distance_m: number;
  lon: number;
  lat: number;
};

type ProximitySummary = { kind: string; type: string; label: string; count: number; buildings: number | null };

type ProximityResponse = {
  center: [number, number];
  radius_m: number;
  district: { pcode: string; name: string } | null;
  hazard: { hazard_id: string; flooded_m2: number; ambiguous_m2: number } | null;
  total: number;
  summary: ProximitySummary[];
  features: ProximityFeature[];
};

const RADIUS_OPTIONS = [250, 500, 1000, 2000, 5000];

type PickTarget = "proximity" | "site";

type CandidateSite = { id: string; lon: number; lat: number };

type SiteCriterion = { id: string; label: string; unit: string; group: string; note: string };

type ComparisonResponse = {
  radius_m: number;
  criteria: SiteCriterion[];
  sites: { lon: number; lat: number; values: Record<string, string | number | null> }[];
  rasters: { dem: boolean; landcover: boolean };
  note: string;
};

const SITE_LETTERS = ["A", "B", "C", "D"];
const SITE_RADIUS_OPTIONS = [250, 500, 1000, 2000, 5000];

function formatCriterion(value: string | number | null | undefined, unit: string): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "string") return value;
  switch (unit) {
    case "m":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
    case "m_asl":
      return `${Math.round(value)} m`;
    case "deg":
      return `${value.toFixed(1)}°`;
    case "ha":
      return `${value.toFixed(1)} ha`;
    case "count":
      return Math.round(value).toLocaleString();
    default:
      return String(value);
  }
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

// Approximate circle (as a polygon ring) of a given radius in metres around a point
function circleRing(lon: number, lat: number, radiusM: number, steps = 72): [number, number][] {
  const ring: [number, number][] = [];
  const metresPerDegLat = 110_574;
  const metresPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    ring.push([
      lon + (radiusM * Math.cos(angle)) / metresPerDegLon,
      lat + (radiusM * Math.sin(angle)) / metresPerDegLat,
    ]);
  }
  return ring;
}

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

type MetricDefinition = {
  id: string;
  label: string;
  unit: string;
  kind: string;
  definition: string;
  source: string;
};

type DashboardDistrict = {
  pcode: string;
  name: string;
  region: string;
  area_km2: number;
  assets: number;
  assets_flagged: number;
  settlements: number;
  buildings: number;
  settlements_in_flood: number;
  settlements_ambiguous_or_near: number;
  flooded_km2: number | null;
  ambiguous_km2: number | null;
};

type DashboardAssetType = {
  asset_type: string;
  label: string;
  category: string;
  coverage_warning: string | null;
  total: number;
  in_flood: number;
  in_ambiguous: number;
  near: number;
};

type DashboardResponse = {
  scope: { pcode: string | null; name: string };
  near_m: number;
  hazard: { hazard_id: string; title: string; observed_dates: string };
  kpis: { id: string; value: number | null }[];
  districts: DashboardDistrict[];
  asset_types: DashboardAssetType[];
  definitions: MetricDefinition[];
  note: string;
};

function formatMetric(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "–";
  if (unit === "km²") return `${value.toFixed(1)} km²`;
  return Math.round(value).toLocaleString();
}

type BarRow = { key: string; label: string; value: number | null; selected: boolean };

// One-series horizontal bar chart (single hue, sorted, direct value labels, hover title)
function BarList({ title, rows, unit, note }: { title: string; rows: BarRow[]; unit: string; note?: string }) {
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const max = Math.max(0, ...sorted.map((r) => r.value ?? 0));
  const anySelected = sorted.some((r) => r.selected);
  return (
    <figure className="bar-chart">
      <figcaption>{title}</figcaption>
      {sorted.map((r) => {
        const width = max > 0 && r.value ? (r.value / max) * 100 : 0;
        const value = formatMetric(r.value, unit);
        return (
          <div
            key={r.key}
            className={`bar-row${anySelected && !r.selected ? " is-dim" : ""}`}
            title={`${r.label}: ${value}`}
          >
            <span className="bar-label">{r.label}</span>
            <span className="bar-track"><span className="bar" style={{ width: `${width}%` }} /></span>
            <span className="bar-value">{value}</span>
          </div>
        );
      })}
      {note && <p className="hint">{note}</p>}
    </figure>
  );
}

type DashboardProps = {
  data: DashboardResponse | null;
  loading: boolean;
  districts: District[];
  selectedPcode: string;
  onSelectPcode: (pcode: string) => void;
  nearM: number;
  onNearM: (m: number) => void;
  onClose: () => void;
};

function DashboardView({
  data, loading, districts, selectedPcode, onSelectPcode, nearM, onNearM, onClose,
}: DashboardProps) {
  const definitions = new Map((data?.definitions ?? []).map((d) => [d.id, d]));
  const unitOf = (id: string) => definitions.get(id)?.unit ?? "";
  const bars = (key: keyof DashboardDistrict): BarRow[] =>
    (data?.districts ?? []).map((d) => ({
      key: d.pcode,
      label: d.name,
      value: d[key] as number | null,
      selected: d.pcode === selectedPcode,
    }));

  return (
    <div className="dashboard">
      <div className="dash-header">
        <div>
          <h2>Dashboard · {data?.scope.name ?? "…"}</h2>
          {data && (
            <p className="subtitle">
              Flood indicators: {data.hazard.title} (observed {data.hazard.observed_dates}) ·
              near = within {formatDistance(nearM)}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-secondary dash-close" onClick={onClose}>
          Back to map
        </button>
      </div>

      <div className="dash-filters">
        <label className="field">
          <span>District</span>
          <select value={selectedPcode} onChange={(e) => onSelectPcode(e.target.value)}>
            <option value="">All pilot districts</option>
            {districts.map((d) => <option key={d.pcode} value={d.pcode}>{d.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>"Near" means within</span>
          <select value={nearM} onChange={(e) => onNearM(Number(e.target.value))}>
            {NEAR_OPTIONS.map((m) => <option key={m} value={m}>{formatDistance(m)}</option>)}
          </select>
        </label>
      </div>

      {loading && <p className="subtitle">Loading dashboard…</p>}

      {data && !loading && (
        <>
          <div className="kpi-grid">
            {data.kpis.map((k) => {
              const def = definitions.get(k.id);
              return (
                <div className="kpi" key={k.id} title={def?.definition}>
                  <span className="kpi-value">{formatMetric(k.value, unitOf(k.id))}</span>
                  <span className="kpi-label">{def?.label ?? k.id}</span>
                  <span className="kind">{def?.kind}</span>
                </div>
              );
            })}
          </div>

          <div className="chart-grid">
            <BarList
              title="Observed flooding by district (km²)"
              rows={bars("flooded_km2")}
              unit="km²"
              note="Sentinel-1 on two dates; likely an under-estimate."
            />
            <BarList
              title="Settlements intersecting observed flooding"
              rows={bars("settlements_in_flood")}
              unit="count"
              note="GRID3 footprints x observed flooding."
            />
            <BarList
              title={`Assets flagged (in or within ${formatDistance(nearM)} of observed water)`}
              rows={bars("assets_flagged")}
              unit="count"
              note="Mapped OpenStreetMap assets only."
            />
          </div>

          <h3 className="dash-h3">By district</h3>
          <div className="table-wrap">
            <table className="summary-table dash-table">
              <thead>
                <tr>
                  <th>District</th><th>Area</th><th>Assets</th><th>Settlements</th><th>Buildings</th>
                  <th>Flooding</th><th>Ambiguous</th><th>Settl. in flood</th>
                  <th>Settl. ambig./near</th><th>Assets flagged</th>
                </tr>
              </thead>
              <tbody>
                {data.districts.map((d) => (
                  <tr key={d.pcode} className={d.pcode === selectedPcode ? "is-selected" : ""}>
                    <td>{d.name} <span className="muted">({d.pcode})</span></td>
                    <td>{formatMetric(d.area_km2, "km²")}</td>
                    <td>{formatMetric(d.assets, "count")}</td>
                    <td>{formatMetric(d.settlements, "count")}</td>
                    <td>{formatMetric(d.buildings, "count")}</td>
                    <td>{formatMetric(d.flooded_km2, "km²")}</td>
                    <td>{formatMetric(d.ambiguous_km2, "km²")}</td>
                    <td>{formatMetric(d.settlements_in_flood, "count")}</td>
                    <td>{formatMetric(d.settlements_ambiguous_or_near, "count")}</td>
                    <td>{formatMetric(d.assets_flagged, "count")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="dash-h3">Assets by type · {data.scope.name}</h3>
          <div className="table-wrap">
            <table className="summary-table dash-table">
              <thead>
                <tr><th>Asset type</th><th>Mapped</th><th>In flood</th><th>In ambiguous</th><th>Near</th><th>Coverage</th></tr>
              </thead>
              <tbody>
                {data.asset_types.map((t) => (
                  <tr key={t.asset_type}>
                    <td>{t.label}</td>
                    <td>{t.total}</td>
                    <td>{t.in_flood}</td>
                    <td>{t.in_ambiguous}</td>
                    <td>{t.near}</td>
                    <td className="text-cell">{t.coverage_warning ? `⚠ ${t.coverage_warning}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="dash-h3">Metric definitions</h3>
          <div className="table-wrap">
            <table className="summary-table dash-table definitions">
              <thead>
                <tr><th>Metric</th><th>Kind</th><th>Definition</th><th>Source</th></tr>
              </thead>
              <tbody>
                {data.definitions.map((d) => (
                  <tr key={d.id}>
                    <td>{d.label}</td>
                    <td className="text-cell"><span className="kind">{d.kind}</span></td>
                    <td className="text-cell">{d.definition}</td>
                    <td className="text-cell">{d.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Kinds: <strong>Observation</strong> = counted or measured from a source dataset;
            {" "}<strong>Modelled estimate</strong> = produced by a provider's model;
            {" "}<strong>Derived</strong> = calculated by GeoPulse from other layers.
          </p>
          <p className="warning">{data.note}</p>
        </>
      )}
    </div>
  );
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
  const pickModeRef = useRef(false);
  const pickTargetRef = useRef<PickTarget>("proximity");
  const radiusRef = useRef(1000);
  const sitesRef = useRef<CandidateSite[]>([]);
  const siteMarkersRef = useRef(new Map<string, maplibregl.Marker>());

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
  const [pickMode, setPickMode] = useState(false);
  const [radiusM, setRadiusM] = useState(1000);
  const [proximity, setProximity] = useState<ProximityResponse | null>(null);
  const [proximityLoading, setProximityLoading] = useState(false);
  const [pickTarget, setPickTarget] = useState<PickTarget>("proximity");
  const [sites, setSites] = useState<CandidateSite[]>([]);
  const [siteRadius, setSiteRadius] = useState(1000);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [view, setView] = useState<"map" | "dashboard">("map");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);

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

  // Query everything within the chosen radius of a point and draw the search circle
  async function runProximity(lon: number, lat: number) {
    const map = mapRef.current;
    if (!map) return;
    pickModeRef.current = false;
    setPickMode(false);
    const radius = radiusRef.current;

    const source = map.getSource("proximity") as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { role: "area" },
          geometry: { type: "Polygon", coordinates: [circleRing(lon, lat, radius)] },
        },
        {
          type: "Feature",
          properties: { role: "centre" },
          geometry: { type: "Point", coordinates: [lon, lat] },
        },
      ],
    });

    setProximityLoading(true);
    try {
      const data = await fetchJson(
        `${API_URL}/proximity?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}` +
        `&radius_m=${radius}&hazard_id=${HAZARD_ID}&limit=100`,
      );
      setProximity(data as ProximityResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProximityLoading(false);
    }
  }

  function clearProximity() {
    setProximity(null);
    const source = mapRef.current?.getSource("proximity") as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: [] });
  }

  function changeRadius(value: number) {
    setRadiusM(value);
    radiusRef.current = value;
    if (proximity) runProximity(proximity.center[0], proximity.center[1]);
  }

  // Start or cancel "click the map" mode, for a proximity search or for adding a candidate site
  function togglePickMode(target: PickTarget) {
    const next = !(pickMode && pickTarget === target);
    pickModeRef.current = next;
    pickTargetRef.current = target;
    setPickMode(next);
    setPickTarget(target);
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = next ? "crosshair" : "";
  }

  function endPickMode() {
    pickModeRef.current = false;
    setPickMode(false);
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = "";
  }

  // Add a candidate site (A-D) where the map was clicked
  function addSite(lon: number, lat: number) {
    const map = mapRef.current;
    endPickMode();
    if (!map) return;
    const used = new Set(sitesRef.current.map((s) => s.id));
    const id = SITE_LETTERS.find((letter) => !used.has(letter));
    if (!id) return;

    const element = document.createElement("div");
    element.className = "site-marker";
    element.textContent = id;
    siteMarkersRef.current.set(id, new maplibregl.Marker({ element }).setLngLat([lon, lat]).addTo(map));

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
        [c.label, c.group, c.unit, c.note, ...comparison.sites.map((s) => s.values[c.id] ?? "")]
          .map(quote)
          .join(","),
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
            if (pickModeRef.current) return;
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
          map.on("mouseenter", "settlement-fill", () => {
            if (!pickModeRef.current) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "settlement-fill", () => {
            if (!pickModeRef.current) map.getCanvas().style.cursor = "";
          });
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
            if (pickModeRef.current) return;
            const feature = e.features?.[0];
            if (feature) showPopup(e.lngLat, feature.properties as Record<string, unknown>);
          });
          map.on("mouseenter", layerId, () => {
            if (!pickModeRef.current) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            if (!pickModeRef.current) map.getCanvas().style.cursor = "";
          });
        }

        // Proximity search circle (drawn on top of everything)
        map.addSource("proximity", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "proximity-fill", type: "fill", source: "proximity",
          filter: ["==", ["get", "role"], "area"] as unknown as FilterSpecification,
          paint: { "fill-color": "#1f2933", "fill-opacity": 0.06 },
        });
        map.addLayer({
          id: "proximity-line", type: "line", source: "proximity",
          filter: ["==", ["get", "role"], "area"] as unknown as FilterSpecification,
          paint: { "line-color": "#1f2933", "line-width": 2, "line-dasharray": [2, 2] },
        });
        map.addLayer({
          id: "proximity-centre", type: "circle", source: "proximity",
          filter: ["==", ["get", "role"], "centre"] as unknown as FilterSpecification,
          paint: {
            "circle-radius": 6, "circle-color": "#1f2933",
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
          },
        });

        // Candidate site assessment circles
        map.addSource("sites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "sites-fill", type: "fill", source: "sites",
          paint: { "fill-color": "#0f766e", "fill-opacity": 0.08 },
        });
        map.addLayer({
          id: "sites-line", type: "line", source: "sites",
          paint: { "line-color": "#0f766e", "line-width": 2, "line-dasharray": [1, 1.5] },
        });

        // In "pick a point" mode, a click on the map runs a proximity search or adds a site
        map.on("click", (e) => {
          if (!pickModeRef.current) return;
          if (pickTargetRef.current === "site") addSite(e.lngLat.lng, e.lngLat.lat);
          else runProximity(e.lngLat.lng, e.lngLat.lat);
        });

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

  // Draw site circles and re-run the comparison whenever sites or the radius change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource("sites") as maplibregl.GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: sites.map((s) => ({
        type: "Feature" as const,
        properties: { id: s.id },
        geometry: { type: "Polygon" as const, coordinates: [circleRing(s.lon, s.lat, siteRadius)] },
      })),
    });

    if (sites.length === 0) {
      setComparison(null);
      return;
    }

    let cancelled = false;
    const query = sites.map((s) => `site=${s.lon.toFixed(6)},${s.lat.toFixed(6)}`).join("&");
    setComparisonLoading(true);
    fetchJson(`${API_URL}/sites/compare?${query}&radius_m=${siteRadius}&hazard_id=${HAZARD_ID}`)
      .then((data) => {
        if (!cancelled) setComparison(data as ComparisonResponse);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setComparisonLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sites, siteRadius, mapReady]);

  // Load dashboard figures while the dashboard is open
  useEffect(() => {
    if (view !== "dashboard") return;
    let cancelled = false;
    setDashboardLoading(true);
    const query =
      `pilot_id=${PILOT_ID}&hazard_id=${HAZARD_ID}&near_m=${nearM}` +
      (selectedPcode ? `&pcode=${encodeURIComponent(selectedPcode)}` : "");
    fetchJson(`${API_URL}/dashboard?${query}`)
      .then((data) => {
        if (!cancelled) setDashboard(data as DashboardResponse);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDashboardLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, nearM, selectedPcode]);

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

  function toggleCategory(category: string) {
    setHiddenCategories((current) =>
      current.includes(category)
        ? current.filter((c) => c !== category)
        : [...current, category],
    );
  }

  // Report download link for the current distance and district selection
  const reportUrl = (format: "html" | "csv" | "geojson") =>
    `${API_URL}/reports/screening/${HAZARD_ID}?format=${format}&near_m=${nearM}` +
    (selectedPcode ? `&pcode=${encodeURIComponent(selectedPcode)}` : "");

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
            <button
              type="button"
              className="btn dash-toggle"
              onClick={() => setView((v) => (v === "map" ? "dashboard" : "map"))}
            >
              {view === "map" ? "Open dashboard" : "Back to map"}
            </button>

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

            <section className="section">
              <h2 className="section-title">What's nearby? · proximity</h2>

              <label className="field inline">
                <span>Radius</span>
                <select value={radiusM} onChange={(e) => changeRadius(Number(e.target.value))}>
                  {RADIUS_OPTIONS.map((m) => (
                    <option key={m} value={m}>{formatDistance(m)}</option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className={`btn${pickMode && pickTarget === "proximity" ? " btn-active" : ""}`}
                onClick={() => togglePickMode("proximity")}
              >
                {pickMode && pickTarget === "proximity"
                  ? "Click the map to choose a point (or cancel)"
                  : "Pick a point on the map"}
              </button>

              {proximityLoading && <p className="subtitle">Searching…</p>}

              {proximity && !proximityLoading && (
                <>
                  <p className="counts-scope">
                    Within {formatDistance(proximity.radius_m)} of {proximity.center[1].toFixed(4)},{" "}
                    {proximity.center[0].toFixed(4)}
                    {proximity.district ? ` · ${proximity.district.name}` : " · outside mapped districts"}
                  </p>

                  {proximity.total === 0 && <p className="subtitle">Nothing mapped within this radius.</p>}

                  {proximity.summary.length > 0 && (
                    <table className="summary-table">
                      <thead>
                        <tr><th>Type</th><th>Count</th></tr>
                      </thead>
                      <tbody>
                        {proximity.summary.map((s) => (
                          <tr key={`${s.kind}-${s.type}`}>
                            <td>{s.kind === "settlement" ? `${s.label} (footprint)` : s.label}</td>
                            <td>
                              {s.count}
                              {s.buildings ? ` · ${s.buildings.toLocaleString()} bldgs` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {proximity.hazard && (proximity.hazard.flooded_m2 > 0 || proximity.hazard.ambiguous_m2 > 0) && (
                    <p className="subtitle">
                      Observed new water (Oct 2023) inside the circle:{" "}
                      {(proximity.hazard.flooded_m2 / 10_000).toFixed(1)} ha flooding,{" "}
                      {(proximity.hazard.ambiguous_m2 / 10_000).toFixed(1)} ha ambiguous.
                    </p>
                  )}

                  {proximity.features.length > 0 && (
                    <ul className="results">
                      {proximity.features.map((f) => (
                        <li key={`${f.kind}-${f.id}`}>
                          <button type="button" onClick={() => openProximityFeature(f)}>
                            <strong>
                              {f.name ?? (f.kind === "settlement" ? `${f.label} footprint` : "(unnamed)")}
                            </strong>
                            <span>{f.label} · {Math.round(f.distance_m)} m</span>
                          </button>
                        </li>
                      ))}
                      {proximity.total > proximity.features.length && (
                        <li className="empty">
                          Showing nearest {proximity.features.length} of {proximity.total}.
                        </li>
                      )}
                    </ul>
                  )}

                  <p className="hint">
                    Straight-line (geodesic) distance to the nearest edge of each feature, not travel
                    distance. Settlement building counts cover whole settlements.
                  </p>
                  <button type="button" className="btn btn-secondary" onClick={clearProximity}>
                    Clear
                  </button>
                </>
              )}
            </section>

            <section className="section">
              <h2 className="section-title">Compare candidate sites</h2>

              <label className="field inline">
                <span>Assessment radius</span>
                <select value={siteRadius} onChange={(e) => setSiteRadius(Number(e.target.value))}>
                  {SITE_RADIUS_OPTIONS.map((m) => (
                    <option key={m} value={m}>{formatDistance(m)}</option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className={`btn${pickMode && pickTarget === "site" ? " btn-active" : ""}`}
                onClick={() => togglePickMode("site")}
                disabled={sites.length >= SITE_LETTERS.length}
              >
                {sites.length >= SITE_LETTERS.length
                  ? "Maximum of 4 sites"
                  : pickMode && pickTarget === "site"
                    ? "Click the map to place the site (or cancel)"
                    : `Add site ${SITE_LETTERS.find((l) => !sites.some((s) => s.id === l))} (click the map)`}
              </button>

              {sites.length > 0 && (
                <ul className="site-list">
                  {sites.map((s) => (
                    <li key={s.id}>
                      <span className="site-badge">{s.id}</span>
                      <span>{s.lat.toFixed(4)}, {s.lon.toFixed(4)}</span>
                      <button type="button" className="link-button" onClick={() => removeSite(s.id)}>
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {comparisonLoading && <p className="subtitle">Comparing…</p>}

              {comparison && !comparisonLoading && comparison.sites.length === sites.length && (
                <>
                  <div className="table-wrap">
                    <table className="summary-table compare-table">
                      <thead>
                        <tr>
                          <th>Criterion</th>
                          {sites.map((s) => <th key={s.id}>{s.id}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.criteria.map((c, i) => (
                          <Fragment key={c.id}>
                            {(i === 0 || comparison.criteria[i - 1].group !== c.group) && (
                              <tr className="group-row">
                                <td colSpan={sites.length + 1}>{c.group}</td>
                              </tr>
                            )}
                            <tr>
                              <td title={c.note}>{c.label}</td>
                              {comparison.sites.map((s, j) => (
                                <td key={sites[j]?.id ?? j}>{formatCriterion(s.values[c.id], c.unit)}</td>
                              ))}
                            </tr>
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {(!comparison.rasters.dem || !comparison.rasters.landcover) && (
                    <p className="warning">
                      Terrain and/or land cover unavailable: run scripts/download_site_rasters.py.
                    </p>
                  )}
                  <p className="hint">
                    Criteria are shown separately, with no score or ranking: whether a value is
                    favourable depends on the project. Hover a criterion for its source. Distances are
                    straight-line. Preliminary screening only.
                  </p>
                  <button type="button" className="btn btn-secondary" onClick={downloadComparisonCsv}>
                    Download comparison (CSV)
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={clearSites}>
                    Clear all sites
                  </button>
                </>
              )}
            </section>

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

                <div className="downloads">
                  <p className="counts-scope">
                    Download report for {scopeLabel} · near = {formatDistance(nearM)}
                  </p>
                  <a className="btn btn-secondary" href={reportUrl("html")} target="_blank" rel="noopener">
                    Printable report (save as PDF)
                  </a>
                  <a className="btn btn-secondary" href={reportUrl("csv")}>CSV + metadata (.zip)</a>
                  <a className="btn btn-secondary" href={reportUrl("geojson")}>GeoJSON (for GIS)</a>
                </div>

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
      <div className="map-area">
        <div ref={mapContainer} className="map" />
        {view === "dashboard" && (
          <DashboardView
            data={dashboard}
            loading={dashboardLoading}
            districts={districts}
            selectedPcode={selectedPcode}
            onSelectPcode={setSelectedPcode}
            nearM={nearM}
            onNearM={setNearM}
            onClose={() => setView("map")}
          />
        )}
      </div>
    </div>
  );
}
