"""Database connection for the API. Settings come from the project-root .env file."""
import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

# backend/app/db.py -> parents[2] is the project root, where .env lives
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

engine = create_engine(
    URL.create(
        drivername="postgresql+psycopg",
        username=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        database=os.environ["DB_NAME"],
    ),
    pool_pre_ping=True,  # quietly reconnect if the database connection dropped
)