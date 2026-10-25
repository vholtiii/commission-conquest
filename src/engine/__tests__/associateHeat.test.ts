import { describe, expect, it } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createCrewMember, tiedToFamily } from "@/engine/crew";
import { createRacket, processEconomyTurn, processLaundering, tickDistrictHeat } from "@/engine/economy";
import { exposureHeat } from "@/engine/hitOps";
import { createRng } from "@/engine/rng";
import type { CrewMember, CrewRole, GameState } from "@/types/game";

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

function man(role: CrewRole, seed: number): CrewMember {
  return createCrewMember(createRng(seed), "Moretti", role);
}

/** The base game plus one racket on a player block, run by `manager`. */
function withRacket(manager: CrewMember, extra: Record<string, unknown> = {}) {
  const base = game();
  const block = base.territories.find((t) => t.owner === "Moretti")!;
  const racket = { ...createRacket("r_assoc_test", block.id, "speakeasy", 3, 0), managerId: manager.id, ...extra };
  const territories = base.territories.map((t) =>
    t.id === block.id ? { ...t, rackets: [...t.rackets, racket] } : t,
  );
  const state: GameState = { ...base, turn: 20, crew: [...base.crew, manager], territories };
  return { state, racketId: racket.id };
}

describe("tiedToFamily", () => {
  it("is false only for associates", () => {
    expect(tiedToFamily(man("associate", 1))).toBe(false);
    for (const role of ["soldier", "capo", "underboss", "consigliere", "boss"] as CrewRole[]) {
      expect(tiedToFamily(man(role, 2))).toBe(true);
    }
    expect(tiedToFamily(undefined)).toBe(false);
  });
});

describe("fronts run by associates", () => {
  it("add no family heat, and the block heats the same", () => {
    const soldier = withRacket(man("soldier", 3));
    const associate = withRacket(man("associate", 4));
    const soldierHeat = processEconomyTurn(soldier.state, "Moretti").heatDelta;
    const associateHeat = processEconomyTurn(associate.state, "Moretti").heatDelta;
    expect(associateHeat).toBeLessThan(soldierHeat);
    const heats = (s: GameState) => tickDistrictHeat(s.territories).map((t) => t.heatLevel);
    expect(heats(associate.state)).toEqual(heats(soldier.state));
  });

  it("freeze and lose the money in an audit but add no heat", () => {
    const audit = (m: CrewMember) => {
      const { state } = withRacket(m, {
        type: "laundromat",
        heatGen: 1,
        launderReadyTurn: 1,
        scrutiny: 1.5,
        auditOpenedTurn: 18,
        auditDueTurn: 20,
      });
      return processLaundering({ ...state, dirtyMoney: 1_000_000, launderPlan: {} }, state.territories);
    };
    const bySoldier = audit(man("soldier", 5));
    const byAssociate = audit(man("associate", 6));
    expect(bySoldier.audits).toHaveLength(1);
    expect(byAssociate.audits).toHaveLength(1);
    expect(bySoldier.audits[0]!.heat).toBeGreaterThan(0);
    expect(byAssociate.audits[0]!.heat).toBe(0);
    expect(byAssociate.heatDelta).toBe(0);
    expect(byAssociate.audits[0]!.seized).toBe(bySoldier.audits[0]!.seized);
    expect(byAssociate.racketUpdates.get("r_assoc_test")?.frozenUntil).toBeGreaterThan(20);
  });
});

describe("hit exposure heat", () => {
  it("counts only made men past two", () => {
    const associates = [1, 2, 3, 4].map((i) => man("associate", 10 + i));
    const soldiers = [1, 2, 3, 4].map((i) => man("soldier", 20 + i));
    const crew = [...associates, ...soldiers];
    expect(exposureHeat(crew, associates.map((c) => c.id))).toBe(0);
    expect(exposureHeat(crew, soldiers.map((c) => c.id))).toBe(6);
    expect(exposureHeat(crew, [...soldiers.slice(0, 2), ...associates].map((c) => c.id))).toBe(0);
  });
});
