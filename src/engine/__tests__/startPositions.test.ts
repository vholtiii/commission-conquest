import { describe, expect, it } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { buildInitialState } from "@/engine/initialState";
import { dealStartingHoldings, dealtSeats } from "@/engine/startPositions";
import { valueScore } from "@/engine/territoryValue";

function hops(from: string, to: string, adj: Map<string, string[]>): number {
  if (from === to) return 0;
  const dist = new Map<string, number>([[from, 0]]);
  const q = [from];
  while (q.length > 0) {
    const cur = q.shift()!;
    const d = dist.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (dist.has(next)) continue;
      if (next === to) return d + 1;
      dist.set(next, d + 1);
      q.push(next);
    }
  }
  return 99;
}

describe("opening deal", () => {
  it("is the same city for the same seed, with five seats and a tight value spread", () => {
    const map = buildInitialState(21, { startMode: "classic" }).territories;
    const first = dealStartingHoldings(map, 21);
    const second = dealStartingHoldings(map, 21);
    expect(first.homeSeats).toEqual(second.homeSeats);
    const seats = ALL_FAMILY_NAMES.map((name) => first.homeSeats[name]!);
    expect(new Set(seats).size).toBe(5);
    const adj = new Map(first.territories.map((t) => [t.id, t.adjacentTerritories]));
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        expect(hops(seats[i]!, seats[j]!, adj)).toBeGreaterThanOrEqual(1);
      }
    }
    for (const seed of [21, 3, 8, 40, 77]) {
      const dealt = dealStartingHoldings(map, seed);
      const totals = ALL_FAMILY_NAMES.map((name) =>
        dealt.territories.filter((t) => t.owner === name).reduce((n, t) => n + valueScore(t), 0),
      );
      const max = Math.max(...totals);
      const min = Math.min(...totals);
      expect((max - min) / max).toBeLessThanOrEqual(0.15);
    }
  });

  it("keeps home seats only for a game that was dealt at random", () => {
    const homeSeats = { Moretti: "west_village" };
    expect(dealtSeats({ homeSeats })).toBeUndefined();
    expect(dealtSeats({ settings: { startMode: "classic" }, homeSeats })).toBeUndefined();
    expect(dealtSeats({ settings: { startMode: "random" }, homeSeats })).toEqual(homeSeats);
  });
});
