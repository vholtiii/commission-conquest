import type { Territory } from "@/types/game";
import { createRng, hashString } from "./rng";

export const GRID_W = 48;
export const GRID_H = 36;
export const BLOCK_SIZE = 2.2;
export const ROAD_GAP = 0.55;

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
}

function isWaterCell(gx: number, gz: number): boolean {
  // Hudson (west), East River (east corridor), harbor south
  if (gx <= 2) return true;
  if (gx >= GRID_W - 3 && gz > 8 && gz < GRID_H - 6) return true;
  if (gz >= GRID_H - 3 && gx > 8 && gx < GRID_W - 8) return true;
  // Central park-ish water / harbor bite
  if (gx > 20 && gx < 26 && gz > GRID_H - 5) return true;
  return false;
}

function isRoadCell(gx: number, gz: number): boolean {
  return gx % 4 === 0 || gz % 4 === 0;
}

function isParkCell(gx: number, gz: number): boolean {
  // Central Park-ish + small greens
  if (gx >= 18 && gx <= 24 && gz >= 12 && gz <= 20 && !isRoadCell(gx, gz)) return true;
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

export function buildCityLayout(territories: Territory[], seed = 42): CityLayout {
  const rng = createRng(seed);
  const width = GRID_W * (BLOCK_SIZE + ROAD_GAP);
  const depth = GRID_H * (BLOCK_SIZE + ROAD_GAP);

  const centers: DistrictCenter[] = territories.map((t) => {
    const worldX = (t.x / 100) * width - width / 2;
    const worldZ = (t.y / 100) * depth - depth / 2;
    return { territoryId: t.id, worldX, worldZ, name: t.name };
  });

  const byId = new Map(territories.map((t) => [t.id, t]));

  const blocks: CityBlock[] = [];
  for (let gz = 0; gz < GRID_H; gz++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const worldX = gx * (BLOCK_SIZE + ROAD_GAP) - width / 2 + BLOCK_SIZE / 2;
      const worldZ = gz * (BLOCK_SIZE + ROAD_GAP) - depth / 2 + BLOCK_SIZE / 2;

      let kind: CellKind = "building";
      if (isWaterCell(gx, gz)) kind = "water";
      else if (isRoadCell(gx, gz)) kind = "road";
      else if (isParkCell(gx, gz)) kind = "park";

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

  return { blocks, centers, width, depth };
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
