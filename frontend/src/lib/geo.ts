// Small geometry helpers that run in the browser
import type { Bounds, Geometry, NestedCoords } from "../types";

// Bounding box of any GeoJSON geometry
export function geometryBounds(geometry: Geometry): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords: NestedCoords): void => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords as number[];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    } else {
      for (const part of coords as NestedCoords[]) visit(part);
    }
  };
  visit(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

// A sensible place to anchor a popup on a feature
export function anchorPoint(geometry: Geometry): [number, number] {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as [number, number][];
    return coords[Math.floor(coords.length / 2)];
  }
  const [minX, minY, maxX, maxY] = geometryBounds(geometry);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// Approximate circle (as a polygon ring) of a given radius in metres around a point
export function circleRing(lon: number, lat: number, radiusM: number, steps = 72): [number, number][] {
  const ring: [number, number][] = [];
  const metresPerDegLat = 110_574;
  const metresPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    ring.push([
      lon + (radiusM * Math.cos(angle)) / metresPerDegLon,
      lat + (radiusM * Math.sin(angle)) / metresPerDegLat,
    ]);
  }
  return ring;
}
