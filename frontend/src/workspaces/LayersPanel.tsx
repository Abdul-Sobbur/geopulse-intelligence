// Layers workspace: every layer in the catalogue, grouped by theme, with where it comes from and its limits
import { CATEGORY_LABELS, CATEGORY_ORDER, MAP_LAYER_GROUPS, THEMES } from "../config";
import type { AssetType, CatalogLayer, CatalogResponse, CatalogSource } from "../types";

type Props = {
  catalog: CatalogResponse;
  hiddenLayers: string[];
  onToggleLayer: (id: string) => void;
  assetTypes: AssetType[];
  counts: Map<string, number>;
  colours: Record<string, string>;
  hiddenCategories: string[];
  onToggleCategory: (category: string) => void;
  settlementFootprints: number | null;
  scopeLabel: string;
  // An optional status line under a layer (loading, totals or an error)
  layerStatus?: Record<string, string>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS.at(Number(iso.slice(5, 7)) - 1)} ${iso.slice(0, 4)}`;
}

// When a layer describes, in plain words
function when(t: CatalogLayer["temporal"]): string {
  if (t.kind === "event" && t.start) return t.end && t.end !== t.start ? `${day(t.start)} to ${day(t.end)}` : day(t.start);
  if (t.kind === "period" && t.start) return t.end ? `${t.start.slice(0, 4)} to ${t.end.slice(0, 4)}` : `From ${t.start.slice(0, 4)}`;
  if (t.kind === "snapshot" && t.start) return t.note ?? `As of ${day(t.start)}`;
  return t.note ?? "Not time-specific";
}

function SourceLine({ source }: { source: CatalogSource }) {
  return (
    <li>
      {source.url ? <a href={source.url} target="_blank" rel="noopener">{source.title}</a> : source.title}
      <span className="muted">, {source.provider}. </span>
      <span className={source.licence_confirmed ? "" : "unconfirmed"}>
        {source.licence_confirmed ? source.licence : `Licence to confirm: ${source.licence}`}
      </span>
    </li>
  );
}

export default function LayersPanel({
  catalog, hiddenLayers, onToggleLayer, assetTypes, counts, colours, hiddenCategories, onToggleCategory,
  settlementFootprints, scopeLabel, layerStatus = {},
}: Props) {
  const sources = new Map(catalog.sources.map((s) => [s.id, s]));
  const live = catalog.layers.filter((l) => l.status === "live");

  return (
    <>
      <div className="panel-head">
        <h2>Layers</h2>
        <p>
          <span className="figure">{live.length}</span> layers, each with its source, date and limits.
          Counts are for {scopeLabel} unless a layer covers all of Ghana.
        </p>
      </div>

      {THEMES.map((theme) => {
        const layers = live.filter((l) => l.theme === theme.id);
        if (layers.length === 0) return null;
        return (
          <section className="theme" key={theme.id} aria-label={theme.label}>
            <h3 className="theme-name">{theme.label}</h3>
            {layers.map((layer) => {
              const drawable = layer.id in MAP_LAYER_GROUPS;
              const on = !hiddenLayers.includes(layer.id);
              return (
                <article className={`layer${drawable && !on ? " is-off" : ""}`} key={layer.id}>
                  <div className="layer-head">
                    <div>
                      <h4>{layer.title}</h4>
                      <span className={`kind kind-${layer.evidence.split(" ")[0].toLowerCase()}`}>{layer.evidence}</span>
                      <span className="layer-when">{when(layer.temporal)}</span>
                    </div>
                    {drawable ? (
                      <button
                        type="button" className="switch" role="switch" aria-checked={on}
                        aria-label={`Show ${layer.title} on the map`} onClick={() => onToggleLayer(layer.id)}
                      />
                    ) : (
                      <span className="layer-note">Used by Compare sites</span>
                    )}
                  </div>
                  <p className="layer-summary">{layer.summary}</p>
                  {layerStatus[layer.id] && <p className="layer-status" role="status">{layerStatus[layer.id]}</p>}

                  {layer.id === "osm-assets" && (
                    <ul className="class-list">
                      {CATEGORY_ORDER.map((category) => {
                        const rows = assetTypes.filter((t) => t.category === category);
                        if (rows.length === 0) return null;
                        const hidden = hiddenCategories.includes(category);
                        const total = rows.reduce((n, t) => n + (counts.get(t.asset_type) ?? 0), 0);
                        return (
                          <li key={category}>
                            <button
                              type="button" className={`class-toggle${hidden ? " is-off" : ""}`} aria-pressed={!hidden}
                              onClick={() => onToggleCategory(category)}
                              title={rows.map((t) => `${t.label}: ${(counts.get(t.asset_type) ?? 0).toLocaleString()}`).join("\n")}
                            >
                              <i className={`key key-${category}`} style={{ color: colours[category] }} />
                              <span>{CATEGORY_LABELS[category] ?? category}</span>
                              <span className="class-count">{total.toLocaleString()}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {layer.id === "grid3-settlements" && settlementFootprints !== null && (
                    <p className="layer-count"><span className="figure">{settlementFootprints.toLocaleString()}</span> footprints</p>
                  )}

                  <details className="about">
                    <summary>Source, method and limits</summary>
                    <h5>Sources</h5>
                    <ul className="source-list">
                      {layer.sources.map((id) => {
                        const source = sources.get(id);
                        return source ? <SourceLine key={id} source={source} /> : <li key={id}>{id}</li>;
                      })}
                    </ul>
                    <h5>Method</h5>
                    <p>{layer.method}</p>
                    <h5>Limitations</h5>
                    <ul className="limit-list">{layer.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
                  </details>
                </article>
              );
            })}
          </section>
        );
      })}

      <p className="hint">
        Observation: counted or measured from a source dataset. Modelled estimate: produced by a provider's model.
        Derived: calculated by GeoPulse from other layers.
      </p>
    </>
  );
}
