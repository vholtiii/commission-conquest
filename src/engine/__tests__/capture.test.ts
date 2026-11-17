import { describe, expect, it, vi } from "vitest";
import { captureAllowance, captureStrength, resolveCapture } from "@/engine/capture";
import { createRacket } from "@/engine/economy";
import { createCrewMember } from "@/engine/crew";
import { scatterFamily } from "@/engine/defection";
import { tryExpand } from "@/engine/rivalAI";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import type { FamilyName, GameState } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

const quiet = { turn: 4, captureTally: { turn: 4, byFamily: {} }, vendettas: [] as FamilyName[] };

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

describe("capture allowance", () => {
  it("allows one grab a week, two for Valenti, and a second against a vendetta", () => {
    expect(captureAllowance(quiet, "Moretti").ok).toBe(true);
    expect(captureAllowance(quiet, "Moretti").limit).toBe(1);
    const used = { ...quiet, captureTally: { turn: 4, byFamily: { Moretti: 1 } } };
    expect(captureAllowance(used, "Moretti").ok).toBe(false);
    expect(captureAllowance(quiet, "Valenti").limit).toBe(2);
    const valentiUsed = { ...quiet, captureTally: { turn: 4, byFamily: { Valenti: 1 } } };
    expect(captureAllowance(valentiUsed, "Valenti").ok).toBe(true);
    const vendetta = {
      ...used,
      vendettas: ["Moretti", "Rinaldi"] as FamilyName[],
    };
    const extra = captureAllowance(vendetta, "Moretti", { owner: "Rinaldi", leadershipVacuum: 0 });
    expect(extra.ok).toBe(true);
    expect(extra.bonusReason).toBe("vendetta");
  });

  it("treats a finished family's turf as a vacuum grab", () => {
    const used = {
      ...quiet,
      captureTally: { turn: 4, byFamily: { Moretti: 1 } },
      defunctFamilies: ["Rinaldi"] as FamilyName[],
    };
    const extra = captureAllowance(used, "Moretti", { owner: "Rinaldi", leadershipVacuum: 0 });
    expect(extra.ok).toBe(true);
    expect(extra.bonusReason).toBe("vacuum");
  });
});

