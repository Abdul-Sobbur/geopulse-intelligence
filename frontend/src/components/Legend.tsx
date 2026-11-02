// Map legend: what is drawn, and click a category to show or hide it
import { useState } from "react";

import { CATEGORY_LABELS, CATEGORY_ORDER, FLOOD_COLOURS, STATUS_COLOURS } from "../config";

type Props = {
  categories: string[];
  colours: Record<string, string>;
  hidden: string[];
  onToggle: (category: string) => void;
  showFlood: boolean;
  floodAvailable: boolean;
  screeningOn: boolean;
};

export default function Legend({ categories, colours, hidden, onToggle, showFlood, floodAvailable, screeningOn }: Props) {
  const ordered = CATEGORY_ORDER.filter((c) => categories.includes(c));
  // Starts folded on small screens, where it would cover most of the map
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 860);

  return (
    <div className={`legend${open ? "" : " is-folded"}`} aria-label="Map legend">
      <button type="button" className="legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Legend
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 7.5 6 4.5 9 7.5" /></svg>
      </button>

      {open && (
        <>
          <ul className="legend-list">
            {ordered.map((c) => {
              const isHidden = hidden.includes(c);
              const label = CATEGORY_LABELS[c] ?? c;
              return (
                <li key={c}>
                  <button
                    type="button"
                    className={`legend-item${isHidden ? " is-off" : ""}`}
                    aria-pressed={!isHidden}
                    title={isHidden ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
                    onClick={() => onToggle(c)}
                  >
                    <i className={`key key-${c}`} style={{ color: colours[c] }} />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>

          {floodAvailable && showFlood && (
            <ul className="legend-list legend-static">
              <li><i className="key key-area" style={{ color: FLOOD_COLOURS.flooded }} />Observed flooding, Oct 2023</li>
              <li><i className="key key-area" style={{ color: FLOOD_COLOURS.ambiguous }} />Ambiguous seasonal water</li>
            </ul>
          )}

          {screeningOn && (
            <ul className="legend-list legend-static">
              <li><i className="key key-ring" style={{ color: STATUS_COLOURS.in_flood }} />In flooding</li>
              <li><i className="key key-ring" style={{ color: STATUS_COLOURS.in_ambiguous }} />In ambiguous water</li>
              <li><i className="key key-ring" style={{ color: STATUS_COLOURS.near }} />Near observed water</li>
            </ul>
          )}
        </>
      )}
    </div>
  );
}
