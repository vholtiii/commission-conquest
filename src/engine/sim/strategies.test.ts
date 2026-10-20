import { describe, expect, it } from "vitest";
import type { FamilyName } from "@/types/game";
import type { SimStrategy } from "./autoPlayer";
import { simulateGame, writeReport, type SimResult } from "./runSim";

/** One game each, a different family and seed, all on Normal at medium length. */
const GAMES: { strategy: SimStrategy; family: FamilyName; seed: number }[] = [
  { strategy: "balanced", family: "Moretti", seed: 11 },
  { strategy: "racketeer", family: "Valenti", seed: 29 },
  { strategy: "warmonger", family: "Ferraro", seed: 47 },
  { strategy: "expansionist", family: "Salvati", seed: 83 },
  { strategy: "turtle", family: "Rinaldi", seed: 101 },
];

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
}

function rivalWealth(g: SimResult): number {
  return Object.entries(g.wealth)
    .filter(([name]) => name !== g.family)
    .reduce((sum, [, value]) => sum + value, 0);
}

describe("strategy simulations", () => {
  it("plays five styles on Normal and stays stable", () => {
    const games = GAMES.map((g) =>
      simulateGame({ ...g, difficulty: "normal", gameLength: "medium" }),
    );
    const stability = games.flatMap((g) =>
      g.problems.map((p) => `${g.strategy} ${g.family} seed ${g.seed}: ${p}`),
    );
    writeReport({ games, stability, balance: [] }, "sim-strategies.json");

    const lines = [
      "strategy      family   end    week  player     rivals     held  taken  lost  heat",
    ];
    for (const g of games) {
      lines.push(
        [
          (g.strategy ?? "").padEnd(13),
          g.family.padEnd(8),
          g.outcome.padEnd(6),
          String(g.turn).padEnd(5),
          money(g.wealth[g.family] ?? 0).padEnd(10),
          money(rivalWealth(g)).padEnd(10),
          String(g.districts[g.family] ?? 0).padEnd(5),
          String(g.hitsTaken).padEnd(6),
          String(g.districtsLost).padEnd(5),
          String(g.peakHeat),
        ].join(" "),
      );
      if (g.reason) lines.push(`  ${g.reason}`);
    }
    console.log(lines.join("\n"));
    expect(stability, stability.slice(0, 12).join("\n")).toEqual([]);
  }, 600_000);
});
