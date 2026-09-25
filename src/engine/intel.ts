import type {
  CrewMember,
  FamilyName,
  GameState,
  IntelSource,
  IntelState,
} from "@/types/game";
import {
  crewPresentIn,
  familyHq,
  resolveCrewTerritoryId,
  type LocationState,
} from "./crewLocation";

export { familyHq } from "./crewLocation";

export function emptyIntel(): IntelState {
  return {
    known: {},
    districtReveal: {},
    familyReveal: {},
    reports: {},
    clues: {},
    business: {},
    alerted: {},
    burned: {},
  };
}

/** Fill in fields missing from older saves / partial literals. */
export function normalizeIntel(intel?: Partial<IntelState> | null): IntelState {
  return { ...emptyIntel(), ...(intel ?? {}) };
}

type VisibilityState = Pick<
  GameState,
  "crew" | "territories" | "routes" | "operations" | "playerFamily" | "intel" | "turn"
>;

/**
 * Whether you can put a face to a rival: your own crew always, a rival only
 * with real intel — a lookout's report, a hit, a bribe, or an active district
 * / family reveal. A street sighting ("was seen in…") is enough to know where
 * his car is, not who's in it; see `isBossCarVisible`.
 */
export function isCrewVisible(state: VisibilityState, crew: CrewMember): boolean {
  if (crew.status === "dead" || crew.status === "jailed") return false;
  if (crew.family === state.playerFamily) return true;

  const territoryId = resolveCrewTerritoryId(state, crew.id);
  if (!territoryId) return false;

  const intel = state.intel ?? emptyIntel();
  const known = intel.known[crew.id];
  if (known && known.territoryId === territoryId && known.source !== "sighting") return true;

  if ((intel.districtReveal[territoryId] ?? 0) > state.turn) return true;
  if ((intel.familyReveal[crew.family] ?? 0) > state.turn) return true;

  return false;
}

/**
 * The boss's black sedan is a public tell even when the man himself isn't:
 * everyone knows where a family's headquarters is and whose car is parked out
 * front, and the street talks when it's seen somewhere else.
 */
export function isBossCarVisible(state: VisibilityState, boss: CrewMember): boolean {
  if (boss.role !== "boss") return false;
  if (isCrewVisible(state, boss)) return true;
  if (boss.status === "dead" || boss.status === "jailed") return false;

  const territoryId = resolveCrewTerritoryId(state, boss.id);
  if (!territoryId) return false;

  const hq = familyHq(state, boss.family);
  if (hq && hq === territoryId) return true;

  const known = (state.intel ?? emptyIntel()).known[boss.id];
  return !!known && known.territoryId === territoryId;
}

export function visibleCrewIn(state: VisibilityState, territoryId: string): CrewMember[] {
  return crewPresentIn(state, territoryId).filter((c) => isCrewVisible(state, c));
}

export function hiddenCountIn(state: VisibilityState, territoryId: string): number {
  const present = crewPresentIn(state, territoryId);
  return present.filter((c) => !isCrewVisible(state, c)).length;
}

export function recordIntel(
  state: GameState,
  crewIds: string[],
  territoryId: string,
  source: IntelSource,
): GameState {
  if (crewIds.length === 0) return state;
  const known = { ...(state.intel?.known ?? {}) };
  for (const id of crewIds) {
    const c = state.crew.find((m) => m.id === id);
    if (!c || c.family === state.playerFamily) continue;
    if (c.status !== "active" && c.status !== "wounded") continue;
    known[id] = { territoryId, turn: state.turn, source };
  }
  return {
    ...state,
    intel: {
      ...(state.intel ?? emptyIntel()),
      known,
    },
  };
}

/** Drop intel entries whose crew moved, died, or vanished. */
export function pruneIntel(state: GameState): GameState {
  const intel = state.intel ?? emptyIntel();
  const known: IntelState["known"] = {};
  for (const [crewId, entry] of Object.entries(intel.known)) {
    const c = state.crew.find((m) => m.id === crewId);
    if (!c || c.status === "dead" || c.status === "jailed") continue;
    const loc = resolveCrewTerritoryId(state, crewId);
    if (loc !== entry.territoryId) continue;
    known[crewId] = entry;
  }

  const districtReveal: Record<string, number> = {};
  for (const [tid, exp] of Object.entries(intel.districtReveal)) {
    if (exp > state.turn) districtReveal[tid] = exp;
  }
  const familyReveal: IntelState["familyReveal"] = {};
  for (const [fam, exp] of Object.entries(intel.familyReveal)) {
    if (exp !== undefined && exp > state.turn) {
      familyReveal[fam as FamilyName] = exp;
    }
  }

  // Casing residue: clues expire on their own clock, alerts and burned faces fade.
  const clues: IntelState["clues"] = {};
  for (const [tid, list] of Object.entries(intel.clues ?? {})) {
    const live = (list ?? []).filter((c) => c.expiresTurn > state.turn);
    if (live.length > 0) clues[tid] = live;
  }
  const alerted: IntelState["alerted"] = {};
  for (const [tid, exp] of Object.entries(intel.alerted ?? {})) {
    if (exp > state.turn) alerted[tid] = exp;
  }
  const burned: IntelState["burned"] = {};
  for (const [crewId, b] of Object.entries(intel.burned ?? {})) {
    const c = state.crew.find((m) => m.id === crewId);
    if (!c || c.status === "dead") continue;
    if (b.expiresTurn > state.turn) burned[crewId] = b;
  }

  return {
    ...state,
    intel: {
      ...intel,
      known,
      districtReveal,
      familyReveal,
      reports: intel.reports ?? {},
      clues,
      alerted,
      burned,
    },
  };
}

export function hasActiveIntel(state: VisibilityState, territoryId: string): boolean {
  const intel = state.intel ?? emptyIntel();
  if ((intel.districtReveal[territoryId] ?? 0) > state.turn) return true;
  const present = crewPresentIn(state as LocationState, territoryId);
  return present.some((c) => {
    if (c.family === state.playerFamily) return false;
    const k = intel.known[c.id];
    return !!k && k.territoryId === territoryId;
  });
}

/** True when any present rival was spotted by surveillance within maxAge turns. */
export function hasFreshCasing(
  state: VisibilityState,
  territoryId: string,
  maxAge = 2,
): boolean {
  const intel = state.intel ?? emptyIntel();
  const present = crewPresentIn(state as LocationState, territoryId);
  return present.some((c) => {
    if (c.family === state.playerFamily) return false;
    const k = intel.known[c.id];
    if (!k || k.territoryId !== territoryId) return false;
    if (k.source !== "surveillance") return false;
    return k.turn >= state.turn - maxAge;
  });
}

export function rivalCrewInDistrict(
  state: VisibilityState,
  territoryId: string,
  rivalFamily: FamilyName,
): CrewMember[] {
  return crewPresentIn(state, territoryId).filter((c) => c.family === rivalFamily);
}
