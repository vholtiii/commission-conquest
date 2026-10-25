import type { FamilyMind, FamilyName, GameState } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";

/** Memories kept per family; the least salient fall out first. */
export const MEMORY_CAP = 40;
/** Weeks a sighting of a man stays useful. */
export const CREW_BELIEF_WEEKS = 8;

export function emptyMind(): FamilyMind {
  return {
    goal: null,
    memories: [],
    beliefs: { blocks: {}, crew: {} },
    trust: {},
    adapt: { weakHits: [], minBorder: 0, playerHits: [] },
    stats: { goalSwitches: 0, plansDone: 0, plansAbandoned: 0, scouts: 0 },
  };
}

/** A saved mind from an older build, filled out to the current shape. */
export function normalizeMind(saved: Partial<FamilyMind> | undefined): FamilyMind {
  const base = emptyMind();
  if (!saved) return base;
  return {
    goal: saved.goal ?? null,
    memories: Array.isArray(saved.memories) ? saved.memories : [],
    beliefs: {
      blocks: saved.beliefs?.blocks ?? {},
      crew: saved.beliefs?.crew ?? {},
    },
    trust: saved.trust ?? {},
    adapt: { ...base.adapt, ...(saved.adapt ?? {}) },
    stats: { ...base.stats, ...(saved.stats ?? {}) },
  };
}

export function rivalFamilies(state: Pick<GameState, "playerFamily">): FamilyName[] {
  return ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
}

/** Every rival has a mind. Older saves and fresh games get empty ones. */
export function ensureMinds(state: GameState): GameState {
  const minds = state.aiMinds ?? {};
  let changed = !state.aiMinds;
  const next: Partial<Record<FamilyName, FamilyMind>> = { ...minds };
  for (const f of rivalFamilies(state)) {
    if (!next[f]) {
      next[f] = emptyMind();
      changed = true;
    }
  }
  return changed ? { ...state, aiMinds: next } : state;
}

export function mindOf(state: GameState, family: FamilyName): FamilyMind {
  return state.aiMinds?.[family] ?? emptyMind();
}

export function withMind(state: GameState, family: FamilyName, mind: FamilyMind): GameState {
  return { ...state, aiMinds: { ...(state.aiMinds ?? {}), [family]: mind } };
}

export function migrateMinds(
  saved: Partial<Record<FamilyName, Partial<FamilyMind>>> | undefined,
): Partial<Record<FamilyName, FamilyMind>> | undefined {
  if (!saved) return undefined;
  const out: Partial<Record<FamilyName, FamilyMind>> = {};
  for (const [f, m] of Object.entries(saved) as [FamilyName, Partial<FamilyMind>][]) {
    out[f] = normalizeMind(m);
  }
  return out;
}

export function brainOn(state: Pick<GameState, "settings">): boolean {
  return (state.settings.aiBrain ?? "brain") === "brain";
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
