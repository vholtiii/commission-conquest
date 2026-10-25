import type { FamilyName, GameLength, GameState, VictoryState } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { livingBoss } from "./jail";
import { leadTurnsFor } from "./tempo";

export const LEAD_TURNS = 6;
/** Sudden-death streaks start counting on this turn; nobody is crowned in the opening weeks. */
export const STREAK_START_TURN = 10;
export const BANKRUPT_TURNS = 3;
export const INFLUENCE_BAR = 200;
export const INFLUENCE_MULT = 1.5;
export const WEALTH_FLOOR = 30_000;
/** The wealth bar climbs by this much every week. */
export const WEALTH_FLOOR_SLOPE = 1_500;
export const WEALTH_MULT = 2;
/**
 * Unwashed cash is worth this much toward the wealth win. Below 1 the sim's
 * players almost never clear the rising bar on Normal, so it stays at full value.
 */
export const DIRTY_WEIGHT = 1;

export function wealthFloor(turn: number): number {
  return WEALTH_FLOOR + WEALTH_FLOOR_SLOPE * turn;
}
export const SUMMIT_RATIO = 1.1;

export function finalTurnFor(length: GameLength | undefined): number {
  if (length === "short") return 30;
  if (length === "long") return 80;
  return 50;
}

export function emptyVictory(finalTurn = 50): VictoryState {
  return {
    won: false,
    lost: false,
    finalTurn,
    influenceLeadTurns: 0,
    wealthLeadTurns: 0,
    bankruptTurns: 0,
  };
}

export function seedRivalInfluence(
  existing: Partial<Record<FamilyName, number>> | undefined,
  player: FamilyName | null,
): Partial<Record<FamilyName, number>> {
  if (existing && Object.keys(existing).length > 0) return existing;
  const seeded: Partial<Record<FamilyName, number>> = {};
  for (const family of ALL_FAMILY_NAMES) {
    if (family !== player) seeded[family] = 120;
  }
  return seeded;
}

export interface StandingDrivers {
  respect: number;
  fear: number;
  streetInfluence: number;
}

const INFLUENCE_WEIGHTS = { respect: 0.04, fear: 0.03, streetInfluence: 0.02 } as const;
const INFLUENCE_UPKEEP = 2;
export const INFLUENCE_CAP = 300;

/** Weekly standing drift. The same curve for every family at the table. */
export function influenceTick(rep: StandingDrivers): number {
  return (
    rep.respect * INFLUENCE_WEIGHTS.respect +
    rep.fear * INFLUENCE_WEIGHTS.fear +
    rep.streetInfluence * INFLUENCE_WEIGHTS.streetInfluence -
    INFLUENCE_UPKEEP
  );
}

/** Tooltip lines for the Influence stat: what this week's drift is made of. */
export function influenceBreakdown(rep: StandingDrivers, influence: number): string {
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
  const part = (label: string, value: number, weight: number) =>
    `${label} ${Math.round(value)} × ${weight} = ${signed(value * weight)}`;
  const net = influenceTick(rep);
  return [
    `Each week:`,
    part("Respect", rep.respect, INFLUENCE_WEIGHTS.respect),
    part("Fear", rep.fear, INFLUENCE_WEIGHTS.fear),
    part("Street", rep.streetInfluence, INFLUENCE_WEIGHTS.streetInfluence),
    `Upkeep ${signed(-INFLUENCE_UPKEEP)}`,
    `Net ${signed(net)} a week${influence >= INFLUENCE_CAP && net > 0 ? ` (capped at ${INFLUENCE_CAP})` : ""}`,
    ``,
    `Spent on: sit-downs, demands, pacts, Commission calls and lobbying, and standing thrown into deals.`,
    `Lost when you break a deal. Gained from message hits, Commission errands and hosting sit-downs.`,
  ].join("\n");
}

/**
 * A rival's standing drivers, read off the map. Turf earns respect, muscle
 * earns fear, and the personality decides which the street remembers.
 */
export function rivalStandingDrivers(state: GameState, family: FamilyName): StandingDrivers {
  const turf = state.territories.filter((t) => t.owner === family).length;
  const personality = getFamilyDef(family).personality;
  return {
    respect: 5 + turf * 3 + (personality === "economic" ? 10 : 0),
    fear: 3 + turf * 2 + (personality === "volatile" ? 10 : 0),
    streetInfluence: 5 + turf * 2 + (personality === "smuggler" || personality === "covert" ? 5 : 0),
  };
}

export function familyInfluence(state: GameState, family: FamilyName): number {
  if (family === state.playerFamily) return state.influence;
  return state.rivalInfluence?.[family] ?? 0;
}

export function familyWealth(state: GameState, family: FamilyName): number {
  if (family === state.playerFamily) return state.money + state.dirtyMoney * DIRTY_WEIGHT;
  return state.rivalTreasury?.[family] ?? 0;
}

function secondPlace(state: GameState, score: (f: FamilyName) => number): number {
  const player = state.playerFamily;
  let best = 0;
  for (const f of ALL_FAMILY_NAMES) {
    if (f === player) continue;
    best = Math.max(best, score(f));
  }
  return best;
}

/** Lead by 10%, trail by more than 10%, or close: within 10% either way. */
function gap(player: number, second: number): "lead" | "close" | "trail" {
  if (second <= 0) return player > 0 ? "lead" : "close";
  if (player >= second * SUMMIT_RATIO) return "lead";
  if (player >= second * (2 - SUMMIT_RATIO)) return "close";
  return "trail";
}

function districtsOf(state: GameState, family: FamilyName): number {
  return state.territories.filter((t) => t.owner === family).length;
}

