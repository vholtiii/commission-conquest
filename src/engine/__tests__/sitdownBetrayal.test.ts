import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { getBoss } from "@/engine/crew";
import { resolveCrewTerritoryId } from "@/engine/crewLocation";
import { calculateHitOdds, resolveHit } from "@/engine/hitOps";
import {
  likelyBetrayalEscort,
  sitdownInviteChance,
  type BetrayalEscort,
} from "@/engine/sitdownBetrayal";
import { canDiplomacy, sitdownInfluenceCost, tableBurned } from "@/engine/diplomacy";
import { proposePassageSitdown } from "@/engine/sitdowns";
import { getRelation, setRelation } from "@/engine/relations";
import { createRng, type Rng } from "@/engine/rng";
import type { CrewMember, GameState, Operation } from "@/types/game";

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

function rivalMark(state: GameState): CrewMember {
  const boss = getBoss(state.crew, "Valenti");
  if (boss && boss.status === "active") return boss;
  const any = state.crew.find((c) => c.family === "Valenti" && c.status === "active");
  if (!any) throw new Error("no Valenti mark");
  return any;
}

function betrayalOp(state: GameState, mark: CrewMember, venueId: string, shooterIds: string[] = []): Operation {
  const nego = getBoss(state.crew, "Moretti")!;
  return {
    id: "op_betray_test",
    family: "Moretti",
    kind: "hit",
    targetCrewId: mark.id,
    targetTerritoryId: venueId,
    targetFamily: mark.family,
    approach: "sitdown_betrayal",
    shooterIds,
    negotiatorId: nego.id,
    surveilled: false,
    tippedOff: false,
    pendingTurns: 0,
    resolved: false,
  };
}

function sitRng(kind: "kill" | "escape"): Rng {
  const base = createRng(7);
  let invite = true;
  return {
    ...base,
    chance: () => {
      if (invite) {
        invite = false;
        return true;
      }
      return false;
    },
    next: () => (kind === "kill" ? 0 : 0.99),
  };
}

function withWar(state: GameState, family: "Valenti"): GameState {
  return { ...state, relations: setRelation(state.relations, "Moretti", family, -70) };
}

function withTruce(state: GameState, family: "Valenti"): GameState {
  return { ...state, relations: setRelation(state.relations, "Moretti", family, 20) };
}

