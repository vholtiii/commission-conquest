import type { FamilyName, RacketType, Territory } from "@/types/game";
import { buildCityLayout, getDistrictBlocks, type CityLayout } from "./cityLayout";
import { MAX_RACKETS_PER_DISTRICT } from "./economy";

export type LotTier = "empty" | "sparse" | "built";

export const ALL_RACKET_TYPES: RacketType[] = [
  "still",
  "brewery",
  "warehouse",
  "speakeasy",
  "gambling",
  "brothel",
  "loan_shark",
  "laundromat",
  "deli",
  "barber",
  "restaurant",
  "trucking",
  "safehouse",
];

/** Hideouts that fit a lot with no street frontage. */
export const EMPTY_LOT_TYPES: RacketType[] = ["still", "warehouse", "safehouse"];

/** Small storefronts. No nightlife. */
export const SPARSE_LOT_TYPES: RacketType[] = [
  ...EMPTY_LOT_TYPES,
  "loan_shark",
  "deli",
  "trucking",
];

/** Building blocks per racket slot. Tuned so median districts land on ~3 slots. */
export const SLOT_BLOCK_DIVISOR = 3;

export const MIN_RACKET_SLOTS = 2;
export const MAX_RACKET_SLOTS = 6;
/** An empty lot has no frontage but plenty of ground: three hideout spots. */
export const EMPTY_LOT_SLOTS = 3;

export function buildingBlocksFor(layout: CityLayout, territoryId: string): number {
  return getDistrictBlocks(layout, territoryId).length;
}

export function slotsFromBlocks(count: number): number {
  if (count <= 0) return EMPTY_LOT_SLOTS;
  if (count <= 2) return 2;
  const raw = Math.round(count / SLOT_BLOCK_DIVISOR);
  return Math.max(MIN_RACKET_SLOTS, Math.min(MAX_RACKET_SLOTS, raw));
}

export function lotTier(t: Pick<Territory, "buildingBlocks">): LotTier {
  const blocks = t.buildingBlocks ?? 0;
  if (blocks <= 0) return "empty";
  if (blocks <= 2) return "sparse";
  return "built";
}

export function allowedRacketTypes(t: Pick<Territory, "buildingBlocks">): RacketType[] {
  const tier = lotTier(t);
  if (tier === "empty") return EMPTY_LOT_TYPES;
  if (tier === "sparse") return SPARSE_LOT_TYPES;
  return ALL_RACKET_TYPES;
}

export function lotTierLabel(tier: LotTier): string {
  if (tier === "empty") return "Empty lot";
  if (tier === "sparse") return "Sparse lot";
  return "";
}

export function lotTierHint(tier: LotTier): string {
  if (tier === "empty") {
    return "Empty lot — only a still, warehouse, or safehouse can be hidden here.";
  }
  if (tier === "sparse") {
    return "Sparse lot — still, warehouse, safehouse, loan shark, deli, or trucking.";
  }
  return "";
}

export function maxRacketsFor(t: Pick<Territory, "racketSlots">): number {
  return t.racketSlots ?? MAX_RACKETS_PER_DISTRICT;
}

export function valueScore(
  t: Pick<Territory, "racketSlots" | "baseIncome" | "strategicBonus">,
): number {
  const slots = maxRacketsFor(t);
  const strategic =
    t.strategicBonus?.type === "income" ? t.strategicBonus.value : 0;
  return slots * 200 + t.baseIncome + strategic;
}

/**
 * A block with rackets and nobody standing on it.
 * `activeIds` is every crew member on his feet. An active garrison man or an
 * active racket manager means the block is not empty. Omit the set and any
 * listed id counts.
 */
export function isUnguarded(
  t: Pick<Territory, "owner" | "rackets" | "garrisonIds">,
  activeIds?: Set<string>,
): boolean {
  if (!t.owner || t.rackets.length === 0) return false;
  const standing = (id: string | null | undefined) => !!id && (!activeIds || activeIds.has(id));
  if (t.garrisonIds.some((id) => standing(id))) return false;
  if (t.rackets.some((r) => standing(r.managerId))) return false;
  return true;
}

/** Crew who are on their feet. Pass this to `isUnguarded`. */
export function activeCrewIds(crew: { id: string; status: string }[]): Set<string> {
  return new Set(crew.filter((c) => c.status === "active").map((c) => c.id));
}

/** Fill buildingBlocks + racketSlots from the city layout (deterministic for seed). */
export function computeTerritorySlots(
  territories: Territory[],
  seed: number,
): Territory[] {
  const layout = buildCityLayout(territories, seed);
  return territories.map((t) => {
    const buildingBlocks = buildingBlocksFor(layout, t.id);
    return {
      ...t,
      buildingBlocks,
      racketSlots: slotsFromBlocks(buildingBlocks),
    };
  });
}

/** Backfill slots on older saves that lack the fields (or still have 1-slot empty lots). */
export function ensureTerritorySlots(
  territories: Territory[],
  seed: number,
): Territory[] {
  if (
    territories.length > 0 &&
    territories.every(
      (t) =>
        typeof t.buildingBlocks === "number" &&
        typeof t.racketSlots === "number" &&
        t.racketSlots >= 1 &&
        (t.buildingBlocks > 0 || t.racketSlots >= EMPTY_LOT_SLOTS),
    )
  ) {
    return territories;
  }
  return computeTerritorySlots(territories, seed);
}

export function activeGarrisonSet(
  state: { crew: { id: string; status: string; family: FamilyName }[]; territories: Territory[] },
  family?: FamilyName | null,
): Set<string> {
  const ids = new Set<string>();
  for (const t of state.territories) {
    if (family && t.owner !== family) continue;
    for (const id of t.garrisonIds) {
      const c = state.crew.find((m) => m.id === id);
      if (c && c.status === "active") ids.add(id);
    }
  }
  return ids;
}
