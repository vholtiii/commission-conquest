import { describe, expect, it } from "vitest";
import { balanceNotes, simulateGame } from "./runSim";

const SEEDS = [11, 29, 47, 83, 131, 173, 211, 257];

describe("map size simulations", () => {
  it("keeps small and large games inside the opening and stability gates", () => {
    const games = (["small", "large"] as const).flatMap((mapSize) =>
      SEEDS.map((seed) =>
        simulateGame({
          seed,
          family: "Moretti",
          difficulty: "normal",
          gameLength: "medium",
          mapSize,
        }),
      ),
    );
    const stability = games.flatMap((g) =>
      g.problems.map((p) => `${g.family} ${g.difficulty} seed ${g.seed}: ${p}`),
    );
    const notes = balanceNotes(games);
    const widest = Math.max(...games.map((g) => g.openingSpread));
    console.log(
      games
        .map((g) => `${g.family} seed ${g.seed} ${g.outcome} turn ${g.turn} spread ${g.openingSpread.toFixed(3)}`)
        .join("\n"),
    );
    console.log(notes.length ? notes.join("; ") : "balance gates clear", `widest opening ${widest.toFixed(3)}`);
    expect(stability, stability.slice(0, 8).join("\n")).toEqual([]);
    expect(widest).toBeLessThanOrEqual(0.15);
    expect(notes.filter((n) => n.startsWith("opening value"))).toEqual([]);
  }, 600_000);
});
