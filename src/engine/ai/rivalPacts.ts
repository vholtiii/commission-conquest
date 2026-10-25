import type { FamilyName, GameState, RivalPact } from "@/types/game";

export function activeRivalPacts(state: Pick<GameState, "diplomacy" | "turn">): RivalPact[] {
  return (state.diplomacy?.rivalPacts ?? []).filter((p) => p.until > state.turn);
}

/** The pact binding two rival families this week, if any. */
export function rivalPactBetween(
  state: Pick<GameState, "diplomacy" | "turn">,
  a: FamilyName,
  b: FamilyName,
): RivalPact | undefined {
  return activeRivalPacts(state).find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
}

/** The family a coalition member is lined up against, if it is in one. */
export function coalitionTarget(
  state: Pick<GameState, "diplomacy" | "turn">,
  family: FamilyName,
): FamilyName | undefined {
  return activeRivalPacts(state).find((p) => p.kind === "coalition" && (p.a === family || p.b === family))?.target;
}
