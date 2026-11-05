// Talking to the GeoPulse API
import type { StyleSpecification } from "maplibre-gl";

import {
  API_URL, ASSETS_LAYER, BASEMAPS, type BasemapId, FALLBACK_STYLE, FLOOD_LAYER, HAZARD_ID, PILOT_ID,
  SETTLEMENTS_LAYER,
} from "../config";
import type {
  CandidateSite, MapDataManifest, ScreeningAsset, ScreeningResponse, ScreenResponse, ScreenStatus, SettlementScreening,
  SettlementScreeningResponse,
} from "../types";

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} (${url})`);
  return (await response.json()) as T;
}

export function comparisonQuery(sites: CandidateSite[], radiusM: number): string {
  const siteParams = sites.map((s) => `site=${s.lon.toFixed(6)},${s.lat.toFixed(6)}`).join("&");
  return `${siteParams}&radius_m=${radiusM}&hazard_id=${HAZARD_ID}`;
}

export function dashboardQuery(nearM: number, pcode: string): string {
  return `pilot_id=${PILOT_ID}&hazard_id=${HAZARD_ID}&near_m=${nearM}` +
    (pcode ? `&pcode=${encodeURIComponent(pcode)}` : "");
}

export function reportUrl(format: "html" | "csv" | "geojson", nearM: number, pcode: string): string {
  return `${API_URL}/reports/screening/${HAZARD_ID}?format=${format}&near_m=${nearM}` +
    (pcode ? `&pcode=${encodeURIComponent(pcode)}` : "");
}

export function peopleQuery(pcode: string): string {
  return `pilot_id=${PILOT_ID}` + (pcode ? `&pcode=${encodeURIComponent(pcode)}` : "");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Static map data built at deploy time (scripts/build_map_data.py), served next to the app
export const DATA_URL = `${import.meta.env.BASE_URL}data/`;

// The manifest of the static map data, or null if there is none (local development, or the build skipped it)
export async function loadManifest(): Promise<MapDataManifest | null> {
  try {
    const response = await fetch(`${DATA_URL}manifest.json`, { cache: "no-cache" });
    // A dev server answers unknown paths with the app's HTML page, so check it really is JSON
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
    const manifest = (await response.json()) as MapDataManifest;
    return manifest.version === 1 ? manifest : null;
  } catch {
    return null;
  }
}

// Where to load a layer from: the static copy if the build made one, otherwise the API
export function layerUrl(manifest: MapDataManifest | null, name: string, apiPath: string): string {
  const file = manifest?.files[name];
  return file ? `${DATA_URL}${file}` : `${API_URL}${apiPath}`;
}

// Absolute address of a static file (PMTiles needs a full URL)
export function dataFileUrl(file: string): string {
  return new URL(`${DATA_URL}${file}`, window.location.href).href;
}

// Fetch a basemap style; if it can't be reached, use a plain background so the data still shows
export async function loadBasemap(id: BasemapId): Promise<{ style: StyleSpecification; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(BASEMAPS[id].url, { signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    return { style: (await response.json()) as StyleSpecification, ok: true };
  } catch {
    return { style: FALLBACK_STYLE, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Wait until the API answers its health check (a sleeping free server can take about a minute to wake)
export async function waitForApi(attempts = 12, delayMs = 6000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${API_URL}/health`);
      if (response.ok && (response.headers.get("content-type") ?? "").includes("json")) return;
    } catch {
      // Not awake yet (or a wake-up page without CORS headers): try again shortly
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// The map's own status names (shared with the legend, popups and map styles)
const MAP_STATUS: Record<ScreenStatus, string> = {
  in_primary: "in_flood", in_secondary: "in_ambiguous", near: "near", not_flagged: "not_flagged", context: "context",
};

function screenUrl(exposure: string, nearM: number): string {
  return `${API_URL}/screen?hazard=${FLOOD_LAYER}&exposure=${exposure}&near_m=${nearM}`;
}

// Flood screening of assets and settlements, from the generic /screen endpoint.
// Falls back to the original endpoints if the API has not been updated or screened yet.
export async function loadFloodScreening(nearM: number): Promise<{
  assets: ScreeningAsset[];
  settlements: SettlementScreening[] | null;
}> {
  try {
    const [a, s] = await Promise.all([
      fetchJson<ScreenResponse>(screenUrl(ASSETS_LAYER, nearM)),
      fetchJson<ScreenResponse>(screenUrl(SETTLEMENTS_LAYER, nearM)).catch(() => null),
    ]);
    return {
      assets: (a.features ?? []).map((r) => ({
        asset_id: Number(r.feature_id),
        asset_type: r.type ?? "",
        category: "",
        status: MAP_STATUS[r.status],
        distance_m: r.distance_m,
        flooded_length_m: r.overlap_unit === "m" ? r.overlap_primary : null,
      })),
      settlements: s?.features
        ? s.features.map((r) => ({
          settlement_id: Number(r.feature_id),
          adm2_pcode: r.pcode,
          settlement_type: r.type ?? "",
          building_count: null,
          status: MAP_STATUS[r.status],
          distance_m: r.distance_m,
          flooded_m2: r.overlap_unit === "m2" ? r.overlap_primary : null,
        }))
        : null,
    };
  } catch {
    const [a, s] = await Promise.all([
      fetchJson<ScreeningResponse>(`${API_URL}/screening/${HAZARD_ID}?near_m=${nearM}`),
      fetchJson<SettlementScreeningResponse>(`${API_URL}/screening/${HAZARD_ID}/settlements?near_m=${nearM}`)
        .catch(() => null),
    ]);
    return { assets: a.assets, settlements: s ? s.settlements : null };
  }
}
