// Shared data types for the GeoPulse frontend

export type Bounds = [number, number, number, number];

// GeoJSON coordinates nest to any depth: [x, y], [[x, y], ...], [[[x, y], ...]], ...
export type NestedCoords = number[] | NestedCoords[];

export type Geometry = { type: string; coordinates: NestedCoords };

export type AssetProperties = {
  asset_id: number;
  asset_type: string;
  category: string;
  label: string;
  subtype: string | null;
  name: string | null;
  adm2_pcode: string | null;
  source_id: string;
  source_ref: string;
  source_date: string;
};

export type DistrictProperties = { pcode: string; name: string; region: string };

export type Feature<P = AssetProperties> = { type: "Feature"; id?: number; geometry: Geometry; properties: P };

export type FeatureCollection<P = AssetProperties> = {
  type: "FeatureCollection";
  features: Feature<P>[];
  bbox?: Bounds;
};

export type Workspace = "layers" | "flood" | "nearby" | "compare" | "dashboard" | "reports";

export type AssetType = {
  asset_type: string;
  category: string;
  label: string;
  coverage_warning: string | null;
  count: number;
};

export type District = { pcode: string; name: string; region: string; bounds: Bounds };

export type HazardLayer = {
  hazard_id: string;
  title: string;
  source_id: string;
  observed_dates: string | null;
  method: string | null;
  pre_event_window: string[] | null;
  limitations: string[] | null;
};

export type ScreeningAsset = {
  asset_id: number;
  asset_type: string;
  category: string;
  status: string;
  distance_m: number | null;
  flooded_length_m: number | null;
};

export type ScreeningResponse = { hazard_id: string; near_m: number; assets: ScreeningAsset[] };

export type SettlementScreening = {
  settlement_id: number;
  adm2_pcode: string | null;
  settlement_type: string;
  building_count: number | null;
  status: string;
  distance_m: number | null;
  flooded_m2: number | null;
};

export type SettlementScreeningResponse = { settlements: SettlementScreening[] };

export type SummaryRow = { asset_type: string; total: number; in_flood: number; in_ambiguous: number; near: number };

export type ExposureCounts = { in_flood: number; in_ambiguous: number; near: number };

export type ProximityFeature = {
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

export type ProximitySummary = { kind: string; type: string; label: string; count: number; buildings: number | null };

export type ProximityResponse = {
  center: [number, number];
  radius_m: number;
  district: { pcode: string; name: string } | null;
  hazard: { hazard_id: string; flooded_m2: number; ambiguous_m2: number } | null;
  total: number;
  summary: ProximitySummary[];
  features: ProximityFeature[];
};

export type PickTarget = "proximity" | "site";

export type CandidateSite = { id: string; lon: number; lat: number };

export type SiteCriterion = { id: string; label: string; unit: string; group: string; note: string };

export type ComparisonResponse = {
  radius_m: number;
  criteria: SiteCriterion[];
  sites: { lon: number; lat: number; values: Record<string, string | number | null> }[];
  rasters: { dem: boolean; landcover: boolean };
  note: string;
};

export type MetricDefinition = {
  id: string;
  label: string;
  unit: string;
  kind: string;
  definition: string;
  source: string;
};

export type DashboardDistrict = {
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

export type DashboardAssetType = {
  asset_type: string;
  label: string;
  category: string;
  coverage_warning: string | null;
  total: number;
  in_flood: number;
  in_ambiguous: number;
  near: number;
};

export type DashboardResponse = {
  scope: { pcode: string | null; name: string };
  near_m: number;
  hazard: { hazard_id: string; title: string; observed_dates: string };
  kpis: { id: string; value: number | null }[];
  districts: DashboardDistrict[];
  asset_types: DashboardAssetType[];
  definitions: MetricDefinition[];
  note: string;
};

// ---- Layer catalogue (GET /catalog) ----

export type CatalogClass = {
  value: string | number;
  label: string;
  colour: string;
  description: string | null;
  screening_level: "primary" | "secondary" | null;
  screened: boolean;
};

export type CatalogLayer = {
  id: string;
  title: string;
  summary: string;
  theme: string;
  role: string;
  evidence: "Observation" | "Modelled estimate" | "Derived";
  geometry: string;
  status: string;
  version: string;
  coverage: { scope: string; pilot_id: string | null; country: string };
  temporal: { kind: string; start: string | null; end: string | null; note: string | null };
  sources: string[];
  method: string;
  limitations: string[];
  classes: CatalogClass[];
  screening: "hazard" | "exposure" | null;
};

export type CatalogSource = {
  id: string;
  title: string;
  provider: string;
  url: string | null;
  licence: string;
  licence_confirmed: boolean;
  attribution: string;
};

export type CatalogResponse = { layers: CatalogLayer[]; sources: CatalogSource[] };

// ---- Generic screening (GET /screen) ----

export type ScreenStatus = "in_primary" | "in_secondary" | "near" | "not_flagged" | "context";

export type ScreenRow = {
  feature_id: string;
  type: string | null;
  pcode: string | null;
  status: ScreenStatus;
  distance_m: number | null;
  overlap_primary: number | null;
  overlap_unit: "m" | "m2" | null;
};

export type ScreenResponse = { features: ScreenRow[] | null };

// ---- People near observed flooding (GET /people) ----

export type PeopleStep = {
  id: "in_cells" | "within_100m" | "within_250m" | "settlements_touching";
  label: string;
  worldpop: number | null;
  ghspop: number | null;
  buildings: number | null;
  note: string;
};

export type ReportedFigure = {
  id: string;
  value: number;
  measure: "displaced" | "affected";
  area: string;
  within_pilot: "yes" | "partly" | "no";
  reported_by: string;
  published: string;
  source_title: string;
  url: string;
  note: string | null;
};

export type PeopleDistrict = {
  pcode: string;
  name: string;
  population: number;
  in_cells: number;
  within_100m: number;
  within_250m: number;
  settlements_touching: number;
};

export type PeopleResponse = {
  scope: { pcode: string | null; name: string };
  computed_at: string;
  population: { worldpop_2023: number | null; ghspop_2023: number | null };
  buildings: { confidence_065: number | null; confidence_075: number | null };
  ladder: PeopleStep[];
  districts: PeopleDistrict[];
  references: ReportedFigure[];
  limitations: string[];
};

// ---- National district map (GET /national/districts) ----

export type NationalDistrictProperties = {
  pcode: string;
  name: string;
  region: string;
  population: number | null;
  buildings: number | null;
  area_km2: number | null;
  density: number | null;
  in_pilot: boolean;
};

export type NationalTotals = {
  districts: number;
  with_estimates: number;
  population: number;
  buildings: number;
  area_km2: number;
  density: number | null;
};

export type NationalResponse = FeatureCollection<NationalDistrictProperties> & {
  totals: NationalTotals;
  limitations: string[];
};
