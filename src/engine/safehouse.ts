import type { CrewMember, FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import { safehouseLevel } from "./economy";
import { resolveCrewTerritoryId } from "./crewLocation";

/**
 * Lying low. A man on a block with a live safehouse can go inside: his wanted
 * count drops each week and a rival crew has to find him before they can hit
 * him. The price is that he's off the street — he doesn't guard the block,
 * run a racket, or (for the boss) lend the family his presence.
 */
export const SAFEHOUSE = {
  /** Wanted shed per week inside, on top of the safehouse level. */
  wantedBonus: 1,
  /** Hit odds a crew that found a man inside gives up, per level of the house. */
  hitPenaltyPerLevel: 0.12,
  hitPenaltyMax: 0.4,
  /** Chance the street gives away a boss laid low. Lower than a boss merely away from his HQ. */
  bossLeak: 0.15,
  /** Rivals send a man inside at this wanted count and let him out at zero. */
  rivalWantedIn: 3,
  /** Men inside return fire on a hit this many blocks away (0 = the block itself). */
  coverRange: 1,
  /** Each man inside counts as this many defenders in the firefight, by level: 0.75 / 1 / 1.25 … */
  coverBase: 0.5,
  coverPerLevel: 0.25,
  /** Getaway risk shaved per level, by how far the crew has to run: same block / next door / two over. */
  getawayPerLevel: [0.04, 0.025, 0.01] as readonly number[],
  getawayMax: 0.12,
  /** Police seizure odds shaved per level for a truck whose road passes the house / passes next to it. */
  seizurePerLevel: [0.2, 0.1] as readonly number[],
  seizureMax: 0.6,
  /** Block defence against capture, per level: a fortified door on the block. */
  captureDefPerLevel: 0.08,
} as const;

/** Multiplier on the block's capture defence from its safehouse. Lv1 ×1.08, Lv3 ×1.24. */
export function safehouseCaptureDefence(t: Pick<Territory, "rackets">, turn: number): number {
  return 1 + safehouseLevel(t, turn) * SAFEHOUSE.captureDefPerLevel;
}

type SafehouseState = Pick<GameState, "crew" | "territories" | "turn">;

/** How much a found man inside still costs the crew. Lv1 −12%, Lv2 −24%, Lv3 −36%, capped. */
export function safehouseHitPenalty(level: number): number {
  return Math.min(SAFEHOUSE.hitPenaltyMax, Math.max(0, level) * SAFEHOUSE.hitPenaltyPerLevel);
}

/** The house a laid-low man is in, and its level. */
export function laidLowHouse(
  state: Pick<GameState, "territories" | "turn">,
  m: Pick<CrewMember, "assignment" | "family">,
): { territory: Territory; level: number } | null {
  if (!isLaidLow(m) || !m.assignment.territoryId) return null;
  const t = state.territories.find((x) => x.id === m.assignment.territoryId);
  if (!t || t.owner !== m.family) return null;
  const level = safehouseLevel(t, state.turn);
  return level > 0 ? { territory: t, level } : null;
}

/** Hops between two blocks, up to `max`; anything farther returns max + 1. Adjacency only. */
export function blocksApart(
  territories: Pick<Territory, "id" | "adjacentTerritories">[],
  a: string,
  b: string,
  max: number,
): number {
  if (a === b) return 0;
  const byId = new Map(territories.map((t) => [t.id, t]));
  let frontier = [a];
  const seen = new Set(frontier);
  for (let d = 1; d <= max; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const adj of byId.get(id)?.adjacentTerritories ?? []) {
        if (adj === b) return d;
        if (!seen.has(adj)) {
          seen.add(adj);
          next.push(adj);
        }
      }
    }
    frontier = next;
  }
  return max + 1;
}

/** A family's live safehouses within `range` blocks of a spot, nearest first. */
export function safehousesNear(
  state: Pick<GameState, "territories" | "turn">,
  family: FamilyName,
  territoryId: string,
  range: number,
): { territory: Territory; level: number; hops: number }[] {
  const out: { territory: Territory; level: number; hops: number }[] = [];
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    const level = safehouseLevel(t, state.turn);
    if (level <= 0) continue;
    const hops = blocksApart(state.territories, territoryId, t.id, range);
    if (hops <= range) out.push({ territory: t, level, hops });
  }
  return out.sort((x, y) => x.hops - y.hops || y.level - x.level);
}

export interface CoverFire {
  /** Men inside, ready to shoot. */
  men: number;
  /** What they count for against the hit team, level-weighted. */
  weight: number;
  /** Where they're shooting from. */
  from: { territory: Territory; level: number; hops: number; men: number }[];
}

