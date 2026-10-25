import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createCrewMember, MAX_WANTED, raiseWanted } from "@/engine/crew";
import { DISTRICT_HEAT_CAP } from "@/engine/economy";
import { applyOutcome } from "@/engine/eventEffects";
import { HIT_WANTED, resolveHit } from "@/engine/hitOps";
import { CAPTURE_WANTED, captureAllowance, eligibleCaptureCrew, resolveCapture } from "@/engine/capture";
import { crewPresentIn } from "@/engine/crewLocation";
import {
  applyFederalIndictments,
  arrestRisk,
  processHeatTurn,
  quietHeatDecay,
  RICO,
  ricoTargets,
  warrantChance,
  WARRANT,
} from "@/engine/heat";
import { createRng } from "@/engine/rng";
import type { CrewMember, CrewRole, GameEvent, GameState, Operation } from "@/types/game";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event district heat", () => {
  it("stops at the district cap", () => {
    const state = game();
    const block = state.territories.find((t) => t.owner === "Moretti")!;
    const event = { id: "evt_test", title: "Test", choices: [] } as unknown as GameEvent;
    const out = applyOutcome(state, { territoryHeat: { territoryId: block.id, delta: 40 } }, createRng(1), event);
    expect(out.territories.find((t) => t.id === block.id)!.heatLevel).toBe(DISTRICT_HEAT_CAP);
  });
});

/** A rival block with men on it, a mark from there, and a shooter from `family`. */
function hitSetup(family: string) {
  const state = game();
  for (const block of state.territories) {
    if (!block.owner || block.owner === family) continue;
    const men = crewPresentIn(state, block.id).filter((c) => c.family === block.owner && c.role !== "boss");
    if (men.length === 0) continue;
    const shooter = state.crew.find((c) => c.family === family && c.status === "active" && c.role !== "boss")!;
    const op: Operation = {
      id: "op_wanted",
      family: family as Operation["family"],
      kind: "hit",
      targetTerritoryId: block.id,
      targetFamily: block.owner,
      targetCrewId: men[0]!.id,
      approach: "ambush",
      shooterIds: [shooter.id],
      surveilled: false,
      tippedOff: false,
      pendingTurns: 0,
      resolved: false,
    };
    return { state: { ...state, operations: [op] }, op, shooter };
  }
  throw new Error("no rival block with men");
}

describe("wanted from hits", () => {
  it("the player's shooter picks up wanted by outcome", () => {
    const { state, op, shooter } = hitSetup("Moretti");
    let gained = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const out = resolveHit(state, op, createRng(seed));
      const after = out.state.crew.find((c) => c.id === shooter.id)!;
      if (after.status === "dead") continue;
      const sheet = out.result.crewCall === "aborted" ? 0 : HIT_WANTED[out.result.outcome];
      expect(after.wanted).toBe(raiseWanted(shooter, sheet));
      if (sheet > 0) gained++;
    }
    expect(gained).toBeGreaterThan(0);
  });

  it("a rival's shooter does not", () => {
    const { state, op, shooter } = hitSetup("Valenti");
    for (let seed = 1; seed <= 10; seed++) {
      const out = resolveHit(state, op, createRng(seed));
      const after = out.state.crew.find((c) => c.id === shooter.id)!;
      expect(after.wanted).toBe(shooter.wanted);
    }
  });
});

describe("raiseWanted", () => {
  it("stops at the cap but never lowers a man already past it", () => {
    expect(raiseWanted({ wanted: 3 }, 2)).toBe(5);
    expect(raiseWanted({ wanted: 9 }, 2)).toBe(MAX_WANTED);
    expect(raiseWanted({ wanted: 14 }, 1)).toBe(14);
  });
});

describe("wanted from captures", () => {
  it("everyone sent on the attack picks up wanted, win or lose", () => {
    const state = game();
    const mine = new Set(state.territories.filter((t) => t.owner === "Moretti").map((t) => t.id));
    const target = state.territories.find(
      (t) =>
        t.owner &&
        t.owner !== "Moretti" &&
        t.adjacentTerritories.some((id) => mine.has(id)) &&
        captureAllowance(state, "Moretti", t).ok &&
        eligibleCaptureCrew(state, t.id).length > 0,
    )!;
    expect(target).toBeTruthy();
    const chosen = eligibleCaptureCrew(state, target.id).slice(0, 2);
    let won = 0;
    let lost = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const out = resolveCapture(state, target.id, chosen.map((c) => c.id), createRng(seed));
      if (out.blocked) continue;
      out.success ? won++ : lost++;
      for (const c of chosen) {
        expect(out.state.crew.find((m) => m.id === c.id)!.wanted).toBe(raiseWanted(c, CAPTURE_WANTED));
      }
    }
    expect(won + lost).toBeGreaterThan(0);
  });
});

