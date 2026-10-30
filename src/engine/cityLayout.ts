import type { Territory } from "@/types/game";
import { createRng, hashString } from "./rng";

export const GRID_W = 48;
export const GRID_H = 36;
export const BLOCK_SIZE = 2.2;
export const ROAD_GAP = 0.55;

export interface GridDims {
  w: number;
  h: number;
}

export const NORMAL_DIMS: GridDims = { w: GRID_W, h: GRID_H };

/** Furthest the camera pulls back. Grows with the grid so a large map still fits. */
export function cameraPullback(gridW: number): number {
  return Math.round((150 * gridW) / GRID_W);
}

export type CellKind = "building" | "road" | "water" | "park";

export interface CityBlock {
  gx: number;
  gz: number;
  worldX: number;
  worldZ: number;
  territoryId: string | null;
  kind: CellKind;
  heightBias: number;
}

export interface DistrictCenter {
  territoryId: string;
  worldX: number;
  worldZ: number;
  name: string;
}

export interface CityLayout {
  blocks: CityBlock[];
  centers: DistrictCenter[];
  width: number;
  depth: number;
  gridW: number;
  gridH: number;
}

/**
 * A larger grid keeps the old city in the middle, block for block, and frames
 * it with the same rivers. A smaller grid scales those features with the frame.
 * The normal 48×36 grid takes neither path, so it stays where it is.
 */
function featureFrame(w: number, h: number): { ox: number; oz: number; sx: number; sy: number } {
  if (w > GRID_W) return { ox: (w - GRID_W) / 2, oz: (h - GRID_H) / 2, sx: 1, sy: 1 };
  return { ox: 0, oz: 0, sx: w / GRID_W, sy: h / GRID_H };
}

function isWaterCell(gx: number, gz: number, w: number, h: number): boolean {
  const { ox, sx, sy } = featureFrame(w, h);
  // Hudson (west), East River (east corridor), harbor south
  if (gx <= 2 * sx) return true;
  if (gx >= w - 3 * sx && gz > 8 * sy && gz < h - 6 * sy) return true;
  if (gz >= h - 3 * sy && gx > 8 * sx && gx < w - 8 * sx) return true;
  // Harbor bite, kept with the original city when the grid grows
  if (gx > 20 * sx + ox && gx < 26 * sx + ox && gz > h - 5 * sy) return true;
  return false;
}

function isRoadCell(gx: number, gz: number): boolean {
  return gx % 4 === 0 || gz % 4 === 0;
}

function isParkCell(gx: number, gz: number, w: number, h: number): boolean {
  const { ox, oz, sx, sy } = featureFrame(w, h);
  // Central Park-ish + small greens
  if (
    gx >= 18 * sx + ox &&
    gx <= 24 * sx + ox &&
    gz >= 12 * sy + oz &&
    gz <= 20 * sy + oz &&
    !isRoadCell(gx, gz)
  ) {
    return true;
  }
  if ((gx + gz) % 17 === 0 && !isRoadCell(gx, gz)) return true;
  return false;
}

function boroughHeightBias(borough: string): number {
  switch (borough) {
    case "Manhattan":
      return 1.6;
    case "Brooklyn":
      return 1.1;
    case "Queens":
      return 1.0;
    case "Bronx":
      return 0.95;
    case "Staten Island":
      return 0.8;
    default:
      return 1.0;
  }
}

const layoutCache = new Map<string, CityLayout>();

/** Geometry only depends on id, position, borough, whether the lot is empty, and the grid. */
export function layoutCacheKey(
  territories: Pick<Territory, "id" | "x" | "y" | "borough" | "emptyLot">[],
  seed: number,
  dims: GridDims = NORMAL_DIMS,
): string {
  return `${seed}|${dims.w}x${dims.h}|${territories
    .map((t) => `${t.id}:${t.x}:${t.y}:${t.borough}:${t.emptyLot ? 1 : 0}`)
    .join("|")}`;
}

/** Cached layout. Selection and slot math rebuild the grid only when the map changes. */
export function getCityLayout(territories: Territory[], seed = 42, dims: GridDims = NORMAL_DIMS): CityLayout {
  const key = layoutCacheKey(territories, seed, dims);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const layout = buildCityLayout(territories, seed, dims);
  layoutCache.set(key, layout);
  if (layoutCache.size > 4) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
  return layout;
}

