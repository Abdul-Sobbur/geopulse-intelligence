"""Database connection for the API. Settings come from the project-root .env file."""
import os
import socket
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.engine import URL

# backend/app/db.py -> parents[2] is the project root, where .env lives
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

if os.environ.get("GEOPULSE_TEST_NO_DB"):
    # Tests: a database that refuses at once (a real but closed port can take seconds per try on Windows)
    import psycopg

    def _refuse():
        raise psycopg.OperationalError("tests run without a database")

    engine = create_engine("postgresql+psycopg://", creator=_refuse)
else:
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


def prefer_ipv4(cparams: dict) -> None:
    """Connect to the host's IPv4 address when it has one.

    Some hosts (Render's free tier, for example) cannot reach IPv6, but a database host may resolve to
    IPv6 first. Setting hostaddr makes libpq connect to the IPv4 address while still using the host
    name for TLS (SNI and certificate checks), which managed services such as Neon need.
    """
    host = cparams.get("host")
    if not host or host in ("localhost",) or cparams.get("hostaddr"):
        return
    try:
        infos = socket.getaddrinfo(host, cparams.get("port") or 5432, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return  # no IPv4 address found: let libpq try whatever the host resolves to
    if infos:
        cparams["hostaddr"] = infos[0][4][0]


if not os.environ.get("GEOPULSE_TEST_NO_DB"):
    @event.listens_for(engine, "do_connect")
    def _connect_over_ipv4(dialect, conn_rec, cargs, cparams):
        prefer_ipv4(cparams)
