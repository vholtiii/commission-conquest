import { describe, expect, it } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { beltTighten, tickRivalHeat } from "@/engine/rivalHeat";
import type { Rng } from "@/engine/rng";

const always: Rng = {
  seed: 1,
  next: () => 0,
  int: (min) => min,
  chance: () => true,
  pick: (arr) => arr[0]!,
  shuffle: (arr) => [...arr],
};

describe("rival pressure", () => {
  it("lets a broke family's cheapest associate go", () => {
    const game = startGame(buildInitialState(8, { startMode: "classic" }), "Moretti");
    const family = "Valenti";
    const soldier = game.crew.find((c) => c.family === family && c.role === "soldier");
    expect(soldier).toBeTruthy();
    const crew = [...game.crew, { ...soldier!, id: "temp_assoc", role: "associate" as const }];
    const cut = beltTighten(game.territories, crew, family);
    expect(cut.note).toBeTruthy();
    expect(cut.crew.some((c) => c.id === "temp_assoc")).toBe(false);
  });

  it("raids a hot rival instead of jailing the boss", () => {
    const game = startGame(buildInitialState(9, { startMode: "classic" }), "Moretti");
    const family = "Ferraro";
    const boss = game.crew.find((c) => c.family === family && c.role === "boss");
    const raided = tickRivalHeat({ ...game, rivalHeat: { [family]: 90 } }, game.territories, game.crew, () => always);
    expect(raided.logs.length).toBeGreaterThan(0);
    const bossAfter = raided.crew.find((c) => c.id === boss?.id);
    expect(bossAfter?.status).not.toBe("jailed");
  });
});
