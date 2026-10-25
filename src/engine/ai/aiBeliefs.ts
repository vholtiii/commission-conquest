import type { BlockBelief, FamilyName, GameState, Territory } from "@/types/game";
import { resolveCrewTerritoryId } from "../crewLocation";
import { dinnerActive } from "../dinner";
import { racketIncome } from "../economy";
import { isDefunct } from "../defection";
import { CREW_BELIEF_WEEKS, ensureMinds, mindOf, rivalFamilies, withMind } from "./minds";

/** A block sighting this old is no better than a guess. */
export const BLOCK_STALE_WEEKS = 8;
/** What a family assumes is on a block it has never watched. */
export const UNKNOWN_GARRISON = 1.5;
/** Cost of a week of a soldier watching someone else's block. */
export const SCOUT_COST = 150;

/** Men actually standing guard. A family dinner empties the player's blocks. */
export function liveGarrison(state: GameState, t: Territory): number {
  if (dinnerActive(state) && t.owner === state.playerFamily) return 0;
  const active = new Set(state.crew.filter((c) => c.status === "active").map((c) => c.id));
  return t.garrisonIds.filter((id) => active.has(id)).length;
}

function siteMap(state: GameState): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of state.crew) {
    if (c.status === "dead" || c.status === "jailed") continue;
    const tid = resolveCrewTerritoryId(state, c.id);
    if (tid) map.set(c.id, tid);
  }
  return map;
}

/** Blocks a family can see this week: its own, the ones next door, and wherever its men stand. */
export function watchedBlocks(state: GameState, family: FamilyName, sites = siteMap(state)): Set<string> {
  const seen = new Set<string>();
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    seen.add(t.id);
    for (const adj of t.adjacentTerritories) seen.add(adj);
  }
  for (const c of state.crew) {
    if (c.family !== family || c.status !== "active") continue;
    const tid = sites.get(c.id);
    if (tid) seen.add(tid);
  }
  return seen;
}

function observe(
  state: GameState,
  family: FamilyName,
  blocks: Iterable<string>,
  sites: Map<string, string>,
): GameState {
  const mind = mindOf(state, family);
  const beliefBlocks = { ...mind.beliefs.blocks };
  const beliefCrew = { ...mind.beliefs.crew };
  const ids = new Set(blocks);
  for (const id of ids) {
    const t = state.territories.find((x) => x.id === id);
    if (!t) continue;
    beliefBlocks[id] = { owner: t.owner, garrison: liveGarrison(state, t), seen: state.turn };
  }
  for (const c of state.crew) {
    if (c.family === family) continue;
    const tid = sites.get(c.id);
    if (tid && ids.has(tid)) beliefCrew[c.id] = { territoryId: tid, seen: state.turn };
  }
  return withMind(state, family, { ...mind, beliefs: { blocks: beliefBlocks, crew: beliefCrew } });
}

/** Every rival looks at what it can see, and forgets men it hasn't seen in weeks. */
export function updateBeliefs(state: GameState): GameState {
  let next = ensureMinds(state);
  const sites = siteMap(next);
  const dead = new Set(next.crew.filter((c) => c.status === "dead").map((c) => c.id));
  for (const family of rivalFamilies(next)) {
    if (isDefunct(next, family)) continue;
    next = observe(next, family, watchedBlocks(next, family, sites), sites);
    const mind = mindOf(next, family);
    const crew: typeof mind.beliefs.crew = {};
    for (const [id, b] of Object.entries(mind.beliefs.crew)) {
      if (dead.has(id) || next.turn - b.seen > CREW_BELIEF_WEEKS) continue;
      crew[id] = b;
    }
    next = withMind(next, family, { ...mind, beliefs: { ...mind.beliefs, crew } });
  }
  return next;
}

/** A soldier spends the week watching one block. Costs a little; the owner may notice. */
export function scoutBlock(state: GameState, family: FamilyName, territoryId: string): GameState {
  const scouted = observe(ensureMinds(state), family, [territoryId], siteMap(state));
  const mind = mindOf(scouted, family);
  return {
    ...withMind(scouted, family, { ...mind, stats: { ...mind.stats, scouts: mind.stats.scouts + 1 } }),
    rivalTreasury: {
      ...(scouted.rivalTreasury ?? {}),
      [family]: (scouted.rivalTreasury?.[family] ?? 0) - SCOUT_COST,
    },
  };
}

export function blockBelief(state: GameState, family: FamilyName, territoryId: string): BlockBelief | undefined {
  return mindOf(state, family).beliefs.blocks[territoryId];
}

