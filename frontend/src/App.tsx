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
// Free basemap, no API key needed (OpenFreeMap, built on OpenStreetMap data)
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

const CATEGORY_COLOURS: Record<string, string> = {
  transport: "#d95f02",
  water: "#1f78b4",
  settlement: "#6a3d9a",
  social: "#33a02c",
  energy: "#e31a1c",
};

// Which asset types each map layer draws
const LAYER_TYPES: Record<string, string[]> = {
  "asset-areas": ["water_body"],
  "asset-lines": ["road", "bridge", "waterway", "power_line"],
  "asset-points": ["place", "education", "health", "power_plant", "power_substation"],
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

// Colour each feature by its category (MapLibre "match" expression)
const categoryColour = [
  "match", ["get", "category"],
  ...Object.entries(CATEGORY_COLOURS).flat(),
  "#666666",
] as unknown as ExpressionSpecification;

// Filter for an asset layer: its own types, minus hidden categories, optionally one district
function layerFilter(types: string[], hidden: string[], pcode: string): FilterSpecification {
  const conditions: unknown[] = [
    ["in", ["get", "asset_type"], ["literal", types]],
    ["!", ["in", ["get", "category"], ["literal", hidden]]],
  ];
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
  return `
    <div class="popup">
      <h3>${escapeHtml(name)}</h3>
      <p>${escapeHtml(text(p.label) ?? "")}${subtype ? " · " + escapeHtml(subtype) : ""}</p>
      <p>District: ${escapeHtml(district)}</p>
      <p>Source: ${escapeHtml(text(p.source_id) ?? "")} · ${refLink} · ${escapeHtml(text(p.source_date) ?? "")}</p>
      ${warning ? `<p class="warning">⚠ ${escapeHtml(warning)}</p>` : ""}
    </div>`;
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pilotBoundsRef = useRef<Bounds | null>(null);
  const warningByTypeRef = useRef(new Map<string, string | null>());
  const districtNamesRef = useRef(new Map<string, string>());

  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [assetsData, setAssetsData] = useState<FeatureCollection | null>(null);
  const [districts, setDistricts] = useState<District[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);
  const [selectedPcode, setSelectedPcode] = useState("");
  const [query, setQuery] = useState("");

  function showPopup(lngLat: maplibregl.LngLatLike, properties: Record<string, unknown>) {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(popupHtml(properties, warningByTypeRef.current, districtNamesRef.current))
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
        const [districtsFc, assetsFc, types] = await Promise.all([
          fetchJson(`${API_URL}/pilots/${PILOT_ID}/districts`),
          fetchJson(`${API_URL}/assets?limit=5000`),
          fetchJson(`${API_URL}/asset-types`),
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
          paint: { "fill-color": categoryColour, "fill-opacity": 0.35 },
        });
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
          id: "asset-lines", type: "line", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-lines"], [], ""),
          paint: {
            "line-color": categoryColour,
            "line-width": [
              "case",
              ["==", ["get", "asset_type"], "bridge"], 5,
              ["==", ["get", "asset_type"], "road"], 2,
              1.5,
            ],
          },
        });
        map.addLayer({
          id: "asset-points", type: "circle", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-points"], [], ""),
          paint: {
            "circle-color": categoryColour,
            "circle-radius": ["case", ["==", ["get", "asset_type"], "place"], 3.5, 5],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
          },
        });

        // Click an asset to see its details and provenance
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
    for (const [layerId, types] of Object.entries(LAYER_TYPES)) {
      map.setFilter(layerId, layerFilter(types, hiddenCategories, selectedPcode));
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

  const scopeLabel = selectedPcode
    ? districts.find((d) => d.pcode === selectedPcode)?.name ?? selectedPcode
    : "all pilot districts";

  return (
    <div className="app">
      <aside className="panel">
        <h1>GeoPulse Intelligence</h1>
        <p className="subtitle">Pilot: Lower Volta corridor, Ghana · Asset map</p>

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

            <p className="hint">Click a category to show or hide it. Click a map feature for details.</p>
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
          snapshot 2026-10-31. Boundaries: Ghana Statistical Service via OCHA HDX.
          Absence of a feature on this map is not evidence of absence on the ground.
        </p>
      </aside>
      <div ref={mapContainer} className="map" />
    </div>
  );
}