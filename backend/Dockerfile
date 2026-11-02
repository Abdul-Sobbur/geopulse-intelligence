# GeoPulse API image: FastAPI served by uvicorn
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RASTER_DIR=/app/site_rasters

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# Terrain and land-cover rasters for site comparison (small, clipped to the pilot area)
COPY site_rasters ./site_rasters

EXPOSE 8000
# Hosting platforms such as Render tell the app which port to use through $PORT; 8000 otherwise
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
