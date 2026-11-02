// Compare sites workspace: up to four candidate sites side by side, criterion by criterion
import { Fragment } from "react";

import Segmented from "../components/Segmented";
import { RADIUS_OPTIONS, SITE_LETTERS } from "../config";
import { formatCriterion, formatDistance } from "../lib/format";
import type { CandidateSite, ComparisonResponse } from "../types";

type Props = {
  sites: CandidateSite[];
  radiusM: number;
  onRadius: (m: number) => void;
  picking: boolean;
  onTogglePick: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onFocus: (site: CandidateSite) => void;
  loading: boolean;
  comparison: ComparisonResponse | null;
  onDownload: () => void;
};

export default function ComparePanel({
  sites, radiusM, onRadius, picking, onTogglePick, onRemove, onClear, onFocus, loading, comparison, onDownload,
}: Props) {
  const nextLetter = SITE_LETTERS.find((l) => !sites.some((s) => s.id === l));
  const full = !nextLetter;
  const ready = comparison && !loading && comparison.sites.length === sites.length;

  return (
    <>
      <div className="panel-head">
        <h2>Compare candidate sites</h2>
        <p>Place up to four sites on the map to see terrain, access, services and flood constraints side by side.</p>
      </div>

      <section className="group">
        <div className="control">
          <span className="control-label">Assess within</span>
          <Segmented
            label="Assess within"
            value={radiusM}
            options={RADIUS_OPTIONS.map((m) => ({ value: m, label: formatDistance(m) }))}
            onChange={onRadius}
          />
        </div>
        <button
          type="button"
          className={`btn btn-primary${picking ? " is-picking" : ""}`}
          onClick={onTogglePick}
          disabled={full}
        >
          {full ? "Four sites placed" : picking ? `Click the map to place site ${nextLetter}` : `Place site ${nextLetter}`}
        </button>
        {picking && <button type="button" className="btn btn-quiet" onClick={onTogglePick}>Cancel</button>}

        {sites.length > 0 && (
          <ul className="site-list">
            {sites.map((s) => (
              <li key={s.id}>
                <button type="button" className="site-chip" onClick={() => onFocus(s)} title="Show on the map">
                  <span className="site-letter">{s.id}</span>
                  {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                </button>
                <button type="button" className="icon-button" aria-label={`Remove site ${s.id}`} onClick={() => onRemove(s.id)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sites.length === 0 && !picking && <p className="empty-state">No sites placed yet.</p>}
      {loading && <p className="loading-line">Comparing sites…</p>}

      {ready && (
        <>
          <div className="table-wrap">
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">Criterion</span></th>
                  {sites.map((s) => <th scope="col" key={s.id}><span className="site-letter">{s.id}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {comparison.criteria.map((c, i) => (
                  <Fragment key={c.id}>
                    {(i === 0 || comparison.criteria[i - 1].group !== c.group) && (
                      <tr className="group-row">
                        <th colSpan={sites.length + 1} scope="colgroup">{c.group}</th>
                      </tr>
                    )}
                    <tr>
                      <th scope="row" title={c.note}>{c.label}</th>
                      {comparison.sites.map((s, j) => (
                        <td key={sites[j]?.id ?? j}>{formatCriterion(s.values[c.id], c.unit)}</td>
                      ))}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {(!comparison.rasters.dem || !comparison.rasters.landcover) && (
            <p className="caveat">
              Terrain or land cover is missing. Run scripts/download_site_rasters.py, then restart the API.
            </p>
          )}
          <p className="hint">
            There is no score or ranking: whether a value is good depends on the project. Hover a criterion
            to see its source. Distances are straight lines.
          </p>
          <div className="button-row">
            <button type="button" className="btn" onClick={onDownload}>Download CSV</button>
            <button type="button" className="btn btn-quiet" onClick={onClear}>Remove all sites</button>
          </div>
        </>
      )}
    </>
  );
}