/** Families currently clearing the sudden-death bar, player or rival. */
export function familiesPressingSuddenDeath(state: GameState): FamilyName[] {
  if (state.turn < STREAK_START_TURN) return [];
  const byInf = [...ALL_FAMILY_NAMES].sort(
    (a, b) => familyInfluence(state, b) - familyInfluence(state, a),
  );
  const byWealth = [...ALL_FAMILY_NAMES].sort(
    (a, b) => familyWealth(state, b) - familyWealth(state, a),
  );
  const pressing = new Set<FamilyName>();
  const infLead = byInf[0];
  const infSecond = byInf[1] ? familyInfluence(state, byInf[1]) : 0;
  if (
    infLead &&
    familyInfluence(state, infLead) >= INFLUENCE_BAR &&
    familyInfluence(state, infLead) >= infSecond * INFLUENCE_MULT
  ) {
    pressing.add(infLead);
  }
  const wealthLead = byWealth[0];
  const wealthSecond = byWealth[1] ? familyWealth(state, byWealth[1]) : 0;
  if (
    wealthLead &&
    familyWealth(state, wealthLead) >= wealthFloor(state.turn) &&
    familyWealth(state, wealthLead) >= wealthSecond * WEALTH_MULT
  ) {
    pressing.add(wealthLead);
  }
  return [...pressing];
}

export function checkVictory(state: GameState): VictoryState {
  const victory: VictoryState = {
    ...emptyVictory(),
    ...state.victory,
    finalTurn: state.victory?.finalTurn || finalTurnFor(state.settings.gameLength),
  };
  if (victory.won || victory.lost) return victory;
  if (!state.playerFamily || !state.started) return victory;

  const player = state.playerFamily;
  const reg = state.interregnum;
  if (reg?.family === player) {
    if (state.turn >= reg.deadline) {
      return {
        ...victory,
        lost: true,
        reason:
          reg.cause === "put_away"
            ? "Five weeks with no boss. The family never recovered from the Tombs."
            : "Five weeks with no boss. The chair stayed empty.",
      };
    }
  } else {
  const boss = livingBoss(state, player);
  if (!boss || boss.status === "dead") {
    const putAway = state.crew.some(
      (c) => c.family === player && c.role === "boss" && c.putAway,
    );
    return {
      ...victory,
      lost: true,
      reason: putAway
        ? "Your boss never left the Tombs, and no underboss was ready."
        : "Your boss is dead and no underboss could take the chair.",
    };
  }
  if (boss.status === "jailed" && state.turn >= (boss.jailedUntilTurn ?? state.turn)) {
    return {
      ...victory,
      lost: true,
      reason: "Your boss never left the Tombs, and no underboss was ready.",
    };
  }
  }

  const broke = state.money < 0 && state.dirtyMoney < 0;
  const bankruptTurns = broke ? victory.bankruptTurns + 1 : 0;
  if (bankruptTurns >= BANKRUPT_TURNS) {
    return {
      ...victory,
      bankruptTurns,
      lost: true,
      reason: `Bankrupt for ${BANKRUPT_TURNS} weeks — both coffers are empty.`,
    };
  }

  const leadTurns = leadTurnsFor(state.settings.gameLength);
  const streaksFrozen = state.interregnum?.family === player;
  const streaksOpen = state.turn >= STREAK_START_TURN && !streaksFrozen;
  const inf = familyInfluence(state, player);
  const infSecond = secondPlace(state, (f) => familyInfluence(state, f));
  const influenceLead =
    streaksOpen && inf >= INFLUENCE_BAR && inf >= infSecond * INFLUENCE_MULT;
  const influenceLeadTurns = streaksFrozen
    ? victory.influenceLeadTurns
    : influenceLead
      ? victory.influenceLeadTurns + 1
      : 0;
  if (!streaksFrozen && influenceLeadTurns >= leadTurns) {
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns: 0,
      won: true,
      reason: `Standing for ${leadTurns} weeks — the Commission bends.`,
    };
  }

  const wealth = familyWealth(state, player);
  const wealthSecond = secondPlace(state, (f) => familyWealth(state, f));
  const wealthLead =
    streaksOpen && wealth >= wealthFloor(state.turn) && wealth >= wealthSecond * WEALTH_MULT;
  const wealthLeadTurns = streaksFrozen
    ? victory.wealthLeadTurns
    : wealthLead
      ? victory.wealthLeadTurns + 1
      : 0;
  if (!streaksFrozen && wealthLeadTurns >= leadTurns) {
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns,
      won: true,
      reason: `The richest family in the city for ${leadTurns} weeks.`,
    };
  }

  const next: VictoryState = {
    ...victory,
    bankruptTurns,
    influenceLeadTurns,
    wealthLeadTurns,
  };

  if (state.turn < next.finalTurn) return next;

  const infGap = gap(inf, infSecond);
  const wealthGap = gap(wealth, wealthSecond);
  if (infGap === "lead" || wealthGap === "lead") {
    const which = infGap === "lead" ? "standing" : "wealth";
    return {
      ...next,
      won: true,
      reason: `The summit names you first in ${which}.`,
    };
  }
  if (infGap === "close" && wealthGap === "close") {
    const mine = districtsOf(state, player);
    const bestRival = Math.max(
      ...ALL_FAMILY_NAMES.filter((f) => f !== player).map((f) => districtsOf(state, f)),
    );
    if (mine > bestRival) {
      return {
        ...next,
        won: true,
        reason: "Too close to call on the books — the map breaks the tie.",
      };
    }
  }
  return {
    ...next,
    lost: true,
    reason: "The summit adjourns. Another family leaves with the city.",
  };
}
