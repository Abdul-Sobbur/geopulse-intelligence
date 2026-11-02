// Talking to the GeoPulse API
import type { StyleSpecification } from "maplibre-gl";

import { API_URL, BASEMAPS, type BasemapId, FALLBACK_STYLE, HAZARD_ID, PILOT_ID } from "../config";
import type { CandidateSite } from "../types";

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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
