import { describe, expect, it } from "vitest";
import { remember } from "@/engine/ai/aiMemory";
import { ensureMinds } from "@/engine/ai/minds";
import { overheardKey, pickOverheard, speakOverheard } from "@/engine/overheard";
import { buildInitialState, startGame } from "@/engine/initialState";
import type { GameState } from "@/types/game";

function game(): GameState {
  const g = startGame(buildInitialState(7, { startMode: "classic" }), "Moretti");
  return ensureMinds({ ...g, turn: 20, settings: { ...g.settings, aiBrain: "brain" } });
}

describe("overheard picker", () => {
  it("speaks the most salient unspoken rival memory", () => {
    let g = remember(game(), "Valenti", "hit_us", "Moretti");
    g = remember(g, "Ferraro", "killed_boss", "Moretti");
    const pick = pickOverheard(g);
    expect(pick?.family).toBe("Ferraro");
    expect(pick?.mem.kind).toBe("killed_boss");
    const spoken = speakOverheard(g);
    expect(spoken.log?.category).toBe("system");
    expect(spoken.log?.text).toBe("Ferraro still talk about the chair.");
    expect(spoken.state.overheardKeys).toContain(pick!.key);
  });

  it("skips a memory already spoken and takes the next", () => {
    let g = remember(game(), "Valenti", "hit_us", "Moretti");
    g = remember(g, "Ferraro", "killed_boss", "Moretti");
    const chair = pickOverheard(g)!;
    g = { ...g, overheardKeys: [chair.key] };
    const next = pickOverheard(g);
    expect(next?.mem.kind).toBe("hit_us");
    expect(next?.key).not.toBe(chair.key);
    const again = speakOverheard({ ...g, overheardKeys: [chair.key, next!.key] });
    expect(again.log).toBeUndefined();
  });

  it("keys a memory so the same chair is not the log twice", () => {
    const g = remember(game(), "Valenti", "killed_boss", "Moretti");
    const mem = g.aiMinds!.Valenti!.memories[0]!;
    expect(overheardKey("Valenti", mem)).toBe(`Valenti:killed_boss:Moretti:${mem.territoryId ?? ""}:${mem.turn}`);
  });
});