/**
 * Men laid low in a safehouse on the block or next door come out shooting
 * when their family is hit. They don't stop the hit — they're behind a door —
 * but they join the firefight after, and a better house gives them better
 * sightlines.
 */
export function coverFire(state: SafehouseState, family: FamilyName, territoryId: string): CoverFire {
  const from: CoverFire["from"] = [];
  let men = 0;
  let weight = 0;
  for (const house of safehousesNear(state, family, territoryId, SAFEHOUSE.coverRange)) {
    const inside = laidLowIn(state.crew, house.territory.id).filter(
      (c) => c.family === family && c.status === "active",
    ).length;
    if (inside === 0) continue;
    men += inside;
    weight += inside * (SAFEHOUSE.coverBase + SAFEHOUSE.coverPerLevel * house.level);
    from.push({ ...house, men: inside });
  }
  return { men, weight, from };
}

export interface GetawayCover {
  territory: Territory;
  level: number;
  hops: number;
  /** Getaway risk shaved. */
  bonus: number;
}

/**
 * A crew with a safehouse near the job has somewhere to run. The closer the
 * door and the better the house, the less the getaway costs them.
 */
export function getawayCover(
  state: Pick<GameState, "territories" | "turn">,
  family: FamilyName,
  territoryId: string,
): GetawayCover | null {
  const range = SAFEHOUSE.getawayPerLevel.length - 1;
  let best: GetawayCover | null = null;
  for (const house of safehousesNear(state, family, territoryId, range)) {
    const per = SAFEHOUSE.getawayPerLevel[house.hops] ?? 0;
    const bonus = Math.min(SAFEHOUSE.getawayMax, per * house.level);
    if (!best || bonus > best.bonus) best = { ...house, bonus };
  }
  return best;
}

export interface SeizureCover {
  territory: Territory;
  level: number;
  /** 0 = the truck passes the house; 1 = the house is one block off the road. */
  hops: number;
  /** Share of police seizures the truck ducks. */
  evasion: number;
}

/**
 * A truck rolling past a safehouse has a garage to duck into when the
 * checkpoint goes up. Best house along the road wins; on the road beats
 * next to it.
 */
export function seizureCover(
  state: Pick<GameState, "territories" | "turn">,
  family: FamilyName,
  path: readonly string[],
): SeizureCover | null {
  const range = SAFEHOUSE.seizurePerLevel.length - 1;
  let best: SeizureCover | null = null;
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    const level = safehouseLevel(t, state.turn);
    if (level <= 0) continue;
    let hops = range + 1;
    for (const stop of path) {
      hops = Math.min(hops, blocksApart(state.territories, stop, t.id, range));
      if (hops === 0) break;
    }
    if (hops > range) continue;
    const evasion = Math.min(SAFEHOUSE.seizureMax, (SAFEHOUSE.seizurePerLevel[hops] ?? 0) * level);
    if (!best || evasion > best.evasion) best = { territory: t, level, hops, evasion };
  }
  return best;
}

export function isLaidLow(m: Pick<CrewMember, "assignment">): boolean {
  return m.assignment.type === "safehouse";
}

/** Men inside the safehouse on this block. */
export function laidLowIn(crew: CrewMember[], territoryId: string): CrewMember[] {
  return crew.filter(
    (c) =>
      isLaidLow(c) &&
      c.assignment.territoryId === territoryId &&
      (c.status === "active" || c.status === "wounded"),
  );
}

/** Beds inside: one per safehouse level. */
export function safehouseCapacity(t: Pick<Territory, "rackets">, turn: number): number {
  return safehouseLevel(t, turn);
}

export function canLieLow(
  state: SafehouseState,
  member: CrewMember,
  territoryId: string,
): { ok: boolean; reason?: string } {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t || t.owner !== member.family) return { ok: false, reason: "Not your block." };
  const level = safehouseLevel(t, state.turn);
  if (level <= 0) return { ok: false, reason: "No safehouse on this block." };
  if (member.status !== "active" && member.status !== "wounded") {
    return { ok: false, reason: `He's ${member.status}.` };
  }
  if (member.awayAt && member.awayAt.untilTurn > state.turn) {
    return { ok: false, reason: "He's on the road this week." };
  }
  const a = member.assignment.type;
  if (a === "operation" || a === "surveillance" || a === "delivery") {
    return { ok: false, reason: "He's tied up on a job." };
  }
  if (isLaidLow(member) && member.assignment.territoryId === territoryId) {
    return { ok: false, reason: "He's already inside." };
  }
  const inside = laidLowIn(state.crew, territoryId).filter((c) => c.id !== member.id);
  if (inside.length >= level) {
    return { ok: false, reason: `The safehouse holds ${level}. It's full.` };
  }
  return { ok: true };
}

