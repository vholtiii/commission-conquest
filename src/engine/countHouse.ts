/**
 * Dirty cash above a safe pile sits on a block. That block can be raided.
 * Rivals keep the same pile at their HQ. The block does not change hands.
 */
import type { FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { familyHq } from "./crewLocation";
import { captureOdds, captureStrength } from "./capture";
import { territoryHops } from "./territoryHops";
import { atPeace, inTruce } from "./deals";
import { breakPact, hasPact } from "./diplomacy";
import { setRelationDelta } from "./relations";
import { bribedHeat } from "./heat";
import { raiseWanted } from "./crew";
import { bumpRivalHeat } from "./rivalHeat";

export const COUNT_HOUSE_SAFE = 10_000;
export const RAID_SHARE = 0.35;
export const RAID_COOLDOWN = 4;
export const TIP_SHARE = 0.2;
export const RAID_HEAT = 10;
export const RAID_RELATION = -30;

export function exposedCash(state: GameState, family: FamilyName): number {
  if (family === state.playerFamily) return Math.max(0, state.dirtyMoney - COUNT_HOUSE_SAFE);
  return Math.max(0, (state.rivalTreasury?.[family] ?? 0) - COUNT_HOUSE_SAFE);
}

export function countHouseBlock(state: GameState, family: FamilyName): Territory | undefined {
  if (family === state.playerFamily && state.countHouseId) {
    const chosen = state.territories.find((t) => t.id === state.countHouseId && t.owner === family);
    if (chosen) return chosen;
  }
  const hq = familyHq(state, family);
  return (
    state.territories.find((t) => t.id === hq && t.owner === family) ??
    state.territories.find((t) => t.owner === family)
  );
}

export function moveCountHouse(state: GameState, territoryId: string): { state: GameState; error?: string } {
  const player = state.playerFamily;
  const block = state.territories.find((t) => t.id === territoryId);
  if (!player || !block || block.owner !== player) return { state, error: "Not your block." };
  if (state.countHouseMovedTurn === state.turn) return { state, error: "The count house moved once this week." };
  return { state: { ...state, countHouseId: territoryId, countHouseMovedTurn: state.turn } };
}

function hasReport(state: GameState, territoryId: string): boolean {
  return Object.values(state.intel?.reports ?? {}).some((r) => r?.territoryId === territoryId);
}

export function canRaidCountHouse(
  state: GameState,
  victim: FamilyName,
): { ok: boolean; reason?: string; block?: Territory } {
  const player = state.playerFamily;
  const block = countHouseBlock(state, victim);
  if (!player || !block || victim === player) return { ok: false, reason: "Nothing to raid." };
  if (exposedCash(state, victim) <= 0) return { ok: false, reason: "No cash sitting there." };
  if (!hasReport(state, block.id)) return { ok: false, reason: "Case the block first." };
  if (inTruce(state, player, victim)) return { ok: false, reason: `A truce holds with ${victim}.` };
  if ((state.countHouseCooldown?.[victim] ?? 0) > state.turn) return { ok: false, reason: "Too soon to go back." };
  return { ok: true, block };
}

/**
 * A capture roll against the block's garrison. Success takes a share of the
 * exposed cash. The block stays with its owner.
 */
export function raidCountHouse(
  state: GameState,
  attacker: FamilyName,
  victim: FamilyName,
  partyIds: string[],
  rng: Rng,
): { state: GameState; success: boolean; taken: number; log: TurnLogEntry } {
  const block = countHouseBlock(state, victim);
  const exposed = exposedCash(state, victim);
  const log = (text: string, category: TurnLogEntry["category"] = "combat"): TurnLogEntry => ({
    id: `log_count_${attacker}_${victim}_${state.turn}_${rng.int(10, 99)}`,
    turn: state.turn,
    category,
    text,
    family: state.playerFamily ?? undefined,
    territoryId: block?.id,
  });
  if (!block || exposed <= 0 || partyIds.length === 0) {
    return { state, success: false, taken: 0, log: log("The raid finds nothing.") };
  }
  const view = attacker === state.playerFamily ? state : { ...state, playerFamily: attacker };
  const strength = captureStrength(view, block.id, partyIds);
  const success = rng.next() < captureOdds(strength.atk, strength.def);
  const taken = success ? Math.floor(exposed * RAID_SHARE) : 0;
  let next = state;
  if (attacker === state.playerFamily) {
    const party = new Set(partyIds);
    next = {
      ...next,
      crew: next.crew.map((c) => (party.has(c.id) ? { ...c, wanted: raiseWanted(c, 1) } : c)),
      heat: bribedHeat(next, success ? RAID_HEAT : 4, `count:${block.id}`),
    };
    if (hasPact(next, attacker, victim)) next = breakPact(next, victim);
    next = { ...next, relations: setRelationDelta(next.relations, attacker, victim, RAID_RELATION) };
    next = {
      ...next,
      countHouseCooldown: { ...(next.countHouseCooldown ?? {}), [victim]: state.turn + RAID_COOLDOWN },
    };
  } else {
    next = bumpRivalHeat(next, attacker, success ? 6 : 4);
  }
  if (success && taken > 0) {
    if (victim === state.playerFamily) {
      next = { ...next, dirtyMoney: Math.max(0, next.dirtyMoney - taken) };
    } else {
      next = {
        ...next,
        rivalTreasury: {
          ...(next.rivalTreasury ?? {}),
          [victim]: Math.max(0, (next.rivalTreasury?.[victim] ?? 0) - taken),
        },
      };
    }
    if (attacker === state.playerFamily) next = { ...next, dirtyMoney: next.dirtyMoney + taken };
    else {
      next = {
        ...next,
        rivalTreasury: {
          ...(next.rivalTreasury ?? {}),
          [attacker]: (next.rivalTreasury?.[attacker] ?? 0) + taken,
        },
      };
    }
  }
  const text = success
    ? `${attacker} raided the count house in ${block.name} and took $${taken}.`
    : `${attacker} hit the count house in ${block.name} and came away with nothing.`;
  return { state: next, success, taken, log: log(text) };
}

function nearestHops(state: GameState, family: FamilyName, territoryId: string): number {
  const owned = state.territories.filter((t) => t.owner === family);
  if (owned.length === 0) return 99;
  return Math.min(...owned.map((t) => territoryHops(state, t.id, territoryId)));
}

/**
 * A rival casing or hitting the player's count house, or tipping the police
 * when they cannot reach it. One rival a week, the one with a reason.
 */
export function tickRivalCountHouse(
  state: GameState,
  family: FamilyName,
  rng: Rng,
  goal: { kind: string; target?: string; track?: string } | null,
): { state: GameState; logs: TurnLogEntry[] } {
  const player = state.playerFamily;
  const logs: TurnLogEntry[] = [];
  if (!player || family === player) return { state, logs };

  // A truce or a pact covers the count house too.
  if (
    goal?.kind === "contain_leader" &&
    goal.track === "wealth" &&
    goal.target &&
    goal.target !== player &&
    !atPeace(state, family, goal.target as FamilyName)
  ) {
    const victim = goal.target as FamilyName;
    const key = `${family}|${victim}`;
    const block = countHouseBlock(state, victim);
    const exposed = exposedCash(state, victim);
    if ((state.countHouseRivalCooldown?.[key] ?? 0) <= state.turn && block && exposed > 0 && nearestHops(state, family, block.id) <= 2) {
      const men = state.crew.filter((c) => c.family === family && c.status === "active").slice(0, 3).map((c) => c.id);
      const raid = raidCountHouse(state, family, victim, men, rng);
      logs.push(raid.log);
      return {
        state: {
          ...raid.state,
          countHouseRivalCooldown: { ...(state.countHouseRivalCooldown ?? {}), [key]: state.turn + RAID_COOLDOWN },
        },
        logs,
      };
    }
  }

  const aimed = !!goal && (goal.kind === "contain_leader" || goal.kind === "retaliate") && goal.target === player;
  const block = countHouseBlock(state, player);
  const exposed = exposedCash(state, player);
  if (!aimed || !block || exposed <= 0) return { state, logs };
  if (atPeace(state, family, player)) {
    // The men watching the block are called home when the guns go down.
    return { state: state.countHouseCasing?.family === family ? { ...state, countHouseCasing: null } : state, logs };
  }

  const casing = state.countHouseCasing;
  if (casing && casing.family === family && casing.hitTurn <= state.turn && casing.territoryId === block.id) {
    const men = state.crew.filter((c) => c.family === family && c.status === "active").slice(0, 3).map((c) => c.id);
    const raid = raidCountHouse(state, family, player, men, rng);
    logs.push(raid.log);
    return { state: { ...raid.state, countHouseCasing: null }, logs };
  }

  const hops = nearestHops(state, family, block.id);
  if (hops <= 2) {
    if (casing?.family === family) return { state, logs };
    const hitTurn = state.turn + 1;
    logs.push({
      id: `log_count_case_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} men were seen watching the count house in ${block.name}. They'll come next week.`,
      family: player,
      territoryId: block.id,
    });
    return { state: { ...state, countHouseCasing: { family, territoryId: block.id, hitTurn } }, logs };
  }

  const bribed = state.bribes.captains.isActive || state.bribes.chiefs.isActive;
  if (state.heat.level >= 50 && !bribed && rng.chance(0.35)) {
    const seized = Math.floor(exposed * TIP_SHARE);
    logs.push({
      id: `log_count_tip_${family}_${state.turn}`,
      turn: state.turn,
      category: "heat",
      text: `${family} tipped the precinct. The cops took $${seized} from the count house in ${block.name}.`,
      family: player,
      territoryId: block.id,
    });
    return { state: { ...state, dirtyMoney: Math.max(0, state.dirtyMoney - seized) }, logs };
  }
  return { state, logs };
}