describe("sit-down betrayal invite, escort, handshake", () => {
  it("cuts sit chance when the mark is off the venue block", () => {
    const state = game();
    const mark = rivalMark(state);
    const home = resolveCrewTerritoryId(state, mark.id)!;
    const ours = resolveCrewTerritoryId(state, getBoss(state.crew, "Moretti")!.id)!;
    expect(home).not.toBe(ours);
    const on = sitdownInviteChance(state, betrayalOp(state, mark, home));
    const off = sitdownInviteChance(state, betrayalOp(state, mark, ours));
    expect(off).toBeLessThan(on);
  });

  it("refuse applies heat and a relations hit without burning the table", () => {
    const base = game();
    const mark = rivalMark(base);
    const home = resolveCrewTerritoryId(base, mark.id)!;
    const op = betrayalOp(base, mark, home);
    const beforeRel = getRelation(base.relations, "Moretti", mark.family);
    const beforeInf = base.influence;
    const beforeHeat = base.heat.level;
    const rng = { ...createRng(1), chance: () => false };
    const out = resolveHit({ ...base, operations: [op] }, op, rng);
    expect(out.result.markAbsent).toBe(true);
    expect(out.result.headline.toLowerCase()).toMatch(/empty|never sits|smelled/);
    expect(out.state.heat.level).toBeGreaterThan(beforeHeat);
    expect(getRelation(out.state.relations, "Moretti", mark.family)).toBeLessThan(beforeRel);
    expect(tableBurned(out.state, mark.family)).toBe(false);
    expect(sitdownInfluenceCost(out.state)).toBe(15);
    expect(out.state.influence).toBe(beforeInf);
    expect(canDiplomacy(out.state, "sitdown", mark.family).ok).toBe(true);
  });

  it("war escort includes muscle; consigliere-only escort does not cut kill vs no guns", () => {
    const base = withWar(game(), "Valenti");
    const mark = rivalMark(base);
    const home = resolveCrewTerritoryId(base, mark.id)!;
    const op = betrayalOp(base, mark, home);
    const war = likelyBetrayalEscort(base, op);
    expect(war.likelyMuscle).toBeGreaterThanOrEqual(2);

    const consig = base.crew.find(
      (c) => c.family === "Valenti" && c.role === "consigliere" && c.status === "active",
    );
    const none: BetrayalEscort = { muscleIds: [], likelyMuscle: 0, likelyConsigliere: false };
    const onlyConsig: BetrayalEscort = {
      muscleIds: [],
      consigliereId: consig?.id,
      likelyMuscle: 0,
      likelyConsigliere: !!consig,
    };
    expect(calculateHitOdds(base, op, { escort: none })).toBe(
      calculateHitOdds(base, op, { escort: onlyConsig }),
    );
  });

  it("smart backup beats high-muscle escort on kill odds versus dumb backup", () => {
    const base = withWar(game(), "Valenti");
    const mark = rivalMark(base);
    const home = resolveCrewTerritoryId(base, mark.id)!;
    const guns = base.crew
      .filter((c) => c.family === "Valenti" && c.status === "active" && (c.role === "soldier" || c.role === "capo"))
      .slice(0, 2);
    expect(guns.length).toBeGreaterThanOrEqual(1);
    const escort: BetrayalEscort = {
      muscleIds: guns.map((c) => c.id),
      likelyMuscle: guns.length,
      likelyConsigliere: false,
    };
    const smart = base.crew.find((c) => c.family === "Moretti" && c.status === "active" && c.role !== "boss")!;
    const dumb = base.crew.find(
      (c) => c.family === "Moretti" && c.status === "active" && c.role !== "boss" && c.id !== smart.id,
    )!;
    const highMuscle = Math.max(...guns.map((c) => c.skills.muscle), 80);
    const crew = base.crew.map((c) => {
      if (c.id === smart.id) return { ...c, skills: { ...c.skills, smarts: highMuscle + 20 } };
      if (c.id === dumb.id) return { ...c, skills: { ...c.skills, smarts: 5 } };
      if (guns.some((g) => g.id === c.id)) return { ...c, skills: { ...c.skills, muscle: highMuscle } };
      return c;
    });
    const state = { ...base, crew };
    const opSmart = betrayalOp(state, mark, home, [smart.id]);
    const opDumb = betrayalOp(state, mark, home, [dumb.id]);
    expect(calculateHitOdds(state, opSmart, { escort })).toBeGreaterThan(
      calculateHitOdds(state, opDumb, { escort }),
    );
  });

  it("escape after sitting burns the table, docks standing, and surcharges other families", () => {
    const base = withTruce(game(), "Valenti");
    const mark = rivalMark(base);
    const home = resolveCrewTerritoryId(base, mark.id)!;
    const op = betrayalOp(base, mark, home);
    const beforeInf = base.influence;
    const beforeRespect = base.reputation.respect;
    const out = resolveHit({ ...base, operations: [op], influence: Math.max(base.influence, 40) }, op, sitRng("escape"));
    expect(out.result.targetDead).toBe(false);
    expect(tableBurned(out.state, "Valenti")).toBe(true);
    expect(canDiplomacy(out.state, "sitdown", "Valenti").ok).toBe(false);
    expect(sitdownInfluenceCost(out.state)).toBe(25);
    expect(out.state.influence).toBeLessThan(Math.max(beforeInf, 40));
    expect(out.state.reputation.respect).toBeLessThanOrEqual(beforeRespect);
    const passage = proposePassageSitdown(out.state, "Valenti", undefined, createRng(1));
    expect(passage.log?.text.toLowerCase()).toMatch(/will not talk passage|cafe/);
    expect(passage.state.sitdowns?.some((s) => s.purpose === "passage" && s.other === "Valenti" && s.status !== "declined")).toBeFalsy();
  });

  it("a clean kill nicks respect only — no burned table, no surcharge", () => {
    const base = game();
    const mark = rivalMark(base);
    const home = resolveCrewTerritoryId(base, mark.id)!;
    const op = betrayalOp(base, mark, home);
    const beforeRespect = base.reputation.respect;
    const beforeInf = base.influence;
    const out = resolveHit({ ...base, operations: [op] }, op, sitRng("kill"));
    expect(out.result.targetDead).toBe(true);
    expect(tableBurned(out.state, mark.family)).toBe(false);
    expect(sitdownInfluenceCost(out.state)).toBe(15);
    expect(out.state.influence).toBe(beforeInf);
    expect(out.state.reputation.respect).toBeLessThan(beforeRespect);
    expect(out.state.reputation.respect).toBeGreaterThanOrEqual(beforeRespect - 4);
    expect(canDiplomacy(out.state, "sitdown", mark.family).ok).toBe(true);
  });
});
