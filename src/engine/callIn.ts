/**
 * Calling in one of your own. The rat events and the crew sheet share the
 * removal: he leaves the garrison, the racket, any job he was on, and if he
 * led a crew his soldiers go loose. What it costs the family depends on how
 * clean he looked.
 */
import type { CrewMember, CrewRequest, GameState, Operation, SupplyRoute, Territory, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { buildSummonsCinematic } from "./hitOps";
import { orphanCrews } from "./crews";
import { dinnerActive } from "./dinner";

export const CALL_IN_COOLDOWN = 6;

export interface CallInRead {
  /** 0 = the street already wanted him gone, 1 = he looked clean. */
  cleanness: number;
  label: string;
  /** He is the rat the boss already spared. */
  sparedRat: boolean;
}

export function canCallIn(state: GameState, crewId: string): { ok: boolean; reason?: string } {
  const man = state.crew.find((c) => c.id === crewId);
  if (!man || man.family !== state.playerFamily) return { ok: false, reason: "He isn't yours." };
  if (man.status !== "active") return { ok: false, reason: "He isn't on the street." };
  if (man.role === "boss" || man.isPlayerBoss) return { ok: false, reason: "You don't call yourself in." };
  if (dinnerActive(state)) return { ok: false, reason: "The family is at the table." };
  const affair = state.ratAffair;
  const onWatch =
    !!affair &&
    affair.crewId === crewId &&
    affair.phase === "open" &&
    (affair.kind === "watch" || affair.kind === "investigation");
  const last = state.lastCallInTurn;
  if (!onWatch && last != null && state.turn < last + CALL_IN_COOLDOWN) {
    const ago = state.turn - last;
    return {
      ok: false,
      reason:
        ago <= 0
          ? "Too soon — the last one was this week."
          : `Too soon — you called a man in ${ago} week${ago === 1 ? "" : "s"} ago.`,
    };
  }
  return { ok: true };
}

/** How justified it will look. Graded, not a cliff. */
export function callInRead(state: GameState, victim: CrewMember): CallInRead {
  const sparedRat = state.ratLeakCrewId != null && state.ratLeakCrewId === victim.id;
  if (sparedRat) {
    return { cleanness: 0, label: "He's the one talking to the Bureau.", sparedRat: true };
  }
  let c = Math.max(0, Math.min(1, (victim.loyalty - 30) / 50));
  if (victim.wanted >= 5) c = Math.max(0, c - 0.4);
  if (victim.traits.includes("rat_risk")) c = Math.max(0, c - 0.5);
  const label =
    c <= 0.2
      ? "The street understood"
      : c <= 0.6
        ? "It'll be talked about"
        : "He was clean — the family will take it badly";
  return { cleanness: c, label, sparedRat: false };
}

export function callInCosts(read: CallInRead, made: boolean): {
  loyaltyDrop: number;
  respectDrop: number;
  walkChance: number;
} {
  const c = read.cleanness;
  return {
    loyaltyDrop: Math.round(5 + 9 * c + (made ? 4 : 0)),
    respectDrop: Math.round(3 * c) + (made ? 5 : 0),
    walkChance: Math.min(1, 0.2 + 0.3 * c + (made ? 0.25 : 0)),
  };
}

function idle(c: CrewMember): CrewMember {
  return { ...c, assignment: { type: "idle" } };
}

/** Take him off the board: dead, off the rackets, off any job, crew orphaned. */
export function removeMan(
  state: GameState,
  victimId: string,
  opts?: { quiet?: boolean },
): {
  crew: CrewMember[];
  territories: Territory[];
  operations: Operation[];
  supplyRoutes: SupplyRoute[];
  logs: TurnLogEntry[];
} {
  const victim = state.crew.find((c) => c.id === victimId);
  const logs: TurnLogEntry[] = [];
  if (!victim) {
    return {
      crew: state.crew,
      territories: state.territories,
      operations: state.operations,
      supplyRoutes: state.supplyRoutes ?? [],
      logs,
    };
  }

  const territories = state.territories.map((t) => ({
    ...t,
    garrisonIds: t.garrisonIds.filter((id) => id !== victimId),
    rackets: t.rackets.map((r) => (r.managerId === victimId ? { ...r, managerId: null } : r)),
  }));

  let operations = state.operations.map((op) => ({ ...op }));
  const cancelled = new Set<string>();
  operations = operations.map((op) => {
    if (op.resolved) return op;
    const wasShooter = op.shooterIds.includes(victimId);
    const involved =
      wasShooter ||
      op.wheelmanId === victimId ||
      op.lookoutId === victimId ||
      op.bombMakerId === victimId ||
      op.planterId === victimId ||
      op.negotiatorId === victimId;
    if (!involved) return op;
    const shooterIds = op.shooterIds.filter((id) => id !== victimId);
    const next = {
      ...op,
      shooterIds,
      wheelmanId: op.wheelmanId === victimId ? undefined : op.wheelmanId,
      lookoutId: op.lookoutId === victimId ? undefined : op.lookoutId,
      bombMakerId: op.bombMakerId === victimId ? undefined : op.bombMakerId,
      planterId: op.planterId === victimId ? undefined : op.planterId,
      negotiatorId: op.negotiatorId === victimId ? undefined : op.negotiatorId,
    };
    if (wasShooter && shooterIds.length === 0 && op.family === state.playerFamily) {
      cancelled.add(op.id);
      logs.push({
        id: `log_callin_cancel_${op.id}`,
        turn: state.turn,
        category: "hit",
        text: `The job on ${state.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "that block"} is off — the shooter was called in.`,
        family: state.playerFamily ?? undefined,
      });
      return { ...next, resolved: true, resolvedTurn: state.turn };
    }
    return next;
  });

  const soldiers = state.crew.filter((c) => c.capoId === victimId && c.status !== "dead");

  let crew = state.crew.map((c) => {
    if (c.id === victimId) {
      return idle({ ...c, status: "dead" as const, capoId: undefined });
    }
    let next = c;
    if (!opts?.quiet && victim.capoId && c.family === victim.family && c.capoId === victim.capoId && c.status !== "dead") {
      next = { ...next, loyalty: Math.max(0, next.loyalty - 6) };
    }
    if (!opts?.quiet && soldiers.some((s) => s.id === c.id)) {
      next = { ...next, loyalty: Math.max(0, next.loyalty - 12) };
    }
    if (next.assignment.operationId && cancelled.has(next.assignment.operationId)) return idle(next);
    return next;
  });
  crew = orphanCrews(crew);

  const supplyRoutes = (state.supplyRoutes ?? []).map((r) =>
    r.driverId === victimId && r.status !== "suspended"
      ? { ...r, status: "suspended" as const, suspendedReason: "The driver was called in" }
      : r,
  );

  return { crew, territories, operations, supplyRoutes, logs };
}

/** A crewmate asking to walk after one of his own was taken out. */
export function walkRequestFor(state: GameState, crew: CrewMember[], victim: CrewMember): CrewRequest | null {
  const capo = victim.capoId ? crew.find((c) => c.id === victim.capoId && c.status !== "dead") : undefined;
  const walker = capo
    ? crew.find((c) => c.capoId === capo.id && c.id !== victim.id && c.status === "active")
    : crew.find((c) => c.capoId === victim.id && c.status === "active");
  if (!walker) return null;
  return {
    id: `req_walk_${victim.id}_${state.turn}`,
    turn: state.turn,
    capoId: capo?.id ?? victim.id,
    candidateId: walker.id,
    pitch: `${walker.name.split(" ")[0]} watched ${victim.name.split(" ")[0]} get called in. He wants to walk — to someone who doesn't do that to their own.`,
    status: "pending",
    kind: "walk",
  };
}

export function callInOwn(
  state: GameState,
  crewId: string,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const victim = state.crew.find((c) => c.id === crewId);
  const check = canCallIn(state, crewId);
  if (!victim || !check.ok) return { state, logs: [] };

  const read = callInRead(state, victim);
  const made = victim.traits.includes("made_man");
  const costs = callInCosts(read, made);
  const removed = removeMan(state, crewId);

  const logs: TurnLogEntry[] = [
    ...removed.logs,
    {
      id: `log_callin_${victim.id}_${state.turn}`,
      turn: state.turn,
      category: "hit",
      text: read.sparedRat
        ? `You called ${victim.name} in. He doesn't come back. He was the one talking. The leak stops here.`
        : `You called ${victim.name} in. He doesn't come back. ${read.label}.`,
      family: state.playerFamily ?? undefined,
    },
  ];

  const crew = removed.crew.map((c) =>
    c.family === state.playerFamily && c.status !== "dead" && c.id !== victim.id
      ? { ...c, loyalty: Math.max(0, c.loyalty - costs.loyaltyDrop) }
      : c,
  );

  let crewRequests = state.crewRequests;
  if (rng.chance(costs.walkChance)) {
    const ask = walkRequestFor(state, state.crew, victim);
    if (ask) crewRequests = [...crewRequests, ask];
  }

  const heatDelta = read.sparedRat ? -10 : 5;

  return {
    logs,
    state: {
      ...state,
      crew,
      territories: removed.territories,
      operations: removed.operations,
      supplyRoutes: removed.supplyRoutes,
      crewRequests,
      lastCallInTurn: state.turn,
      ratLeakTurn: read.sparedRat ? undefined : state.ratLeakTurn,
      ratLeakCrewId: read.sparedRat ? undefined : state.ratLeakCrewId,
      heat: {
        ...state.heat,
        level: Math.max(0, Math.min(100, state.heat.level + heatDelta)),
      },
      reputation: {
        ...state.reputation,
        fear: Math.max(0, Math.min(100, state.reputation.fear + 8)),
        respect: Math.max(0, Math.min(100, state.reputation.respect - costs.respectDrop)),
      },
      pendingSummons: buildSummonsCinematic(state, victim, read.cleanness > 0.6),
    },
  };
}
