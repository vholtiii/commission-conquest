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
    expect(wealthFloor(10)).toBe(30_000);
    expect(wealthFloor(30)).toBe(50_000);
  });

  it("presses at turn 10 only past the week's bar", () => {
    const base = game();
    const short = withMoney(base, 10, 20_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(short)).not.toContain("Moretti");
    const clear = withMoney(base, 10, 30_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(clear)).toContain("Moretti");
  });

  it("the same pile is not enough at turn 30", () => {
    const s = withMoney(game(), 30, 40_000, 0, 1_000);
    expect(familyWealth(s, "Moretti")).toBe(40_000);
    expect(familiesPressingSuddenDeath(s)).not.toContain("Moretti");
    expect(checkVictory(s).wealthLeadTurns).toBe(0);
  });

  it("no streak starts on turn 1, however rich", () => {
    const s = withMoney(game(), 1, 500_000, 0, 1_000);
    expect(familiesPressingSuddenDeath(s)).toEqual([]);
    expect(checkVictory(s).wealthLeadTurns).toBe(0);
  });

  it("ignores a finished family's treasury and turf", () => {
    const s = withMoney(game(), 12, 40_000, 0, 1_000);
    s.rivalTreasury = { ...s.rivalTreasury, Valenti: 900_000 };
    s.defunctFamilies = ["Valenti"];
    expect(familiesPressingSuddenDeath(s)).toContain("Moretti");
    expect(checkVictory(s).won).toBe(false);
    expect(checkVictory(s).wealthLeadTurns).toBe(1);
  });

  it("refuses a wealth lead that is almost all dirty", () => {
    const s = withMoney(game(), 12, 5_000, 80_000, 1_000);
    expect(familiesPressingSuddenDeath(s)).not.toContain("Moretti");
  });

  it("crowns the last family standing", () => {
    const s = game();
    s.turn = 3;
    s.defunctFamilies = ["Valenti", "Ferraro", "Salvati", "Rinaldi"];
    const end = checkVictory(s);
    expect(end.won).toBe(true);
    expect(end.reason).toMatch(/last family/i);
  });

  it("lets a rival finish a streak, and gives the player a same-week tie", () => {
    let s = withMoney(game(), 10, 1_000, 0, 1_000);
    s = { ...s, rivalTreasury: { ...s.rivalTreasury, Valenti: 500_000 } };
    for (let i = 0; i < 6; i++) {
      s = { ...s, turn: 10 + i };
      s = { ...s, victory: checkVictory(s) };
    }
    expect(s.victory.lost).toBe(true);
    expect(s.victory.winner).toBe("Valenti");

    let tied = withMoney(game(), 10, 200_000, 0, 1_000);
    tied = { ...tied, influence: 100, rivalInfluence: { ...tied.rivalInfluence, Valenti: 300 } };
    for (let i = 0; i < 6; i++) {
      tied = { ...tied, turn: 10 + i };
      tied = { ...tied, victory: checkVictory(tied) };
    }
    expect(tied.victory.won).toBe(true);
    expect(tied.victory.winner).toBe("Moretti");
  });

});
