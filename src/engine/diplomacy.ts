import type {
  AiPersonality,
  DiplomacyState,
  FamilyName,
  GameState,
  RelationStatus,
  TurnLogEntry,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import {
  getRelation,
  relationKey,
  setRelation,
  setRelationDelta,
  statusFromScore,
} from "./relations";

/** Tunable costs. Influence income is only a few points per turn. */
export const SITDOWN_INFLUENCE = 15;
export const SITDOWN_MONEY = 500;
export const SITDOWN_COOLDOWN = 2;

export const TRIBUTE_MONEY = 600;
export const TRIBUTE_COOLDOWN = 2;

export const DEMAND_INFLUENCE = 10;
export const DEMAND_COOLDOWN = 3;
export const DEMAND_FEAR = 40;
export const DEMAND_DISTRICT_LEAD = 2;

export const PACT_INFLUENCE = 30;
export const PACT_MONEY = 1000;
export const PACT_COOLDOWN = 3;
export const PACT_DURATION = 8;
export const PACT_MIN_SCORE = 45;
/** Truce or better. */
export const PACT_REQUIRE_SCORE = 10;

export const WAR_SCORE = -70;
export const PACT_BREAK_RELATION = -40;
export const PACT_BREAK_RESPECT = 10;
export const WAR_FEAR = 5;
export const WAR_PACT_RESPECT = 15;

const PERSONALITY_MOD: Record<AiPersonality, number> = {
  economic: 0.1,
  smuggler: 0.05,
  covert: 0,
  expansionist: -0.05,
  volatile: -0.15,
};

const STATUS_PENALTY: Record<RelationStatus, number> = {
  war: 0.25,
  hostile: 0.15,
  cold: 0.08,
  neutral: 0,
  truce: -0.05,
  allied: -0.1,
};

export type DiplomacyAction = "sitdown" | "tribute" | "demand" | "pact" | "war";

export interface DiplomacyCheck {
  ok: boolean;
  reason?: string;
  /** Present when the action is a roll. */
  odds?: number;
}

export function emptyDiplomacy(): DiplomacyState {
  return { pacts: {}, cooldowns: {} };
}

export function diplomacyOf(state: GameState): DiplomacyState {
  return {
    pacts: state.diplomacy?.pacts ?? {},
    cooldowns: state.diplomacy?.cooldowns ?? {},
  };
}

/** True while a non-aggression pact between the player and `other` is in force. */
export function hasPact(state: GameState, a: FamilyName, b: FamilyName): boolean {
  const player = state.playerFamily;
  if (!player || a === b) return false;
  const rival = a === player ? b : b === player ? a : null;
  if (!rival) return false;
  const until = diplomacyOf(state).pacts[rival];
  if (until == null) return false;
  return state.turn < until;
}

/** Relation-matrix keys whose decay is frozen by an active pact. */
export function activePactKeys(state: GameState): Set<string> {
  const keys = new Set<string>();
  const player = state.playerFamily;
  if (!player) return keys;
  for (const family of Object.keys(diplomacyOf(state).pacts) as FamilyName[]) {
    if (hasPact(state, player, family)) keys.add(relationKey(player, family));
  }
  return keys;
}

export function pactTurnsLeft(state: GameState, target: FamilyName): number | null {
  if (!state.playerFamily || !hasPact(state, state.playerFamily, target)) return null;
  const until = diplomacyOf(state).pacts[target] ?? state.turn;
  return Math.max(0, until - state.turn);
}

function ownedCount(state: GameState, family: FamilyName): number {
  return state.territories.filter((t) => t.owner === family).length;
}

function cooldownLeft(state: GameState, target: FamilyName): number {
  const until = diplomacyOf(state).cooldowns[target] ?? 0;
  return Math.max(0, until - state.turn);
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function clampOdds(n: number, lo = 0.1, hi = 0.9): number {
  return Math.max(lo, Math.min(hi, n));
}

function hasConsigliere(state: GameState): boolean {
  return state.crew.some(
    (c) =>
      c.family === state.playerFamily &&
      c.role === "consigliere" &&
      c.status === "active",
  );
}

export function sitdownOdds(state: GameState, target: FamilyName): number {
  if (!state.playerFamily) return 0.5;
  const score = getRelation(state.relations, state.playerFamily, target);
  const odds =
    0.5 +
    (state.reputation.respect - 50) / 200 +
    PERSONALITY_MOD[getFamilyDef(target).personality] -
    STATUS_PENALTY[statusFromScore(score)] +
    (hasConsigliere(state) ? 0.1 : 0);
  return clampOdds(odds);
}

export function demandOdds(state: GameState, target: FamilyName): number {
  if (!state.playerFamily) return 0.4;
  const lead =
    ownedCount(state, state.playerFamily) - ownedCount(state, target) - DEMAND_DISTRICT_LEAD;
  const odds =
    0.4 +
    (state.reputation.fear - DEMAND_FEAR) / 150 +
    lead * 0.05 +
    PERSONALITY_MOD[getFamilyDef(target).personality];
  return clampOdds(odds, 0.15, 0.85);
}

function resourceReason(state: GameState, money: number, influence: number): string | null {
  if (influence > 0 && state.influence < influence) return "Not enough influence";
  if (money > 0 && state.money < money) return `Need $${money} clean`;
  return null;
}

export function canDiplomacy(
  state: GameState,
  action: DiplomacyAction,
  target: FamilyName,
): DiplomacyCheck {
  if (!state.playerFamily || target === state.playerFamily) {
    return { ok: false, reason: "No family to deal with" };
  }
  const score = getRelation(state.relations, state.playerFamily, target);

  if (action === "war") {
    if (score <= -60 && !hasPact(state, state.playerFamily, target)) {
      return { ok: false, reason: "Already at war" };
    }
    return { ok: true };
  }

  if (action === "pact") {
    if (hasPact(state, state.playerFamily, target)) {
      return { ok: false, reason: "Pact already holds" };
    }
    if (score < PACT_REQUIRE_SCORE) {
      return { ok: false, reason: "Need a truce first" };
    }
  }

  if (action === "demand") {
    if (state.reputation.fear < DEMAND_FEAR) {
      return { ok: false, reason: `Need fear of ${DEMAND_FEAR} to demand tribute` };
    }
    const playerN = ownedCount(state, state.playerFamily);
    const rivalN = ownedCount(state, target);
    if (playerN < rivalN + DEMAND_DISTRICT_LEAD) {
      return { ok: false, reason: `Need two more districts than ${target}` };
    }
  }

  const wait = cooldownLeft(state, target);
  if (wait > 0) {
    return {
      ok: false,
      reason: `Cooldown ${wait} turn${wait === 1 ? "" : "s"}`,
    };
  }

  if (action === "sitdown") {
    const blocked = resourceReason(state, SITDOWN_MONEY, SITDOWN_INFLUENCE);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, odds: sitdownOdds(state, target) };
  }
  if (action === "tribute") {
    const blocked = resourceReason(state, TRIBUTE_MONEY, 0);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true };
  }
  if (action === "demand") {
    const blocked = resourceReason(state, 0, DEMAND_INFLUENCE);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, odds: demandOdds(state, target) };
  }
  const blocked = resourceReason(state, PACT_MONEY, PACT_INFLUENCE);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true };
}