export function buildCityLayout(
  territories: Territory[],
  seed = 42,
  dims: GridDims = NORMAL_DIMS,
): CityLayout {
  const rng = createRng(seed);
  const gridW = dims.w;
  const gridH = dims.h;
  const width = gridW * (BLOCK_SIZE + ROAD_GAP);
  const depth = gridH * (BLOCK_SIZE + ROAD_GAP);

  const centers: DistrictCenter[] = territories.map((t) => {
    const worldX = (t.x / 100) * width - width / 2;
    const worldZ = (t.y / 100) * depth - depth / 2;
    return { territoryId: t.id, worldX, worldZ, name: t.name };
  });

  const byId = new Map(territories.map((t) => [t.id, t]));

  const blocks: CityBlock[] = [];
  for (let gz = 0; gz < gridH; gz++) {
    for (let gx = 0; gx < gridW; gx++) {
      const worldX = gx * (BLOCK_SIZE + ROAD_GAP) - width / 2 + BLOCK_SIZE / 2;
      const worldZ = gz * (BLOCK_SIZE + ROAD_GAP) - depth / 2 + BLOCK_SIZE / 2;

      let kind: CellKind = "building";
      if (isWaterCell(gx, gz, gridW, gridH)) kind = "water";
      else if (isRoadCell(gx, gz)) kind = "road";
      else if (isParkCell(gx, gz, gridW, gridH)) kind = "park";

      let territoryId: string | null = null;
      if (kind === "building" || kind === "park" || kind === "road") {
        let best = Infinity;
        for (const c of centers) {
          const dx = c.worldX - worldX;
          const dz = c.worldZ - worldZ;
          const d = dx * dx + dz * dz;
          if (d < best) {
            best = d;
            territoryId = c.territoryId;
          }
        }
      }

      const t = territoryId ? byId.get(territoryId) : undefined;
      // A district flagged as an empty lot is vacant ground: nothing gets built
      // on its blocks by the city, so it stays a lot for hideouts only.
      if (kind === "building" && t?.emptyLot) kind = "park";
      const bias = t ? boroughHeightBias(t.borough) : 1;
      const jitter = 0.7 + ((hashString(`${gx},${gz},${seed}`) % 1000) / 1000) * 0.8;

      blocks.push({
        gx,
        gz,
        worldX,
        worldZ,
        territoryId,
        kind,
        heightBias: bias * jitter * (rng.next() * 0.3 + 0.85),
      });
    }
  }

  return { blocks, centers, width, depth, gridW, gridH };
}

export function getDistrictBlocks(layout: CityLayout, territoryId: string): CityBlock[] {
  return layout.blocks.filter((b) => b.territoryId === territoryId && b.kind === "building");
}

/** Building blocks for a district, nearest to district center first. */
export function getDistrictBlocksNearestFirst(
  layout: CityLayout,
  territoryId: string,
): CityBlock[] {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const blocks = getDistrictBlocks(layout, territoryId);
  if (!center) return blocks;
  return [...blocks].sort((a, b) => {
    const da = (a.worldX - center.worldX) ** 2 + (a.worldZ - center.worldZ) ** 2;
    const db = (b.worldX - center.worldX) ** 2 + (b.worldZ - center.worldZ) ** 2;
    return da - db;
  });
}

/** Park cells in a district, nearest to the center first. Used when a lot has no buildings. */
export function getDistrictLotBlocks(layout: CityLayout, territoryId: string): CityBlock[] {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const blocks = layout.blocks.filter(
    (b) => b.territoryId === territoryId && b.kind === "park",
  );
  if (!center) return blocks;
  return [...blocks].sort((a, b) => {
    const da = (a.worldX - center.worldX) ** 2 + (a.worldZ - center.worldZ) ** 2;
    const db = (b.worldX - center.worldX) ** 2 + (b.worldZ - center.worldZ) ** 2;
    return da - db;
  });
}

/**
 * Spots on an empty lot with no park cells: the centre, then one pitch west
 * and one pitch east, so each hideout gets its own patch of ground.
 */
const LOT_FALLBACK_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [-(BLOCK_SIZE + ROAD_GAP), 0],
  [BLOCK_SIZE + ROAD_GAP, 0],
  [0, BLOCK_SIZE + ROAD_GAP],
  [0, -(BLOCK_SIZE + ROAD_GAP)],
  [-(BLOCK_SIZE + ROAD_GAP), BLOCK_SIZE + ROAD_GAP],
];

function centerFallbackBlock(
  layout: CityLayout,
  territoryId: string,
  slot = 0,
): CityBlock | null {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  if (!center) return null;
  const [dx, dz] = LOT_FALLBACK_OFFSETS[slot % LOT_FALLBACK_OFFSETS.length]!;
  return {
    gx: -1 - slot,
    gz: -1,
    worldX: center.worldX + dx,
    worldZ: center.worldZ + dz,
    territoryId,
    kind: "park",
    heightBias: 1,
  };
}

/** Deterministic block used for a racket's stable site slot in a territory. */
export function racketBlockFor(
  layout: CityLayout,
  territoryId: string,
  siteIndex: number,
): CityBlock | null {
  const buildings = getDistrictBlocksNearestFirst(layout, territoryId);
  if (buildings.length > 0) return buildings[siteIndex % buildings.length] ?? null;
  // Empty lot: use the district's open ground first, then spread the rest
  // around the centre so three hideouts never stack on one spot.
  const lots = getDistrictLotBlocks(layout, territoryId);
  if (siteIndex < lots.length) return lots[siteIndex] ?? null;
  return centerFallbackBlock(layout, territoryId, siteIndex - lots.length);
}

