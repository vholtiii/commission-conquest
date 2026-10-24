import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { backfillSentences, jailInCrew, newlyJailed, sentenceWeeks, tickJails } from "@/engine/jail";
import {
  bailBase,
  bumpRate,
  coolRate,
  fightBase,
  lawyerFee,
  lawyerName,
  migrateRetainer,
  RATE_CAP,
  weeksToCool,
} from "@/engine/lawyer";
import { unfinishedBusiness } from "@/engine/unfinishedBusiness";
import { collectLaunderSites, createRacket, nextScrutiny, processLaundering } from "@/engine/economy";
import { lawyerAuditReads } from "@/engine/auditReads";
import { createRng } from "@/engine/rng";
import type { CrewMember, GameState } from "@/types/game";

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

function soldier(state: GameState): CrewMember {
  return state.crew.find((c) => c.family === "Moretti" && c.role === "soldier" && c.status === "active")!;
}

describe("sentences", () => {
  it("runs 3 to 6 weeks by wanted", () => {
    expect(sentenceWeeks(0)).toBe(3);
    expect(sentenceWeeks(1)).toBe(3);
    expect(sentenceWeeks(2)).toBe(4);
    expect(sentenceWeeks(5)).toBe(5);
    expect(sentenceWeeks(20)).toBe(6);
  });

  it("jails a soldier with an end date and lets him out when it's up", () => {
    const base = game();
    const man = soldier(base);
    let state: GameState = {
      ...base,
      turn: 5,
      crew: base.crew.map((c) => (c.id === man.id ? { ...c, wanted: 2 } : c)),
    };
    state = { ...state, crew: jailInCrew(state.crew, man.id, state.turn) };
    const inside = state.crew.find((c) => c.id === man.id)!;
    expect(inside.status).toBe("jailed");
    expect(inside.jailedUntilTurn).toBe(9);
    expect(newlyJailed(base.crew, state.crew, "Moretti").map((c) => c.id)).toEqual([man.id]);

    const early = tickJails({ ...state, turn: 8 }, createRng(1));
    expect(early.state.crew.find((c) => c.id === man.id)!.status).toBe("jailed");

    const out = tickJails({ ...state, turn: 9 }, createRng(1));
    const walked = out.state.crew.find((c) => c.id === man.id)!;
    expect(walked.status).toBe("active");
    expect(walked.assignment.type).toBe("idle");
    expect(walked.wanted).toBe(1);
    expect(walked.jailedUntilTurn).toBeUndefined();
    expect(out.logs.some((l) => l.id.startsWith("log_jail_out_") && l.crewId === man.id)).toBe(true);
  });

  it("gives old-save soldiers with no sentence three weeks", () => {
    const base = game();
    const man = soldier(base);
    const crew = base.crew.map((c) => (c.id === man.id ? { ...c, status: "jailed" as const } : c));
    const fixed = backfillSentences(crew, 12);
    expect(fixed.find((c) => c.id === man.id)!.jailedUntilTurn).toBe(15);
  });

  it("flags men inside with no case fought as a loose end", () => {
    const base = game();
    const man = soldier(base);
    const state = { ...base, crew: jailInCrew(base.crew, man.id, base.turn) };
    expect(unfinishedBusiness(state).some((e) => e.id === "inside")).toBe(true);
    const fought = {
      ...state,
      crew: state.crew.map((c) => (c.id === man.id ? { ...c, caseFought: true } : c)),
    };
    expect(unfinishedBusiness(fought).some((e) => e.id === "inside")).toBe(false);
  });
});

describe("fees", () => {
  const plain = { turn: 10, lawyerRate: 1, lawyerRetainer: null };

  it("prices bail and the case by wanted, more for a capo", () => {
    expect(bailBase({ wanted: 2, role: "soldier" })).toBe(1400);
    expect(bailBase({ wanted: 2, role: "capo" })).toBe(2100);
    expect(fightBase({ wanted: 3 })).toBe(1200);
  });

  it("takes the retainer's cut off case work and applies the rate", () => {
    expect(lawyerFee(plain, 1400, true)).toBe(1400);
    const house = { ...plain, lawyerRetainer: { tier: "house" as const, until: 12 } };
    expect(lawyerFee(house, 1400, true)).toBe(980);
    expect(lawyerFee(house, 1400, false)).toBe(1400);
    const lapsed = { ...house, turn: 12 };
    expect(lawyerFee(lapsed, 1400, true)).toBe(1400);
    const pricey = { ...house, lawyerRate: 1.3 };
    expect(lawyerFee(pricey, 1400, true)).toBe(1270);
  });
});

