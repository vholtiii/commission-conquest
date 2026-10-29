import { describe, expect, it } from "vitest";
import { declareMourning, handsDown, MOURNING_WEEKS } from "@/engine/mourning";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import { resolvePlayerHits } from "@/engine/turnPipeline";
import type { Operation } from "@/types/game";

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

  it("calls off a street hit and leaves a Commission hit standing", () => {
    const game = startGame(buildInitialState(7), "Moretti");
    const territoryId = game.territories.find((t) => t.owner === "Valenti")?.id ?? game.territories[0]!.id;
    const street: Operation = {
      id: "street",
      family: "Moretti",
      kind: "hit",
      targetTerritoryId: territoryId,
      targetFamily: "Valenti",
      shooterIds: [],
      surveilled: false,
      pendingTurns: 1,
      resolved: false,
      approach: "ambush",
    };
    const table: Operation = { ...street, id: "table", intent: "commission", errandId: "errand_1" };
    const quiet = declareMourning({ ...game, turn: 10, operations: [street, table] });
    expect(quiet.state.operations.find((o) => o.id === "street")?.resolved).toBe(true);
    const standing = quiet.state.operations.find((o) => o.id === "table");
    expect(standing?.resolved).toBe(false);
    expect(standing?.pendingTurns).toBe(1);
    expect(quiet.logs[0]?.text).toContain("except the table's order");

    const landed = resolvePlayerHits(
      { ...quiet.state, turn: 11 },
      createRng(1),
    );
    expect(landed.state.operations.find((o) => o.id === "street")?.resolved).toBe(true);
    expect(landed.state.operations.find((o) => o.id === "table")?.resolved).toBe(true);
    expect(handsDown(landed.state)).toBe(true);
  });
});
