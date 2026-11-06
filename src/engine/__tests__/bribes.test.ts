import { describe, expect, it, vi, afterEach } from "vitest";
import {
  attemptBribe,
  bribeBreakdown,
  bribeSuccessRate,
  envelopeMan,
} from "@/engine/bribes";
import { emptyIntel } from "@/engine/intel";
import { buildInitialState, startGame } from "@/engine/initialState";
import { jailInCrew } from "@/engine/jail";
import { crewPresentIn } from "@/engine/crewLocation";
import type { CasingClue, CrewMember, GameState, Territory } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

function rivalBlock(state: GameState): { territory: Territory; men: CrewMember[] } {
  for (const t of state.territories) {
    if (!t.owner || t.owner === state.playerFamily) continue;
    const men = crewPresentIn(state, t.id).filter((c) => c.family === t.owner);
    if (men.length >= 1) return { territory: t, men };
  }
  const t = state.territories.find((x) => x.owner && x.owner !== state.playerFamily);
  if (!t) throw new Error("no rival district");
  return { territory: t, men: [] };
}

function copClue(territory: Territory, buyable: boolean): CasingClue {
  return {
    id: `clue_cop_${territory.id}`,
    kind: "cop_on_payroll",
    territoryId: territory.id,
    targetFamily: territory.owner!,
    copBuyable: buyable,
    turn: 1,
    expiresTurn: 99,
    text: "cop",
  };
}

function idleInner(state: GameState, extra: Partial<CrewMember> = {}): GameState {
  return {
    ...state,
    crew: state.crew.map((c) => {
      if (c.family !== "Moretti") return c;
      if (c.role !== "capo" && c.role !== "underboss" && c.role !== "consigliere" && c.role !== "boss") {
        return c;
      }
      if (c.status !== "active") return c;
      return {
        ...c,
        assignment: { type: "idle" as const },
        ...extra,
        traits: extra.traits ?? c.traits,
        skills: extra.skills ?? c.skills,
      };
    }),
  };
}

describe("cops", () => {
  it("a hot theirs corner misses more than a cased buyable cool block with an inner-circle ghost", () => {
    const base = idleInner(game());
    const { territory, men } = rivalBlock(base);
    const mark = men[0];
    const hot: GameState = {
      ...base,
      territories: base.territories.map((t) =>
        t.id === territory.id ? { ...t, heatLevel: 18 } : t,
      ),
      intel: {
        ...emptyIntel(),
        clues: { [territory.id]: [copClue(territory, false)] },
      },
    };
    const cool: GameState = {
      ...base,
      territories: base.territories.map((t) =>
        t.id === territory.id ? { ...t, heatLevel: 0 } : t,
      ),
      crew: base.crew.map((c) => {
        if (c.family !== "Moretti" || c.role !== "capo" || c.status !== "active") return c;
        return {
          ...c,
          assignment: { type: "idle" as const },
          traits: [...c.traits.filter((tr) => tr !== "hothead"), "ghost"],
          skills: { ...c.skills, charm: 80 },
        };
      }),
      intel: {
        ...emptyIntel(),
        clues: { [territory.id]: [copClue(territory, true)] },
        known: mark
          ? {
              [mark.id]: {
                territoryId: territory.id,
                turn: base.turn,
                source: "surveillance" as const,
              },
            }
          : {},
      },
    };
    const bad = bribeSuccessRate(hot, "cops", { territoryId: territory.id });
    const good = bribeSuccessRate(cool, "cops", { territoryId: territory.id });
    expect(good).toBeGreaterThan(bad + 0.25);
    expect(bribeBreakdown(hot, "cops", { territoryId: territory.id }).hurts).toEqual(
      expect.arrayContaining(["The cop on the corner is theirs"]),
    );
  });
});

describe("envelope", () => {
  it("never picks a soldier, even a ghost, over a capo", () => {
    const base = game();
    const state: GameState = {
      ...base,
      crew: base.crew.map((c) => {
        if (c.family !== "Moretti" || c.status !== "active") return c;
        if (c.role === "soldier") {
          return {
            ...c,
            assignment: { type: "idle" as const },
            traits: [...c.traits, "ghost"],
            skills: { ...c.skills, charm: 99 },
          };
        }
        if (c.role === "capo") {
          return {
            ...c,
            assignment: { type: "idle" as const },
            traits: c.traits.filter((t) => t !== "ghost"),
            skills: { ...c.skills, charm: 5 },
          };
        }
        if (c.role === "boss" || c.role === "underboss" || c.role === "consigliere") {
          return { ...c, assignment: { type: "operation" as const, operationId: "busy" } };
        }
        return c;
      }),
    };
    const man = envelopeMan(state, "cops");
    expect(man).not.toBeNull();
    expect(man!.role).not.toBe("soldier");
    expect(man!.role).toBe("capo");
  });

  it("soldiers never carry even when they are the only idle men", () => {
    const base = game();
    const state: GameState = {
      ...base,
      crew: base.crew.map((c) => {
        if (c.family !== "Moretti" || c.status !== "active") return c;
        if (c.role === "soldier" || c.role === "associate") {
          return { ...c, assignment: { type: "idle" as const }, traits: ["ghost"] };
        }
        return { ...c, assignment: { type: "operation" as const, operationId: "busy" } };
      }),
    };
    expect(envelopeMan(state, "cops")).toBeNull();
    expect(envelopeMan(state, "captains")).toBeNull();
  });
});

