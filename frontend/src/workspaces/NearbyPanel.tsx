// Nearby workspace: everything mapped within a radius of a point you pick
import Segmented from "../components/Segmented";
import { CATEGORY_COLOURS, RADIUS_OPTIONS } from "../config";
import { formatDistance } from "../lib/format";
import type { ProximityFeature, ProximityResponse } from "../types";

type Props = {
  radiusM: number;
  onRadius: (m: number) => void;
  picking: boolean;
  onTogglePick: () => void;
  loading: boolean;
  result: ProximityResponse | null;
  onOpen: (f: ProximityFeature) => void;
  onClear: () => void;
};

export default function NearbyPanel({ radiusM, onRadius, picking, onTogglePick, loading, result, onOpen, onClear }: Props) {
  return (
    <>
      <div className="panel-head">
        <h2>What's nearby</h2>
        <p>Pick a point on the map to list the assets and settlements around it.</p>
      </div>

      <section className="group">
        <div className="control">
          <span className="control-label">Search radius</span>
          <Segmented
            label="Search radius"
            value={radiusM}
            options={RADIUS_OPTIONS.map((m) => ({ value: m, label: formatDistance(m) }))}
            onChange={onRadius}
          />
        </div>
        <button type="button" className={`btn btn-primary${picking ? " is-picking" : ""}`} onClick={onTogglePick}>
          {picking ? "Click the map to choose a point" : result ? "Pick another point" : "Pick a point on the map"}
        </button>
        {picking && (
          <button type="button" className="btn btn-quiet" onClick={onTogglePick}>Cancel</button>
        )}
      </section>

      {loading && <p className="loading-line">Searching…</p>}

      {!result && !loading && !picking && (
        <p className="empty-state">No point chosen yet.</p>
      )}

      {result && !loading && (
        <>
          <section className="group">
            <h3 className="group-title">
              {result.total.toLocaleString()} {result.total === 1 ? "feature" : "features"} within {formatDistance(result.radius_m)}
            </h3>
            <p className="meta">
              {result.center[1].toFixed(4)}, {result.center[0].toFixed(4)}
              {result.district ? ` in ${result.district.name}` : ", outside the mapped districts"}
            </p>

            {result.summary.length > 0 && (
              <dl className="count-list">
                {result.summary.map((s) => (
                  <div key={`${s.kind}-${s.type}`}>
                    <dt>{s.kind === "settlement" ? `${s.label} footprints` : s.label}</dt>
                    <dd>
                      {s.count.toLocaleString()}
                      {s.buildings ? <span className="muted"> with {s.buildings.toLocaleString()} buildings</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {result.hazard && (result.hazard.flooded_m2 > 0 || result.hazard.ambiguous_m2 > 0) && (
              <p className="flood-note">
                Observed new water in the circle (Oct 2023): {(result.hazard.flooded_m2 / 10_000).toFixed(1)} ha
                of flooding and {(result.hazard.ambiguous_m2 / 10_000).toFixed(1)} ha of ambiguous seasonal water.
              </p>
            )}
          </section>

          {result.features.length > 0 && (
            <section className="group">
              <h3 className="group-title">Nearest first</h3>
              <ol className="feature-list">
                {result.features.map((f) => (
                  <li key={`${f.kind}-${f.id}`}>
                    <button type="button" onClick={() => onOpen(f)}>
                      <i className="dot" style={{ background: CATEGORY_COLOURS[f.category] ?? "#8a9aa8" }} />
                      <span className="feature-name">
                        {f.name ?? (f.kind === "settlement" ? `${f.label} footprint` : `Unnamed ${f.label.toLowerCase()}`)}
                        <span className="muted">{f.label}</span>
                      </span>
                      <span className="feature-distance">{Math.round(f.distance_m).toLocaleString()} m</span>
                    </button>
                  </li>
                ))}
              </ol>
              {result.total > result.features.length && (
                <p className="hint">The nearest {result.features.length} of {result.total} are listed.</p>
              )}
            </section>
          )}

          <p className="hint">
            Distances are straight lines to the nearest edge of each feature, not travel distances.
            Building counts cover whole settlements.
          </p>
          <button type="button" className="btn btn-quiet" onClick={onClear}>Clear the search</button>
        </>
      )}
    </>
  );
}
