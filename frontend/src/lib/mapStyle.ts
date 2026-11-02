// MapLibre expressions and filters shared by the map layers
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { type BasemapId, CATEGORY_COLOURS, OVERLAY_SOURCES, STATUS_COLOURS } from "../config";

// GeoJSON passed straight to a MapLibre source
export type SourceData = GeoJSONSourceSpecification["data"];

export function expr(value: unknown): ExpressionSpecification {
  return value as ExpressionSpecification;
}

export function filterExpr(value: unknown): FilterSpecification {
  return value as FilterSpecification;
}

// Category colours for a basemap: roads are pale on the dark map and slate on the light one
export function categoryColours(basemap: BasemapId): Record<string, string> {
  return basemap === "light" ? { ...CATEGORY_COLOURS, transport: "#5b6b78" } : CATEGORY_COLOURS;
}

// Colour each feature by its category
export function categoryColour(basemap: BasemapId): ExpressionSpecification {
  return expr(["match", ["get", "category"], ...Object.entries(categoryColours(basemap)).flat(), "#8a9aa8"]);
}

// Exposure status lives in MapLibre "feature state" (set without reloading data)
export const STATUS = ["coalesce", ["feature-state", "status"], "none"];
export const FLAGGED = ["in_flood", "in_ambiguous", "near"];
export const DIMMED = ["not_flagged", "context"];

export function statusColour(fallback: string): ExpressionSpecification {
  return expr([
    "match", STATUS,
    "in_flood", STATUS_COLOURS.in_flood,
    "in_ambiguous", STATUS_COLOURS.in_ambiguous,
    "near", STATUS_COLOURS.near,
    fallback,
  ]);
}

// An asset layer shows its own types, minus hidden categories, optionally one district
export function layerFilter(types: string[], hidden: string[], pcode: string): FilterSpecification {
  const conditions: unknown[] = [
    ["in", ["get", "asset_type"], ["literal", types]],
    ["!", ["in", ["get", "category"], ["literal", hidden]]],
  ];
  if (pcode) conditions.push(["==", ["get", "adm2_pcode"], pcode]);
  return filterExpr(["all", ...conditions]);
}

// Settlement footprints follow the 'settlement' category toggle and the district
export function settlementFilter(hidden: string[], pcode: string): FilterSpecification {
  const conditions: unknown[] = [!hidden.includes("settlement")];
  if (pcode) conditions.push(["==", ["get", "adm2_pcode"], pcode]);
  return filterExpr(["all", ...conditions]);
}

// Our own layers in the current style (with their current filters and visibility)
export function overlayLayers(style: StyleSpecification | undefined): LayerSpecification[] {
  return (style?.layers ?? []).filter(
    (layer) => "source" in layer && typeof layer.source === "string" && OVERLAY_SOURCES.includes(layer.source),
  );
}

// When the basemap changes, put our sources and layers on top of the new basemap style
export function withOverlays(
  next: StyleSpecification,
  layers: LayerSpecification[],
  data: Record<string, SourceData>,
): StyleSpecification {
  const sources = { ...next.sources };
  for (const [id, value] of Object.entries(data)) sources[id] = { type: "geojson", data: value };
  return { ...next, sources, layers: [...next.layers, ...layers] };
}
