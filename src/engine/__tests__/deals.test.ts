import { describe, expect, it } from "vitest";
import { createRacket } from "@/engine/economy";
import { honorDeal, makeDeal, shipStandingLiquor, tickDeals } from "@/engine/deals";
import { familyHq } from "@/engine/crewLocation";
import { establishDealRoute } from "@/engine/supplyRoutes";
import { processSupplyRoutes } from "@/engine/supplyRoutes";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import type { GameState } from "@/types/game";

function withSale() {
  let state = startGame(buildInitialState(99), "Moretti");
  const home = state.territories.find((t) => t.owner === "Moretti")!;
  const other =
    state.territories.find((t) => t.owner && t.owner !== "Moretti")!.owner!;
  const hqId = familyHq(state, other)!;
  const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
  state = {
    ...state,
    rivalTreasury: { ...state.rivalTreasury, [other]: 5_000 },
    territories: state.territories.map((t) => {
      if (t.id === home.id) {
        return {
          ...t,
          rackets: [
            ...t.rackets,
            { ...createRacket("barn", t.id, "warehouse"), stock: 40, managerId: manager.id, proofed: 0 },
          ],
        };
      }
      if (t.id === hqId && !t.rackets.some((r) => r.type === "warehouse" || r.type === "speakeasy")) {
        return {
          ...t,
          rackets: [...t.rackets, { ...createRacket("yard", t.id, "warehouse"), stock: 0 }],
        };
      }
      return t;
    }),
  };
  const made = makeDeal(
    state,
    "liquor",
    other,
    { weekly: true, destTerritoryId: hqId, crates: 4, weeks: 6, cash: -72, standing: 0 },
    { weeks: 7, obligor: "Moretti" },
  );
  return { state: made.state, other, homeId: home.id, hqId, dealId: made.deal.id };
}

function openRoad(state: GameState, dealId: string, sourceTerritoryId: string, crates = 4) {
  return establishDealRoute(state, { dealId, sourceTerritoryId, cratesPerTurn: crates }, createRng(1)).state;
}

describe("standing liquor sale", () => {
  it("ships nothing until a deal-route is opened", () => {
    const { state: pending, homeId } = withSale();
    const week = shipStandingLiquor({ ...pending, turn: pending.turn + 1 });
    expect(week.logs[0]?.text).toMatch(/no truck left the barn/);
    expect(week.state.deals.find((d) => d.kind === "liquor")?.status).toBe("active");
    expect(week.state.deals.find((d) => d.kind === "liquor")?.delivered ?? 0).toBe(0);
    const barn = week.state.territories.find((t) => t.id === homeId)!.rackets.find((r) => r.id === "barn");
    expect(barn?.stock).toBe(40);
  });

  it("ships from the chosen barn to their HQ and honors a one-shot", () => {
    const { state: base, homeId, hqId, other } = withSale();
    const made = makeDeal(
      { ...base, deals: [] },
      "liquor",
      other,
      { weekly: false, destTerritoryId: hqId, crates: 4, weeks: 2, cash: -72, standing: 0 },
      { weeks: 3, obligor: "Moretti" },
    );
    let state = openRoad(made.state, made.deal.id, homeId);
    const week = shipStandingLiquor({ ...state, turn: state.turn + 1 });
    expect(week.state.deals.find((d) => d.id === made.deal.id)?.status).toBe("honored");
    const hq = week.state.territories.find((t) => t.id === hqId)!;
    const stock = hq.rackets.reduce((n, r) => n + r.stock, 0);
    expect(stock).toBeGreaterThan(0);
    expect(week.state.pendingDealSettlements?.some((s) => s.outcome === "honored")).toBe(true);
  });

  it("ships four crates a week for six weeks then honors", () => {
    let { state, homeId, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    let shipped = 0;
    for (let i = 0; i < 8; i++) {
      state = { ...state, turn: state.turn + 1 };
      const week = shipStandingLiquor(state);
      state = week.state;
      if (week.logs.some((l) => /Standing order: \d+ crate/.test(l.text))) shipped++;
      const due = tickDeals(state, createRng(i));
      state = due.state;
    }
    expect(shipped).toBeGreaterThanOrEqual(6);
    const deal = state.deals.find((d) => d.id === dealId);
    expect(deal?.status).toBe("honored");
    expect(deal?.delivered).toBeGreaterThan(0);
  });

  it("breaks the deal when an opened road finds an empty barn", () => {
    let { state, homeId, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    state = {
      ...state,
      turn: state.turn + 1,
      territories: state.territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) => (r.type === "warehouse" && t.owner === "Moretti" ? { ...r, stock: 0 } : r)),
      })),
    };
    const week = shipStandingLiquor(state);
    expect(week.state.deals.find((d) => d.id === dealId)?.status).toBe("breached");
    expect(week.logs.some((l) => /broken/.test(l.text))).toBe(true);
  });

  it("breaks when the deadline hits with nothing delivered", () => {
    const { state: pending, dealId } = withSale();
    const due = tickDeals({ ...pending, turn: (pending.deals.find((d) => d.id === dealId)?.untilTurn ?? 8) }, createRng(2));
    expect(due.state.deals.find((d) => d.id === dealId)?.status).toBe("breached");
  });

  it("pays only what the rival treasury has", () => {
    let { state, homeId, other, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    state = { ...state, turn: state.turn + 1, rivalTreasury: { ...state.rivalTreasury, [other]: 1 } };
    const before = state.money;
    const week = shipStandingLiquor(state);
    expect(week.state.money - before).toBe(1);
    expect(week.state.rivalTreasury[other]).toBe(0);
  });

  it("ends the order when they lose the house", () => {
    let { state, homeId, other, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    state = {
      ...state,
      turn: state.turn + 1,
      territories: state.territories.map((t) => (t.owner === other ? { ...t, owner: "Moretti" } : t)),
    };
    const week = shipStandingLiquor(state);
    expect(week.state.deals.find((d) => d.id === dealId)?.status).toBe("expired");
    expect(week.logs[0]?.text).toContain("lost the house");
  });

  it("does not drop a deal-route because the dest is rival turf", () => {
    let { state, homeId, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    const run = processSupplyRoutes({ ...state, turn: state.turn + 1 }, createRng(3));
    expect(run.state.supplyRoutes.some((r) => r.dealId === dealId && r.status === "active")).toBe(true);
  });
});

describe("honorDeal cash skip", () => {
  it("can close a kept weekly order without a second payment", () => {
    let { state, homeId, dealId } = withSale();
    state = openRoad(state, dealId, homeId);
    state = shipStandingLiquor({ ...state, turn: state.turn + 1 }).state;
    const money = state.money;
    const held = {
      ...state,
      deals: state.deals.map((d) => (d.id === dealId ? { ...d, untilTurn: state.turn + 1 } : d)),
    };
    const kept = honorDeal(held, dealId, { skipCash: true, text: "kept" });
    expect(kept.state.money).toBe(money);
    expect(kept.state.deals.find((d) => d.id === dealId)?.status).toBe("honored");
  });
});
