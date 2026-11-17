import { describe, expect, it } from "vitest";
import { createRacket } from "@/engine/economy";
import {
  applyWarehouseShrinkage,
  depositTracked,
  feedsOwnSpeakeasies,
  idleStorageCost,
  makeManagerLookup,
  markWarehouseProof,
  planFeedSpeakeasy,
  pourLocalCook,
  processShipments,
  produceAndStore,
  producerManagerMods,
  productionOutput,
  pullFrom,
  warehouseStock,
  withdrawFamilyCrates,
} from "@/engine/liquor";
import { createRng } from "@/engine/rng";
import { buildInitialState, startGame } from "@/engine/initialState";
import type { CrewMember, Territory } from "@/types/game";

function started() {
  return startGame(buildInitialState(1234), "Moretti");
}

function racket(type: Parameters<typeof createRacket>[2], stock: number, extra: Record<string, unknown> = {}) {
  return { ...createRacket("r", "t", type), stock, ...extra };
}

describe("pullFrom", () => {
  it("keeps the proofed crates that were not taken", () => {
    const r = racket("warehouse", 10, { proofed: 8 });
    const got = pullFrom(r, 3);
    expect(got).toEqual({ take: 3, proofed: 3 });
    expect(r.stock).toBe(7);
    expect(r.proofed).toBe(5);
  });
});

describe("warehouse stock", () => {
  it("shrinks a copy and leaves the original barn alone", () => {
    const state = started();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const barn = racket("warehouse", 10);
    const territory: Territory = { ...home, rackets: [barn] };
    const shrunk = applyWarehouseShrinkage(territory, makeManagerLookup(state.crew, "Moretti"), state.turn);
    expect(barn.stock).toBe(10);
    expect(shrunk.shrunk).toBeGreaterThan(0);
    expect(shrunk.territory.rackets[0]!.stock).toBeLessThan(10);
  });

  it("pours a tracked load into the warehouse only", () => {
    const state = started();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const territory: Territory = {
      ...home,
      rackets: [racket("speakeasy", 0, { id: "bar" }), racket("warehouse", 0, { id: "barn" })],
    };
    const landed = depositTracked(territory, 6, 2, "warehouseOnly", state.turn);
    const barn = landed.territory.rackets.find((r) => r.id === "barn")!;
    const bar = landed.territory.rackets.find((r) => r.id === "bar")!;
    expect(barn.stock).toBe(6);
    expect(barn.proofed).toBe(2);
    expect(bar.stock).toBe(0);
  });

  it("proofs a managed barn and only clamps a frozen one", () => {
    const state = started();
    const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const open: Territory = {
      ...home,
      rackets: [racket("warehouse", 4, { managerId: manager.id, proofed: 1 })],
    };
    const marked = markWarehouseProof(open, state.turn, makeManagerLookup(state.crew, "Moretti"));
    expect(marked.rackets[0]!.proofed).toBe(4);

    const frozen: Territory = {
      ...home,
      rackets: [racket("warehouse", 4, { managerId: manager.id, proofed: 9, frozenUntil: state.turn + 3 })],
    };
    const clamped = markWarehouseProof(frozen, state.turn, makeManagerLookup(state.crew, "Moretti"));
    expect(clamped.rackets[0]!.proofed).toBe(4);
  });

  it("charges rent only past the first 40 empty slots", () => {
    const state = started();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const full: Territory = { ...home, rackets: [racket("warehouse", 100)] };
    expect(idleStorageCost(full, state.turn)).toBe(0);
    const empty: Territory = { ...home, rackets: [racket("warehouse", 0)] };
    expect(idleStorageCost(empty, state.turn)).toBe(6);
  });
});

