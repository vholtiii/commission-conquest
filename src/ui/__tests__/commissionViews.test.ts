import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { aiPetition, pledgeSeat } from "@/engine/commission";
import { createRng } from "@/engine/rng";
import { setRelation } from "@/engine/relations";
import { useGameStore } from "@/engine/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import CommissionPanel from "@/ui/panels/CommissionPanel";
import CommissionRulingModal from "@/ui/panels/CommissionRulingModal";
import RacePanel from "@/ui/panels/RacePanel";
import { chooseGoal } from "@/engine/ai/aiPlanner";
import type { FamilyName, GameState } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

function game(): GameState {
  const base = startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
  return { ...base, turn: 20, rivalInfluence: { ...base.rivalInfluence, Ferraro: 160, Rinaldi: 160 } };
}

/** Server rendering reads the store's initial state, so the state under test is written onto it. */
function show(state: GameState, view: () => JSX.Element | null): string {
  useGameStore.setState(state);
  Object.assign(useGameStore.getInitialState(), useGameStore.getState());
  return renderToString(createElement(TooltipProvider, null, createElement(view))).replace(/<!-- -->/g, "");
}

describe("Commission views for a rival's call", () => {
  it("shows a call between two rivals with the player's seat and the three choices", () => {
    const opened = aiPetition(game(), "Ferraro", "Rinaldi", "war", createRng(1)).state;
    expect(opened.commissionCall?.thirdParty).toBe(true);

    const html = show(opened, CommissionPanel);
    expect(html).toContain("A call between families");
    expect(html).toContain("Ferraro wants guns on Rinaldi");
    expect(html).toContain("Your seat");
    expect(html).toContain("abstains");
    expect(html).toContain("Back Ferraro");
    expect(html).toContain("Back Rinaldi");
    expect(html).toContain("Abstain");
    expect(html).toContain("you are at war with Rinaldi too if it carries");
    // The player's own family is not listed as a seat that leans.
    expect(html).not.toMatch(/Moretti<\/span><span[^>]*>leans/);

    const backed = show(pledgeSeat(opened, "caller").state, CommissionPanel);
    expect(backed).toContain("backs Ferraro");
  });

  it("tells the player the table has gone to war with him when a rival carried it", () => {
    let state = game();
    for (const seat of ["Valenti", "Salvati", "Rinaldi"] as FamilyName[]) {
      state = { ...state, relations: setRelation(setRelation(state.relations, seat, "Ferraro", 90), seat, "Moretti", -90) };
    }
    const called = aiPetition(state, "Ferraro", "Moretti", "war", createRng(3)).state;
    const ruling = called.pendingRulings?.[0];
    expect(ruling?.kind).toBe("war");
    expect(ruling?.verdict).toBe("caller");

    const html = show(called, CommissionRulingModal);
    expect(html).toContain("The Commission goes to war with you");
    expect(html).toContain("Ferraro asked for guns on you");
    expect(html).toContain("Every other family is at war with you");
    expect(html).toContain("Brace for it");
    expect(html).not.toContain("Guns up</button>");
    expect(html).not.toContain("Yours is your own to plan");
    expect(html).toContain("sides against you");
  });
});

describe("the race on Hard", () => {
  const rivals = ["Valenti", "Ferraro", "Salvati", "Rinaldi"] as FamilyName[];
  const every = (n: number) => Object.fromEntries(rivals.map((f) => [f, n])) as Record<FamilyName, number>;

  function hard(turn: number): GameState {
    const base = startGame(buildInitialState(4, { startMode: "classic", difficulty: "hard" }), "Moretti");
    return { ...base, turn, influence: 120, money: 1_000, dirtyMoney: 0, rivalInfluence: every(100), rivalTreasury: every(50_000) };
  }

  it("shows the longer streak, when the families start planning, and who is on the summit", () => {
    const early = show(hard(20), RacePanel);
    expect(early).toContain("0/8");
    expect(early).toContain("The families start planning for the summit 12 weeks out.");
    expect(early).toContain("Nobody is leaning on a leader.");

    const state = hard(44);
    const planned = chooseGoal(state, "Ferraro").state;
    const late = show(planned, RacePanel);
    expect(late).toContain("The families are planning for the summit");
    expect(late).toContain("Summit, standing: Ferraro on you, buying standing and calling the table.");

    const normal = startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
    const plain = show({ ...normal, turn: 44 }, RacePanel);
    expect(plain).toContain("0/6");
    expect(plain).not.toContain("planning for the summit");
    expect(plain).not.toContain("On Easy");
  });

  it("tells an Easy player that first is enough", () => {
    const easy = startGame(buildInitialState(4, { startMode: "classic", difficulty: "easy" }), "Moretti");
    const html = show({ ...easy, turn: 44, influence: 105, rivalInfluence: every(100) }, RacePanel);
    expect(html).toContain("Named today: Moretti on standing.");
    expect(html).toContain("On Easy the summit names whoever is first; no margin needed.");
  });
});
