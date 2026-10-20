import { describe, expect, it } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { startInterregnum, tickInterregnum } from "@/engine/interregnum";
import { checkVictory } from "@/engine/victory";
import { createRng } from "@/engine/rng";

describe("leaderless family", () => {
  it("loses ground once, then crowns an underboss who has held the rank", () => {
    const game = startGame(buildInitialState(5, { startMode: "classic" }), "Moretti");
    const before = game.territories.filter((t) => t.owner === "Moretti").length;
    const started = startInterregnum(game, "Moretti", "killed", createRng(1));
    const after = started.state.territories.filter((t) => t.owner === "Moretti").length;
    expect(after).toBeLessThan(before);
    expect(started.state.interregnum?.deadline).toBe(game.turn + 5);
    const crowned = tickInterregnum(
      {
        ...started.state,
        crew: started.state.crew.map((c) =>
          c.family === "Moretti" && c.role === "underboss"
            ? { ...c, loyalty: 70, roleSinceTurn: game.turn - 1, status: "active" as const }
            : c,
        ),
      },
      createRng(2),
    );
    expect(crowned.state.interregnum).toBeNull();
    expect(crowned.state.crew.some((c) => c.family === "Moretti" && c.role === "boss" && c.status !== "dead")).toBe(true);
  });

  it("ends the game when the five weeks run out", () => {
    const game = startGame(buildInitialState(6, { startMode: "classic" }), "Moretti");
    const started = startInterregnum({ ...game, turn: 12 }, "Moretti", "killed", createRng(3));
    const due = {
      ...started.state,
      turn: started.state.interregnum!.deadline,
      crew: started.state.crew.map((c) =>
        c.family === "Moretti" && c.role === "underboss" ? { ...c, loyalty: 10 } : c,
      ),
    };
    const ticked = tickInterregnum(due, createRng(4));
    expect(ticked.state.interregnum?.family).toBe("Moretti");
    expect(checkVictory(ticked.state).lost).toBe(true);
  });

  it("a new game drops the old empty chair and the rat leak", () => {
    const game = startGame(buildInitialState(7, { startMode: "classic" }), "Moretti");
    const started = startInterregnum(
      { ...game, ratLeakTurn: 3, ratLeakCrewId: "crew_rat", ratLeakWeeks: 4 },
      "Moretti",
      "killed",
      createRng(5),
    );
    const fresh = { ...started.state, ...buildInitialState(9, { startMode: "classic" }) };
    expect(fresh.interregnum).toBeNull();
    expect(fresh.ratLeakTurn).toBeUndefined();
    expect(fresh.ratLeakCrewId).toBeUndefined();
    expect(fresh.ratLeakWeeks).toBeUndefined();
    expect(fresh.onboardingDismissed).toBe(false);
    expect(fresh.headlines).toEqual([]);
    expect(fresh.history).toEqual([]);
  });
});
