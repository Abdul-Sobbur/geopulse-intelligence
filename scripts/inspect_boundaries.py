"""Inspect the Ghana COD-AB district (admin-2) boundaries before loading them.

Run from the project root:  python scripts/inspect_boundaries.py
Handles both older (ADM2_EN) and newer (adm2_name) COD-AB naming.
"""
import re
from pathlib import Path

import geopandas as gpd

RAW_DIR = Path("data/raw/boundaries")

# Name fragments for the eight agreed pilot districts (matched case-insensitively)
PILOT_NAME_FRAGMENTS = [
    "Asuogyaman", "Lower Manya", "Shai", "Ada East", "Ada West",
    "North Tongu", "Central Tongu", "South Tongu",
]


def first_present(columns, candidates):
    """Return the first candidate column name that exists (case-insensitive)."""
    lookup = {c.lower(): c for c in columns}
    for cand in candidates:
        if cand.lower() in lookup:
            return lookup[cand.lower()]
    return None


# 1. Find spatial files and pick the admin-2 layer
all_shp = sorted(RAW_DIR.rglob("*.shp"))
print("Shapefiles found:")
for f in all_shp:
    print("  ", f.name)

adm2_files = [f for f in all_shp if re.search(r"adm(in)?[_-]?2", f.name, re.IGNORECASE)]
if not adm2_files:
    raise SystemExit("No admin-2 shapefile identified - paste the list above into the chat.")
print("\nUsing:", adm2_files[0].name)

# 2. Read it and describe it
gdf = gpd.read_file(adm2_files[0])
print("CRS:", gdf.crs)
print("Number of districts:", len(gdf))
print("Columns:", list(gdf.columns))

name_col = first_present(gdf.columns, ["ADM2_EN", "adm2_name", "ADM2_NAME"])
pcode_col = first_present(gdf.columns, ["ADM2_PCODE", "adm2_pcode"])
region_col = first_present(gdf.columns, ["ADM1_EN", "adm1_name", "ADM1_NAME"])
if name_col is None:
    raise SystemExit("No district-name column recognised - paste the column list above into the chat.")

# 3. Find the pilot districts
pattern = "|".join(PILOT_NAME_FRAGMENTS)
pilot = gdf[gdf[name_col].str.contains(pattern, case=False, na=False)]
show_cols = [c for c in [name_col, pcode_col, region_col] if c]
print("\nPilot district matches:")
print(pilot[show_cols].to_string(index=False))
print(f"\nMatched {len(pilot)} districts (expected 8)")

# 4. Basic geometry quality check
print("Invalid geometries (all districts):", int((~gdf.is_valid).sum()))