describe("rate", () => {
  it("climbs 15% a job, caps at 2x, and cools 5% a week", () => {
    expect(bumpRate(1)).toBe(1.15);
    let rate = 1;
    for (let i = 0; i < 10; i++) rate = bumpRate(rate);
    expect(rate).toBe(RATE_CAP);
    expect(coolRate(1.3)).toBe(1.25);
    expect(coolRate(1.02)).toBe(1);
    expect(weeksToCool(1.3)).toBe(6);
    expect(weeksToCool(1)).toBe(0);
  });
});

/** One fresh laundromat on a player block, set up and ready, with nothing else washing. */
function withFront(): { state: GameState; racketId: string; cap: number } {
  const base = game();
  const block = base.territories.find((t) => t.owner === "Moretti")!;
  const racket = { ...createRacket("r_test_front", block.id, "laundromat", 1, 0), launderReadyTurn: 1 };
  const territories = base.territories.map((t) =>
    t.id === block.id ? { ...t, rackets: [...t.rackets, racket] } : t,
  );
  const state: GameState = {
    ...base,
    turn: 20,
    dirtyMoney: 1_000_000,
    heat: { ...base.heat, level: 5 },
    territories,
    launderPlan: {},
  };
  const cap = collectLaunderSites({ ...state, launderPlan: { [racket.id]: 1 } }, territories)[0]!.cap;
  return { state, racketId: racket.id, cap };
}

function front(state: GameState, racketId: string) {
  return state.territories.flatMap((t) => t.rackets).find((r) => r.id === racketId)!;
}

/** Close one week of laundering at `amount` on the test front. */
function week(state: GameState, racketId: string, amount: number) {
  const s = { ...state, launderPlan: { [racketId]: amount } };
  const out = processLaundering(s, s.territories);
  const territories = s.territories.map((t) => ({
    ...t,
    rackets: t.rackets.map((r) => {
      const patch = out.racketUpdates.get(r.id);
      return patch ? { ...r, ...patch } : r;
    }),
  }));
  return {
    state: { ...s, territories, turn: s.turn + 1, dirtyMoney: s.dirtyMoney + out.dirtyDelta },
    out,
  };
}

