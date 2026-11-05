// Flood screening workspace: the observed 2023 flood layer and what lies in or near it
import PeopleLadder from "../components/PeopleLadder";
import Segmented from "../components/Segmented";
import { FLOOD_COLOURS, NEAR_OPTIONS, STATUS_COLOURS } from "../config";
import { formatDistance } from "../lib/format";
import type { ExposureCounts, HazardLayer, PeopleResponse, SummaryRow } from "../types";

type Props = {
  hazard: HazardLayer | null;
  floodedKm2: number | null;
  ambiguousKm2: number | null;
  showFlood: boolean;
  onShowFlood: (on: boolean) => void;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  nearM: number;
  onNearM: (m: number) => void;
  loading: boolean;
  summary: SummaryRow[];
  settlementSummary: ExposureCounts | null;
  labelFor: (assetType: string) => string;
  scopeLabel: string;
  people: PeopleResponse | null;
};

export default function FloodPanel({
  hazard, floodedKm2, ambiguousKm2, showFlood, onShowFlood, highlight, onHighlight,
  nearM, onNearM, loading, summary, settlementSummary, labelFor, scopeLabel, people,
}: Props) {
  if (!hazard) {
    return (
      <div className="panel-head">
        <h2>Flood screening</h2>
        <p>The observed flood layer is not loaded. Run scripts/load_flood_layer.py, then reload.</p>
      </div>
    );
  }

  const totals = summary.reduce(
    (t, r) => ({ in_flood: t.in_flood + r.in_flood, in_ambiguous: t.in_ambiguous + r.in_ambiguous, near: t.near + r.near }),
    { in_flood: 0, in_ambiguous: 0, near: 0 },
  );

  return (
    <>
      <div className="panel-head">
        <h2>Akosombo and Kpong spillage, 2023</h2>
        <p>New surface water seen by Sentinel-1 radar on {hazard.observed_dates}, in {scopeLabel}.</p>
      </div>

      <section className="hero-readout" aria-label="Observed water">
        <div>
          <span className="hero-value" style={{ color: FLOOD_COLOURS.flooded }}>
            {floodedKm2 === null ? "–" : floodedKm2.toFixed(1)}
            <small>km²</small>
          </span>
          <span className="hero-label">Observed flooding</span>
        </div>
        <div>
          <span className="hero-value" style={{ color: FLOOD_COLOURS.ambiguous }}>
            {ambiguousKm2 === null ? "–" : ambiguousKm2.toFixed(1)}
            <small>km²</small>
          </span>
          <span className="hero-label">Ambiguous seasonal water</span>
        </div>
        {floodedKm2 !== null && ambiguousKm2 !== null && (
          <p className="hero-note">
            Read the extent as a range of {floodedKm2.toFixed(0)} to {(floodedKm2 + ambiguousKm2).toFixed(0)} km².
            Lagoons and salt pans near Ada flood every year, so that water cannot be put down to the spillage.
          </p>
        )}
      </section>

      {people && (() => {
        const near100 = people.ladder.find((s) => s.id === "within_100m")?.worldpop;
        const near250 = people.ladder.find((s) => s.id === "within_250m")?.worldpop;
        return (
          <section className="group people-block" aria-label="People near the observed water">
            <h3 className="group-title">People near the observed water</h3>
            {near100 != null && near250 != null && (
              <p className="people-range">
                <span className="people-figure">{near100.toLocaleString()}</span>
                <span className="people-to">to</span>
                <span className="people-figure">{near250.toLocaleString()}</span>
              </p>
            )}
            <p className="hero-label">
              people lived within 100 m to 250 m of observed flooding, estimated from WorldPop 2023.
            </p>
            <PeopleLadder ladder={people.ladder} references={people.references} compact />
          </section>
        );
      })()}

      <section className="group">
        <div className="group-head">
          <h3>Show observed water on the map</h3>
          <button
            type="button" className="switch" role="switch" aria-checked={showFlood}
            aria-label="Show observed water on the map" onClick={() => onShowFlood(!showFlood)}
          />
        </div>
        <div className="group-head">
          <h3>Highlight exposed assets</h3>
          <button
            type="button" className="switch" role="switch" aria-checked={highlight}
            aria-label="Highlight exposed assets" onClick={() => onHighlight(!highlight)}
          />
        </div>
        <div className="control">
          <span className="control-label">Count as near within</span>
          <Segmented
            label="Count as near within"
            value={nearM}
            options={NEAR_OPTIONS.map((m) => ({ value: m, label: formatDistance(m) }))}
            onChange={onNearM}
          />
        </div>
      </section>

      {highlight && loading && <p className="loading-line">Screening assets…</p>}

      {highlight && !loading && (
        <section className="group">
          <h3 className="group-title">What is in or near observed water</h3>
          <table className="exposure-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col" title="Inside observed flooding">
                  <i className="dot" style={{ background: STATUS_COLOURS.in_flood }} />In
                </th>
                <th scope="col" title="Inside ambiguous seasonal water">
                  <i className="dot" style={{ background: STATUS_COLOURS.in_ambiguous }} />Ambig.
                </th>
                <th scope="col" title={`Within ${formatDistance(nearM)} of observed water`}>
                  <i className="dot" style={{ background: STATUS_COLOURS.near }} />Near
                </th>
              </tr>
            </thead>
            <tbody>
              {settlementSummary && (
                <tr className="is-lead">
                  <th scope="row">Settlement footprints</th>
                  <td>{settlementSummary.in_flood}</td>
                  <td>{settlementSummary.in_ambiguous}</td>
                  <td>{settlementSummary.near}</td>
                </tr>
              )}
              {summary.map((r) => (
                <tr key={r.asset_type}>
                  <th scope="row">{labelFor(r.asset_type)}</th>
                  <td className={r.in_flood ? "" : "zero"}>{r.in_flood}</td>
                  <td className={r.in_ambiguous ? "" : "zero"}>{r.in_ambiguous}</td>
                  <td className={r.near ? "" : "zero"}>{r.near}</td>
                </tr>
              ))}
            </tbody>
            {summary.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">All mapped assets</th>
                  <td>{totals.in_flood}</td>
                  <td>{totals.in_ambiguous}</td>
                  <td>{totals.near}</td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="caveat">
            This is preliminary screening. Being in or near observed water is not a measure of damage,
            and an asset that is not flagged is not confirmed safe.
          </p>
        </section>
      )}

      <details className="method">
        <summary>How the flood layer was made</summary>
        <dl>
          <dt>Observed</dt>
          <dd>{hazard.observed_dates}, Sentinel-1 radar (source {hazard.source_id})</dd>
          {hazard.pre_event_window && (
            <>
              <dt>Baseline</dt>
              <dd>{hazard.pre_event_window.join(" to ")}</dd>
            </>
          )}
          <dt>Method</dt>
          <dd>{hazard.method}</dd>
        </dl>
        {(hazard.limitations ?? []).length > 0 && (
          <>
            <h4>Limitations</h4>
            <ul>{(hazard.limitations ?? []).map((l) => <li key={l}>{l}</li>)}</ul>
          </>
        )}
      </details>
    </>
  );
}
