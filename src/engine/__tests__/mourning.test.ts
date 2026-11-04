import { describe, expect, it } from "vitest";
import {
  commissionHeld,
  declareFuneral,
  declareMourning,
  funeralWeeksLeft,
  handsDown,
  MOURNING_WEEKS,
  STREET_FUNERAL_WEEKS,
} from "@/engine/mourning";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import { resolvePlayerHits } from "@/engine/turnPipeline";
import { canWorkErrand } from "@/engine/commissionErrand";
import type { CommissionErrand, Operation } from "@/types/game";

function streetOp(territoryId: string): Operation {
  return {
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
}

function tableOp(territoryId: string): Operation {
  return { ...streetOp(territoryId), id: "table", intent: "commission", errandId: "errand_1" };
}

function huntingErrand(path: string[], turn: number, found = false): CommissionErrand {
  return {
    id: "errand_1",
    phase: "hunting",
    kind: "stranger",
    targetName: "No-Name",
    path,
    leadIndex: 0,
    detail: "A lead.",
    found,
    untilTurn: turn + 5,
    openedTurn: turn,
  };
}

describe("funeral quiet", () => {
  it("lasts three weeks and a second death starts the count over", () => {
    expect(MOURNING_WEEKS).toBe(3);
    const game = startGame(buildInitialState(7), "Moretti");
    const first = declareMourning({ ...game, turn: 10 });
    expect(first.state.mourningUntil).toBe(13);
    expect(first.state.mourningForBoss).toBe(true);
    expect(handsDown({ turn: 10, mourningUntil: 13 })).toBe(true);
    expect(handsDown({ turn: 12, mourningUntil: 13 })).toBe(true);
    expect(handsDown({ turn: 13, mourningUntil: 13 })).toBe(false);
    expect(commissionHeld(first.state)).toBe(true);
    const second = declareMourning({ ...first.state, turn: 11 });
    expect(second.state.mourningUntil).toBe(14);
    expect(second.logs[0]?.text).toContain("three weeks");
  });

  it("a soldier's funeral is one week, Commission hit still stands, casing is allowed", async () => {
    expect(STREET_FUNERAL_WEEKS).toBe(1);
    const game = startGame(buildInitialState(7), "Moretti");
    const territoryId = game.territories.find((t) => t.owner === "Valenti")?.id ?? game.territories[0]!.id;
    const street = streetOp(territoryId);
    const table = tableOp(territoryId);
    const quiet = declareFuneral({ ...game, turn: 10, operations: [street, table] }, false);
    expect(quiet.state.mourningUntil).toBe(11);
    expect(quiet.state.mourningForBoss).toBe(false);
    expect(handsDown(quiet.state)).toBe(true);
    expect(commissionHeld(quiet.state)).toBe(false);
    expect(funeralWeeksLeft(quiet.state)).toBe(1);
    expect(quiet.state.operations.find((o) => o.id === "street")?.resolved).toBe(true);
    const standing = quiet.state.operations.find((o) => o.id === "table");
    expect(standing?.resolved).toBe(false);
    expect(standing?.pendingTurns).toBe(1);

    const landed = resolvePlayerHits({ ...quiet.state, turn: 10 }, createRng(1));
    expect(landed.state.operations.find((o) => o.id === "table")?.resolved).toBe(true);

    const lookout = quiet.state.crew.find(
      (c) => c.family === "Moretti" && canWorkErrand(c, quiet.state.operations),
    );
    expect(lookout).toBeTruthy();
    const { useGameStore } = await import("@/engine/store");
    useGameStore.setState({
      ...quiet.state,
      commissionErrand: huntingErrand([territoryId], 10),
    });
    const before = useGameStore.getState().operations.length;
    useGameStore.getState().caseCommissionErrand(lookout!.id);
    expect(useGameStore.getState().operations.length).toBeGreaterThan(before);
  });

  it("a boss funeral calls off the table hit and refuses casing and the order", async () => {
    const game = startGame(buildInitialState(7), "Moretti");
    const territoryId = game.territories.find((t) => t.owner === "Valenti")?.id ?? game.territories[0]!.id;
    const street = streetOp(territoryId);
    const table = tableOp(territoryId);
    const quiet = declareMourning({ ...game, turn: 10, operations: [street, table] });
    expect(quiet.state.mourningUntil).toBe(13);
    expect(quiet.state.mourningForBoss).toBe(true);
    expect(commissionHeld(quiet.state)).toBe(true);
    expect(quiet.state.operations.find((o) => o.id === "street")?.resolved).toBe(true);
    expect(quiet.state.operations.find((o) => o.id === "table")?.resolved).toBe(true);

    const lookout = quiet.state.crew.find(
      (c) => c.family === "Moretti" && canWorkErrand(c, quiet.state.operations),
    );
    expect(lookout).toBeTruthy();
    const { useGameStore } = await import("@/engine/store");
    useGameStore.setState({
      ...quiet.state,
      operations: quiet.state.operations.filter((o) => o.id !== "table"),
      commissionErrand: huntingErrand([territoryId], 10),
    });
    const beforeCase = useGameStore.getState().operations.length;
    useGameStore.getState().caseCommissionErrand(lookout!.id);
    expect(useGameStore.getState().operations.length).toBe(beforeCase);

    useGameStore.setState({
      ...useGameStore.getState(),
      commissionErrand: huntingErrand([territoryId], 10, true),
    });
    const beforeHit = useGameStore.getState().operations.filter((o) => o.kind === "hit" && !o.resolved).length;
    useGameStore.getState().orderCommissionHit({ approach: "ambush", shooterIds: [lookout!.id] });
    const afterHit = useGameStore.getState().operations.filter((o) => o.kind === "hit" && !o.resolved).length;
    expect(afterHit).toBe(beforeHit);
  });

  it("a boss death during a street funeral upgrades and restarts", () => {
    const game = startGame(buildInitialState(7), "Moretti");
    const street = declareFuneral({ ...game, turn: 10 }, false);
    expect(street.state.mourningUntil).toBe(11);
    expect(street.state.mourningForBoss).toBe(false);
    const laterStreet = declareFuneral({ ...street.state, turn: 10 }, false);
    expect(laterStreet.state.mourningUntil).toBe(11);
    const boss = declareFuneral({ ...street.state, turn: 10 }, true);
    expect(boss.state.mourningUntil).toBe(13);
    expect(boss.state.mourningForBoss).toBe(true);
    expect(boss.logs[0]?.text).toMatch(/boss|quiet starts over/i);
    const stillStreet = declareFuneral({ ...boss.state, turn: 10 }, false);
    expect(stillStreet.state.mourningUntil).toBe(13);
    expect(stillStreet.state.mourningForBoss).toBe(true);
    expect(stillStreet.logs).toHaveLength(0);
  });
});