describe("audits", () => {
  it("builds scrutiny near the cap, jumps over it, and cools paused", () => {
    expect(nextScrutiny(0, 0.5, 1)).toBe(0);
    expect(nextScrutiny(0, 0.8, 1)).toBeGreaterThan(0);
    expect(nextScrutiny(0, 0.95, 1)).toBeGreaterThan(nextScrutiny(0, 0.8, 1));
    expect(nextScrutiny(0, 1.5, 1)).toBeGreaterThan(0.5);
    expect(nextScrutiny(0.8, 0.5, 1)).toBeLessThan(0.8);
    expect(nextScrutiny(0.8, 0, 1)).toBeLessThan(nextScrutiny(0.8, 0.5, 1));
    expect(nextScrutiny(0.5, 0.9, 2)).toBeGreaterThan(nextScrutiny(0.5, 0.9, 1));
  });

  it("opens a file past the line and lands it on the due week", () => {
    const { state, racketId, cap } = withFront();
    let s = state;
    let openedOn: number | undefined;
    for (let i = 0; i < 6 && openedOn == null; i++) {
      s = week(s, racketId, cap * 2).state;
      openedOn = front(s, racketId).auditOpenedTurn;
    }
    expect(openedOn).toBeDefined();
    const due = front(s, racketId).auditDueTurn!;
    expect(due - openedOn!).toBeGreaterThanOrEqual(1);
    expect(due - openedOn!).toBeLessThanOrEqual(3);
    let audited = false;
    while (s.turn <= due) {
      const step = week(s, racketId, cap * 2);
      s = step.state;
      if (step.out.audits.length > 0) {
        audited = true;
        expect(step.state.turn - 1).toBe(due);
      }
    }
    expect(audited).toBe(true);
    expect(front(s, racketId).frozenUntil).toBeGreaterThan(due);
    expect(front(s, racketId).auditDueTurn).toBeUndefined();
  });

  it("closes the file when the front is paused in time", () => {
    const { state, racketId } = withFront();
    const territories = state.territories.map((t) => ({
      ...t,
      rackets: t.rackets.map((r) =>
        r.id === racketId ? { ...r, scrutiny: 1, auditOpenedTurn: 19, auditDueTurn: 22 } : r,
      ),
    }));
    let s: GameState = { ...state, territories };
    const logs: string[] = [];
    let audits = 0;
    while (s.turn <= 22) {
      const step = week(s, racketId, 0);
      s = step.state;
      audits += step.out.audits.length;
      logs.push(...step.out.logs.map((l) => l.id));
    }
    expect(audits).toBe(0);
    expect(logs.some((id) => id.startsWith("log_audit_closed_"))).toBe(true);
    expect(front(s, racketId).auditDueTurn).toBeUndefined();
  });

  it("reads Treasury better the better the retainer", () => {
    const { state, racketId } = withFront();
    const fileOpen = (s: GameState) => ({
      ...s,
      territories: s.territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) =>
          r.id === racketId ? { ...r, scrutiny: 1.2, auditOpenedTurn: 20, auditDueTurn: 22 } : r,
        ),
      })),
    });
    const near = (s: GameState) => ({
      ...s,
      territories: s.territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) => (r.id === racketId ? { ...r, scrutiny: 0.8 } : r)),
      })),
    });
    const hired = (tier: "street" | "house" | "top") => ({ lawyerRetainer: { tier, until: 30 } });
    const readOf = (s: GameState) => lawyerAuditReads(s).find((r) => r.racketId === racketId);

    expect(lawyerAuditReads(fileOpen(state))).toEqual([]);

    const top = readOf({ ...fileOpen(state), ...hired("top") })!;
    expect(top.dueTurn).toBe(22);
    expect(top.tag).toContain("week 22");
    expect(readOf({ ...near(state), ...hired("top") })?.advice).toBe("ease");

    const house = readOf({ ...fileOpen(state), ...hired("house") })!;
    expect(house.tag).toContain("within a few weeks");
    expect(house.dueTurn).toBeUndefined();

    let streetSpotted = 0;
    let streetFalse = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (readOf({ ...fileOpen(state), seed, ...hired("street") })) streetSpotted++;
      if (readOf({ ...near(state), seed, ...hired("street") })) streetFalse++;
    }
    expect(streetSpotted).toBeGreaterThan(90);
    expect(streetSpotted).toBeLessThan(150);
    expect(streetFalse).toBeGreaterThan(15);
    expect(streetFalse).toBeLessThan(70);
  });
});

describe("old saves", () => {
  it("maps counsel to house and the street lawyer to street", () => {
    expect(migrateRetainer({ counselUntil: 14 }, 10)).toEqual({ tier: "house", until: 14 });
    expect(migrateRetainer({ streetLawyerUntil: 12 }, 10)).toEqual({ tier: "street", until: 12 });
    expect(migrateRetainer({ streetLawyerUntil: 16, counselUntil: 13 }, 10)).toEqual({ tier: "house", until: 16 });
    expect(migrateRetainer({ counselUntil: 8 }, 10)).toBeNull();
    expect(migrateRetainer({ lawyerRetainer: { tier: "top", until: 20 } }, 10)).toEqual({ tier: "top", until: 20 });
  });

  it("keeps one lawyer per seed", () => {
    expect(lawyerName({ seed: 42 })).toBe(lawyerName({ seed: 42 }));
    expect(lawyerName({ seed: 42, lawyerName: "Sol Hirsch, Esq." })).toBe("Sol Hirsch, Esq.");
  });
});
