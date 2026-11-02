// Number and distance formatting

export function formatDistance(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : Math.round(value).toLocaleString();
}

export function formatMetric(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "–";
  if (unit === "km²") return `${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km²`;
  return Math.round(value).toLocaleString();
}

export function formatCriterion(value: string | number | null | undefined, unit: string): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "string") return value;
  switch (unit) {
    case "m":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
    case "m_asl":
      return `${Math.round(value)} m`;
    case "deg":
      return `${value.toFixed(1)}°`;
    case "ha":
      return `${value.toFixed(1)} ha`;
    case "count":
      return Math.round(value).toLocaleString();
    default:
      return String(value);
  }
}
