import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { getBoss } from "@/engine/crew";
import { resolveCrewTerritoryId } from "@/engine/crewLocation";
import { stageSitdowns } from "@/engine/sitdowns";
import { resolvePlayerHits } from "@/engine/turnPipeline";
import { createRng } from "@/engine/rng";
import type { GameState, Operation, Sitdown } from "@/types/game";

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

function bombOn(state: GameState, markId: string, territoryId: string): Operation {
  const maker = state.crew.find((c) => c.family === "Moretti" && c.role === "soldier" && c.status === "active");
  const planter = state.crew.find(
    (c) => c.family === "Moretti" && c.status === "active" && c.id !== maker?.id && c.role !== "boss",
  );
  return {
    id: "op_bomb_test",
    family: "Moretti",
    kind: "hit",
    targetCrewId: markId,
    targetTerritoryId: territoryId,
    targetFamily: "Valenti",
    approach: "car_bomb",
    shooterIds: [],
    bombMakerId: maker?.id,
    planterId: planter?.id,
    surveilled: false,
    pendingTurns: 1,
    resolved: false,
  };
}

function meeting(state: GameState, venue: "ours" | "theirs", venueTerritoryId: string): Sitdown {
  return {
    id: "sitdown_test",
    proposedTurn: state.turn,
    heldTurn: state.turn,
    proposer: "Moretti",
    other: "Valenti",
    venue,
    venueTerritoryId,
    status: "scheduled",
    purpose: "general",
  };
}

function withHomes(state: GameState): GameState {
  return {
    ...state,
    crew: state.crew.map((c) => {
      const site = resolveCrewTerritoryId(state, c.id);
      return site ? { ...c, lastSiteId: site } : c;
    }),
  };
}

describe("boss car bomb and sit-down travel", () => {
  it("waits on Next Turn, then springs when their boss comes to our table", () => {
    const base = withHomes(game());
    const rival = getBoss(base.crew, "Valenti")!;
    const ours = getBoss(base.crew, "Moretti")!;
    const rivalHome = resolveCrewTerritoryId(base, rival.id)!;
    const ourHome = resolveCrewTerritoryId(base, ours.id)!;
    expect(rivalHome).not.toBe(ourHome);

    const armed: GameState = {
      ...base,
      operations: [bombOn(base, rival.id, rivalHome)],
      sitdowns: [meeting(base, "ours", ourHome)],
    };

    const early = resolvePlayerHits(armed, createRng(1));
    expect(early.state.operations.find((o) => o.id === "op_bomb_test")?.resolved).not.toBe(true);

    const week = resolvePlayerHits(stageSitdowns(early.state), createRng(1), { onlyBossBombs: true });
    expect(week.state.operations.find((o) => o.id === "op_bomb_test")?.resolved).toBe(true);
  });

  it("stays armed when he hosts on the block he is already standing on", () => {
    const base = withHomes(game());
    const rival = getBoss(base.crew, "Valenti")!;
    const standing = resolveCrewTerritoryId(base, rival.id)!;

    const armed: GameState = {
      ...base,
      operations: [bombOn(base, rival.id, standing)],
      sitdowns: [meeting(base, "theirs", standing)],
    };

    const quiet = { ...createRng(1), chance: () => false };
    const week = resolvePlayerHits(stageSitdowns(armed), quiet, { onlyBossBombs: true });
    const after = week.state.operations.find((o) => o.id === "op_bomb_test");
    expect(after?.resolved).not.toBe(true);
    expect(after?.armedTurns).toBeGreaterThanOrEqual(1);
  });
});
