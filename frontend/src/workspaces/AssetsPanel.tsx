// Assets workspace: what is mapped in the current scope, by category
import { CATEGORY_LABELS, CATEGORY_ORDER } from "../config";
import type { AssetType } from "../types";

type Props = {
  assetTypes: AssetType[];
  counts: Map<string, number>;
  colours: Record<string, string>;
  hidden: string[];
  onToggle: (category: string) => void;
  scopeLabel: string;
  settlementFootprints: number | null;
};

export default function AssetsPanel({ assetTypes, counts, colours, hidden, onToggle, scopeLabel, settlementFootprints }: Props) {
  const total = assetTypes.reduce((sum, t) => sum + (counts.get(t.asset_type) ?? 0), 0);
  return (
    <>
      <div className="panel-head">
        <h2>Mapped assets</h2>
        <p>
          <span className="figure">{total.toLocaleString()}</span> assets from OpenStreetMap in {scopeLabel}.
          Click anything on the map for its details and source.
        </p>
      </div>

      {CATEGORY_ORDER.map((category) => {
        const rows = assetTypes.filter((t) => t.category === category);
        if (rows.length === 0) return null;
        const isHidden = hidden.includes(category);
        const warnings = [...new Set(rows.map((r) => r.coverage_warning).filter((w): w is string => !!w))];
        return (
          <section className={`group${isHidden ? " is-off" : ""}`} key={category}>
            <div className="group-head">
              <h3>
                <i className={`key key-${category}`} style={{ color: colours[category] }} />
                {CATEGORY_LABELS[category] ?? category}
              </h3>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={!isHidden}
                aria-label={`Show ${CATEGORY_LABELS[category] ?? category} on the map`}
                onClick={() => onToggle(category)}
              />
            </div>
            <dl className="count-list">
              {rows.map((t) => (
                <div key={t.asset_type}>
                  <dt>{t.label}</dt>
                  <dd>{(counts.get(t.asset_type) ?? 0).toLocaleString()}</dd>
                </div>
              ))}
              {category === "settlement" && settlementFootprints !== null && (
                <div>
                  <dt>Settlement footprints (GRID3)</dt>
                  <dd>{settlementFootprints.toLocaleString()}</dd>
                </div>
              )}
            </dl>
            {warnings.map((w) => <p className="coverage" key={w}>{w}</p>)}
          </section>
        );
      })}

      <p className="hint">
        A feature missing from the map is not evidence that it is missing on the ground. OpenStreetMap
        coverage varies by place and by asset type.
      </p>
    </>
  );
}
