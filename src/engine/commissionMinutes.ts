import type { CrewMember, FamilyName, GameState, RelationStatus, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { getRelation, statusFromScore } from "./relations";
import { familyHeadless, livingBoss } from "./jail";

/** Log lines the table would talk about. Player-side chatter (your own proposals) stays out. */
const MINUTE_PREFIXES = [
  "log_hit_",
  "log_ai_hit_",
  "succ_",
  "log_defunct_",
  "log_defect_",
  "log_pact_break_",
  "log_pact_lapse_",
  "log_deal_break_",
  "log_deal_honor_",
  "log_deal_expired_",
  "log_sitdown_held_",
  "log_sitdown_table_",
  "log_sitdown_abort_",
  "log_sitdown_no_",
  "log_sitdown_moot_",
  "log_table_",
  "log_commission_",
  "log_lobby_",
];

export const MINUTES_WEEKS = 3;

export function isMinute(log: TurnLogEntry): boolean {
  return MINUTE_PREFIXES.some((p) => log.id.startsWith(p));
}

/** Newest first, capped. */
export function commissionMinutes(
  logs: TurnLogEntry[],
  turn: number,
  weeks = MINUTES_WEEKS,
  limit = 6,
): TurnLogEntry[] {
  return logs
    .filter((l) => l.turn > turn - weeks && isMinute(l))
    .slice(-limit)
    .reverse();
}

export function minuteAge(log: TurnLogEntry, turn: number): string {
  const d = turn - log.turn;
  if (d <= 0) return "this week";
  if (d === 1) return "last week";
  return `${d} wks ago`;
}

/** Which family's dot sits by the line: for hits, the one it happened to. */
export function minuteFamily(log: TurnLogEntry): FamilyName | undefined {
  return log.victim ?? log.family;
}

export type SeatChip =
  | { kind: "new_boss"; name: string; weeks: number }
  | { kind: "headless" }
  | { kind: "finished" }
  | { kind: "jailed"; name: string }
  | { kind: "wounded"; name: string }
  | { kind: "sanctioned" };

const NEW_BOSS_WEEKS = 4;

/** What's changed in a family's chair, read straight from the roster. */
export function seatChips(
  state: Pick<GameState, "crew" | "turn"> &
    Partial<Pick<GameState, "defunctFamilies" | "diplomacy" | "playerFamily">>,
  family: FamilyName,
): SeatChip[] {
  const chips: SeatChip[] = [];
  if ((state.defunctFamilies ?? []).includes(family)) {
    chips.push({ kind: "finished" });
    return chips;
  }
  const boss: CrewMember | undefined = livingBoss(state, family);
  if (!boss) {
    chips.push({ kind: "headless" });
    return chips;
  }
  const last = boss.name.split(" ").slice(-1)[0] ?? boss.name;
  if (boss.status === "jailed") chips.push({ kind: "jailed", name: last });
  else if (boss.status === "wounded") chips.push({ kind: "wounded", name: last });
  if (familyHeadless(state, family)) chips.push({ kind: "headless" });
  const since = boss.roleSinceTurn;
  if (since != null && since > 0 && state.turn - since < NEW_BOSS_WEEKS) {
    chips.push({ kind: "new_boss", name: last, weeks: state.turn - since });
  }
  if (family === state.playerFamily && (state.diplomacy?.sanctionUntil ?? 0) > state.turn) {
    chips.push({ kind: "sanctioned" });
  }
  return chips;
}

export interface Feud {
  a: FamilyName;
  b: FamilyName;
  status: Extract<RelationStatus, "war" | "hostile" | "allied">;
}

/** Rival-on-rival wars and alliances the table can see. The player's own rows are shown elsewhere. */
export function rivalFeuds(state: Pick<GameState, "relations" | "playerFamily">): Feud[] {
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
  const out: Feud[] = [];
  for (let i = 0; i < rivals.length; i++) {
    for (let j = i + 1; j < rivals.length; j++) {
      const a = rivals[i]!;
      const b = rivals[j]!;
      const status = statusFromScore(getRelation(state.relations, a, b));
      if (status === "war" || status === "hostile" || status === "allied") out.push({ a, b, status });
    }
  }
  return out.sort((x, y) => rank(x.status) - rank(y.status));
}

function rank(s: Feud["status"]): number {
  return s === "war" ? 0 : s === "hostile" ? 1 : 2;
}
