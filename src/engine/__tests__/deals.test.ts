import { describe, expect, it } from "vitest";
import { createRacket } from "@/engine/economy";
import { makeDeal, shipStandingLiquor } from "@/engine/deals";
import { buildInitialState, startGame } from "@/engine/initialState";

function withSale() {
  let state = startGame(buildInitialState(99), "Moretti");
  const home = state.territories.find((t) => t.owner === "Moretti")!;
  const dest = state.territories.find((t) => t.owner && t.owner !== "Moretti")!;
  const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
  const other = dest.owner!;
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
      if (t.id === dest.id) {
        return {
          ...t,
          rackets: [{ ...createRacket("bar", t.id, "speakeasy"), stock: 0 }],
        };
      }
      return t;
    }),
  };
  const made = makeDeal(
    state,
    "liquor",
    other,
    { weekly: true, destTerritoryId: dest.id, crates: 4, weeks: 6, cash: -72, standing: 0 },
    { weeks: 7 },
  );
  return { state: made.state, other, destId: dest.id };
}

describe("standing liquor sale", () => {
  it("ships four crates a week for six weeks", () => {
    let { state } = withSale();
    let shipped = 0;
    for (let i = 0; i < 8; i++) {
      state = { ...state, turn: state.turn + 1 };
      const week = shipStandingLiquor(state);
      state = week.state;
      if (week.logs.some((l) => /Standing order: \d+ crate/.test(l.text))) shipped++;
    }
    expect(shipped).toBe(6);
    const deal = state.deals.find((d) => d.kind === "liquor" && d.terms.weekly);
    expect(deal?.delivered).toBe(24);
  });

  it("logs a short week without calling it a breach", () => {
    let { state } = withSale();
    state = {
      ...state,
      turn: state.turn + 1,
      territories: state.territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) => (r.type === "warehouse" ? { ...r, stock: 0 } : r)),
      })),
    };
    const week = shipStandingLiquor(state);
    expect(week.logs[0]?.text).toContain("short");
    expect(week.state.deals.find((d) => d.kind === "liquor")?.status).toBe("active");
  });

  it("pays only what the rival treasury has", () => {
    const { state: sold, other } = withSale();
    const state = { ...sold, turn: sold.turn + 1, rivalTreasury: { ...sold.rivalTreasury, [other]: 1 } };
    const before = state.money;
    const week = shipStandingLiquor(state);
    expect(week.state.money - before).toBe(1);
    expect(week.state.rivalTreasury[other]).toBe(0);
  });

  it("ends the order when they lose the bar", () => {
    const { state: open, destId } = withSale();
    const state = {
      ...open,
      turn: open.turn + 1,
      territories: open.territories.map((t) => (t.id === destId ? { ...t, owner: "Moretti" } : t)),
    };
    const week = shipStandingLiquor(state);
    expect(week.state.deals.find((d) => d.kind === "liquor")?.status).toBe("expired");
    expect(week.logs[0]?.text).toContain("lost the bar");
  });
});
