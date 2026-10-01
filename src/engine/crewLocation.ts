import type { CrewMember, FamilyName, GameState } from "@/types/game";
import { getFamilyDef } from "@/data/families";

export type LocationState = Pick<
  GameState,
  "crew" | "territories" | "routes" | "operations" | "playerFamily"
> & { turn?: number };

type HqState = Pick<GameState, "territories">;

/** Family headquarters: starting borough if still owned, else strategic, else first owned. */
export function familyHq(state: HqState, family: FamilyName): string | null {
  const def = getFamilyDef(family);
  const startId = def.startingTerritory;
  const byBorough = state.territories.find(
    (t) => t.owner === family && t.borough.toLowerCase().includes(startId.toLowerCase()),
  );
  if (byBorough) return byBorough.id;

  const strategic = state.territories.find((t) => t.owner === family && t.isStrategic);
  if (strategic) return strategic.id;

  const first = state.territories.find((t) => t.owner === family);
  return first?.id ?? null;
}

export type CrewLocationReason =
  | "garrisoned"
  | "laid_low"
  | "running_racket"
  | "on_delivery"
  | "casing_target"
  | "on_hit"
  | "at_sitdown"
  | "visiting"
  | "at_home"
  | "unknown";

export interface CrewLocation {
  territoryId: string | null;
  reason: CrewLocationReason;
}

export const LOCATION_REASON_LABEL: Record<CrewLocationReason, string> = {
  garrisoned: "Garrisoned here",
  laid_low: "Laid low in the safehouse here",
  running_racket: "Running a racket here",
  on_delivery: "Out on a delivery",
  casing_target: "Casing the mark",
  on_hit: "Staged for a hit",
  at_sitdown: "At a sit-down",
  visiting: "Visiting a district",
  at_home: "At home base",
  unknown: "Location unknown",
};

/** Where a crew member is on the map, plus why they're there. */
export function resolveCrewLocation(state: LocationState, crewId: string): CrewLocation {
  const member = state.crew.find((c) => c.id === crewId);
  if (!member) return { territoryId: null, reason: "unknown" };

  // A scheduled trip overrides everything else for its duration.
  if (member.awayAt && member.awayAt.untilTurn > (state.turn ?? 0)) {
    return {
      territoryId: member.awayAt.territoryId,
      reason: member.awayAt.reason === "sitdown" ? "at_sitdown" : "visiting",
    };
  }

  const a = member.assignment;

  if (a.type === "operation" || a.type === "surveillance") {
    if (a.operationId) {
      const op = state.operations.find((o) => o.id === a.operationId);
      if (op) {
        return {
          territoryId: op.targetTerritoryId,
          reason: a.type === "surveillance" ? "casing_target" : "on_hit",
        };
      }
    }
    if (a.territoryId) {
      return {
        territoryId: a.territoryId,
        reason: a.type === "surveillance" ? "casing_target" : "on_hit",
      };
    }
  }

  if (a.type === "delivery" && a.routeId) {
    const route = state.routes.find((r) => r.id === a.routeId);
    if (route) {
      return { territoryId: route.path[0] ?? route.sourceTerritoryId, reason: "on_delivery" };
    }
  }

  if (a.type === "racket" && a.territoryId) {
    return { territoryId: a.territoryId, reason: "running_racket" };
  }

  if (a.type === "garrison" && a.territoryId) {
    return { territoryId: a.territoryId, reason: "garrisoned" };
  }

  if (a.type === "safehouse" && a.territoryId) {
    return { territoryId: a.territoryId, reason: "laid_low" };
  }

  if (a.territoryId) return { territoryId: a.territoryId, reason: "garrisoned" };

  const garrisoned = state.territories.find((t) => t.garrisonIds.includes(crewId));
  if (garrisoned) return { territoryId: garrisoned.id, reason: "garrisoned" };

  // Boss / idle default to family HQ
  const hq = familyHq(state, member.family);
  if (hq) return { territoryId: hq, reason: "at_home" };

  const familyHome = state.territories.find((t) => t.owner === member.family);
  return { territoryId: familyHome?.id ?? null, reason: familyHome ? "at_home" : "unknown" };
}

/** Find where a crew member currently is on the map. */
export function resolveCrewTerritoryId(state: LocationState, crewId: string): string | null {
  return resolveCrewLocation(state, crewId).territoryId;
}

/**
 * A boss is "underground" when he is holding court somewhere other than the
 * family HQ and not on a public trip (sit-down, weekly visit). Everyone knows
 * the HQ address; a rival planning a hit has to find him anywhere else.
 */
export function isBossUnderground(state: LocationState, boss: CrewMember): boolean {
  if (boss.role !== "boss" || boss.status !== "active") return false;
  if (boss.awayAt && boss.awayAt.untilTurn > (state.turn ?? 0)) return false;
  const here = resolveCrewTerritoryId(state, boss.id);
  if (!here) return false;
  const hq = familyHq(state, boss.family);
  return !!hq && here !== hq;
}

/**
 * Rival/player crew considered present in a district:
 * garrison list, explicit assignment territory, or resolved map location
 * (covers idle bosses at their stronghold).
 */
export function crewPresentIn(state: LocationState, territoryId: string): CrewMember[] {
  const territory = state.territories.find((t) => t.id === territoryId);
  if (!territory) return [];

  return state.crew.filter((c) => {
    if (c.status !== "active") return false;
    if (territory.garrisonIds.includes(c.id)) return true;
    if (c.assignment.territoryId === territoryId) return true;
    return resolveCrewTerritoryId(state, c.id) === territoryId;
  });
}

export function rivalTargetsInDistrict(
  state: LocationState,
  territoryId: string,
  rivalFamily: string,
): CrewMember[] {
  return crewPresentIn(state, territoryId).filter((c) => c.family === rivalFamily);
}
