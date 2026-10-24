import { describe, expect, it } from "vitest";
import type { GameState } from "@/types/game";
import { buildInitialState, startGame } from "@/engine/initialState";
import { looseEndsSummary, unfinishedBusiness } from "@/engine/unfinishedBusiness";
import { isLegitBusiness, launderSlack } from "@/engine/economy";

function game(): GameState {
  return startGame(buildInitialState(11, { startMode: "classic" }), "Moretti");
}

/** Every man on a job and every racket managed, so only the case under test fires. */
function tidy(state: GameState): GameState {
  const men = state.crew.filter((c) => c.family === "Moretti" && c.role !== "boss");
  let next = 0;
  const territories = state.territories.map((t) => ({
    ...t,
    rackets: t.rackets.map((r) => ({ ...r, managerId: r.managerId ?? men[next++ % men.length]?.id ?? "x" })),
  }));
  const crew = state.crew.map((c) =>
    c.family === "Moretti" && c.assignment.type === "idle"
      ? { ...c, assignment: { type: "garrison" as const, territoryId: "t" } }
      : c,
  );
  return { ...state, territories, crew, dirtyMoney: 0, deals: [], passageDeals: [] };
}

describe("unfinished business", () => {
  it("is quiet when everything is handled", () => {
    expect(unfinishedBusiness(tidy(game()))).toEqual([]);
  });

  it("counts idle men but not the boss or men away at a sit-down", () => {
    const base = tidy(game());
    const men = base.crew.filter((c) => c.family === "Moretti" && c.role !== "boss");
    const crew = base.crew.map((c) => {
      if (c.id === men[0]!.id || c.id === men[1]!.id) return { ...c, assignment: { type: "idle" as const } };
      if (c.id === men[2]!.id) {
        return {
          ...c,
          assignment: { type: "idle" as const },
          awayAt: { territoryId: "t", untilTurn: base.turn + 1, reason: "sitdown" as const },
        };
      }
      if (c.family === "Moretti" && c.role === "boss") return { ...c, assignment: { type: "idle" as const } };
      return c;
    });
    const ends = unfinishedBusiness({ ...base, crew });
    expect(ends.find((e) => e.id === "idle")?.count).toBe(2);
    expect(looseEndsSummary(ends)).toBe("2 men idle");
  });

  it("flags rackets with no manager, but not safehouses", () => {
    const base = tidy(game());
    const own = base.territories.find((t) => t.owner === "Moretti" && t.rackets.length > 0)!;
    const territories = base.territories.map((t) =>
      t.id === own.id
        ? {
            ...t,
            rackets: [
              { ...t.rackets[0]!, managerId: null },
              { ...t.rackets[0]!, id: "safe_1", type: "safehouse" as const, managerId: null },
            ],
          }
        : t,
    );
    const ends = unfinishedBusiness({ ...base, territories });
    const unmanaged = ends.find((e) => e.id === "unmanaged");
    expect(unmanaged?.count).toBe(1);
    expect(unmanaged?.action).toEqual({ kind: "territory", territoryId: own.id });
  });

  it("nags about dirty cash only when a ready front has room for it", () => {
    const base = tidy(game());
    const own = base.territories.find((t) => t.owner === "Moretti")!;
    const front = {
      ...own.rackets[0]!,
      id: "front_1",
      type: "laundromat" as const,
      level: 3,
      launderReadyTurn: base.turn,
      frozenUntil: undefined,
    };
    expect(isLegitBusiness(front.type)).toBe(true);
    const territories = base.territories.map((t) =>
      t.id === own.id ? { ...t, rackets: [...t.rackets, front] } : t,
    );
    const withFront = { ...base, territories, dirtyMoney: 5000, launderPlan: {} };
    expect(launderSlack(withFront).spareCap).toBeGreaterThan(0);
    expect(unfinishedBusiness(withFront).some((e) => e.id === "laundry")).toBe(true);

    const routedFull = { ...withFront, launderPlan: { front_1: 5000 } };
    expect(launderSlack(routedFull).unrouted).toBe(0);
    expect(unfinishedBusiness(routedFull).some((e) => e.id === "laundry")).toBe(false);

    const noDirty = { ...withFront, dirtyMoney: 100 };
    expect(unfinishedBusiness(noDirty).some((e) => e.id === "laundry")).toBe(false);
  });

  it("warns about a truce and a pact that lapse at the end of this week", () => {
    const base = tidy(game());
    const truce = {
      id: "deal_1",
      kind: "truce" as const,
      a: "Moretti" as const,
      b: "Valenti" as const,
      terms: {} as GameState["deals"][number]["terms"],
      sinceTurn: base.turn - 4,
      untilTurn: base.turn + 1,
      status: "active" as const,
    };
    const later = { ...truce, id: "deal_2", b: "Rinaldi" as const, untilTurn: base.turn + 3 };
    const state: GameState = {
      ...base,
      deals: [truce, later],
      diplomacy: { ...base.diplomacy, pacts: { Ferraro: base.turn + 1 } },
    };
    const expiring = unfinishedBusiness(state).find((e) => e.id === "expiring");
    expect(expiring?.count).toBe(2);
    expect(expiring?.label).toBe("2 deals run out this week");
  });
});