describe("abandoned turf", () => {
  it("lets an associate walk in and keeps the rackets", () => {
    const state = game();
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const block = state.territories.find((t) => t.owner === "Rinaldi")!;
    const associate = {
      ...createCrewMember(createRng(9), "Moretti", "associate", { id: "kid", name: "The Kid" }),
      skills: { muscle: 0, smarts: 10, stealth: 10, driving: 10 },
      assignment: { type: "idle" as const },
    };
    const warehouse = { ...createRacket("wh", block.id, "warehouse", 2), stock: 18, managerId: "dead_mgr" };
    const bar = { ...createRacket("bar", block.id, "speakeasy", 1), stock: 6 };
    const primed: GameState = {
      ...state,
      defunctFamilies: ["Rinaldi"],
      crew: [...state.crew, associate],
      territories: state.territories.map((t) =>
        t.id === block.id
          ? { ...t, rackets: [warehouse, bar], garrisonIds: ["ghost"], defenseBonus: 0.4 }
          : t,
      ),
    };
    const fight = captureStrength(primed, block.id, [associate.id]);
    expect(fight.def).toBe(0);
    expect(fight.defenders).toEqual([]);

    const live = captureStrength(
      { ...primed, defunctFamilies: [] },
      block.id,
      [associate.id],
    );
    expect(live.def).toBeGreaterThan(0);

    const out = resolveCapture(primed, block.id, [associate.id], createRng(1));
    expect(out.success).toBe(true);
    const taken = out.state.territories.find((t) => t.id === block.id)!;
    expect(taken.owner).toBe("Moretti");
    expect(taken.rackets.find((r) => r.id === "wh")!.stock).toBe(18);
    expect(taken.rackets.find((r) => r.id === "bar")!.stock).toBe(6);
    expect(taken.rackets.every((r) => r.managerId == null)).toBe(true);
    expect(taken.garrisonIds).toEqual([associate.id]);
    expect(out.state.crew.find((c) => c.id === associate.id)!.wanted).toBe(associate.wanted);
    expect(out.state.heat.level).toBe(primed.heat.level);
    expect(out.state.turnLog.at(-1)?.text).toContain("Walked into");
    expect(home.id).toBeTruthy();
  });

  it("clears leftover garrisons when a family scatters", () => {
    const state = game();
    const block = state.territories.find((t) => t.owner === "Rinaldi")!;
    const held = {
      ...state,
      territories: state.territories.map((t) =>
        t.id === block.id ? { ...t, garrisonIds: ["stale"] } : t,
      ),
    };
    const out = scatterFamily(held, "Rinaldi", createRng(2));
    expect(out.state.defunctFamilies).toContain("Rinaldi");
    expect(out.state.territories.find((t) => t.id === block.id)!.garrisonIds).toEqual([]);
    expect(out.state.territories.find((t) => t.id === block.id)!.owner).toBe("Rinaldi");
  });

  it("does not let a truce stop a walk-in", async () => {
    const { useGameStore } = await import("@/engine/store");
    const state = game();
    const block = state.territories.find((t) => t.owner === "Rinaldi")!;
    const associate = {
      ...createCrewMember(createRng(3), "Moretti", "associate", { id: "walker" }),
      assignment: { type: "idle" as const },
    };
    const truce = {
      id: "deal_truce",
      kind: "truce" as const,
      a: "Moretti" as const,
      b: "Rinaldi" as const,
      terms: {} as GameState["deals"][number]["terms"],
      sinceTurn: state.turn - 1,
      untilTurn: state.turn + 4,
      status: "active" as const,
    };
    useGameStore.setState({
      ...state,
      defunctFamilies: ["Rinaldi"],
      deals: [truce],
      crew: [...state.crew, associate],
      territories: state.territories.map((t) =>
        t.id === block.id ? { ...t, garrisonIds: [], rackets: [createRacket("wh", t.id, "warehouse")] } : t,
      ),
    });
    useGameStore.getState().captureTerritory(block.id, [associate.id]);
    expect(useGameStore.getState().territories.find((t) => t.id === block.id)!.owner).toBe("Moretti");
  });

  it("a rival always walks into adjacent abandoned turf when they have a crew", () => {
    const state = game();
    const block = state.territories.find((t) => t.owner === "Rinaldi")!;
    const neighbour = state.territories.find(
      (t) => t.owner && t.owner !== "Rinaldi" && t.owner !== "Moretti" && t.adjacentTerritories.includes(block.id),
    );
    expect(neighbour).toBeTruthy();
    const family = neighbour!.owner!;
    const capo = {
      ...createCrewMember(createRng(4), family, "capo", { id: "capo_grab" }),
      status: "active" as const,
    };
    const soldier = {
      ...createCrewMember(createRng(5), family, "soldier", { id: "sol_grab" }),
      capoId: capo.id,
      status: "active" as const,
    };
    const primed: GameState = {
      ...state,
      defunctFamilies: ["Rinaldi"],
      crew: [...state.crew.filter((c) => c.family !== family), capo, soldier],
      territories: state.territories.map((t) =>
        t.id === block.id
          ? { ...t, garrisonIds: ["stale"], rackets: [createRacket("wh", t.id, "warehouse", 3)] }
          : t,
      ),
    };
    const out = tryExpand(primed, family, createRng(1), { territoryId: block.id });
    const taken = out.state.territories.find((t) => t.id === block.id)!;
    expect(taken.owner).toBe(family);
    expect(taken.rackets[0]!.level).toBe(3);
    expect(out.log?.text).toContain("walked into");
  });
});
