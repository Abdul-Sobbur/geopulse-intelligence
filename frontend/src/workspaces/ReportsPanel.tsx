// Reports workspace: download the flood screening for the current scope, plus data sources
import Segmented from "../components/Segmented";
import { NEAR_OPTIONS } from "../config";
import { reportUrl } from "../lib/api";
import { formatDistance } from "../lib/format";

type Props = {
  nearM: number;
  onNearM: (m: number) => void;
  selectedPcode: string;
  scopeLabel: string;
};

export default function ReportsPanel({ nearM, onNearM, selectedPcode, scopeLabel }: Props) {
  return (
    <>
      <div className="panel-head">
        <h2>Flood screening reports</h2>
        <p>
          Reports cover {scopeLabel}. Change the district in the top bar to narrow them down.
        </p>
      </div>

      <section className="group">
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

      <ul className="download-list">
        <li>
          <a href={reportUrl("html", nearM, selectedPcode)} target="_blank" rel="noopener">
            <strong>Printable report</strong>
            <span>Opens in a new tab. Use your browser's print option to save it as a PDF.</span>
          </a>
        </li>
        <li>
          <a href={reportUrl("csv", nearM, selectedPcode)}>
            <strong>Spreadsheet tables</strong>
            <span>A .zip of CSV files with a metadata sheet, for Excel or any spreadsheet.</span>
          </a>
        </li>
        <li>
          <a href={reportUrl("geojson", nearM, selectedPcode)}>
            <strong>GIS layer</strong>
            <span>GeoJSON of flagged assets and settlements, for QGIS or ArcGIS.</span>
          </a>
        </li>
      </ul>

      <section className="group sources">
        <h3 className="group-title">Data sources</h3>
        <dl>
          <dt>Assets</dt>
          <dd>© OpenStreetMap contributors (ODbL), snapshot 2026-10-31</dd>
          <dt>Boundaries</dt>
          <dd>Ghana Statistical Service via OCHA HDX (COD-AB)</dd>
          <dt>Settlements</dt>
          <dd>GRID3 GHA Settlement Extents v3.0 (CIESIN, Columbia University, 2024)</dd>
          <dt>Flood layer</dt>
          <dd>Derived from Copernicus Sentinel-1 data (2023)</dd>
          <dt>Terrain and land cover</dt>
          <dd>Copernicus DEM GLO-30; ESA WorldCover 2021</dd>
          <dt>Basemap</dt>
          <dd>OpenFreeMap, © OpenMapTiles, OpenStreetMap data</dd>
        </dl>
      </section>

      <p className="caveat">
        Preliminary screening information only. Not for engineering design, insurance or legal decisions.
      </p>
    </>
  );
}
