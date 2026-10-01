/** Shared color palette + small helpers for the city scene. */

import * as THREE from "three";

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

export interface SeasonLook {
  background: THREE.Color;
  fog: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  ambient: number;
  sunElevation: number;
}

function look(
  background: string,
  fog: string,
  sunColor: string,
  sunIntensity: number,
  skyColor: string,
  groundColor: string,
  ambient: number,
  sunElevation: number,
): SeasonLook {
  return {
    background: new THREE.Color(background),
    fog: new THREE.Color(fog),
    sunColor: new THREE.Color(sunColor),
    sunIntensity,
    skyColor: new THREE.Color(skyColor),
    groundColor: new THREE.Color(groundColor),
    ambient,
    sunElevation,
  };
}

/** Peaks: mid-January, mid-April, mid-July, mid-October. Spring matches the original noon light. */
const WINTER = look("#0c1218", "#1a2838", "#d5e2f2", 0.9, "#8ea4be", "#1c1816", 0.3, 26);
const SPRING = look("#11141a", "#11141a", "#ffd9a8", 1.35, "#cbd7e8", "#241d16", 0.22, 45);
const SUMMER = look("#16130e", "#2a2218", "#ffb060", 1.55, "#f0d2a8", "#2c2218", 0.2, 62);
const AUTUMN = look("#14110e", "#241c16", "#ffc48a", 1.15, "#d8c4a4", "#261c16", 0.24, 34);

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
    fog: a.fog.clone().lerp(b.fog, t),
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
