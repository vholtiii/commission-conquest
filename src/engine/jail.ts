import type { CrewMember, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { applySuccession, isSuccessionReady } from "./succession";
import { declareMourning } from "./mourning";

/** Turns the boss sits before the chair passes for good. */
export const JAIL_TURNS = 4;

export function livingBoss(state: Pick<GameState, "crew">, family: FamilyName): CrewMember | undefined {
  return state.crew.find((c) => c.family === family && c.role === "boss" && c.status !== "dead");
}

export function actingUnderboss(
  state: Pick<GameState, "crew">,
  family: FamilyName,
): CrewMember | undefined {
  return state.crew.find((c) => c.family === family && c.actingBoss && c.status === "active");
}

export function bossIsJailed(state: Pick<GameState, "crew">, family: FamilyName): boolean {
  return livingBoss(state, family)?.status === "jailed";
}

/** Jailed boss and nobody ready to stand in. */
export function familyHeadless(state: Pick<GameState, "crew">, family: FamilyName): boolean {
  return bossIsJailed(state, family) && !actingUnderboss(state, family);
}

function withActing(crew: CrewMember[], family: FamilyName, turn: number): CrewMember[] {
  const ready = crew.find((c) => c.family === family && isSuccessionReady(c, turn));
  return crew.map((c) => {
    if (c.family !== family) return c;
    if (c.actingBoss && c.id !== ready?.id) return { ...c, actingBoss: undefined };
    if (ready && c.id === ready.id) return { ...c, actingBoss: true };
    return c;
  });
}

/**
 * Send a crew member to jail. Soldiers stay jailed. The boss gets a 4-turn
 * window and, if an underboss is ready, that man runs the family without taking the title.
 */
export function jailInCrew(crew: CrewMember[], crewId: string, turn: number): CrewMember[] {
  const member = crew.find((c) => c.id === crewId);
  if (!member || member.status === "dead" || member.status === "jailed") return crew;
  if (member.role !== "boss") {
    return crew.map((c) => (c.id === crewId ? { ...c, status: "jailed" as const } : c));
  }
  const until = turn + JAIL_TURNS;
  const next = crew.map((c) =>
    c.id === member.id
      ? { ...c, status: "jailed" as const, jailedUntilTurn: until, actingBoss: undefined }
      : c,
  );
  return withActing(next, member.family, turn);
}

export function jailMember(state: GameState, crewId: string): GameState {
  return { ...state, crew: jailInCrew(state.crew, crewId, state.turn) };
}

/** The street lawyer posted bail. A non-boss walks, wanted unchanged, back to idle. */
export function releaseMember(crew: CrewMember[], crewId: string): CrewMember[] {
  return crew.map((c) =>
    c.id === crewId && c.status === "jailed" && c.role !== "boss"
      ? { ...c, status: "active" as const, assignment: { type: "idle" as const } }
      : c,
  );
}

/** The judge came through. The boss walks out and the stand-in steps back. */
export function releaseBoss(state: GameState, family: FamilyName): GameState {
  const crew = state.crew.map((c) => {
    if (c.family !== family) return c;
    if (c.role === "boss" && c.status === "jailed") {
      return { ...c, status: "active" as const, jailedUntilTurn: undefined };
    }
    if (c.actingBoss) return { ...c, actingBoss: undefined };
    return c;
  });
  return { ...state, crew };
}

/** Loyalty drip while the boss is inside, and the chair passes when the window ends. */
export function tickJails(
  state: GameState,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  let current = state;
  const families = new Set(
    current.crew.filter((c) => c.role === "boss" && c.status === "jailed").map((c) => c.family),
  );

  for (const family of families) {
    const boss = livingBoss(current, family);
    if (!boss || boss.status !== "jailed") continue;
    const headless = !current.crew.some(
      (c) => c.family === family && isSuccessionReady(c, current.turn),
    );
    // The arrest week itself is free; the drip starts with the first full week inside.
    const arrestedThisTurn = boss.jailedUntilTurn === current.turn + JAIL_TURNS;
    const drip = arrestedThisTurn ? 0 : headless ? 4 : 2;
    let crew = current.crew.map((c) => {
      if (c.family !== family || c.status === "dead" || c.id === boss.id || drip === 0) return c;
      return { ...c, loyalty: Math.max(0, c.loyalty - drip) };
    });
    crew = withActing(crew, family, current.turn);
    current = { ...current, crew };

    const until = boss.jailedUntilTurn ?? current.turn;
    if (current.turn < until) continue;

    crew = current.crew.map((c) => {
      if (c.id === boss.id) {
        return { ...c, status: "dead" as const, putAway: true, jailedUntilTurn: undefined };
      }
      if (c.family === family && c.actingBoss) return { ...c, actingBoss: undefined };
      return c;
    });
    current = { ...current, crew };
    const succ = applySuccession(current, family, rng);
    current = succ.state;
    const quiet = declareMourning(current);
    current = quiet.state;
    logs.push(...succ.logs, ...quiet.logs);
    logs.push({
      id: `log_jail_expire_${family}_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: succ.succeeded
        ? `${boss.name} never walked out. The chair passes.`
        : `${boss.name} rots in the Tombs. Nobody was ready to take the chair.`,
      family,
    });
  }

  return { state: current, logs };
}