describe("captains", () => {
  it("an inner-circle hothead-only roster is worse than a mixed inner circle", () => {
    const base = game();
    const borough = rivalBlock(base).territory.borough;
    const allHot: GameState = {
      ...base,
      crew: base.crew.map((c) => {
        if (c.family !== "Moretti" || c.status !== "active") return c;
        if (c.role !== "boss" && c.role !== "underboss" && c.role !== "consigliere" && c.role !== "capo") {
          return c;
        }
        return {
          ...c,
          assignment: { type: "idle" as const },
          traits: [...c.traits.filter((t) => t !== "ghost"), "hothead"],
        };
      }),
    };
    const mixed: GameState = {
      ...allHot,
      crew: allHot.crew.map((c) => {
        if (c.family !== "Moretti" || c.role !== "underboss") return c;
        return { ...c, traits: c.traits.filter((t) => t !== "hothead") };
      }),
    };
    const hotRate = bribeSuccessRate(allHot, "captains", { borough });
    const calmRate = bribeSuccessRate(mixed, "captains", { borough });
    expect(calmRate).toBeGreaterThan(hotRate);
    expect(bribeBreakdown(allHot, "captains", { borough }).hurts.some((h) => h.includes("hothead"))).toBe(
      true,
    );
    expect(bribeBreakdown(mixed, "captains", { borough }).hurts.some((h) => h.includes("hothead"))).toBe(
      false,
    );
  });

  it("requires a borough", () => {
    const state = { ...game(), money: 50_000 };
    const after = attemptBribe(state, "captains");
    expect(after.state.bribes.captains.isActive).toBe(false);
    expect(after.state.money).toBe(50_000);
    expect(after.state.turnLog.at(-1)?.text).toMatch(/borough/i);
  });
});

describe("chiefs", () => {
  it("hasCase and a retainer beat a funeral and a rat leak", () => {
    const base = game();
    const good: GameState = {
      ...base,
      vendettas: ["Valenti"],
      lawyerRetainer: { tier: "house", until: base.turn + 3 },
    };
    const bad: GameState = {
      ...base,
      vendettas: [],
      mourningUntil: base.turn + 2,
      ratLeakTurn: base.turn,
      ratLeakWeeks: 4,
    };
    expect(bribeSuccessRate(good, "chiefs", { family: "Valenti" })).toBeGreaterThan(
      bribeSuccessRate(bad, "chiefs", { family: "Valenti" }),
    );
    expect(bribeBreakdown(bad, "chiefs", { family: "Valenti" }).hurts).toEqual(
      expect.arrayContaining(["Funeral — chiefs won't be seen with you", "A rat is talking"]),
    );
  });
});

describe("mayor", () => {
  it("heat 60 is much worse than heat 10 at the same respect", () => {
    const base = game();
    const cool: GameState = {
      ...base,
      reputation: { ...base.reputation, respect: 100, fear: 100 },
      heat: { ...base.heat, level: 10 },
      money: 25_000,
    };
    const hot: GameState = { ...cool, heat: { ...cool.heat, level: 60 } };
    const gap = bribeSuccessRate(cool, "mayor") - bribeSuccessRate(hot, "mayor");
    expect(gap).toBeGreaterThan(0.4);
  });

  it("extra clean cash helps a little", () => {
    const base = game();
    const broke: GameState = { ...base, money: 25_000, heat: { ...base.heat, level: 0 } };
    const flush: GameState = { ...broke, money: 25_000 + 80_000 };
    expect(bribeSuccessRate(flush, "mayor")).toBeGreaterThan(bribeSuccessRate(broke, "mayor"));
    expect(bribeSuccessRate(flush, "mayor") - bribeSuccessRate(broke, "mayor")).toBeCloseTo(0.15, 5);
  });
});

describe("judge", () => {
  it("still uses the old formula, and a live mayor adds 35% only there", () => {
    const base = game();
    const boss = base.crew.find((c) => c.family === "Moretti" && c.role === "boss")!;
    const jailed: GameState = {
      ...base,
      money: 80_000,
      reputation: { ...base.reputation, respect: 0, fear: 0 },
      heat: { ...base.heat, level: 0 },
      crew: jailInCrew(base.crew, boss.id, base.turn),
    };
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    const dry = attemptBribe(jailed, "judge");
    expect(dry.state.crew.find((c) => c.id === boss.id)!.status).toBe("jailed");
    expect(dry.reveal).toBeUndefined();

    const withMayor: GameState = {
      ...jailed,
      bribes: {
        ...jailed.bribes,
        mayor: { ...jailed.bribes.mayor, isActive: true, turnsRemaining: 4 },
      },
    };
    const wet = attemptBribe(withMayor, "judge");
    expect(wet.state.crew.find((c) => c.id === boss.id)!.status).toBe("active");
    expect(wet.reveal).toBeUndefined();
  });
});
