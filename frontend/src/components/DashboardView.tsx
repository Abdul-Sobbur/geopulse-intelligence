// Pilot dashboard: headline figures, district charts and tables, with metric definitions
import { FLOOD_COLOURS, NEAR_OPTIONS, STATUS_COLOURS } from "../config";
import { formatDistance, formatMetric } from "../lib/format";
import type { DashboardDistrict, DashboardResponse, PeopleResponse } from "../types";
import BarList, { type BarRow } from "./BarList";
import PeopleLadder from "./PeopleLadder";
import Segmented from "./Segmented";

type Props = {
  data: DashboardResponse | null;
  loading: boolean;
  selectedPcode: string;
  onSelectPcode: (pcode: string) => void;
  nearM: number;
  onNearM: (m: number) => void;
  people: PeopleResponse | null;
};

// Headline figures in reading order; the first two describe the hazard, the rest exposure
const HEADLINE = ["flooded_km2", "ambiguous_km2", "settlements_in_flood", "settlements_ambiguous_or_near", "assets_flagged"];
const CONTEXT = ["area_km2", "assets", "settlements", "buildings"];

export default function DashboardView({ data, loading, selectedPcode, onSelectPcode, nearM, onNearM, people }: Props) {
  const definitions = new Map((data?.definitions ?? []).map((d) => [d.id, d]));
  const kpi = new Map((data?.kpis ?? []).map((k) => [k.id, k.value]));
  const unitOf = (id: string) => definitions.get(id)?.unit ?? "";
  const bars = (key: keyof DashboardDistrict): BarRow[] =>
    (data?.districts ?? []).map((d) => ({
      key: d.pcode,
      label: d.name,
      value: d[key] as number | null,
      selected: d.pcode === selectedPcode,
    }));

  const readout = (id: string) => {
    const def = definitions.get(id);
    return (
      <div className="readout" key={id} title={def?.definition}>
        <span className="readout-value">{formatMetric(kpi.get(id), unitOf(id))}</span>
        <span className="readout-label">{def?.label ?? id}</span>
        <span className={`kind kind-${(def?.kind ?? "").split(" ")[0].toLowerCase()}`}>{def?.kind}</span>
      </div>
    );
  };

  return (
    <div className="dashboard">
      <div className="dash-inner">
        <header className="dash-header">
          <div>
            <h1>{data?.scope.name ?? "Pilot dashboard"}</h1>
            {data && (
              <p className="dash-sub">
                {data.hazard.title}, seen by radar on {data.hazard.observed_dates}.
                {selectedPcode && (
                  <> <button type="button" className="link-button" onClick={() => onSelectPcode("")}>Show all districts</button></>
                )}
              </p>
            )}
          </div>
          <div className="dash-control">
            <span className="control-label">Count as near within</span>
            <Segmented
              label="Count as near within"
              value={nearM}
              options={NEAR_OPTIONS.map((m) => ({ value: m, label: formatDistance(m) }))}
              onChange={onNearM}
            />
          </div>
        </header>

        {loading && <p className="loading-line">Loading figures…</p>}

        {data && !loading && (
          <>
            <section className="readouts" aria-label="Headline figures">
              <div className="readout-group">
                <h2>Hazard</h2>
                <div className="readout-row">{HEADLINE.slice(0, 2).map(readout)}</div>
              </div>
              <div className="readout-group">
                <h2>Exposure</h2>
                <div className="readout-row">{HEADLINE.slice(2).map(readout)}</div>
              </div>
              <div className="readout-group readout-context">
                <h2>Context</h2>
                <div className="readout-row">{CONTEXT.map(readout)}</div>
              </div>
            </section>

            {people && (
              <section className="dash-section" aria-label="People near the observed water">
                <h2>People near the observed water</h2>
                <p className="dash-lead">
                  {(people.ladder.find((s) => s.id === "within_100m")?.worldpop ?? 0).toLocaleString()} to{" "}
                  {(people.ladder.find((s) => s.id === "within_250m")?.worldpop ?? 0).toLocaleString()} people
                  lived within 100 m to 250 m of observed flooding in {people.scope.name}, out of an estimated{" "}
                  {(people.population.worldpop_2023 ?? 0).toLocaleString()} residents.
                </p>
                <div className="people-grid">
                  <PeopleLadder ladder={people.ladder} references={people.references} />
                  <BarList
                    title="People within 250 m of observed flooding, by district"
                    rows={people.districts.map((d) => ({
                      key: d.pcode, label: d.name, value: d.within_250m, selected: d.pcode === selectedPcode,
                    }))}
                    unit="count"
                    colour={FLOOD_COLOURS.flooded}
                    note="WorldPop 2023 residents in 100 m cells near water seen by radar."
                  />
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>District</th><th>Residents</th><th>In cells with observed flooding</th>
                        <th>Within 100 m</th><th>Within 250 m</th><th>In settlements touching flooding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.districts.map((d) => (
                        <tr key={d.pcode} className={d.pcode === selectedPcode ? "is-selected" : ""}>
                          <td>{d.name}</td>
                          <td>{d.population.toLocaleString()}</td>
                          <td>{d.in_cells.toLocaleString()}</td>
                          <td>{d.within_100m.toLocaleString()}</td>
                          <td>{d.within_250m.toLocaleString()}</td>
                          <td>{d.settlements_touching.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="limit-list">{people.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </section>
            )}

            <section className="chart-grid">
              <BarList
                title="Observed flooding by district (km²)"
                rows={bars("flooded_km2")}
                unit="km²"
                colour={FLOOD_COLOURS.flooded}
                note="Sentinel-1 radar on two dates, so likely an under-estimate of the peak."
              />
              <BarList
                title="Settlement footprints intersecting observed flooding"
                rows={bars("settlements_in_flood")}
                unit="count"
                colour={STATUS_COLOURS.in_flood}
                note="GRID3 footprints overlaid on observed flooding."
              />
              <BarList
                title={`Assets in or within ${formatDistance(nearM)} of observed water`}
                rows={bars("assets_flagged")}
                unit="count"
                colour={STATUS_COLOURS.near}
                note="Only assets mapped in OpenStreetMap are counted."
              />
            </section>

            <section className="dash-section">
              <h2>By district</h2>
              <p className="hint">Select a row to focus the dashboard and map on that district.</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>District</th><th>Area</th><th>Assets</th><th>Settlements</th><th>Buildings</th>
                      <th>Flooding</th><th>Ambiguous</th><th>Settlements in flooding</th>
                      <th>Settlements ambiguous or near</th><th>Assets flagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.districts.map((d) => (
                      <tr
                        key={d.pcode}
                        className={`is-clickable${d.pcode === selectedPcode ? " is-selected" : ""}`}
                        onClick={() => onSelectPcode(d.pcode === selectedPcode ? "" : d.pcode)}
                      >
                        <td>
                          <button type="button" className="row-button">{d.name}</button>
                          <span className="muted"> {d.pcode}</span>
                        </td>
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
            </section>

            <section className="dash-section">
              <h2>Assets by type in {data.scope.name}</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Asset type</th><th>Mapped</th><th>In flooding</th><th>In ambiguous water</th>
                      <th>Near</th><th className="text-col">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.asset_types.map((t) => (
                      <tr key={t.asset_type}>
                        <td>{t.label}</td>
                        <td>{t.total}</td>
                        <td>{t.in_flood}</td>
                        <td>{t.in_ambiguous}</td>
                        <td>{t.near}</td>
                        <td className="text-col">{t.coverage_warning ?? <span className="muted">No known gap</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="dash-section">
              <h2>What the figures mean</h2>
              <dl className="definitions">
                {data.definitions.map((d) => (
                  <div key={d.id}>
                    <dt>
                      {d.label}
                      <span className={`kind kind-${d.kind.split(" ")[0].toLowerCase()}`}>{d.kind}</span>
                    </dt>
                    <dd>{d.definition} <span className="muted">Source: {d.source}</span></dd>
                  </div>
                ))}
              </dl>
              <p className="hint">
                An observation is counted or measured from a source dataset. A modelled estimate comes
                from a provider's model. A derived figure is calculated by GeoPulse from other layers.
              </p>
              <p className="caveat">{data.note}</p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
