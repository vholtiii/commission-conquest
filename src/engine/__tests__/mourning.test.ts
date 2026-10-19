import { describe, expect, it } from "vitest";
import { declareMourning, handsDown, MOURNING_WEEKS } from "@/engine/mourning";
import { buildInitialState, startGame } from "@/engine/initialState";

describe("funeral quiet", () => {
  it("lasts three weeks and a second death starts the count over", () => {
    expect(MOURNING_WEEKS).toBe(3);
    const game = startGame(buildInitialState(7), "Moretti");
    const first = declareMourning({ ...game, turn: 10 });
    expect(first.state.mourningUntil).toBe(13);
    expect(handsDown({ turn: 10, mourningUntil: 13 })).toBe(true);
    expect(handsDown({ turn: 12, mourningUntil: 13 })).toBe(true);
    expect(handsDown({ turn: 13, mourningUntil: 13 })).toBe(false);
    const second = declareMourning({ ...first.state, turn: 11 });
    expect(second.state.mourningUntil).toBe(14);
    expect(second.logs[0]?.text).toContain("three weeks");
  });
});
