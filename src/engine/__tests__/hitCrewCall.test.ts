import { describe, expect, it, vi } from "vitest";
import { abortChance, resolveHit } from "@/engine/hitOps";
import { crewPresentIn } from "@/engine/crewLocation";
import { PRESENCE_WEEKS, presenceOnBlock, recordPresence } from "@/engine/intel";
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

interface Setup {
  state: GameState;
  block: Territory;
  mark: CrewMember;
  shooter: CrewMember;
}

/**
 * A rival block with men on it, a named mark from that block who has moved to
 * another of his family's blocks, and one of our soldiers with the given smarts.
 */
function markMovedAway(smarts: number): Setup {
  const base = startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
  for (const block of base.territories) {
    if (!block.owner || block.owner === base.playerFamily) continue;
    const men = crewPresentIn(base, block.id).filter((c) => c.family === block.owner && c.role !== "boss");
    const elsewhere = base.territories.find((t) => t.owner === block.owner && t.id !== block.id);
    if (men.length < 2 || !elsewhere) continue;
    const mark = men[0]!;
    const shooter = base.crew.find(
      (c) => c.family === "Moretti" && c.status === "active" && c.role !== "boss",
    )!;
    const crew = base.crew.map((c) => {
      if (c.id === mark.id) return { ...c, assignment: { type: "garrison" as const, territoryId: elsewhere.id } };
      if (c.id === shooter.id) return { ...c, skills: { ...c.skills, smarts } };
      return c;
    });
    const territories = base.territories.map((t) => {
      if (t.id === block.id) return { ...t, garrisonIds: t.garrisonIds.filter((id) => id !== mark.id) };
      if (t.id === elsewhere.id) return { ...t, garrisonIds: [...t.garrisonIds, mark.id] };
      return t;
    });
    const state = { ...base, crew, territories };
    if (crewPresentIn(state, block.id).some((c) => c.id === mark.id)) continue;
    return { state, block, mark, shooter: crew.find((c) => c.id === shooter.id)! };
  }
  throw new Error("no rival block with a movable mark");
}

function hitOn(s: Setup, family = s.state.playerFamily!): Operation {
  return {
    id: "op_crew_call",
    family,
    kind: "hit",
    targetTerritoryId: s.block.id,
    targetFamily: s.block.owner!,
    targetCrewId: s.mark.id,
    approach: "ambush",
    shooterIds: [s.shooter.id],
    surveilled: false,
    tippedOff: false,
    pendingTurns: 0,
    resolved: false,
  };
}

describe("presence history", () => {
  it("keeps the last six weeks per rival man and counts weeks on a block", () => {
    const s = markMovedAway(50);
    let state: GameState = s.state;
    for (let t = 1; t <= 8; t++) state = recordPresence({ ...state, turn: t });
    const history = state.intel.presence![s.mark.id]!;
    expect(history).toHaveLength(PRESENCE_WEEKS);
    expect(history[0]!.turn).toBe(3);
    const elsewhere = history[0]!.territoryId;
    expect(presenceOnBlock(state, s.mark.id, elsewhere)).toEqual({ weeks: 6, of: 6 });
    expect(presenceOnBlock(state, s.mark.id, s.block.id).weeks).toBe(0);
    expect(state.intel.presence![s.shooter.id]).toBeUndefined();
  });
});

describe("abortChance", () => {
  it("is 0 for a dull lead, 1 for a sharp one, and linear in between", () => {
    expect(abortChance(10)).toBe(0);
    expect(abortChance(30)).toBe(0);
    expect(abortChance(50)).toBeCloseTo(0.5, 5);
    expect(abortChance(70)).toBe(1);
    expect(abortChance(95)).toBe(1);
  });
});

describe("the mark isn't on the block", () => {
  it("a sharp lead calls it off: no heat, no standing lost", () => {
    const s = markMovedAway(85);
    const op = hitOn(s);
    const out = resolveHit({ ...s.state, operations: [op] }, op, createRng(1));
    expect(out.result.crewCall).toBe("aborted");
    expect(out.result.outcome).toBe("target_escaped");
    expect(out.result.complication).toBe("crew_aborted");
    expect(out.result.heatGain).toBe(0);
    expect(out.result.respectDelta).toBe(0);
    expect(out.result.markAbsent).toBe(true);
    expect(out.result.casualtyDetail).toHaveLength(0);
  });

  it("a dull lead goes in blind on whoever is there", () => {
    const s = markMovedAway(15);
    const op = hitOn(s);
    for (let seed = 1; seed < 20; seed++) {
      const out = resolveHit({ ...s.state, operations: [op] }, op, createRng(seed));
      expect(out.result.crewCall).toBe("went_blind");
      expect(out.result.blind).toBe(true);
      expect(out.result.markAbsent).toBe(false);
      expect(out.result.heatGain).toBeGreaterThan(0);
      if (out.result.targetDead) {
        const dead = out.state.crew.find((c) => c.id === s.mark.id)!;
        expect(dead.status).not.toBe("dead");
      }
    }
  });

  it("a rival's hit keeps the old empty-alley result", () => {
    const s = markMovedAway(85);
    const rivalShooter = s.state.crew.find(
      (c) => c.family !== s.block.owner && c.family !== "Moretti" && c.status === "active",
    )!;
    const op = { ...hitOn(s, rivalShooter.family), shooterIds: [rivalShooter.id] };
    const out = resolveHit({ ...s.state, operations: [op] }, op, createRng(2));
    expect(out.result.crewCall).toBeUndefined();
    expect(out.result.outcome).toBe("target_escaped");
  });
});
