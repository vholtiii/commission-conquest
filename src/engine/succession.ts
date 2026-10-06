import type { CrewMember, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";

/** Active, loyal, leveled, and two weeks in the rank. The player's chair still wants an underboss. */
export function chairBarMet(member: CrewMember, turn: number): boolean {
  if (member.status !== "active") return false;
  if (member.loyalty < 60) return false;
  if (member.level < 5) return false;
  const since = member.roleSinceTurn ?? 0;
  return turn - since >= 2;
}

export function isSuccessionReady(member: CrewMember, turn: number): boolean {
  return member.role === "underboss" && chairBarMet(member, turn);
}

/** A rival chair: a ready underboss, or else a consigliere on the same bar. A capo never inherits. */
export function readyRivalHeir(
  crew: CrewMember[],
  family: FamilyName,
  turn: number,
): CrewMember | undefined {
  const active = crew.filter((c) => c.family === family && c.status === "active");
  return (
    active.find((c) => c.role === "underboss" && chairBarMet(c, turn)) ??
    active.find((c) => c.role === "consigliere" && chairBarMet(c, turn))
  );
}

export function successionReadinessReasons(
  member: CrewMember,
  turn: number,
): { label: string; met: boolean }[] {
  const since = member.roleSinceTurn ?? 0;
  return [
    { label: "Active underboss", met: member.role === "underboss" && member.status === "active" },
    { label: "Loyalty ≥ 60", met: member.loyalty >= 60 },
    { label: "Level ≥ 5", met: member.level >= 5 },
    { label: "Held rank ≥ 2 turns", met: turn - since >= 2 },
  ];
}

export interface SuccessionResult {
  state: GameState;
  logs: TurnLogEntry[];
  succeeded: boolean;
  newBossName?: string;
}

/** Promote a ready underboss to boss, or mark rival turf as leaderless. */
export function applySuccession(
  state: GameState,
  family: FamilyName,
  _rng: Rng,
): SuccessionResult {
  const logs: TurnLogEntry[] = [];
  const candidates = state.crew.filter(
    (c) => c.family === family && c.role === "underboss" && c.status === "active",
  );
  const ready = candidates.find((c) => isSuccessionReady(c, state.turn));

  if (ready) return promoteToBoss(state, family, ready);

  // No ready underboss. A rival consigliere is settled separately; the player's chair stops here.
  if (family === state.playerFamily) {
    // Player defeat handled by checkVictory (boss dead, no living boss)
    logs.push({
      id: `succ_fail_${family}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `No underboss was ready — the ${family} family has no heir.`,
      family,
    });
    return { state, logs, succeeded: false };
  }

  return { state, logs, succeeded: false };
}

/** Put an heir in the chair. Rival turf stops being soft. The player's respect dips. */
export function promoteToBoss(
  state: GameState,
  family: FamilyName,
  heir: CrewMember,
): SuccessionResult {
  const isPlayer = family === state.playerFamily;
  const crew = state.crew.map((c) => {
    if (c.id === heir.id) {
      return {
        ...c,
        role: "boss" as const,
        isPlayerBoss: isPlayer ? true : c.isPlayerBoss,
        roleSinceTurn: state.turn,
        loyalty: Math.min(100, c.loyalty + 5),
        capoId: undefined,
        crewSinceTurn: undefined,
      };
    }
    if (isPlayer && c.family === family && c.id !== heir.id && c.status !== "dead") {
      return { ...c, loyalty: Math.max(10, c.loyalty - 5) };
    }
    if (isPlayer && c.isPlayerBoss && c.id !== heir.id) {
      return { ...c, isPlayerBoss: false };
    }
    return c;
  });
  const territories = isPlayer
    ? state.territories
    : state.territories.map((t) => (t.owner === family ? { ...t, leadershipVacuum: 0 } : t));
  const reputation = isPlayer
    ? { ...state.reputation, respect: Math.max(0, state.reputation.respect - 10) }
    : state.reputation;
  const logs: TurnLogEntry[] = [
    {
      id: `succ_${family}_${state.turn}_${heir.id}`,
      turn: state.turn,
      category: "system",
      text: `${heir.name} takes over the ${family} family.`,
      family,
    },
  ];
  return {
    state: { ...state, crew, territories, reputation },
    logs,
    succeeded: true,
    newBossName: heir.name,
  };
}