describe("warrant odds", () => {
  it("climb from 8% at the line to 20% at 100", () => {
    expect(warrantChance(59)).toBe(0);
    expect(warrantChance(60)).toBeCloseTo(0.08);
    expect(warrantChance(80)).toBeCloseTo(0.14);
    expect(warrantChance(100)).toBeCloseTo(0.2);
  });

  it("arrestRisk uses the live odds, and a talking rat adds on top", () => {
    const base = game();
    const m = { ...base.crew.find((c) => c.family === "Moretti" && c.role === "soldier")!, status: "active" as const, wanted: 8 };
    const hot = { ...base, heat: { ...base.heat, level: 90 } };
    expect(arrestRisk(hot, m).chance).toBeCloseTo(warrantChance(90));
    const leaking = { ...hot, ratLeakTurn: hot.turn };
    expect(arrestRisk(leaking, m).chance).toBeCloseTo(warrantChance(90) + WARRANT.ratBonus);
  });
});

function man(role: CrewRole, seed: number, extra: Partial<CrewMember> = {}): CrewMember {
  return { ...createCrewMember(createRng(seed), "Moretti", role), status: "active", ...extra };
}

/** The player's family cut down to the given men, at this heat. */
function federal(heat: number, crew: CrewMember[], extra: Partial<GameState> = {}): GameState {
  const base = game();
  return {
    ...base,
    turn: 30,
    heat: { ...base.heat, level: heat },
    crew: [...base.crew.filter((c) => c.family !== "Moretti"), ...crew],
    ...extra,
  };
}

describe("weekly cooling", () => {
  it("cools off the level the week opened on, so a heavy week can end at Federal", () => {
    const base = game();
    const capped = { ...base, heat: { ...base.heat, level: 100 } };
    const out = processHeatTurn(capped, 70);
    expect(out.heat.level).toBeCloseTo(100 - quietHeatDecay(capped, 70));
    expect(out.heat.level).toBeGreaterThanOrEqual(RICO.heatFloor);
  });
});

describe("RICO", () => {
  it("names officers, never associates or soldiers, and the boss only from 90", () => {
    const crew = [
      man("boss", 1),
      man("underboss", 2),
      man("consigliere", 3),
      man("capo", 4),
      man("soldier", 5),
      man("associate", 6),
      man("hitman", 7),
    ];
    const at85 = ricoTargets(federal(85, crew)).map((t) => t.man.role);
    expect(at85.sort()).toEqual(["capo", "consigliere", "underboss"]);
    const at95 = ricoTargets(federal(95, crew)).map((t) => t.man.role);
    expect(at95).toContain("boss");
    expect(at95).not.toContain("soldier");
    expect(at95).not.toContain("associate");
  });

  it("does nothing below Federal", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const state = federal(79, [man("boss", 1), man("capo", 2)]);
    expect(applyFederalIndictments(state)).toBe(state);
  });

  it("puts an officer away for the federal sentence and logs it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const capo = man("capo", 2);
    const out = applyFederalIndictments(federal(85, [man("boss", 1), capo]));
    const jailed = out.crew.find((c) => c.id === capo.id)!;
    expect(jailed.status).toBe("jailed");
    expect(jailed.jailedUntilTurn).toBe(30 + RICO.sentence);
    expect(out.lastIndictmentTurn).toBe(30);
    expect(out.turnLog.at(-1)!.id.startsWith("log_rico_")).toBe(true);
  });

  it("reaches the boss at 90 when no officer is on the street", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const boss = man("boss", 1);
    const crew = [boss, man("capo", 2, { status: "wounded" }), man("associate", 3)];
    expect(applyFederalIndictments(federal(85, crew)).crew.find((c) => c.id === boss.id)!.status).toBe("active");
    expect(applyFederalIndictments(federal(92, crew)).crew.find((c) => c.id === boss.id)!.status).toBe("jailed");
  });

  it("waits out the cooldown between indictments", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const crew = [man("boss", 1), man("capo", 2)];
    const soon = federal(90, crew, { lastIndictmentTurn: 30 - RICO.cooldown + 1 });
    expect(applyFederalIndictments(soon)).toBe(soon);
    const later = federal(90, crew, { lastIndictmentTurn: 30 - RICO.cooldown });
    expect(applyFederalIndictments(later).lastIndictmentTurn).toBe(30);
  });
});