/**
 * Next free site slot on a district. Prefers the lowest unused index so old
 * saves that used array position keep looking the same after backfill.
 */
export function nextRacketSiteIndex(
  rackets: { siteIndex?: number }[],
): number {
  const taken = new Set(
    rackets
      .map((r, i) => (typeof r.siteIndex === "number" ? r.siteIndex : i))
      .filter((n) => Number.isFinite(n)),
  );
  let i = 0;
  while (taken.has(i)) i += 1;
  return i;
}

/** Backfill missing siteIndex from current array order (one-time for old saves). */
export function ensureRacketSites<T extends { siteIndex?: number }>(rackets: T[]): T[] {
  if (rackets.every((r) => typeof r.siteIndex === "number")) return rackets;
  const used = new Set<number>();
  return rackets.map((r, i) => {
    if (typeof r.siteIndex === "number" && !used.has(r.siteIndex)) {
      used.add(r.siteIndex);
      return r;
    }
    let slot = i;
    while (used.has(slot)) slot += 1;
    used.add(slot);
    return { ...r, siteIndex: slot };
  });
}

/**
 * Districts whose blocks share a side on the city grid. The same nearest-center
 * rule as `buildCityLayout`, so a border is two districts that actually touch.
 * Water is nobody's block and does not bridge a gap. Every border runs both ways.
 */
export function districtsThatTouch(
  territories: { id: string; x: number; y: number }[],
  dims: GridDims = NORMAL_DIMS,
): Map<string, string[]> {
  const gridW = dims.w;
  const gridH = dims.h;
  const width = gridW * (BLOCK_SIZE + ROAD_GAP);
  const depth = gridH * (BLOCK_SIZE + ROAD_GAP);
  const centers = territories.map((t) => ({
    id: t.id,
    worldX: (t.x / 100) * width - width / 2,
    worldZ: (t.y / 100) * depth - depth / 2,
  }));
  const owner: (string | null)[][] = Array.from({ length: gridH }, () =>
    Array<string | null>(gridW).fill(null),
  );
  for (let gz = 0; gz < gridH; gz++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (isWaterCell(gx, gz, gridW, gridH)) continue;
      const worldX = gx * (BLOCK_SIZE + ROAD_GAP) - width / 2 + BLOCK_SIZE / 2;
      const worldZ = gz * (BLOCK_SIZE + ROAD_GAP) - depth / 2 + BLOCK_SIZE / 2;
      let best = Infinity;
      let id: string | null = null;
      for (const c of centers) {
        const d = (c.worldX - worldX) ** 2 + (c.worldZ - worldZ) ** 2;
        if (d < best) {
          best = d;
          id = c.id;
        }
      }
      owner[gz]![gx] = id;
    }
  }
  const adj = new Map<string, Set<string>>(territories.map((t) => [t.id, new Set()]));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let gz = 0; gz < gridH; gz++) {
    for (let gx = 0; gx < gridW; gx++) {
      const a = owner[gz]![gx];
      if (!a) continue;
      for (const [dx, dz] of dirs) {
        const b = owner[gz + dz]?.[gx + dx];
        if (b && b !== a) adj.get(a)!.add(b);
      }
    }
  }
  return new Map([...adj].map(([id, set]) => [id, [...set].sort()]));
}

/** Building cells that share a side with water, counted per district. */
export function waterfrontScores(layout: CityLayout): Map<string, number> {
  const water = new Set<string>();
  for (const b of layout.blocks) {
    if (b.kind === "water") water.add(`${b.gx},${b.gz}`);
  }
  const scores = new Map<string, number>();
  for (const b of layout.blocks) {
    if (b.kind !== "building" || !b.territoryId) continue;
    const touch =
      water.has(`${b.gx - 1},${b.gz}`) ||
      water.has(`${b.gx + 1},${b.gz}`) ||
      water.has(`${b.gx},${b.gz - 1}`) ||
      water.has(`${b.gx},${b.gz + 1}`);
    if (!touch) continue;
    scores.set(b.territoryId, (scores.get(b.territoryId) ?? 0) + 1);
  }
  return scores;
}

/** Nearest road cell to a world position (for cinematic car pathing). */
export function nearestRoadBlock(
  layout: CityLayout,
  worldX: number,
  worldZ: number,
): CityBlock | null {
  let best: CityBlock | null = null;
  let bestD = Infinity;
  for (const b of layout.blocks) {
    if (b.kind !== "road") continue;
    const d = (b.worldX - worldX) ** 2 + (b.worldZ - worldZ) ** 2;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function blockKey(gx: number, gz: number): string {
  return `${gx}-${gz}`;
}
