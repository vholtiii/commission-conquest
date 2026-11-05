import { describe, expect, it } from "vitest";
import { createRacket } from "@/engine/economy";
import { buildInitialState, startGame } from "@/engine/initialState";
import { streetTalk } from "@/engine/streetTalk";
import type { GameState, SupplyRoute } from "@/types/game";

function moretti(): GameState {
  return startGame(buildInitialState(11, { startMode: "classic" }), "Moretti");
}

function homeOf(state: GameState) {
  return state.territories.find((t) => t.owner === "Moretti")!;
}

function manOnBlock(state: GameState, territoryId: string, wanted: number): GameState {
  const man = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
  return {
    ...state,
    crew: state.crew.map((c) =>
      c.id === man.id
        ? { ...c, wanted, assignment: { type: "garrison", territoryId } }
        : c,
    ),
    territories: state.territories.map((t) =>
      t.id === territoryId ? { ...t, garrisonIds: [...t.garrisonIds, man.id] } : t,
    ),
  };
}

function routeOn(state: GameState, homeId: string, outcome: SupplyRoute["last"]): GameState {
  const dest = state.territories.find((t) => t.owner === "Moretti" && t.id !== homeId) ?? homeOf(state);
  const route: SupplyRoute = {
    id: "rt_test",
    family: "Moretti",
    sourceTerritoryId: homeId,
    destTerritoryId: dest.id,
    path: [homeId, dest.id],
    cratesPerTurn: 4,
    driverId: state.crew[0]!.id,
    status: "active",
    sinceTurn: 1,
    awaitingFamilies: [],
    runHot: false,
    last: outcome,
  };
  return { ...state, supplyRoutes: [route] };
}

describe("streetTalk", () => {
  it("names a man wanted past the line", () => {
    let state = moretti();
    const home = homeOf(state);
    state = manOnBlock({ ...state, heat: { ...state.heat, level: 60 } }, home.id, 6);
    expect(streetTalk(state, home)).toMatch(/is wanted past the line in/);
    expect(streetTalk(state, home)).toContain(home.name);
  });

  it("says they took the truck when the last run was hijacked", () => {
    let state = moretti();
    const home = homeOf(state);
    state = routeOn(state, home.id, { turn: 1, outcome: "hijacked", text: "taken" });
    expect(streetTalk(state, home)).toBe(`They took the truck out of ${home.name}.`);
  });

  it("says the truck never left when the barn was dry", () => {
    let state = moretti();
    const home = homeOf(state);
    state = routeOn(state, home.id, { turn: 1, outcome: "no_stock", text: "empty" });
    expect(streetTalk(state, home)).toBe(`${home.name} — the truck never left the warehouse.`);
  });

  it("mentions water when a dry speakeasy sits on a still", () => {
    let state = moretti();
    const home = homeOf(state);
    state = {
      ...state,
      territories: state.territories.map((t) =>
        t.id === home.id
          ? {
              ...t,
              rackets: [
                { ...createRacket("pot", t.id, "still"), stock: 4 },
                { ...createRacket("bar", t.id, "speakeasy"), stock: 0 },
              ],
            }
          : t,
      ),
    };
    const block = state.territories.find((t) => t.id === home.id)!;
    expect(streetTalk(state, block)).toBe(`${home.name} poured water; the still out back was late.`);
  });
});
