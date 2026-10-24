/** Shared color palette + small helpers for the city scene. */

import * as THREE from "three";

/** Resolved render quality. `auto` is `settings.graphics === "auto"` while the frame rate holds. */
export type GraphicsTier = "low" | "auto" | "high";

export const TIER_DPR: Record<GraphicsTier, number | [number, number]> = {
  low: 0.85,
  auto: 1,
  high: [1, 1.25],
};

export const TIER_SHADOW_MAP: Record<GraphicsTier, number> = {
  low: 1024,
  auto: 1536,
  high: 2048,
};

export const BUILDING_PALETTE = {
  sootBrick: "#5a3c34",
  redBrick: "#8b4a3c",
  tanBrick: "#a07a5a",
  terracotta: "#cdb795",
  granite: "#8a8a86",
  brownstone: "#6b4e3d",
  limestone: "#c4b59a",
  sandstone: "#b39a72",
  warehouse: "#5c5c5c",
} as const;

export const ROOF_PALETTE = {
  tar: "#1f1d1c",
  gravel: "#3a3835",
  copper: "#4f7a6a",
  slate: "#2c3036",
} as const;

export const BUILDING_PALETTE_LIST = Object.values(BUILDING_PALETTE);

export type BuildingArchetype = "tenement" | "brownstone" | "warehouse" | "tower" | "commercial";

type Weighted = ReadonlyArray<readonly [string, number]>;

const P = BUILDING_PALETTE;
const ARCHETYPE_PALETTE: Record<BuildingArchetype, Weighted> = {
  tenement: [[P.redBrick, 3], [P.sootBrick, 3], [P.tanBrick, 2], [P.brownstone, 1]],
  brownstone: [[P.brownstone, 5], [P.sootBrick, 1], [P.sandstone, 1]],
  warehouse: [[P.warehouse, 3], [P.sootBrick, 2], [P.redBrick, 2], [P.granite, 1]],
  tower: [[P.limestone, 3], [P.granite, 2], [P.terracotta, 2], [P.sandstone, 1]],
  commercial: [[P.redBrick, 2], [P.tanBrick, 2], [P.terracotta, 2], [P.limestone, 1], [P.sootBrick, 1]],
};

function pickWeighted(list: Weighted, r: number): string {
  let total = 0;
  for (const [, w] of list) total += w;
  let acc = 0;
  for (const [c, w] of list) {
    acc += w / total;
    if (r < acc) return c;
  }
  return list[list.length - 1]![0];
}

export const ROAD_COLOR = "#2a2b2e";
export const WATER_COLOR = "#3d86b0";
export const PARK_COLOR = "#3a4a35";
export const SIDEWALK_COLOR = "#3c3c3c";

/** Deterministic 0..1 pseudo-random value from integer coordinates. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

export function pickPalette(
  gx: number,
  gz: number,
  seed: number,
  archetype: BuildingArchetype = "tenement",
): string {
  return pickWeighted(ARCHETYPE_PALETTE[archetype], hash2(gx, gz, seed));
}

/** Roof finish by archetype: tar on walk-ups, gravel on warehouses, copper on some towers. */
export function pickRoof(gx: number, gz: number, seed: number, archetype: BuildingArchetype): string {
  const r = hash2(gx, gz, seed + 29);
  if (archetype === "tower") return r < 0.2 ? ROOF_PALETTE.copper : ROOF_PALETTE.slate;
  if (archetype === "warehouse") return ROOF_PALETTE.gravel;
  return r < 0.8 ? ROOF_PALETTE.tar : ROOF_PALETTE.gravel;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface SeasonLook {
  /** Below-horizon sky and the clear colour. */
  background: THREE.Color;
  /** Sky at the horizon. Fog uses it too, so the far city fades into the sky. */
  horizon: THREE.Color;
  /** Sky overhead. */
  zenith: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  ambient: number;
  sunElevation: number;
}

function look(
  background: string,
  horizon: string,
  zenith: string,
  sunColor: string,
  sunIntensity: number,
  skyColor: string,
  groundColor: string,
  ambient: number,
  sunElevation: number,
): SeasonLook {
  return {
    background: new THREE.Color(background),
    horizon: new THREE.Color(horizon),
    zenith: new THREE.Color(zenith),
    sunColor: new THREE.Color(sunColor),
    sunIntensity,
    skyColor: new THREE.Color(skyColor),
    groundColor: new THREE.Color(groundColor),
    ambient,
    sunElevation,
  };
}

/**
 * Peaks: mid-January, mid-April, mid-July, mid-October. Spring matches the original noon light.
 * Winter is steel, spring slate, summer dusty amber, autumn bruised orange.
 */
const WINTER = look("#1a222c", "#4a5a6c", "#1a2638", "#d5e2f2", 0.9, "#8ea4be", "#1c1816", 0.3, 26);
const SPRING = look("#1c1f26", "#4a5260", "#1c2230", "#ffd9a8", 1.35, "#cbd7e8", "#241d16", 0.22, 45);
const SUMMER = look("#221d16", "#6a5844", "#262630", "#ffb060", 1.55, "#f0d2a8", "#2c2218", 0.2, 62);
const AUTUMN = look("#201814", "#664636", "#221c26", "#ffc48a", 1.15, "#d8c4a4", "#261c16", 0.24, 34);

const SEASON_KEYS: Array<{ day: number; look: SeasonLook }> = [
  { day: 15, look: WINTER },
  { day: 105, look: SPRING },
  { day: 196, look: SUMMER },
  { day: 288, look: AUTUMN },
  { day: 380, look: WINTER },
];

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dayOfYear(month: number, day: number): number {
  let d = 0;
  const last = Math.max(1, Math.min(12, month));
  for (let m = 1; m < last; m++) d += MONTH_LENGTHS[m - 1]!;
  return d + Math.max(1, day);
}

function lerpLook(a: SeasonLook, b: SeasonLook, t: number): SeasonLook {
  return {
    background: a.background.clone().lerp(b.background, t),
    horizon: a.horizon.clone().lerp(b.horizon, t),
    zenith: a.zenith.clone().lerp(b.zenith, t),
    sunColor: a.sunColor.clone().lerp(b.sunColor, t),
    sunIntensity: a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t,
    skyColor: a.skyColor.clone().lerp(b.skyColor, t),
    groundColor: a.groundColor.clone().lerp(b.groundColor, t),
    ambient: a.ambient + (b.ambient - a.ambient) * t,
    sunElevation: a.sunElevation + (b.sunElevation - a.sunElevation) * t,
  };
}

/** Fog, sun, and sky colours for a calendar date, blended between the four seasons. */
export function seasonPalette(date: { month: number; day: number }): SeasonLook {
  const raw = dayOfYear(date.month, date.day);
  const wrapped = raw < SEASON_KEYS[0]!.day ? raw + 365 : raw;
  let i = 0;
  while (i < SEASON_KEYS.length - 2 && wrapped > SEASON_KEYS[i + 1]!.day) i++;
  const a = SEASON_KEYS[i]!;
  const b = SEASON_KEYS[i + 1]!;
  const t = Math.max(0, Math.min(1, (wrapped - a.day) / (b.day - a.day)));
  return lerpLook(a.look, b.look, t);
}
