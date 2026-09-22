/** Shared color palette + small helpers for the city scene. */

export const BUILDING_PALETTE = {
  brick: "#8B5A4A",
  brownstone: "#6B4E3D",
  limestone: "#C4B59A",
  warehouse: "#5C5C5C",
} as const;

export const BUILDING_PALETTE_LIST = Object.values(BUILDING_PALETTE);

export const ROAD_COLOR = "#2a2b2e";
export const WATER_COLOR = "#33475a";
export const PARK_COLOR = "#3a4a35";
export const SIDEWALK_COLOR = "#3c3c3c";

/** Deterministic 0..1 pseudo-random value from integer coordinates. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

export function pickPalette(gx: number, gz: number, seed: number): string {
  const r = hash2(gx, gz, seed);
  if (r < 0.32) return BUILDING_PALETTE.brick;
  if (r < 0.58) return BUILDING_PALETTE.brownstone;
  if (r < 0.82) return BUILDING_PALETTE.limestone;
  return BUILDING_PALETTE.warehouse;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
