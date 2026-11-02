// Brand, workspace tabs, district scope and name search
import { useState } from "react";

import { MAX_SEARCH_RESULTS, PILOT_NAME, WORKSPACES } from "../config";
import type { District, Feature, Workspace } from "../types";

type Props = {
  workspace: Workspace;
  onWorkspace: (w: Workspace) => void;
  districts: District[];
  selectedPcode: string;
  onSelectPcode: (pcode: string) => void;
  query: string;
  onQuery: (q: string) => void;
  matches: Feature[];
  onOpenMatch: (f: Feature) => void;
  districtNames: Map<string, string>;
  ready: boolean;
};

export default function TopBar({
  workspace, onWorkspace, districts, selectedPcode, onSelectPcode,
  query, onQuery, matches, onOpenMatch, districtNames, ready,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const showResults = searchOpen && query.trim().length >= 2;

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 15c3 0 3-3 6-3s3 3 6 3 3-3 6-3 2 1 2 1" />
          <path d="M2 20c3 0 3-3 6-3s3 3 6 3 3-3 6-3 2 1 2 1" opacity=".45" />
          <circle cx="15" cy="6" r="2.4" />
        </svg>
        <div className="brand-text">
          <span className="brand-name">GeoPulse</span>
          <span className="brand-pilot">{PILOT_NAME}, Ghana</span>
        </div>
      </div>

      <nav className="tabs" aria-label="Workspaces">
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`tab${w.id === workspace ? " is-active" : ""}`}
            aria-current={w.id === workspace ? "page" : undefined}
            onClick={() => onWorkspace(w.id)}
          >
            {w.label}
          </button>
        ))}
      </nav>

      <div className="topbar-tools">
        <label className="scope">
          <span className="visually-hidden">District</span>
          <select
            value={selectedPcode}
            onChange={(e) => onSelectPcode(e.target.value)}
            disabled={!ready}
          >
            <option value="">All 8 pilot districts</option>
            {districts.map((d) => (
              <option key={d.pcode} value={d.pcode}>{d.name}</option>
            ))}
          </select>
        </label>

        <div className="search" onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSearchOpen(false);
        }}>
          <label>
            <span className="visually-hidden">Find an asset by name</span>
            <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" />
            </svg>
            <input
              type="search"
              value={query}
              placeholder="Find an asset, e.g. Kpong"
              disabled={!ready}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => { onQuery(e.target.value); setSearchOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchOpen(false);
                if (e.key === "Enter" && matches[0]) { onOpenMatch(matches[0]); setSearchOpen(false); }
              }}
            />
          </label>
          {showResults && (
            <ul className="search-results">
              {matches.length === 0 && <li className="empty">No named assets match in this scope.</li>}
              {matches.slice(0, MAX_SEARCH_RESULTS).map((f) => (
                <li key={f.properties.asset_id}>
                  <button type="button" onClick={() => { onOpenMatch(f); setSearchOpen(false); }}>
                    <strong>{f.properties.name}</strong>
                    <span>
                      {f.properties.label}
                      {f.properties.adm2_pcode ? `, ${districtNames.get(f.properties.adm2_pcode) ?? ""}` : ""}
                    </span>
                  </button>
                </li>
              ))}
              {matches.length > MAX_SEARCH_RESULTS && (
                <li className="empty">
                  {MAX_SEARCH_RESULTS} of {matches.length} shown. Keep typing to narrow down.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </header>
  );
}
