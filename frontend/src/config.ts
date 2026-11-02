// Settings, colours and labels used across the app
import type { StyleSpecification } from "maplibre-gl";

import type { Workspace } from "./types";

export const API_URL: string = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
export const PILOT_ID = "lower_volta";
export const PILOT_NAME = "Lower Volta corridor";
export const HAZARD_ID = "flood_2023_observed";

// Free basemaps from OpenFreeMap (built on OpenStreetMap data), no API key needed
export const BASEMAPS = {
  dark: { label: "Dark", url: "https://tiles.openfreemap.org/styles/dark" },
  light: { label: "Light", url: "https://tiles.openfreemap.org/styles/positron" },
} as const;
export type BasemapId = keyof typeof BASEMAPS;

// Used if a basemap cannot be loaded, so the data layers still work
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0e1b26" } }],
};

// Overlay sources we own; they are carried across basemap changes
export const OVERLAY_SOURCES = ["districts", "assets", "hazard", "settlements", "proximity", "sites"];

export const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: "assets", label: "Assets" },
  { id: "flood", label: "Flood screening" },
  { id: "nearby", label: "Nearby" },
  { id: "compare", label: "Compare sites" },
  { id: "dashboard", label: "Dashboard" },
  { id: "reports", label: "Reports" },
];

// Category colours, checked for colour-blind separation on the dark map.
// Red, orange and yellow are reserved for exposure status; power lines are also dashed.
export const CATEGORY_COLOURS: Record<string, string> = {
  transport: "#b8c4ce",
  water: "#3987e5",
  settlement: "#d55181",
  social: "#008300",
  energy: "#9085e9",
};

export const CATEGORY_LABELS: Record<string, string> = {
  transport: "Transport",
  water: "Water",
  settlement: "Settlements",
  social: "Schools and health",
  energy: "Energy",
};

export const CATEGORY_ORDER = ["transport", "settlement", "social", "energy", "water"];

// Observed flood layer: luminous cyan for attributable flooding, orange for ambiguous seasonal water
export const FLOOD_COLOURS = { flooded: "#22d3ee", ambiguous: "#ec835a" };

// Exposure status (shared by map, tables and legend)
export const STATUS_COLOURS = { in_flood: "#d03b3b", in_ambiguous: "#ec835a", near: "#fab219" };

export const STATUS_LABELS: Record<string, string> = {
  in_flood: "In observed flooding",
  in_ambiguous: "In ambiguous seasonal water",
  near: "Near observed water",
  not_flagged: "Not flagged",
  context: "Water feature (reference only)",
};

export const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  in_flood: "Footprint intersects observed flooding",
  in_ambiguous: "Footprint intersects ambiguous seasonal water",
  near: "Near observed water",
  not_flagged: "Not flagged",
};

export const NEAR_OPTIONS = [100, 250, 500, 1000];
export const RADIUS_OPTIONS = [250, 500, 1000, 2000, 5000];
export const SITE_LETTERS = ["A", "B", "C", "D"];
export const MAX_SEARCH_RESULTS = 8;

// Which asset types each map layer draws
export const LAYER_TYPES: Record<string, string[]> = {
  "asset-areas": ["water_body"],
  "asset-lines": ["road", "bridge", "waterway"],
  "asset-power-lines": ["power_line"],
  "asset-points": ["place", "education", "health", "power_plant", "power_substation"],
};

// Layers whose filters follow the category and district selections
export const FILTERED_LAYERS: Record<string, string[]> = {
  ...LAYER_TYPES,
  "asset-lines-halo": [...LAYER_TYPES["asset-lines"], ...LAYER_TYPES["asset-power-lines"]],
};

// Map layers that can be clicked for asset details
export const CLICKABLE_ASSET_LAYERS = Object.keys(LAYER_TYPES);