/**
 * End-of-week pass. Everyone inside sheds wanted; anyone whose safehouse is
 * gone is back on the street. Rivals manage their own: in at a few marks
 * against the name, out when the name is clean. The player's men stay put
 * until they're told otherwise.
 */
export function tickSafehouses(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  const turn = state.turn;
  const byId = new Map(state.territories.map((t) => [t.id, t]));
  const cooled: string[] = [];
  const clean: string[] = [];
  const turnedOut: string[] = [];
  const toGarrison = new Map<string, string>();

  let crew = state.crew.map((m) => {
    if (!isLaidLow(m)) return m;
    const home = m.assignment.territoryId ? byId.get(m.assignment.territoryId) : undefined;
    const level = home && home.owner === m.family ? safehouseLevel(home, turn) : 0;
    if (m.status !== "active" && m.status !== "wounded") {
      return { ...m, assignment: { type: "idle" as const } };
    }
    if (level <= 0 || !home) {
      if (m.family === player) turnedOut.push(m.name);
      if (home) toGarrison.set(m.id, home.id);
      return { ...m, assignment: home ? { type: "garrison" as const, territoryId: home.id } : { type: "idle" as const } };
    }
    const wanted = Math.max(0, m.wanted - level - SAFEHOUSE.wantedBonus);
    if (m.family === player) {
      if (wanted < m.wanted) cooled.push(m.name);
      if (wanted === 0 && m.wanted > 0) clean.push(m.name);
    }
    return { ...m, wanted };
  });

  // Rival housekeeping.
  const occupancy = new Map<string, number>();
  for (const c of crew) {
    if (isLaidLow(c) && c.assignment.territoryId) {
      occupancy.set(c.assignment.territoryId, (occupancy.get(c.assignment.territoryId) ?? 0) + 1);
    }
  }
  crew = crew.map((m) => {
    if (m.family === player || m.status !== "active") return m;
    if (isLaidLow(m)) {
      if (m.wanted > 0 || !m.assignment.territoryId) return m;
      toGarrison.set(m.id, m.assignment.territoryId);
      return { ...m, assignment: { type: "garrison" as const, territoryId: m.assignment.territoryId } };
    }
    if (m.wanted < SAFEHOUSE.rivalWantedIn) return m;
    if (m.assignment.type !== "idle" && m.assignment.type !== "garrison") return m;
    if (m.awayAt && m.awayAt.untilTurn > turn) return m;
    const hereId = resolveCrewTerritoryId(state, m.id);
    const here = hereId ? byId.get(hereId) : undefined;
    if (!here || here.owner !== m.family) return m;
    const level = safehouseLevel(here, turn);
    if (level <= 0 || (occupancy.get(here.id) ?? 0) >= level) return m;
    occupancy.set(here.id, (occupancy.get(here.id) ?? 0) + 1);
    return { ...m, assignment: { type: "safehouse" as const, territoryId: here.id } };
  });

  const insideIds = new Set(crew.filter(isLaidLow).map((c) => c.id));
  const territories = state.territories.map((t) => {
    let garrisonIds = t.garrisonIds.filter((id) => !insideIds.has(id));
    for (const [id, tid] of toGarrison) {
      if (tid === t.id && !garrisonIds.includes(id)) garrisonIds = [...garrisonIds, id];
    }
    return garrisonIds === t.garrisonIds ? t : { ...t, garrisonIds };
  });

  if (player) {
    if (cooled.length > 0) {
      logs.push({
        id: `log_safehouse_${turn}`,
        turn,
        category: "system",
        text: `${cooled.join(", ")} laid low — wanted dropped at the safehouse.`,
        family: player,
      });
    }
    if (clean.length > 0) {
      logs.push({
        id: `log_safehouse_clean_${turn}`,
        turn,
        category: "system",
        text: `${clean.join(", ")} ${clean.length === 1 ? "is" : "are"} off the blotter. Safe to come out.`,
        family: player,
      });
    }
    if (turnedOut.length > 0) {
      logs.push({
        id: `log_safehouse_lost_${turn}`,
        turn,
        category: "system",
        text: `${turnedOut.join(", ")} back on the street — the safehouse is gone.`,
        family: player,
      });
    }
  }

  return { state: { ...state, crew, territories }, logs };
}
