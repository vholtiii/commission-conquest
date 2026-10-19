import { describe, expect, it } from "vitest";
import { createRacket } from "@/engine/economy";
import {
  applyWarehouseShrinkage,
  depositTracked,
  idleStorageCost,
  makeManagerLookup,
  markWarehouseProof,
  pullFrom,
} from "@/engine/liquor";
import { buildInitialState, startGame } from "@/engine/initialState";
import type { Territory } from "@/types/game";

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
