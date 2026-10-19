import { describe, expect, it } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { endTurn } from "@/engine/turnPipeline";
import { createRng } from "@/engine/rng";

describe("a seeded season", () => {
  it("runs fifty weeks without broken numbers", () => {
    let state = startGame(buildInitialState(1234), "Moretti");
    const start = state.turn;
    const rng = createRng(1234);
    for (let i = 0; i < 50; i++) {
      state = endTurn(state, rng);
      expect(Number.isFinite(state.money)).toBe(true);
      expect(Number.isFinite(state.dirtyMoney)).toBe(true);
      for (const cash of Object.values(state.rivalTreasury ?? {})) {
        expect(Number.isFinite(cash)).toBe(true);
      }
      for (const t of state.territories) {
        for (const r of t.rackets) {
          expect(Number.isFinite(r.stock)).toBe(true);
          expect(r.stock).toBeGreaterThanOrEqual(0);
        }
      }
      expect(state.turnLog.length).toBeLessThanOrEqual(200);
    }
    expect(state.turn).toBe(start + 50);
  });
});
