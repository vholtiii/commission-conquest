/**
 * Holding more than half a borough's blocks is a Commission seat: a weekly
 * standing bonus and an extra vote, for as long as the majority holds.
 */
import type { FamilyName, GameState } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";

export const SEAT_STANDING = 1.5;

export interface BoroughSeat {
  borough: string;
  holder: FamilyName | null;
  held: number;
  total: number;
  /** Blocks the nearest challenger still needs, or the holder would lose on. */
  gap: number;
}

function seated(state: Pick<GameState, "defunctFamilies">): Set<FamilyName> {
  return new Set(ALL_FAMILY_NAMES.filter((f) => !(state.defunctFamilies ?? []).includes(f)));
}

export function boroughSeats(state: Pick<GameState, "territories" | "defunctFamilies">): BoroughSeat[] {
  const alive = seated(state);
  const byBorough = new Map<string, { total: number; counts: Partial<Record<FamilyName, number>> }>();
  for (const t of state.territories) {
    const row = byBorough.get(t.borough) ?? { total: 0, counts: {} };
    row.total += 1;
    if (t.owner && alive.has(t.owner)) row.counts[t.owner] = (row.counts[t.owner] ?? 0) + 1;
    byBorough.set(t.borough, row);
  }
  return [...byBorough.entries()]
    .map(([borough, row]) => {
      const ranked = (Object.entries(row.counts) as [FamilyName, number][]).sort((a, b) => b[1] - a[1]);
      const top = ranked[0];
      const second = ranked[1]?.[1] ?? 0;
      const holder = top && top[1] * 2 > row.total ? top[0] : null;
      const held = top?.[1] ?? 0;
      const need = Math.floor(row.total / 2) + 1;
      const gap = holder ? Math.max(0, held - second) : Math.max(0, need - held);
      return { borough, holder, held, total: row.total, gap };
    })
    .sort((a, b) => a.borough.localeCompare(b.borough));
}

export function seatsHeld(state: Pick<GameState, "territories" | "defunctFamilies">, family: FamilyName): number {
  return boroughSeats(state).filter((s) => s.holder === family).length;
}

/** Standing added this week for the seats a family holds. */
export function seatStanding(state: Pick<GameState, "territories" | "defunctFamilies">, family: FamilyName): number {
  return seatsHeld(state, family) * SEAT_STANDING;
}

/**
 * Extra votes a family casts with the seats it holds. The caller and the
 * accused vote for themselves; everyone else follows the vote they already cast.
 */
export function seatVotes(
  state: Pick<GameState, "territories" | "defunctFamilies">,
  family: FamilyName,
  side: "caller" | "accused" | "abstain",
): number {
  if (side === "abstain") return 0;
  return seatsHeld(state, family);
}
