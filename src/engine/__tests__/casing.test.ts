import { describe, expect, it, vi } from "vitest";
import { attemptBribe } from "@/engine/bribes";
import {
  FRESH_CASING_ODDS,
  calculateHitOddsBreakdown,
  resolvePendingOperations,
} from "@/engine/hitOps";
import { crewPresentIn } from "@/engine/crewLocation";
import { emptyIntel } from "@/engine/intel";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import type { CrewMember, GameState, Operation, Territory } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

/** A rival block with at least two of its own men standing on it. */
function rivalBlock(state: GameState): { territory: Territory; men: CrewMember[] } {
  for (const t of state.territories) {
    if (!t.owner || t.owner === state.playerFamily) continue;
    const men = crewPresentIn(state, t.id).filter((c) => c.family === t.owner);
    if (men.length >= 2) return { territory: t, men };
  }
  throw new Error("no garrisoned rival block");
}

function playerMen(state: GameState): CrewMember[] {
  return state.crew.filter(
    (c) => c.family === state.playerFamily && c.status === "active" && c.role !== "boss",
  );
}

function hitOn(state: GameState, territory: Territory, extra: Partial<Operation>): Operation {
  return {
    id: "op_test",
    family: state.playerFamily!,
    kind: "hit",
    targetTerritoryId: territory.id,
    targetFamily: territory.owner!,
    approach: "ambush",
    shooterIds: [],
    surveilled: false,
    tippedOff: false,
    pendingTurns: 1,
    resolved: false,
    ...extra,
  };
}

describe("surveilled is earned", () => {
  it("a rival hit gets no surveilled from the clock", () => {
    const state = game();
    const rival = state.crew.find((c) => c.family === "Valenti" && c.status === "active")!;
    const home = state.territories.find((t) => t.owner === "Moretti")!;
    const op: Operation = {
      id: "op_rival",
      family: "Valenti",
      kind: "hit",
      targetTerritoryId: home.id,
      targetFamily: "Moretti",
      approach: "ambush",
      shooterIds: [rival.id],
      surveilled: false,
      tippedOff: false,
      pendingTurns: 1,
      resolved: false,
    };
    const out = resolvePendingOperations({ ...state, operations: [op] }, createRng(7), {
      skipFamily: state.playerFamily,
    });
    const after = out.state.operations.find((o) => o.id === "op_rival")!;
    expect(after.pendingTurns).toBe(0);
    expect(after.surveilled).toBe(false);
  });

  it("a surveil-first with nobody fit to look stays unsurveilled", () => {
    const state = game();
    const { territory } = rivalBlock(state);
    const shooter = playerMen(state)[0]!;
    const jailed = {
      ...state,
      crew: state.crew.map((c) => (c.id === shooter.id ? { ...c, status: "jailed" as const } : c)),
    };
    const op = hitOn(jailed, territory, { shooterIds: [shooter.id], pendingTurns: 2 });
    const out = resolvePendingOperations({ ...jailed, operations: [op] }, createRng(3), {
      skipFamily: jailed.playerFamily,
    });
    expect(out.state.operations.find((o) => o.id === op.id)!.surveilled).toBe(false);
  });

  it("a surveil-first whose lookout comes back is surveilled", () => {
    const base = game();
    const { territory } = rivalBlock(base);
    const shooter = playerMen(base)[0]!;
    const op = hitOn(base, territory, { shooterIds: [shooter.id], pendingTurns: 2 });
    for (let seed = 1; seed < 40; seed++) {
      const out = resolvePendingOperations({ ...base, operations: [op] }, createRng(seed), {
        skipFamily: base.playerFamily,
      });
      const still = out.state.crew.find((c) => c.id === shooter.id)!;
      if (still.status !== "active") continue;
      expect(out.state.operations.find((o) => o.id === op.id)!.surveilled).toBe(true);
      return;
    }
    throw new Error("every seed lost the lookout");
  });
});

