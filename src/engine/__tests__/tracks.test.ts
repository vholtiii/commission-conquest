import { describe, expect, it, vi } from "vitest";
import { heatTakeMult } from "@/engine/heat";
import { boroughSeats, seatsHeld } from "@/engine/boroughSeats";
import { exposedCash, COUNT_HOUSE_SAFE } from "@/engine/countHouse";
import { buildInitialState, startGame } from "@/engine/initialState";
import type { GameState } from "@/types/game";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }) }));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

describe("heat and seats", () => {
  it("cuts illegal take only past heat 40, down to 70% at 100", () => {
    expect(heatTakeMult(40)).toBe(1);
    expect(heatTakeMult(100)).toBeCloseTo(0.7);
    expect(heatTakeMult(70)).toBeCloseTo(0.85);
  });

  it("gives a seat to the family holding more than half a borough", () => {
    const state = game();
    const borough = state.territories[0]!.borough;
    const blocks = state.territories.filter((t) => t.borough === borough);
    const owned = {
      ...state,
      territories: state.territories.map((t) => (t.borough === borough ? { ...t, owner: "Moretti" as const } : t)),
    };
    expect(blocks.length).toBeGreaterThan(0);
    expect(seatsHeld(owned, "Moretti")).toBeGreaterThanOrEqual(1);
    expect(boroughSeats(owned).find((s) => s.borough === borough)?.holder).toBe("Moretti");
  });

  it("exposes only the dirty cash above the safe pile", () => {
    const state = { ...game(), dirtyMoney: COUNT_HOUSE_SAFE + 2500 };
    expect(exposedCash(state, "Moretti")).toBe(2500);
  });
});
