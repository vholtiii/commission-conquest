import type { GameState, TurnLogEntry } from "@/types/game";
import { hitCrewIds } from "@/data/hitApproaches";
import { releaseCrewHome } from "./jobReturn";

/** Weeks the city stays quiet after a boss is killed, counting the week he dies. */
export const MOURNING_WEEKS = 6;

/** No family may order or land a hit while this is true. */
export function handsDown(state: { turn: number; mourningUntil?: number }): boolean {
  return state.turn < (state.mourningUntil ?? 0);
}

/**
 * The week a boss dies. Every family stands down for six weeks.
 * A later death starts those six weeks over. Unresolved hits are called off;
 * the hit that just landed is already resolved and stands.
 */
export function declareMourning(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const until = state.turn + MOURNING_WEEKS;
  const previous = state.mourningUntil ?? 0;
  const already = previous > state.turn;
  const logs: TurnLogEntry[] = [];
  if (!already) {
    logs.push({
      id: `log_mourning_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: "The city goes quiet for the funeral. Six weeks. Nobody gets shot.",
      family: state.playerFamily ?? undefined,
    });
  } else if (previous !== until) {
    logs.push({
      id: `log_mourning_reset_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: "Another boss is in the ground. The quiet starts over — six weeks, nobody gets shot.",
      family: state.playerFamily ?? undefined,
    });
  }

  const dropped = state.operations.filter((o) => !o.resolved && o.kind === "hit");
  let returned = state;
  for (const o of dropped) returned = releaseCrewHome(returned, hitCrewIds(o), o.id);
  const operations =
    dropped.length === 0
      ? state.operations
      : state.operations.map((o) =>
          !o.resolved && o.kind === "hit"
            ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn }
            : o,
        );

  return { state: { ...returned, mourningUntil: until, operations }, logs };
}
