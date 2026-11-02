// One-series horizontal bar chart: single hue, sorted, direct value labels
import { formatMetric } from "../lib/format";

export type BarRow = { key: string; label: string; value: number | null; selected: boolean };

type Props = { title: string; rows: BarRow[]; unit: string; note?: string; colour?: string };

export default function BarList({ title, rows, unit, note, colour }: Props) {
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const max = Math.max(0, ...sorted.map((r) => r.value ?? 0));
  const anySelected = sorted.some((r) => r.selected);
  return (
    <figure className="bar-chart">
      <figcaption>{title}</figcaption>
      {sorted.map((r) => {
        const width = max > 0 && r.value ? (r.value / max) * 100 : 0;
        const value = formatMetric(r.value, unit);
        return (
          <div
            key={r.key}
            className={`bar-row${anySelected && !r.selected ? " is-dim" : ""}`}
            title={`${r.label}: ${value}`}
          >
            <span className="bar-label">{r.label}</span>
            <span className="bar-track">
              <span className="bar" style={{ width: `${width}%`, background: colour }} />
            </span>
            <span className="bar-value">{value}</span>
          </div>
        );
      })}
      {note && <p className="hint">{note}</p>}
    </figure>
  );
}
