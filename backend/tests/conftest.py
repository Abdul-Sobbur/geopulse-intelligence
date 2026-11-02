"""Test setup: point the API at a database that does not exist, so tests never touch real data."""
import os
import sys
from pathlib import Path

os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_PORT", "1")          # nothing listens here: connections fail fast
os.environ.setdefault("DB_NAME", "geopulse_test")
os.environ.setdefault("DB_USER", "test")
os.environ.setdefault("DB_PASSWORD", "test")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # make the 'app' package importable
