import type { CrewRole, GameState, TurnLogEntry } from "@/types/game";
import { hitCrewIds } from "@/data/hitApproaches";
import { releaseCrewHome } from "./jobReturn";

/** Weeks the city stays quiet after a boss is killed, counting the week he dies. */
export const MOURNING_WEEKS = 3;
/** A made man's funeral, not a chair. One week of quiet streets. */
export const STREET_FUNERAL_WEEKS = 1;

const MADE: ReadonlySet<CrewRole> = new Set([
  "soldier",
  "capo",
  "hitman",
  "underboss",
  "consigliere",
  "boss",
]);

export function isMadeMan(role: CrewRole | undefined): boolean {
  return !!role && MADE.has(role);
}

export type MourningState = {
  turn: number;
  mourningUntil?: number;
  mourningForBoss?: boolean;
};

/** No family may order or land a street hit while this is true. */
export function handsDown(state: MourningState): boolean {
  return state.turn < (state.mourningUntil ?? 0);
}

/** The table stands down too: only when the funeral is for a boss. */
export function commissionHeld(state: MourningState): boolean {
  return handsDown(state) && !!state.mourningForBoss;
}

/** Weeks left on the quiet, including this one. */
export function funeralWeeksLeft(state: MourningState): number {
  return Math.max(0, (state.mourningUntil ?? 0) - state.turn);
}

/** Older saves only buried a boss. A missing flag while the streets are still quiet is a boss funeral. */
export function hydrateMourningForBoss(p: {
  mourningForBoss?: boolean;
  mourningUntil?: number;
  turn?: number;
}): boolean {
  if (typeof p.mourningForBoss === "boolean") return p.mourningForBoss;
  return (p.mourningUntil ?? 0) > (p.turn ?? 0);
}

/** A hit the Commission ordered. */
export function tableHit(op: { kind: string; intent?: string; errandId?: string }): boolean {
  return op.kind === "hit" && (op.intent === "commission" || !!op.errandId);
}

/**
 * Streets go quiet. A boss funeral is three weeks (two if the chair emptied
 * this week). A made man's funeral is one week. A later death of the same
 * kind restarts the clock. A boss death upgrades a street funeral. A street
 * death does not shorten a boss funeral.
 *
 * Street hits are called off. Commission hits stay up unless this is a boss funeral.
 */
export function declareFuneral(
  state: GameState,
  forBoss: boolean,
): { state: GameState; logs: TurnLogEntry[] } {
  const already = handsDown(state);
  const alreadyBoss = already && !!state.mourningForBoss;
  if (alreadyBoss && !forBoss) return { state, logs: [] };

  const weeks = forBoss
    ? state.interregnum?.startedTurn === state.turn
      ? 2
      : MOURNING_WEEKS
    : STREET_FUNERAL_WEEKS;
  const until = state.turn + weeks;
  const previous = state.mourningUntil ?? 0;
  const upgraded = already && !alreadyBoss && forBoss;
  const restarted = already && previous !== until;
  const logs: TurnLogEntry[] = [];

  const holdTable = forBoss;
  const tableOut = state.operations.some((o) => !o.resolved && tableHit(o));
  const quiet = holdTable
    ? "Nobody gets shot. The table stands down too."
    : tableOut
      ? "Nobody gets shot, except the table's order."
      : "Nobody gets shot.";

  if (!already) {
    logs.push({
      id: `log_mourning_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: forBoss
        ? `The city goes quiet for the funeral. ${weeks === 2 ? "Two weeks" : "Three weeks"}. ${quiet}`
        : `A funeral. Streets stay quiet this week. ${quiet}`,
      family: state.playerFamily ?? undefined,
    });
  } else if (upgraded) {
    logs.push({
      id: `log_mourning_upgrade_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `A boss is in the ground. The quiet starts over — ${weeks === 2 ? "two weeks" : "three weeks"}. ${quiet}`,
      family: state.playerFamily ?? undefined,
    });
  } else if (restarted) {
    logs.push({
      id: `log_mourning_reset_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: forBoss
        ? `Another boss is in the ground. The quiet starts over — ${weeks === 2 ? "two weeks" : "three weeks"}, ${quiet.toLowerCase()}`
        : `Another funeral. Streets stay quiet this week. ${quiet}`,
      family: state.playerFamily ?? undefined,
    });
  }

  const calledOff = (o: (typeof state.operations)[number]) =>
    !o.resolved && o.kind === "hit" && (holdTable || !tableHit(o));
  const dropped = state.operations.filter(calledOff);
  let returned = state;
  for (const o of dropped) returned = releaseCrewHome(returned, hitCrewIds(o), o.id);
  const operations =
    dropped.length === 0
      ? state.operations
      : state.operations.map((o) =>
          calledOff(o) ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn } : o,
        );

  return {
    state: { ...returned, mourningUntil: until, mourningForBoss: forBoss, operations },
    logs,
  };
}

/** A boss's funeral. Kept for the jail and succession paths. */
export function declareMourning(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  return declareFuneral(state, true);
}
