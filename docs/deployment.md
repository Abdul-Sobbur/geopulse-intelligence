# Deployment

GeoPulse runs live on three free services:

| Part | Host | Notes |
|---|---|---|
| Web app (React) | GitHub Pages | Built and published by `.github/workflows/deploy-pages.yml` on every push to `main` |
| API (FastAPI) | Render, free web service | Built from `backend/Dockerfile`. Sleeps after 15 minutes idle; the first request then takes about a minute |
| Database (PostGIS) | Neon, free plan | 1 GB storage. Suspends after 5 minutes idle and resumes on the next query |

```
Browser -> GitHub Pages (static app) -> Render (FastAPI) -> Neon (PostGIS)
```

## Settings

**Render** (Environment):

| Variable | Value |
|---|---|
| `DB_HOST` | Neon host, e.g. `ep-xxxx.eu-central-1.aws.neon.tech` |
| `DB_PORT` | `5432` |
| `DB_NAME` | `neondb` |
| `DB_USER` | `neondb_owner` |
| `DB_PASSWORD` | Neon password (secret) |
| `PGSSLMODE` | `require` (Neon only accepts encrypted connections) |
| `CORS_ORIGINS` | `https://abdul-sobbur.github.io` |

Health check path: `/health`.

**GitHub** (Settings > Secrets and variables > Actions > Variables): `API_URL` = the Render address, e.g. `https://geopulse-api.onrender.com`.
Settings > Pages > Source: **GitHub Actions**.

## Updating the data

The database is loaded from a dump of the local `geopulse` database:

```
pg_dump -U postgres -d geopulse --no-owner --no-privileges -Fc -f data/processed/geopulse.dump
pg_restore --no-owner --no-privileges --clean --if-exists -d "<Neon connection string>" data/processed/geopulse.dump
```

The site-comparison rasters live in `backend/site_rasters/` (copied from `data/processed/site_rasters/`).
They are clipped to the pilot area: Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA) and ESA WorldCover 2021 v200 (CC BY 4.0).
