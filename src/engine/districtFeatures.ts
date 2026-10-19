/**
 * What a block is good for. Docks sit on the water and move with the city
 * seed. The rest follow the borough. A racket earns more when the block
 * suits it, and a little more when the right neighbour is on the same block.
 */
import type { RacketType, Territory } from "@/types/game";
import { getCityLayout, waterfrontScores } from "./cityLayout";

export type DistrictFeature = "docks" | "downtown" | "industrial" | "residential";

export const FEATURE_LABEL: Record<DistrictFeature, string> = {
  docks: "Docks",
  downtown: "Downtown",
  industrial: "Industrial",
  residential: "Residential",
};

export const FEATURE_BLURB: Record<DistrictFeature, string> = {
  docks: "Docks: trucking +25%, warehouses land extra crates",
  downtown: "Downtown: gambling and loan sharking +20%",
  industrial: "Industrial: stills and breweries cook +25%",
  residential: "Residential: fronts earn +20% and wash more",
};

const VICE = new Set<RacketType>(["speakeasy", "gambling", "brothel", "loan_shark"]);
const INDUSTRIAL_IDS = new Set(["long_island_city", "hunts_point", "port_morris"]);

export interface PlacementBonus {
  /** Multiplier on the racket's cash take. */
  mult: number;
  reasons: string[];
  /** Extra fraction on a front's wash cap. 1 means no change. */
  launderMult: number;
  /** A speakeasy on the block: warehouse crates skip pilferage. */
  noShrink: boolean;
}

function boroughFeature(t: Pick<Territory, "id" | "borough" | "isStrategic" | "emptyLot">): DistrictFeature {
  if (t.borough === "Bronx" || INDUSTRIAL_IDS.has(t.id)) return "industrial";
  if ((t.borough === "Manhattan" && !t.emptyLot) || t.isStrategic) return "downtown";
  if (t.borough === "Brooklyn" || t.borough === "Queens") return "residential";
  if (t.borough === "Manhattan") return "downtown";
  return "residential";
}

/** Stamp every district. The 6 or 7 most water-facing blocks become docks; the seed picks which count. */
export function stampDistrictFeatures(territories: Territory[], seed: number): Territory[] {
  const scores = waterfrontScores(getCityLayout(territories, seed));
  const ranked = [...scores.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const count = 6 + (Math.abs(seed) % 2);
  const docks = new Set(ranked.slice(0, count).map(([id]) => id));
  return territories.map((t) => ({
    ...t,
    feature: docks.has(t.id) ? "docks" : boroughFeature(t),
  }));
}

export function placementBonus(
  territory: Pick<Territory, "feature">,
  racket: { type: RacketType },
  siblings: { type: RacketType }[],
): PlacementBonus {
  const rest = siblings.filter((s) => s !== racket);
  const has = (type: RacketType) => rest.some((s) => s.type === type);
  const reasons: string[] = [];
  let mult = 1;
  const feature = territory.feature;

  if (feature === "docks" && racket.type === "trucking") {
    mult *= 1.25;
    reasons.push("+25% docks");
  }
  if (feature === "docks" && racket.type === "warehouse") {
    reasons.push("docks land extra crates");
  }
  if (feature === "downtown" && (racket.type === "gambling" || racket.type === "loan_shark")) {
    mult *= 1.2;
    reasons.push("+20% downtown");
  }
  if (feature === "industrial" && (racket.type === "still" || racket.type === "brewery")) {
    reasons.push("+25% industrial");
  }
  if (
    feature === "residential" &&
    (racket.type === "deli" || racket.type === "barber" || racket.type === "restaurant")
  ) {
    mult *= 1.2;
    reasons.push("+20% residential");
  }

  let paired = false;
  const pair = (withType: RacketType, label: string) => {
    if (paired || !has(withType)) return;
    mult *= 1.15;
    reasons.push(`+15% with ${label}`);
    paired = true;
  };
  if (racket.type === "speakeasy") pair("gambling", "Gambling");
  if (racket.type === "gambling") pair("speakeasy", "Speakeasy");
  if (racket.type === "speakeasy") pair("warehouse", "Warehouse");
  if (racket.type === "warehouse") pair("speakeasy", "Speakeasy");
  if (racket.type === "brothel") pair("speakeasy", "Speakeasy");
  if (racket.type === "speakeasy") pair("brothel", "Brothel");

  let launderMult = 1;
  if (
    feature === "residential" &&
    (racket.type === "deli" || racket.type === "barber" || racket.type === "restaurant")
  ) {
    launderMult *= 1.2;
  }
  if ((racket.type === "laundromat" || racket.type === "restaurant") && rest.some((s) => VICE.has(s.type))) {
    launderMult *= 1.2;
    reasons.push("+20% wash");
  }

  return {
    mult,
    reasons,
    launderMult,
    noShrink: racket.type === "warehouse" && has("speakeasy"),
  };
}

/** +1 crate on a route that starts at a docks block with a trucking company. */
export function dockHaul(territory: Pick<Territory, "feature" | "rackets"> | undefined): number {
  if (!territory || territory.feature !== "docks") return 0;
  return territory.rackets.some((r) => r.type === "trucking") ? 1 : 0;
}
