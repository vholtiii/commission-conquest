/** Muted borough hues — deliberately outside FAMILY_HEX so turf ownership stays readable. */
export const BOROUGH_HEX: Record<string, string> = {
  Manhattan: "#8a7f6a",
  Brooklyn: "#5f7a8a",
  Queens: "#7a8a5f",
  Bronx: "#8a6a70",
  "Staten Island": "#6f8a80",
  "New Jersey": "#7d7a8a",
  Westchester: "#8a8a6a",
};

const FALLBACK = "#6a6e76";

export const BOROUGH_ORDER = [
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
  "New Jersey",
  "Westchester",
] as const;

export function boroughColor(name: string): string {
  return BOROUGH_HEX[name] ?? FALLBACK;
}
