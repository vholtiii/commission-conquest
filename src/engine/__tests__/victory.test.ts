import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import {
  checkVictory,
  DIRTY_WEIGHT,
  familiesPressingSuddenDeath,
  familyWealth,
  wealthFloor,
} from "@/engine/victory";
import type { FamilyName, GameState } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

/** Every rival holds `each`; the player holds the given clean and dirty cash. */
function withMoney(state: GameState, turn: number, money: number, dirty: number, each: number): GameState {
  const rivalTreasury: Partial<Record<FamilyName, number>> = {};
  for (const f of Object.keys(state.rivalTreasury ?? {}) as FamilyName[]) rivalTreasury[f] = each;
  return { ...state, turn, money, dirtyMoney: dirty, rivalTreasury };
}

describe("wealth win", () => {
  it("weights dirty cash by DIRTY_WEIGHT", () => {
    const s = withMoney(game(), 12, 10_000, 8_000, 1_000);
    expect(familyWealth(s, "Moretti")).toBe(10_000 + 8_000 * DIRTY_WEIGHT);
  });

  it("raises the bar every week", () => {
    expect(wealthFloor(10)).toBe(45_000);
    expect(wealthFloor(30)).toBe(75_000);
  });

  it("presses at turn 10 only past the week's bar", () => {
    const base = game();
    const short = withMoney(base, 10, 44_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(short)).not.toContain("Moretti");
    const clear = withMoney(base, 10, 46_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(clear)).toContain("Moretti");
  });

  it("the same pile is not enough at turn 30", () => {
    const s = withMoney(game(), 30, 70_000, 0, 1_000);
    expect(familyWealth(s, "Moretti")).toBe(70_000);
    expect(familiesPressingSuddenDeath(s)).not.toContain("Moretti");
    expect(checkVictory(s).wealthLeadTurns).toBe(0);
  });

  it("no streak starts on turn 1, however rich", () => {
    const s = withMoney(game(), 1, 500_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(s)).toEqual([]);
    expect(checkVictory(s).wealthLeadTurns).toBe(0);
  });

});
