import type { FamilyName, GameLength, GameState, VictoryState } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { livingBoss } from "./jail";

export const LEAD_TURNS = 6;
/** Sudden-death streaks start counting on this turn; nobody is crowned in the opening weeks. */
export const STREAK_START_TURN = 10;
export const BANKRUPT_TURNS = 3;
export const INFLUENCE_BAR = 200;
export const INFLUENCE_MULT = 1.5;
export const WEALTH_FLOOR = 30_000;
export const WEALTH_MULT = 2;
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

/** Weekly standing drift. The same curve for every family at the table. */
export function influenceTick(rep: StandingDrivers): number {
  return rep.respect * 0.04 + rep.fear * 0.03 + rep.streetInfluence * 0.02 - 2;
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
  if (family === state.playerFamily) return state.money + state.dirtyMoney;
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
    familyWealth(state, wealthLead) >= WEALTH_FLOOR &&
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

  const streaksOpen = state.turn >= STREAK_START_TURN;
  const inf = familyInfluence(state, player);
  const infSecond = secondPlace(state, (f) => familyInfluence(state, f));
  const influenceLead =
    streaksOpen && inf >= INFLUENCE_BAR && inf >= infSecond * INFLUENCE_MULT;
  const influenceLeadTurns = influenceLead ? victory.influenceLeadTurns + 1 : 0;
  if (influenceLeadTurns >= LEAD_TURNS) {
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns: 0,
      won: true,
      reason: `Standing for ${LEAD_TURNS} weeks — the Commission bends.`,
    };
  }

  const wealth = familyWealth(state, player);
  const wealthSecond = secondPlace(state, (f) => familyWealth(state, f));
  const wealthLead =
    streaksOpen && wealth >= WEALTH_FLOOR && wealth >= wealthSecond * WEALTH_MULT;
  const wealthLeadTurns = wealthLead ? victory.wealthLeadTurns + 1 : 0;
  if (wealthLeadTurns >= LEAD_TURNS) {
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns,
      won: true,
      reason: `The richest family in the city for ${LEAD_TURNS} weeks.`,
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
