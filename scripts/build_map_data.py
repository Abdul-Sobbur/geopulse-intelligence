"""Build the static map data that GitHub Pages serves next to the web app.

The app normally asks the API for every map layer when it opens, and the free API can take about a minute
to wake up. This script asks the API once, at build time, and saves the layers as files the app can load
straight away:

    frontend/public/data/manifest.json     what was built, when, and from where
    frontend/public/data/*.json            the pilot layers (districts, assets, settlements, flood, ...)
    frontend/public/data/national.pmtiles  the national district map as vector tiles (needs tippecanoe)

The figures (screening, people, dashboard, reports) still come from the live API.
If the API cannot be reached, nothing is written and the app simply falls back to the API, as before.

Usage (from the project folder):
    python scripts/build_map_data.py --api https://your-api.onrender.com
    python scripts/build_map_data.py --api http://127.0.0.1:8000        # test against a local API
Only the Python standard library is needed; tippecanoe is optional (the GitHub Action installs it).
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

PILOT_ID = "lower_volta"
HAZARD_ID = "flood_2023_observed"
MANIFEST_VERSION = 1

# (name, API path, required): if a required layer fails, no manifest is written and the app uses the API
LAYERS = [
    ("districts", f"/pilots/{PILOT_ID}/districts", True),
    ("assets", "/assets?limit=5000", True),
    ("asset-types", "/asset-types", True),
    ("hazards", "/hazards", False),
    ("flood", f"/hazards/{HAZARD_ID}/features", False),
    ("settlements", "/settlements", False),
    ("catalog", "/catalog", False),
    ("national", f"/national/districts?pilot_id={PILOT_ID}", False),
]


def get(url: str, timeout: int = 120):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "geopulse-build"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if "json" not in response.headers.get("Content-Type", ""):
            raise ValueError(f"not JSON (the server may still be waking up): {url}")
        return json.load(response)


def wait_for_api(api: str, attempts: int = 18, delay: int = 10) -> bool:
    """A sleeping free server can take a minute or two to wake; keep asking /health."""
    for i in range(attempts):
        try:
            if get(f"{api}/health", timeout=30).get("status") == "ok":
                return True
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as err:
            print(f"  waiting for the API ({i + 1}/{attempts}): {err}")
        time.sleep(delay)
    return False


def build_pmtiles(geojson: Path, out: Path) -> bool:
    """Turn the national GeoJSON into vector tiles with tippecanoe, if it is installed."""
    if not shutil.which("tippecanoe"):
        print("  tippecanoe is not installed: skipping national.pmtiles (the app will use national.json)")
        return False
    command = [
        "tippecanoe", "--force", "--quiet", "-o", str(out),
        "--layer=districts", "--minimum-zoom=4", "--maximum-zoom=10",
        "--detect-shared-borders",        # neighbouring districts stay gap-free when simplified
        "--no-feature-limit", "--no-tile-size-limit",  # never drop a district
        str(geojson),
    ]
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  tippecanoe failed, using national.json instead:\n{result.stderr}")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", required=True, help="API address, e.g. https://geopulse-api.onrender.com")
    parser.add_argument("--out", default="frontend/public/data", help="Output folder (default: %(default)s)")
    args = parser.parse_args()
    api = args.api.rstrip("/")
    out = Path(args.out)

    print(f"Building static map data from {api}")
    if not wait_for_api(api):
        print("::warning::The API did not answer, so no static map data was built. The app will load from the API.")
        return 0

    files, counts, failed = {}, {}, []
    data = {}
    for name, path, required in LAYERS:
        try:
            data[name] = get(api + path)
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as err:
            if required:
                print(f"::warning::Could not fetch {name} ({err}); no static map data was built.")
                return 0
            failed.append(name)
            print(f"  skipped {name}: {err}")
            continue
        body = data[name]
        counts[name] = len(body["features"]) if isinstance(body, dict) and "features" in body else (
            len(body) if isinstance(body, list) else len(body.get("layers", [])))

    # Start from a clean folder, so a layer that failed this time cannot leave an old copy behind
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for name, body in data.items():
        target = out / f"{name}.json"
        target.write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
        files[name] = target.name
        print(f"  {target.name}: {counts[name]} items, {target.stat().st_size / 1e6:.2f} MB")

    national = None
    if "national" in data:
        body = data["national"]
        tiles = out / "national.pmtiles"
        has_tiles = build_pmtiles(out / "national.json", tiles)
        if has_tiles:
            print(f"  national.pmtiles: {tiles.stat().st_size / 1e6:.2f} MB")
        national = {
            "bbox": body.get("bbox"),
            "totals": body.get("totals"),
            "limitations": body.get("limitations", []),
            "pmtiles": tiles.name if has_tiles else None,
            "source_layer": "districts",
        }

    manifest = {
        "version": MANIFEST_VERSION,
        "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "api": api,
        "pilot_id": PILOT_ID,
        "hazard_id": HAZARD_ID,
        "files": files,
        "counts": counts,
        "skipped": failed,
        "national": national,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Done: {len(files)} layers written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
