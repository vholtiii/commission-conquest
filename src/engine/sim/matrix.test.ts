import { describe, expect, it } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { FamilyName, GameLength, GameSettings } from "@/types/game";
import { balanceNotes, simulateGame, writeReport, type SimResult } from "./runSim";

const SEEDS = [11, 29, 47, 83];

function matrix(): SimResult[] {
  const games: SimResult[] = [];
  const difficulties: GameSettings["difficulty"][] = ["easy", "normal", "hard"];
  for (const family of ALL_FAMILY_NAMES) {
    for (const difficulty of difficulties) {
      for (const seed of SEEDS) {
        games.push(simulateGame({ seed, family: family as FamilyName, difficulty, gameLength: "medium" }));
      }
    }
    games.push(simulateGame({ seed: 11, family: family as FamilyName, difficulty: "normal", gameLength: "short" as GameLength }));
    games.push(simulateGame({ seed: 11, family: family as FamilyName, difficulty: "normal", gameLength: "long" }));
  }
  return games;
}

describe("full-game simulation", () => {
  it("clears the stability and balance gates", () => {
    const games = matrix();
    const stability = games.flatMap((g) =>
      g.problems.map((p) => `${g.family} ${g.difficulty} ${g.gameLength} seed ${g.seed}: ${p}`),
    );
    const balance = balanceNotes(games);
    writeReport({ games, stability, balance });
    const lines = ["family  diff    length  seed  end   turn  slow  mourn  hits"];
    for (const g of games) {
      lines.push(
        `${g.family.padEnd(8)} ${g.difficulty.padEnd(7)} ${g.gameLength.padEnd(6)} ${String(g.seed).padEnd(5)} ${g.outcome.padEnd(5)} ${String(g.turn).padEnd(5)} ${String(g.slowestEndTurnMs).padEnd(5)} ${String(g.mourningWeeks).padEnd(6)} ${g.hitsAbsent}/${g.hits}`,
      );
    }
    console.log(lines.join("\n"));
    console.log(balance.length ? `balance: ${balance.join("; ")}` : "balance gates clear");
    expect(stability, stability.slice(0, 12).join("\n")).toEqual([]);
    expect(balance, balance.join("\n")).toEqual([]);
  }, 600_000);
});
