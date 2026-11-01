import { useEffect, useRef, useState } from "react";
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

type AssetType = {
  asset_type: string;
  category: string;
  label: string;
  coverage_warning: string | null;
  count: number;
};

// Colour each feature by its category (MapLibre "match" expression)
const categoryColour = [
  "match", ["get", "category"],
  ...Object.entries(CATEGORY_COLOURS).flat(),
  "#666666",
] as unknown as ExpressionSpecification;

// Filter for a layer: its own asset types, minus any hidden categories
function layerFilter(types: string[], hiddenCategories: string[]): FilterSpecification {
  return [
    "all",
    ["in", ["get", "asset_type"], ["literal", types]],
    ["!", ["in", ["get", "category"], ["literal", hiddenCategories]]],
  ] as unknown as FilterSpecification;
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

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [hiddenCategories, setHiddenCategories] = useState<string[]>([]);

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
        const [districts, assets, types] = await Promise.all([
          fetchJson(`${API_URL}/pilots/${PILOT_ID}/districts`),
          fetchJson(`${API_URL}/assets?limit=5000`),
          fetchJson(`${API_URL}/asset-types`),
        ]);
        const typeList = types as AssetType[];
        setAssetTypes(typeList);

        const warningByType = new Map<string, string | null>(
          typeList.map((t) => [t.asset_type, t.coverage_warning]),
        );
        const districtNames = new Map<string, string>(
          districts.features.map((f: any) => [f.properties.pcode, f.properties.name]),
        );

        map.addSource("districts", { type: "geojson", data: districts });
        map.addSource("assets", { type: "geojson", data: assets });

        // Layers are drawn in this order (first = bottom)
        map.addLayer({
          id: "district-fill", type: "fill", source: "districts",
          paint: { "fill-color": "#000000", "fill-opacity": 0.03 },
        });
        map.addLayer({
          id: "asset-areas", type: "fill", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-areas"], []),
          paint: { "fill-color": categoryColour, "fill-opacity": 0.35 },
        });
        map.addLayer({
          id: "district-outline", type: "line", source: "districts",
          paint: { "line-color": "#3e4c59", "line-width": 1.5, "line-dasharray": [3, 2] },
        });
        map.addLayer({
          id: "asset-lines", type: "line", source: "assets",
          filter: layerFilter(LAYER_TYPES["asset-lines"], []),
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
          filter: layerFilter(LAYER_TYPES["asset-points"], []),
          paint: {
            "circle-color": categoryColour,
            "circle-radius": ["case", ["==", ["get", "asset_type"], "place"], 3.5, 5],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
          },
        });

        map.fitBounds(districts.bbox as [number, number, number, number], { padding: 30 });

        // Click an asset to see its details and provenance
        for (const layerId of Object.keys(LAYER_TYPES)) {
          map.on("click", layerId, (e) => {
            const feature = e.features?.[0];
            if (!feature) return;
            const p = feature.properties as Record<string, unknown>;
            const name = text(p.name) ?? "(unnamed)";
            const subtype = text(p.subtype);
            const pcode = text(p.adm2_pcode);
            const ref = text(p.source_ref);
            const warning = warningByType.get(String(p.asset_type));
            const district = pcode ? `${districtNames.get(pcode) ?? ""} (${pcode})` : "–";
            const refLink = ref
              ? `<a href="https://www.openstreetmap.org/${escapeHtml(ref)}" target="_blank" rel="noopener">${escapeHtml(ref)}</a>`
              : "";

            const html = `
              <div class="popup">
                <h3>${escapeHtml(name)}</h3>
                <p>${escapeHtml(text(p.label) ?? "")}${subtype ? " · " + escapeHtml(subtype) : ""}</p>
                <p>District: ${escapeHtml(district)}</p>
                <p>Source: ${escapeHtml(text(p.source_id) ?? "")} · ${refLink} · ${escapeHtml(text(p.source_date) ?? "")}</p>
                ${warning ? `<p class="warning">⚠ ${escapeHtml(warning)}</p>` : ""}
              </div>`;
            new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
          });
          map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
        }

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

  // Whenever the hidden categories change, update the map's layer filters
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const [layerId, types] of Object.entries(LAYER_TYPES)) {
      map.setFilter(layerId, layerFilter(types, hiddenCategories));
    }
  }, [hiddenCategories, mapReady]);

  function toggleCategory(category: string) {
    setHiddenCategories((current) =>
      current.includes(category)
        ? current.filter((c) => c !== category)
        : [...current, category],
    );
  }

  return (
    <div className="app">
      <aside className="panel">
        <h1>GeoPulse Intelligence</h1>
        <p className="subtitle">Pilot: Lower Volta corridor, Ghana · Asset map</p>

        {error && <p className="error">Could not load data: {error}. Is the API running?</p>}
        {!error && assetTypes.length === 0 && <p className="subtitle">Loading…</p>}
        {assetTypes.length > 0 && (
          <p className="hint">Click a category to show or hide it. Click a map feature for details.</p>
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
                  <span>{t.count}</span>
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