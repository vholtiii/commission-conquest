import { describe, expect, it } from "vitest";
import { tickConsigliere } from "@/engine/consigliere";
import { heatForecast } from "@/engine/heat";
import { buildInitialState, startGame } from "@/engine/initialState";
import type { GameState, Operation } from "@/types/game";

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

/** No racket heat, so the only note on offer is the one the test sets up. */
function quiet(state: GameState): GameState {
  return {
    ...state,
    turn: 11,
    heat: { ...state.heat, level: 0 },
    supplyRoutes: [],
    territories: state.territories.map((t) => (t.owner === "Moretti" ? { ...t, rackets: [] } : t)),
  };
}

function valentiHit(i: number, extra: Partial<Operation> = {}): Operation {
  return {
    id: `op_valenti_${i}`,
    family: "Moretti",
    kind: "hit",
    targetTerritoryId: "x",
    targetFamily: "Valenti",
    shooterIds: [],
    surveilled: false,
    pendingTurns: 0,
    resolved: true,
    resolvedTurn: 11,
    ...extra,
  };
}

function bled(state: GameState): GameState {
  return {
    ...quiet(state),
    operations: [valentiHit(1), valentiHit(2)],
  };
}

describe("consigliere's note", () => {
  it("names nothing on turn 10", () => {
    const opened = tickConsigliere({ ...game(), turn: 10 });
    expect(opened.state.consigliereNote ?? null).toBeNull();
    expect(opened.logs).toHaveLength(0);
  });

  it("names a capo who can take an empty chair", () => {
    const state = game();
    const opened = tickConsigliere({
      ...state,
      turn: 11,
      money: 10_000,
      crew: state.crew.map((c) => {
        if (c.family !== "Moretti") return c;
        if (c.role === "underboss") return { ...c, status: "dead" as const };
        if (c.role === "capo") return { ...c, level: 6, loyalty: 80, hits: 4 };
        return c;
      }),
    });
    expect(opened.state.consigliereNote?.kind).toBe("chair");
    expect(opened.state.consigliereNote?.show).toBe("crew");
    const capoId = opened.state.consigliereNote?.crewId;
    const seated = tickConsigliere({
      ...opened.state,
      crew: opened.state.crew.map((c) => (c.id === capoId ? { ...c, role: "underboss" as const } : c)),
    });
    expect(seated.state.reputation.respect).toBe(Math.min(100, opened.state.reputation.respect + 2));
    expect(seated.logs[0]?.category).toBe("diplomacy");
    expect(seated.logs[0]?.text).toContain("Respect +2");
    expect(seated.logs[0]?.text).toContain("chair is covered");
  });

  it("pays nothing for a miss and rests that family for 3 weeks", () => {
    const state = bled(game());
    const before = state.reputation.respect;
    const opened = tickConsigliere(state);
    expect(opened.state.consigliereNote?.kind).toBe("bleeding");
    expect(opened.state.consigliereNote?.family).toBe("Valenti");

    const missed = tickConsigliere(opened.state);
    expect(missed.state.reputation.respect).toBe(before);
    expect(missed.logs).toHaveLength(0);
    expect(missed.state.consigliereNote?.family).not.toBe("Valenti");

    const tooSoon = tickConsigliere({ ...missed.state, turn: 13 });
    expect(tooSoon.state.consigliereNote?.family).not.toBe("Valenti");

    const later = tickConsigliere({ ...missed.state, turn: 14 });
    expect(later.state.consigliereNote?.kind).toBe("bleeding");
    expect(later.state.consigliereNote?.family).toBe("Valenti");
  });

  it("stays quiet while the consigliere is jailed or dead", () => {
    for (const status of ["jailed", "dead"] as const) {
      const state = bled(game());
      const silenced = {
        ...state,
        crew: state.crew.map((c) =>
          c.family === "Moretti" && c.role === "consigliere" ? { ...c, status } : c,
        ),
      };
      const once = tickConsigliere(silenced);
      expect(once.state.consigliereNote?.kind).toBe("absent");
      expect(once.state.consigliereNote?.line).toContain("No consigliere");
      expect(once.state.reputation.respect).toBe(silenced.reputation.respect);
      const twice = tickConsigliere(once.state);
      expect(twice.state.consigliereNote ?? null).toBeNull();
      expect(twice.logs).toHaveLength(0);
    }
  });

  it("closes a bleeding note on a truce or on a hit planned that week", () => {
    const opened = tickConsigliere(bled(game()));
    expect(opened.state.consigliereNote?.kind).toBe("bleeding");
    const respect = opened.state.reputation.respect;
    const issued = opened.state.consigliereNote!.issuedTurn;

    const truce = tickConsigliere({
      ...opened.state,
      deals: [
        ...opened.state.deals,
        {
          id: "truce_test",
          kind: "truce",
          a: "Moretti",
          b: "Valenti",
          terms: { cash: 0, standing: 0 },
          sinceTurn: issued,
          untilTurn: null,
          status: "active",
        },
      ],
    });
    expect(truce.state.reputation.respect).toBe(Math.min(100, respect + 2));
    expect(truce.logs[0]?.text).toContain("well handled with Valenti");

    const byHit = tickConsigliere({
      ...opened.state,
      operations: [
        ...opened.state.operations,
        valentiHit(3, { plannedTurn: issued, resolved: false, resolvedTurn: undefined }),
      ],
    });
    expect(byHit.state.reputation.respect).toBe(Math.min(100, respect + 2));
    expect(byHit.logs[0]?.text).toContain("Respect +2");
  });
});

describe("heat clock", () => {
  it("counts weeks to the next line and turns urgent inside two", () => {
    const state = game();
    const mine = state.territories.find((t) => t.owner === "Moretti" && t.rackets.length > 0);
    expect(mine).toBeTruthy();
    const territories = state.territories.map((t) => {
      if (t.owner !== "Moretti") return t;
      if (t.id !== mine!.id) return { ...t, rackets: [] };
      return { ...t, rackets: [{ ...t.rackets[0]!, heatGen: 20, frozenUntil: 0 }] };
    });
    const base = { ...state, territories };

    const next = heatForecast({ ...base, heat: { ...base.heat, level: 38 } });
    expect(next.generated).toBe(5);
    expect(next.decay).toBe(3);
    expect(next.weeks).toBe(1);
    expect(next.label).toBe("Raids next week");
    expect(next.urgent).toBe(true);
    expect(next.detail).toContain("washes add 5");
    expect(next.detail).toContain("cools 3");
    expect(next.detail).toContain("hit or a capture");

    const two = heatForecast({ ...base, heat: { ...base.heat, level: 36 } });
    expect(two.weeks).toBe(2);
    expect(two.label).toBe("Raids ~2w");
    expect(two.urgent).toBe(true);

    const later = heatForecast({ ...base, heat: { ...base.heat, level: 30 } });
    expect(later.weeks).toBe(5);
    expect(later.label).toBe("Raids ~5w");
    expect(later.urgent).toBe(false);
  });
});
