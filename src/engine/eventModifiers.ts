/**
 * Lingering consequences of event choices. Pure reads over
 * `state.eventModifiers` so liquor, hits, recruiting and the economy can ask
 * without importing the event engine.
 */
import type { EventModifier, EventModifierKind, GameState, TurnLogEntry } from "@/types/game";

type ModState = Pick<GameState, "eventModifiers" | "turn">;

export function liveModifiers(state: ModState, kind?: EventModifierKind): EventModifier[] {
  return (state.eventModifiers ?? []).filter(
    (m) => m.untilTurn > state.turn && (!kind || m.kind === kind),
  );
}

/** Additive kinds: income, heatPerWeek, hitOdds, shipmentSpeed, recruitQuality. */
export function modifierSum(
  state: ModState,
  kind: EventModifierKind,
  territoryId?: string | null,
): number {
  return liveModifiers(state, kind)
    .filter((m) => (territoryId === undefined ? !m.territoryId : m.territoryId === territoryId))
    .reduce((n, m) => n + m.value, 0);
}

/** Multiplicative kinds: raidChance. */
export function modifierProduct(state: ModState, kind: EventModifierKind): number {
  return liveModifiers(state, kind).reduce((n, m) => n * m.value, 1);
}

/** Drop what has run out, with a line for each. */
export function expireModifiers(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const all = state.eventModifiers ?? [];
  const gone = all.filter((m) => m.untilTurn <= state.turn);
  if (gone.length === 0) return { state, logs: [] };
  return {
    state: { ...state, eventModifiers: all.filter((m) => m.untilTurn > state.turn) },
    logs: gone.map((m) => ({
      id: `log_mod_end_${m.id}`,
      turn: state.turn,
      category: "event" as const,
      text: `${m.label} has run its course.`,
      family: state.playerFamily ?? undefined,
      territoryId: m.territoryId,
    })),
  };
}

export function weeksLeft(state: ModState, m: EventModifier): number {
  return Math.max(0, m.untilTurn - state.turn);
}

/** "Raids −50%", "Hit odds +8%", "Heat +2/wk". */
export function modifierChip(m: Pick<EventModifier, "kind" | "value">): string {
  const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`;
  switch (m.kind) {
    case "income":
      return `Income ${pct(m.value)}`;
    case "heatPerWeek":
      return `Heat ${m.value >= 0 ? "+" : "−"}${Math.abs(m.value)}/wk`;
    case "raidChance":
      return `Raids ${pct(m.value - 1)}`;
    case "hitOdds":
      return `Hit odds ${pct(m.value)}`;
    case "shipmentSpeed":
      return m.value > 0 ? `Shipments +${m.value} wk` : `Shipments ${m.value} wk`;
    case "recruitQuality":
      return `Recruits ${m.value >= 0 ? "better" : "worse"}`;
  }
}
