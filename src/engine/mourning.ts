import type { GameState, TurnLogEntry } from "@/types/game";
import { hitCrewIds } from "@/data/hitApproaches";
import { releaseCrewHome } from "./jobReturn";

/** Weeks the city stays quiet after a boss is killed, counting the week he dies. */
export const MOURNING_WEEKS = 3;

/** No family may order or land a hit while this is true. A Commission order is the exception. */
export function handsDown(state: { turn: number; mourningUntil?: number }): boolean {
  return state.turn < (state.mourningUntil ?? 0);
}

/** A hit the Commission ordered. It goes out while the city is quiet for a funeral. */
export function tableHit(op: { kind: string; intent?: string; errandId?: string }): boolean {
  return op.kind === "hit" && (op.intent === "commission" || !!op.errandId);
}

/**
 * The week a boss dies. Every family stands down for three weeks.
 * A later death starts those three weeks over. Unresolved hits are called off,
 * except one the Commission ordered. The hit that just landed is already resolved and stands.
 */
export function declareMourning(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  // A chair that just emptied is its own crisis. The funeral is two weeks, not three.
  const weeks = state.interregnum?.startedTurn === state.turn ? 2 : MOURNING_WEEKS;
  const until = state.turn + weeks;
  const previous = state.mourningUntil ?? 0;
  const already = previous > state.turn;
  const logs: TurnLogEntry[] = [];
  const span = weeks === 2 ? "Two weeks" : "Three weeks";
  const tableOut = state.operations.some((o) => !o.resolved && tableHit(o));
  const quiet = tableOut ? "Nobody gets shot, except the table's order." : "Nobody gets shot.";
  if (!already) {
    logs.push({
      id: `log_mourning_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `The city goes quiet for the funeral. ${span}. ${quiet}`,
      family: state.playerFamily ?? undefined,
    });
  } else if (previous !== until) {
    logs.push({
      id: `log_mourning_reset_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `Another boss is in the ground. The quiet starts over — ${span.toLowerCase()}, ${quiet.toLowerCase()}`,
      family: state.playerFamily ?? undefined,
    });
  }

  const calledOff = (o: (typeof state.operations)[number]) => !o.resolved && o.kind === "hit" && !tableHit(o);
  const dropped = state.operations.filter(calledOff);
  let returned = state;
  for (const o of dropped) returned = releaseCrewHome(returned, hitCrewIds(o), o.id);
  const operations =
    dropped.length === 0
      ? state.operations
      : state.operations.map((o) =>
          calledOff(o) ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn } : o,
        );

  return { state: { ...returned, mourningUntil: until, operations }, logs };
}