describe("same-block still", () => {
  it("refuses a warehouse truck when a still is on the block", () => {
    const state = started();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const block: Territory = {
      ...home,
      rackets: [racket("still", 0, { id: "cook" }), racket("speakeasy", 0, { id: "bar" })],
    };
    expect(feedsOwnSpeakeasies(block, state.turn)).toBe(true);
    const plan = planFeedSpeakeasy(
      { ...state, territories: state.territories.map((t) => (t.id === home.id ? block : t)) },
      home.id,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("The still on this block pours when the week closes");
  });

  it("pours this week's cook into a dry bar on the same block", () => {
    const state = started();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const still = racket("still", 0, { id: "cook" });
    const block: Territory = {
      ...home,
      rackets: [still, racket("speakeasy", 0, { id: "bar" })],
    };
    const cooked = produceAndStore(block, state.turn);
    const poured = pourLocalCook(cooked.territory);
    const cook = poured.rackets.find((r) => r.id === "cook")!;
    const bar = poured.rackets.find((r) => r.id === "bar")!;
    expect(cooked.produced).toBe(productionOutput(still));
    expect(bar.stock).toBe(cooked.produced);
    expect(cook.stock).toBe(0);
  });
});

function cookMan(state: ReturnType<typeof started>, extra: Partial<CrewMember> = {}): CrewMember {
  const base = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
  return {
    ...base,
    ...extra,
    skills: { ...base.skills, smarts: extra.skills?.smarts ?? 40 },
    traits: extra.traits ?? [],
  };
}

describe("cooker managers", () => {
  it("cooks short without a manager", () => {
    const still = racket("still", 0);
    expect(productionOutput(still)).toBe(6);
    expect(producerManagerMods(null).cookMult).toBe(0.85);
  });

  it("adds bookkeeper percent and a smarts crate", () => {
    const state = started();
    const still = racket("still", 0);
    const mgr = cookMan(state, { traits: ["bookkeeper"], skills: { ...state.crew[0]!.skills, smarts: 40 } });
    expect(productionOutput(still, false, mgr)).toBe(9);
  });

  it("a hothead pushes a crate and heat", () => {
    const state = started();
    const still = racket("still", 0);
    const mgr = cookMan(state, { traits: ["hothead"], skills: { ...state.crew[0]!.skills, smarts: 10 } });
    expect(productionOutput(still, false, mgr)).toBe(9);
    expect(producerManagerMods(mgr).heat).toBe(1);
  });

  it("a ghost cools the cooker", () => {
    const state = started();
    const mgr = cookMan(state, { traits: ["ghost"] });
    expect(producerManagerMods(mgr).heat).toBe(-1);
  });

  it("produceAndStore pulls the assigned cooker's manager", () => {
    const state = started();
    const mgr = cookMan(state, { traits: ["bookkeeper"] });
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const still = racket("still", 0, { id: "cook", managerId: mgr.id });
    const block: Territory = { ...home, rackets: [still] };
    const lookup = makeManagerLookup([{ ...mgr, id: mgr.id }], "Moretti");
    const cooked = produceAndStore(block, state.turn, lookup);
    expect(cooked.produced).toBe(productionOutput(still, false, mgr));
    expect(cooked.cookHeat).toBe(0);
  });
});

describe("family crate pile", () => {
  it("loads a truck from other blocks through an empty managed barn", () => {
    const state = started();
    const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const east: Territory = {
      ...home,
      id: "east_village",
      name: "East Village",
      rackets: [racket("warehouse", 0, { managerId: manager.id })],
    };
    const piled: Territory = {
      ...home,
      id: "other_block",
      name: "Other",
      rackets: [
        racket("warehouse", 50, { id: "barn", managerId: manager.id }),
        racket("still", 34, { id: "cook" }),
      ],
    };
    const lookup = makeManagerLookup([manager], "Moretti");
    const wd = withdrawFamilyCrates([east, piled], "Moretti", 20, state.turn, lookup, {
      sourceId: east.id,
    });
    expect(wd.moved).toBe(20);
    expect(wd.fromSource).toBe(0);
    expect(warehouseStock(wd.territories.find((t) => t.id === east.id)!)).toBe(0);
    expect(warehouseStock(wd.territories.find((t) => t.id === piled.id)!)).toBe(30);
  });

  it("takes speakeasy stock only after warehouses and cookers", () => {
    const state = started();
    const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const east: Territory = {
      ...home,
      id: "east_village",
      rackets: [racket("warehouse", 0, { managerId: manager.id })],
    };
    const cook: Territory = {
      ...home,
      id: "cook_block",
      rackets: [racket("still", 10)],
    };
    const bar: Territory = {
      ...home,
      id: "bar_block",
      rackets: [racket("speakeasy", 20)],
    };
    const lookup = makeManagerLookup([manager], "Moretti");
    const wd = withdrawFamilyCrates([east, cook, bar], "Moretti", 12, state.turn, lookup, {
      sourceId: east.id,
    });
    expect(wd.moved).toBe(12);
    expect(wd.territories.find((t) => t.id === cook.id)!.rackets[0]!.stock).toBe(0);
    expect(wd.territories.find((t) => t.id === bar.id)!.rackets[0]!.stock).toBe(18);
  });

  it("leaves an unmanaged barn's crates on the floor", () => {
    const state = started();
    const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const unmanaged: Territory = {
      ...home,
      id: "unmanaged",
      rackets: [racket("warehouse", 40)],
    };
    const emptyManaged: Territory = {
      ...home,
      id: "managed",
      rackets: [racket("warehouse", 0, { managerId: manager.id })],
    };
    const lookup = makeManagerLookup([manager], "Moretti");
    const wd = withdrawFamilyCrates([unmanaged, emptyManaged], "Moretti", 10, state.turn, lookup, {
      sourceId: emptyManaged.id,
    });
    expect(wd.moved).toBe(0);
    expect(warehouseStock(wd.territories.find((t) => t.id === unmanaged.id)!)).toBe(40);
  });

  it("keeps a buy pending on East Village and lands it there next week", () => {
    const state = started();
    const manager = state.crew.find((c) => c.family === "Moretti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const first: Territory = {
      ...home,
      id: "first_barn",
      name: "First Barn",
      rackets: [racket("warehouse", 0, { id: "first_wh", managerId: manager.id })],
    };
    const east: Territory = {
      ...home,
      id: "east_village",
      name: "East Village",
      rackets: [racket("warehouse", 0, { id: "east_wh", managerId: manager.id })],
    };
    const ship = {
      id: "ship_ev",
      crates: 20,
      destTerritoryId: east.id,
      arriveTurn: state.turn + 1,
      cost: 400,
    };
    const crew = state.crew.map((c) => (c.id === manager.id ? manager : c));
    const waiting = processShipments(
      {
        ...state,
        crew,
        territories: [first, east, ...state.territories.filter((t) => t.id !== home.id)],
        pendingShipments: [ship],
      },
      { ...createRng(1), chance: () => false },
    );
    expect(waiting.pendingShipments).toEqual([ship]);
    expect(warehouseStock(waiting.territories.find((t) => t.id === east.id)!)).toBe(0);
    expect(warehouseStock(waiting.territories.find((t) => t.id === first.id)!)).toBe(0);

    const landed = processShipments(
      {
        ...state,
        crew,
        turn: state.turn + 1,
        territories: waiting.territories,
        pendingShipments: waiting.pendingShipments,
      },
      { ...createRng(1), chance: () => false },
    );
    expect(landed.pendingShipments).toEqual([]);
    expect(warehouseStock(landed.territories.find((t) => t.id === east.id)!)).toBe(20);
    expect(warehouseStock(landed.territories.find((t) => t.id === first.id)!)).toBe(0);
  });
});
