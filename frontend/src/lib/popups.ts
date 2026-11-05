// HTML for map popups (data from OSM and GRID3 is escaped before it reaches the page)
import { SETTLEMENT_STATUS_LABELS, STATUS_LABELS } from "../config";
import type { NationalDistrictProperties, ScreeningAsset, SettlementScreening } from "../types";

export function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => replacements[c]);
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function row(label: string, valueHtml: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;
}

function districtText(pcode: string | null, districtNames: Map<string, string>): string {
  if (!pcode) return "Outside mapped districts";
  return `${districtNames.get(pcode) ?? ""} (${pcode})`;
}

export function assetPopupHtml(
  p: Record<string, unknown>,
  warningByType: Map<string, string | null>,
  districtNames: Map<string, string>,
  screening?: ScreeningAsset,
): string {
  const name = text(p.name) ?? "Unnamed";
  const subtype = text(p.subtype);
  const ref = text(p.source_ref);
  const warning = warningByType.get(String(p.asset_type));
  const typeLine = [text(p.label), subtype].filter(Boolean).join(", ");
  const refLink = ref
    ? `<a href="https://www.openstreetmap.org/${escapeHtml(ref)}" target="_blank" rel="noopener">${escapeHtml(ref)}</a>`
    : "";

  let exposure = "";
  if (screening && screening.status !== "context") {
    let detail = STATUS_LABELS[screening.status] ?? screening.status;
    if (screening.distance_m !== null && screening.distance_m > 0) {
      detail += `, ${Math.round(screening.distance_m)} m away`;
    }
    if (screening.flooded_length_m) detail += `; ${Math.round(screening.flooded_length_m)} m inside`;
    exposure = row("Flood screening", `<span class="popup-status status-${screening.status}">${escapeHtml(detail)}</span>`);
  }

  return `
    <div class="popup">
      <h3>${escapeHtml(name)}</h3>
      <p class="popup-type">${escapeHtml(typeLine)}</p>
      <dl>
        ${row("District", escapeHtml(districtText(text(p.adm2_pcode), districtNames)))}
        ${exposure}
        ${row("Source", `OpenStreetMap ${refLink}, snapshot ${escapeHtml(text(p.source_date) ?? "")}`)}
      </dl>
      ${warning ? `<p class="popup-warning">${escapeHtml(warning)}</p>` : ""}
    </div>`;
}

export function settlementPopupHtml(
  p: Record<string, unknown>,
  districtNames: Map<string, string>,
  screening?: SettlementScreening,
): string {
  const buildings = Number(p.building_count ?? 0).toLocaleString();
  const probability = p.probability === null || p.probability === undefined
    ? "–"
    : Number(p.probability).toFixed(2);

  let exposure = "";
  if (screening) {
    let detail = SETTLEMENT_STATUS_LABELS[screening.status] ?? screening.status;
    if (screening.flooded_m2) {
      detail += `, ${Math.round(screening.flooded_m2).toLocaleString()} m² inside`;
    } else if (screening.distance_m !== null && screening.distance_m > 0) {
      detail += `, ${Math.round(screening.distance_m)} m away`;
    }
    exposure = row("Flood screening", `<span class="popup-status status-${screening.status}">${escapeHtml(detail)}</span>`);
  }

  return `
    <div class="popup">
      <h3>${escapeHtml(text(p.settlement_type) ?? "Settlement")}</h3>
      <p class="popup-type">Settlement footprint with ${escapeHtml(buildings)} buildings</p>
      <dl>
        ${row("District", escapeHtml(districtText(text(p.adm2_pcode), districtNames)))}
        ${exposure}
        ${row("Confidence", `GRID3 probability ${escapeHtml(probability)}`)}
        ${row("Source", `GRID3 settlement extents v3.0 (${escapeHtml(text(p.source_ref) ?? "")}), ${escapeHtml(text(p.data_year) ?? "")}`)}
      </dl>
      <p class="popup-warning">The building count covers the whole settlement, not only the part near water.</p>
    </div>`;
}

// Modelled counts are shown to the nearest hundred: the model is not precise enough for more
function approx(value: number | null | undefined): string {
  if (value == null) return "No estimate";
  return (value >= 1000 ? Math.round(value / 100) * 100 : Math.round(value)).toLocaleString();
}

export function nationalPopupHtml(p: NationalDistrictProperties): string {
  // Vector tiles leave out empty values, so a missing figure arrives as undefined rather than null
  const density = p.density == null ? "No estimate" : `${Math.round(p.density).toLocaleString()} people per km²`;
  return `
    <div class="popup">
      <h3>${escapeHtml(p.name)}</h3>
      <p class="popup-type">${escapeHtml(p.region)} Region, ${escapeHtml(p.pcode)}${p.in_pilot === true || String(p.in_pilot) === "true" ? ", in the Lower Volta pilot" : ""}</p>
      <dl>
        ${row("Density", escapeHtml(density))}
        ${row("Residents", `about ${escapeHtml(approx(p.population))}`)}
        ${row("Buildings", escapeHtml(approx(p.buildings)))}
        ${row("Area", p.area_km2 == null ? "–" : `${Math.round(p.area_km2).toLocaleString()} km²`)}
        ${row("Source", "WorldPop 2023 and Google Open Buildings v3")}
      </dl>
      <p class="popup-warning">Modelled estimate. WorldPop 2023 counts about 8.5% more people than the 2021 census for Ghana as a whole.</p>
    </div>`;
}
