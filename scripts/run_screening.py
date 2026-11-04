"""Screen exposure layers against hazard layers, using the layer catalogue.

Run from the project root:
    python scripts/run_screening.py                                   (every screenable pair)
    python scripts/run_screening.py --hazard flood-2023-observed --exposure osm-assets

Results go to the screening_results table (one row per feature per pair) with a screening_runs
record. Re-run after a hazard or exposure layer is reloaded.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.catalog import load_catalog  # noqa: E402
from app.screening import run  # noqa: E402
from db import get_engine  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hazard", help="hazard layer ID (default: every live screenable hazard)")
    parser.add_argument("--exposure", help="exposure layer ID (default: every live screenable exposure layer)")
    args = parser.parse_args()

    cat = load_catalog()
    live = [layer for layer in cat.layers.values() if layer.status == "live"]
    hazards = [layer for layer in live if layer.screening == "hazard" and args.hazard in (None, layer.id)]
    exposures = [layer for layer in live if layer.screening == "exposure" and args.exposure in (None, layer.id)]
    if not hazards or not exposures:
        raise SystemExit("No matching screenable layers. Check the IDs with: python -m app.catalog (in backend)")

    engine = get_engine()
    for hazard in hazards:
        for exposure in exposures:
            start = time.perf_counter()
            print(f"Screening {exposure.id} against {hazard.id} ...", flush=True)
            with engine.begin() as conn:
                count = run(conn, hazard, exposure)
            print(f"  {count:,} features in {time.perf_counter() - start:.0f} s")
    print("\nDone. Check against the original screening with: python scripts/check_screening.py")


if __name__ == "__main__":
    main()
