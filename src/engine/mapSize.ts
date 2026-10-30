/**
 * Which city a new game is played on. Normal is the map file. Small keeps the
 * central districts and a smaller grid. Large keeps every district, shifts
 * them into the middle of a bigger grid, and adds the outer towns.
 */
import type { FamilyName, GameSettings, Territory } from "@/types/game";
import territoriesRaw from "@/data/territories.json";
import extraTerritories from "@/data/extraTerritories.json";

export type MapSize = NonNullable<GameSettings["mapSize"]>;

export interface MapDims {
  w: number;
  h: number;
}

export interface MapDistrict {
  id: string;
  name: string;
  owner: FamilyName | null;
  baseIncome: number;
  defenseBonus: number;
  isStrategic: boolean;
  x: number;
  y: number;
  adjacentTerritories: string[];
  businessType: string | null;
  strategicBonus?: Territory["strategicBonus"];
  emptyLot?: boolean;
  borough?: string;
}

/** Central districts. Every borough stays, and the opening pool still has seats. */
const SMALL_IDS = new Set([
  "alphabet_city",
  "astoria",
  "bronx",
  "brooklyn",
  "bushwick",
  "chinatown",
  "concourse",
  "coney_island",
  "crown_heights",
  "downtown_brooklyn",
  "east_village",
  "financial_district",
  "flatbush",
  "fordham",
  "hoboken",
  "hunts_point",
  "inwood",
  "little_italy",
  "long_island_city",
  "lower_east_side",
  "manhattan",
  "newark",
  "park_slope",
  "prospect_heights",
  "queens",
  "soho",
  "south_bronx",
  "st_george",
  "tremont",
  "tribeca",
  "washington_heights",
  "west_village",
  "williamsburg",
  "woodside",
  "yankee_stadium",
  "yonkers",
]);

/** Rivers take the rim, so a center at 0 or 100 would own no blocks. */
const SMALL_INSET = 10;

/** 56/48 and 42/36 are both 6/7, so one shift fits the old city into the large grid. */
const LARGE_SCALE = 6 / 7;
const LARGE_MARGIN = 100 / 14;

export function mapSizeOf(size: MapSize | undefined): MapSize {
  return size === "small" || size === "large" ? size : "normal";
}

export function mapDims(size: MapSize | undefined): MapDims {
  switch (mapSizeOf(size)) {
    case "small":
      return { w: 38, h: 28 };
    case "large":
      return { w: 56, h: 42 };
    default:
      return { w: 48, h: 36 };
  }
}

export function mapSizeLabel(size: MapSize | undefined): string {
  switch (mapSizeOf(size)) {
    case "small":
      return "Small";
    case "large":
      return "Large";
    default:
      return "Normal";
  }
}

function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

function remapSmall(list: MapDistrict[]): MapDistrict[] {
  const xs = list.map((d) => d.x);
  const ys = list.map((d) => d.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const room = 100 - SMALL_INSET * 2;
  return list.map((d) => ({
    ...d,
    x: roundCoord(SMALL_INSET + ((d.x - minX) / spanX) * room),
    y: roundCoord(SMALL_INSET + ((d.y - minY) / spanY) * room),
  }));
}

function shiftLarge(d: MapDistrict): MapDistrict {
  return {
    ...d,
    x: roundCoord(d.x * LARGE_SCALE + LARGE_MARGIN),
    y: roundCoord(d.y * LARGE_SCALE + LARGE_MARGIN),
  };
}

/** District records for a size, already in that map's 0–100 frame. */
export function rawTerritoriesFor(size: MapSize | undefined): MapDistrict[] {
  const file = territoriesRaw as MapDistrict[];
  switch (mapSizeOf(size)) {
    case "small":
      return remapSmall(file.filter((d) => SMALL_IDS.has(d.id)));
    case "large":
      return [...file.map(shiftLarge), ...(extraTerritories as MapDistrict[])];
    default:
      return file;
  }
}

export function districtCount(size: MapSize): number {
  return rawTerritoriesFor(size).length;
}