describe("fresh casing on the mark", () => {
  it("adds +6% on the man the lookout saw and nothing on another", () => {
    const base = game();
    const { territory, men } = rivalBlock(base);
    const [mark, other] = men as [CrewMember, CrewMember];
    const shooter = playerMen(base)[0]!;
    const intel = {
      ...emptyIntel(),
      known: {
        [mark.id]: { territoryId: territory.id, turn: base.turn, source: "surveillance" as const },
        [other.id]: { territoryId: territory.id, turn: base.turn, source: "sighting" as const },
      },
    };
    const cased = { ...base, intel };
    const blind = { ...base, intel: emptyIntel() };

    const onMark = hitOn(cased, territory, { shooterIds: [shooter.id], targetCrewId: mark.id });
    const withEyes = calculateHitOddsBreakdown(cased, onMark).intel;
    const without = calculateHitOddsBreakdown(blind, onMark).intel;
    expect(withEyes - without).toBeCloseTo(FRESH_CASING_ODDS, 5);

    const onOther = hitOn(cased, territory, { shooterIds: [shooter.id], targetCrewId: other.id });
    expect(calculateHitOddsBreakdown(cased, onOther).intel).toBeCloseTo(
      calculateHitOddsBreakdown(blind, onOther).intel,
      5,
    );

    const stacked = { ...onMark, surveilled: true };
    expect(calculateHitOddsBreakdown(cased, stacked).intel).toBeCloseTo(
      calculateHitOddsBreakdown(blind, stacked).intel,
      5,
    );
  });
});

describe("casing guards", () => {
  it("a jailed lookout files no report and the job is called off", () => {
    const state = game();
    const { territory } = rivalBlock(state);
    const lookout = playerMen(state)[0]!;
    const op: Operation = {
      id: "op_surv_test",
      family: state.playerFamily!,
      kind: "surveillance",
      targetTerritoryId: territory.id,
      targetFamily: territory.owner!,
      shooterIds: [],
      lookoutId: lookout.id,
      surveilled: false,
      tippedOff: false,
      pendingTurns: 1,
      resolved: false,
    };
    const jailed = {
      ...state,
      operations: [op],
      crew: state.crew.map((c) => (c.id === lookout.id ? { ...c, status: "jailed" as const } : c)),
    };
    const out = resolvePendingOperations(jailed, createRng(5), { skipFamily: jailed.playerFamily });
    expect(out.reports).toHaveLength(0);
    expect(out.state.operations.find((o) => o.id === op.id)!.resolved).toBe(true);
    expect(out.tipLogs.some((l) => l.text.includes("Nobody was out there"))).toBe(true);
  });

  it("caseDistrict refuses a finished family and a block already being cased", async () => {
    const { useGameStore } = await import("@/engine/store");
    const state = game();
    const { territory } = rivalBlock(state);
    const idle = playerMen(state).filter((c) => c.assignment.type === "idle" || c.assignment.type === "garrison");
    const [first, second] = idle as [CrewMember, CrewMember];

    useGameStore.setState({ ...state, defunctFamilies: [territory.owner!] });
    useGameStore.getState().caseDistrict(territory.id, first.id);
    expect(useGameStore.getState().operations.some((o) => o.kind === "surveillance")).toBe(false);

    useGameStore.setState({ ...state, defunctFamilies: [] });
    useGameStore.getState().caseDistrict(territory.id, first.id);
    useGameStore.getState().caseDistrict(territory.id, second.id);
    const casings = useGameStore
      .getState()
      .operations.filter((o) => o.kind === "surveillance" && !o.resolved);
    expect(casings).toHaveLength(1);
    expect(casings[0]!.lookoutId).toBe(first.id);
  });
});

describe("bribes", () => {
  it("a tier on the payroll can't be bought again", () => {
    const base = game();
    const state: GameState = {
      ...base,
      money: 100_000,
      bribes: {
        ...base.bribes,
        captains: { ...base.bribes.captains, isActive: true, turnsRemaining: 3 },
      },
    };
    const after = attemptBribe(state, "captains");
    expect(after).toBe(state);
    expect(after.money).toBe(100_000);
  });
});
