// People near observed flooding, from floor to ceiling, with reported figures marked on the same scale
import type { PeopleStep, ReportedFigure } from "../types";

type Props = { ladder: PeopleStep[]; references: ReportedFigure[]; compact?: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const published = (iso: string) => `${MONTHS.at(Number(iso.slice(5, 7)) - 1)} ${iso.slice(0, 4)}`;

export default function PeopleLadder({ ladder, references, compact = false }: Props) {
  const max = Math.max(1, ...ladder.map((s) => s.worldpop ?? 0), ...references.map((r) => r.value));
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <figure className={`ladder${compact ? " is-compact" : ""}`}>
      <figcaption>People living near observed flooding, from floor to ceiling (WorldPop 2023)</figcaption>
      <ol className="ladder-steps">
        {ladder.map((step) => (
          <li key={step.id} className={`ladder-step step-${step.id}`} title={step.note}>
            <span className="ladder-label">{step.label}</span>
            <span className="ladder-track">
              <span className="ladder-bar" style={{ width: pct(step.worldpop ?? 0) }} />
              {references.map((r) => (
                <span key={r.id} className="ladder-ref" style={{ left: pct(r.value) }} aria-hidden="true" />
              ))}
            </span>
            <span className="ladder-value">{step.worldpop === null ? "–" : step.worldpop.toLocaleString()}</span>
            {!compact && (
              <span className="ladder-note">
                {step.note}
                {step.ghspop !== null && ` Second model (GHS-POP): ${step.ghspop.toLocaleString()}.`}
              </span>
            )}
          </li>
        ))}
      </ol>
      {references.length > 0 && (
        <ul className="ladder-refs">
          {references.map((r) => (
            <li key={r.id}>
              <i className="ladder-ref-key" aria-hidden="true" />
              <span>
                <strong>{r.value.toLocaleString()} {r.measure}</strong>, {r.area}.{" "}
                <a href={r.url} target="_blank" rel="noopener">{r.reported_by}</a>, {published(r.published)}.
                {r.note && !compact && <span className="muted"> {r.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