/** Weeks since the family last had eyes on the block; Infinity if never. */
export function beliefAge(state: GameState, family: FamilyName, territoryId: string): number {
  const b = blockBelief(state, family, territoryId);
  return b ? state.turn - b.seen : Infinity;
}

/** The family's usual read of how heavily `owner` holds a block. */
function ownerPrior(state: GameState, family: FamilyName, owner: FamilyName | null): number {
  if (!owner) return 0;
  const blocks = mindOf(state, family).beliefs.blocks;
  let sum = 0;
  let n = 0;
  for (const b of Object.values(blocks)) {
    if (b.owner !== owner || state.turn - b.seen > BLOCK_STALE_WEEKS) continue;
    sum += b.garrison;
    n++;
  }
  return n > 0 ? sum / n : UNKNOWN_GARRISON;
}

/**
 * How many men the family thinks are guarding a block. Its own blocks it
 * knows. A fresh look is taken at face value; an old one blends toward the
 * family's usual read of the owner; a block it never watched is that read.
 */
export function believedGarrison(state: GameState, family: FamilyName, t: Territory): number {
  if (t.owner === family) return liveGarrison(state, t);
  if (!t.owner) return 0;
  const b = blockBelief(state, family, t.id);
  const prior = ownerPrior(state, family, t.owner);
  if (!b || b.owner !== t.owner) return prior;
  const age = state.turn - b.seen;
  if (age <= 1) return b.garrison;
  const w = Math.max(0, 1 - age / BLOCK_STALE_WEEKS);
  return b.garrison * w + prior * (1 - w);
}

/** How sure the family is of that number, 0..1. */
export function garrisonConfidence(state: GameState, family: FamilyName, t: Territory): number {
  if (t.owner === family || !t.owner) return 1;
  const b = blockBelief(state, family, t.id);
  if (!b || b.owner !== t.owner) return 0;
  return Math.max(0, 1 - (state.turn - b.seen) / BLOCK_STALE_WEEKS);
}

/** Where the family last saw a man, if recently enough to act on. */
export function believedCrewSite(
  state: GameState,
  family: FamilyName,
  crewId: string,
  maxWeeks = CREW_BELIEF_WEEKS,
): string | undefined {
  const b = mindOf(state, family).beliefs.crew[crewId];
  if (!b || state.turn - b.seen > maxWeeks) return undefined;
  return b.territoryId;
}

/** Rackets are signs over doors; anyone can count them. Treasuries are not. */
export function believedWealth(state: GameState, other: FamilyName): number {
  let income = 0;
  let blocks = 0;
  for (const t of state.territories) {
    if (t.owner !== other) continue;
    blocks++;
    for (const r of t.rackets) income += racketIncome(r);
  }
  return income * 6 + blocks * 500;
}

/** Men the family believes `other` can field: the ones it has seen, or a guess from turf. */
export function believedStrength(state: GameState, family: FamilyName, other: FamilyName): number {
  if (other === family) return state.crew.filter((c) => c.family === family && c.status === "active").length;
  const crew = mindOf(state, family).beliefs.crew;
  let seen = 0;
  for (const [id, b] of Object.entries(crew)) {
    if (state.turn - b.seen > CREW_BELIEF_WEEKS) continue;
    const c = state.crew.find((m) => m.id === id);
    if (c?.family === other) seen++;
  }
  const turf = state.territories.filter((t) => t.owner === other).length;
  return Math.max(seen, 3 + turf * 1.2);
}

/** A guess at the player's warehouse stock from the warehouses and stills anyone can see. */
export function estimatedWarehouseStock(state: GameState): number {
  const player = state.playerFamily;
  if (!player) return 0;
  let guess = 0;
  for (const t of state.territories) {
    if (t.owner !== player) continue;
    for (const r of t.rackets) {
      if (r.type === "warehouse") guess += 15;
      else if (r.type === "still" || r.type === "brewery") guess += 5;
    }
  }
  return guess;
}

/** Mean absolute gap between believed and real garrisons on watched-for enemy blocks, for the sim. */
export function beliefError(state: GameState, family: FamilyName): number {
  let sum = 0;
  let n = 0;
  for (const t of state.territories) {
    if (!t.owner || t.owner === family) continue;
    sum += Math.abs(believedGarrison(state, family, t) - liveGarrison(state, t));
    n++;
  }
  return n > 0 ? sum / n : 0;
}