export function diplomacyHint(
  state: GameState,
  action: DiplomacyAction,
  target: FamilyName,
): string {
  const check = canDiplomacy(state, action, target);
  if (!check.ok) return check.reason ?? "Unavailable";
  const cost =
    action === "sitdown"
      ? `${SITDOWN_INFLUENCE} influence · $${SITDOWN_MONEY}`
      : action === "tribute"
        ? `$${TRIBUTE_MONEY} for standing`
        : action === "demand"
          ? `${DEMAND_INFLUENCE} influence`
          : action === "pact"
            ? `${PACT_INFLUENCE} influence · $${PACT_MONEY}`
            : "Free — drops standing to war";
  if (check.odds == null) return cost;
  return `${cost} · ${Math.round(check.odds * 100)}% chance`;
}

function withCooldown(state: GameState, target: FamilyName, turns: number): GameState {
  const diplo = diplomacyOf(state);
  return {
    ...state,
    diplomacy: {
      ...diplo,
      cooldowns: { ...diplo.cooldowns, [target]: state.turn + turns },
    },
  };
}

function pushLog(state: GameState, log: TurnLogEntry): GameState {
  return { ...state, turnLog: [...state.turnLog, log] };
}

function makeLog(
  state: GameState,
  action: DiplomacyAction,
  target: FamilyName,
  text: string,
): TurnLogEntry {
  return {
    id: `log_diplo_${action}_${target}_${state.turn}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: state.playerFamily ?? undefined,
  };
}

/**
 * Hostile act against a pact partner. Removes the pact, −40 relation, −10 respect.
 */
export function breakPact(state: GameState, target: FamilyName): GameState {
  if (!state.playerFamily || !hasPact(state, state.playerFamily, target)) return state;
  const diplo = diplomacyOf(state);
  const pacts = { ...diplo.pacts };
  delete pacts[target];
  const next: GameState = {
    ...state,
    diplomacy: { ...diplo, pacts },
    relations: setRelationDelta(
      state.relations,
      state.playerFamily,
      target,
      PACT_BREAK_RELATION,
    ),
    reputation: {
      ...state.reputation,
      respect: clamp100(state.reputation.respect - PACT_BREAK_RESPECT),
    },
  };
  return pushLog(
    next,
    {
      id: `log_pact_break_${target}_${state.turn}`,
      turn: state.turn,
      category: "diplomacy",
      text: `You broke your word with ${target}.`,
      family: state.playerFamily,
    },
  );
}

/** Drop pacts whose lapse turn has arrived. Call after the date advances. */
export function expirePacts(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const diplo = diplomacyOf(state);
  const pacts = { ...diplo.pacts };
  const logs: TurnLogEntry[] = [];
  for (const family of Object.keys(pacts) as FamilyName[]) {
    const until = pacts[family];
    if (until == null || state.turn < until) continue;
    delete pacts[family];
    logs.push({
      id: `log_pact_lapse_${family}_${state.turn}`,
      turn: state.turn,
      category: "diplomacy",
      text: `The pact with ${family} has lapsed.`,
      family: state.playerFamily ?? undefined,
    });
  }
  if (logs.length === 0) return { state: { ...state, diplomacy: diplo }, logs };
  return {
    state: { ...state, diplomacy: { ...diplo, pacts } },
    logs,
  };
}

export function resolveDiplomacy(
  state: GameState,
  action: DiplomacyAction,
  target: FamilyName,
  rng: Rng,
): { state: GameState; log: TurnLogEntry; success: boolean } {
  const check = canDiplomacy(state, action, target);
  if (!check.ok || !state.playerFamily) {
    const log = makeLog(state, action, target, check.reason ?? "Declined");
    return { state, log, success: false };
  }
  const player = state.playerFamily;

  if (action === "sitdown") {
    const success = rng.chance(check.odds ?? sitdownOdds(state, target));
    let next: GameState = {
      ...state,
      money: state.money - SITDOWN_MONEY,
      influence: Math.max(0, state.influence - SITDOWN_INFLUENCE),
      relations: setRelationDelta(
        state.relations,
        player,
        target,
        success ? 15 : 3,
      ),
      reputation: {
        ...state.reputation,
        respect: clamp100(state.reputation.respect + (success ? 2 : 0)),
      },
    };
    next = withCooldown(next, target, SITDOWN_COOLDOWN);
    const log = makeLog(
      next,
      action,
      target,
      success
        ? `Sit-down with ${target} held. They agree to ease off.`
        : `Sit-down with ${target} went nowhere.`,
    );
    return { state: pushLog(next, log), log, success };
  }

  if (action === "tribute") {
    let next: GameState = {
      ...state,
      money: state.money - TRIBUTE_MONEY,
      relations: setRelationDelta(state.relations, player, target, 10),
      reputation: {
        ...state.reputation,
        respect: clamp100(state.reputation.respect - 2),
      },
    };
    next = withCooldown(next, target, TRIBUTE_COOLDOWN);
    const log = makeLog(next, action, target, `You paid tribute to ${target}.`);
    return { state: pushLog(next, log), log, success: true };
  }

  if (action === "demand") {
    const success = rng.chance(check.odds ?? demandOdds(state, target));
    const treasury = state.rivalTreasury?.[target] ?? 0;
    const take = success ? Math.min(Math.floor(treasury * 0.2), 1500) : 0;
    let next: GameState = {
      ...state,
      influence: Math.max(0, state.influence - DEMAND_INFLUENCE),
      dirtyMoney: state.dirtyMoney + take,
      rivalTreasury: {
        ...(state.rivalTreasury ?? {}),
        [target]: Math.max(0, treasury - take),
      },
      relations: setRelationDelta(
        state.relations,
        player,
        target,
        success ? -10 : -15,
      ),
      reputation: {
        ...state.reputation,
        respect: clamp100(state.reputation.respect + (success ? 0 : -5)),
      },
    };
    next = withCooldown(next, target, DEMAND_COOLDOWN);
    const log = makeLog(
      next,
      action,
      target,
      success
        ? take > 0
          ? `${target} paid $${take} under pressure.`
          : `${target} came up empty — no tribute to collect.`
        : `${target} laughed off your demand.`,
    );
    return { state: pushLog(next, log), log, success };
  }

  if (action === "pact") {
    const raised = Math.max(
      getRelation(state.relations, player, target),
      PACT_MIN_SCORE,
    );
    const diplo = diplomacyOf(state);
    let next: GameState = {
      ...state,
      money: state.money - PACT_MONEY,
      influence: Math.max(0, state.influence - PACT_INFLUENCE),
      relations: setRelation(state.relations, player, target, raised),
      diplomacy: {
        ...diplo,
        pacts: { ...diplo.pacts, [target]: state.turn + PACT_DURATION },
      },
    };
    next = withCooldown(next, target, PACT_COOLDOWN);
    const log = makeLog(
      next,
      action,
      target,
      `Non-aggression pact with ${target} — ${PACT_DURATION} weeks.`,
    );
    return { state: pushLog(next, log), log, success: true };
  }

  const pactActive = hasPact(state, player, target);
  const diplo = diplomacyOf(state);
  const pacts = { ...diplo.pacts };
  if (pactActive) delete pacts[target];
  let vendettas = state.vendettas.includes(target)
    ? state.vendettas
    : [...state.vendettas, target];
  if (!vendettas.includes(player)) vendettas = [...vendettas, player];
  const next: GameState = {
    ...state,
    diplomacy: { ...diplo, pacts },
    relations: setRelation(
      state.relations,
      player,
      target,
      Math.min(getRelation(state.relations, player, target), WAR_SCORE),
    ),
    vendettas,
    reputation: {
      ...state.reputation,
      fear: clamp100(state.reputation.fear + WAR_FEAR),
      respect: clamp100(
        state.reputation.respect - (pactActive ? WAR_PACT_RESPECT : 0),
      ),
    },
  };
  const log = makeLog(
    next,
    action,
    target,
    pactActive
      ? `You tore up the pact and declared war on ${target}.`
      : `You declared war on ${target}.`,
  );
  return { state: pushLog(next, log), log, success: true };
}
