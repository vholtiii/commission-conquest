import { describe, expect, it } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { createRng } from "@/engine/rng";
import { endTurn } from "@/engine/turnPipeline";
import type { FamilyName, GameState } from "@/types/game";
import { ensureMinds, mindOf, withMind, MEMORY_CAP } from "@/engine/ai/minds";
import { believedGarrison, updateBeliefs, watchedBlocks } from "@/engine/ai/aiBeliefs";
import { recordMemories, remember, trustIn } from "@/engine/ai/aiMemory";
import { candidateActions, chooseGoal, refreshAdapt, thinBorderBlocks } from "@/engine/ai/aiPlanner";
import { tickRivalDiplomacy } from "@/engine/ai/rivalDiplomacy";
import { activeRivalPacts, rivalPactBetween } from "@/engine/ai/rivalPacts";
import { atPeace } from "@/engine/deals";

function game(seed = 7): GameState {
  const g = startGame(buildInitialState(seed, { startMode: "classic" }), "Moretti");
  return ensureMinds({ ...g, turn: 20, settings: { ...g.settings, aiBrain: "brain" } });
}

describe("rival family brain", () => {
  it("does not read garrisons on blocks it cannot see", () => {
    const g = updateBeliefs(game());
    const seen = watchedBlocks(g, "Ferraro");
    const far = g.territories.find((t) => t.owner === "Moretti" && !seen.has(t.id));
    expect(far).toBeDefined();
    const men = g.crew.filter((c) => c.family === "Moretti" && c.status === "active" && c.role === "soldier").map((c) => c.id);
    const before = believedGarrison(g, "Ferraro", far!);
    const stacked = updateBeliefs({
      ...g,
      territories: g.territories.map((t) => (t.id === far!.id ? { ...t, garrisonIds: men } : t)),
    });
    expect(believedGarrison(stacked, "Ferraro", stacked.territories.find((t) => t.id === far!.id)!)).toBe(before);
    const options = (s: GameState) =>
      candidateActions(s, "Ferraro", null).map((a) => `${a.kind}:${a.territoryId ?? a.targetFamily}:${a.score.toFixed(4)}`);
    expect(options(stacked)).toEqual(options(g));
  });

  it("remembers who took its block and trusts them less", () => {
    const g = game();
    const block = g.territories.find((t) => t.owner === "Valenti")!;
    const after = { ...g, territories: g.territories.map((t) => (t.id === block.id ? { ...t, owner: "Moretti" as FamilyName } : t)) };
    const logs = [] as GameState["turnLog"];
    const next = recordMemories(g, after, logs);
    const mind = mindOf(next, "Valenti");
    expect(mind.memories.some((m) => m.kind === "took_turf" && m.actor === "Moretti")).toBe(true);
    expect(trustIn(mind, "Moretti")).toBeLessThan(0);
  });

  it("keeps a goal rather than flip-flopping week to week", () => {
    let g = updateBeliefs(game());
    g = remember(g, "Rinaldi", "hit_us", "Valenti");
    g = remember(g, "Rinaldi", "hit_us", "Valenti");
    const first = chooseGoal(g, "Rinaldi");
    expect(first.goal).not.toBeNull();
    const again = chooseGoal({ ...first.state, turn: first.state.turn + 1 }, "Rinaldi");
    expect(again.goal?.kind).toBe(first.goal?.kind);
    expect(again.goal?.since).toBe(first.goal?.since);
    expect(again.reason).toMatch(/sticking with it/);
  });

  it("lines up against a runaway leader", () => {
    let g = game();
    const half = Math.ceil(g.territories.length * 0.5);
    g = { ...g, territories: g.territories.map((t, i) => (i < half ? { ...t, owner: "Moretti" as FamilyName } : t)) };
    let signed = false;
    for (let seed = 1; seed <= 10 && !signed; seed++) {
      const r = tickRivalDiplomacy(g, createRng(seed));
      signed = activeRivalPacts(r.state).some((p) => p.kind === "coalition" && p.target === "Moretti");
      if (signed) expect(r.logs.some((l) => l.id.startsWith("log_rpact_coalition_"))).toBe(true);
    }
    expect(signed).toBe(true);
  });

  it("remembers a broken pact, and so does everyone watching", () => {
    let g = game();
    g = {
      ...g,
      diplomacy: { ...g.diplomacy, rivalPacts: [{ a: "Rinaldi", b: "Valenti", kind: "truce", since: g.turn - 1, until: g.turn + 10 }] },
    };
    expect(atPeace(g, "Rinaldi", "Valenti")).toBe(true);
    for (let i = 0; i < 6; i++) g = remember(g, "Rinaldi", "killed_boss", "Valenti");
    let broken: GameState | undefined;
    for (let seed = 1; seed <= 200 && !broken; seed++) {
      const r = tickRivalDiplomacy(g, createRng(seed));
      if (!rivalPactBetween(r.state, "Rinaldi", "Valenti")) broken = r.state;
    }
    expect(broken).toBeDefined();
    expect(mindOf(broken!, "Valenti").memories.some((m) => m.kind === "broke_truce" && m.actor === "Rinaldi")).toBe(true);
    expect(trustIn(mindOf(broken!, "Ferraro"), "Rinaldi")).toBeLessThan(0);
    expect(broken!.diplomacy.rivalPactLog?.some((e) => e.event === "broken" && e.by === "Rinaldi")).toBe(true);
  });

  it("mans its border after losing thin blocks twice", () => {
    let g = updateBeliefs(game());
    const mind = mindOf(g, "Ferraro");
    const ctx = (s: GameState) => ({ state: s, family: "Ferraro" as FamilyName, owned: s.territories.filter((t) => t.owner === "Ferraro"), mind: mindOf(s, "Ferraro") });
    const thinBefore = thinBorderBlocks(ctx(g)).length;
    g = withMind(g, "Ferraro", { ...mind, adapt: { ...mind.adapt, weakHits: [g.turn - 1, g.turn - 3] } });
    g = refreshAdapt(g, "Ferraro");
    expect(mindOf(g, "Ferraro").adapt.minBorder).toBe(2);
    expect(thinBorderBlocks(ctx(g)).length).toBeGreaterThanOrEqual(thinBefore);
    const later = refreshAdapt({ ...g, turn: g.turn + 12 }, "Ferraro");
    expect(mindOf(later, "Ferraro").adapt.minBorder).toBe(0);
  });

  it("plays the same game from the same seed, with memory held to its cap", () => {
    const run = () => {
      let s = startGame(buildInitialState(42, { startMode: "classic" }), "Salvati");
      const rng = createRng(42);
      for (let i = 0; i < 12; i++) s = endTurn(s, rng);
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.aiMinds)).toBe(JSON.stringify(b.aiMinds));
    expect(a.territories.map((t) => t.owner)).toEqual(b.territories.map((t) => t.owner));
    for (const m of Object.values(a.aiMinds ?? {})) expect(m!.memories.length).toBeLessThanOrEqual(MEMORY_CAP);
    expect(a.aiTrace?.families).toBeDefined();
  });
});
