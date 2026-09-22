import type { CrewMember, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";

export function isSuccessionReady(member: CrewMember, turn: number): boolean {
  if (member.role !== "underboss") return false;
  if (member.status !== "active") return false;
  if (member.loyalty < 60) return false;
  if (member.level < 5) return false;
  const since = member.roleSinceTurn ?? 0;
  return turn - since >= 2;
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

  if (ready) {
    const isPlayer = family === state.playerFamily;
    let crew = state.crew.map((c) => {
      if (c.id === ready.id) {
        return {
          ...c,
          role: "boss" as const,
          isPlayerBoss: isPlayer ? true : c.isPlayerBoss,
          roleSinceTurn: state.turn,
          loyalty: Math.min(100, c.loyalty + 5),
        };
      }
      if (isPlayer && c.family === family && c.id !== ready.id && c.status !== "dead") {
        return { ...c, loyalty: Math.max(10, c.loyalty - 5) };
      }
      // Clear old player-boss flag if any other member still has it
      if (isPlayer && c.isPlayerBoss && c.id !== ready.id) {
        return { ...c, isPlayerBoss: false };
      }
      return c;
    });

    let reputation = state.reputation;
    if (isPlayer) {
      reputation = {
        ...reputation,
        respect: Math.max(0, reputation.respect - 10),
      };
    }

    logs.push({
      id: `succ_${family}_${state.turn}_${ready.id}`,
      turn: state.turn,
      category: "system",
      text: `${ready.name} takes over the ${family} family.`,
      family,
    });

    return {
      state: { ...state, crew, reputation },
      logs,
      succeeded: true,
      newBossName: ready.name,
    };
  }

  // No ready successor
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

  const territories = state.territories.map((t) =>
    t.owner === family ? { ...t, leadershipVacuum: Math.max(t.leadershipVacuum, 2) } : t,
  );
  logs.push({
    id: `succ_vac_${family}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text: `The ${family} family is leaderless — their turf is vulnerable.`,
    family,
  });

  return {
    state: { ...state, territories },
    logs,
    succeeded: false,
  };
}
