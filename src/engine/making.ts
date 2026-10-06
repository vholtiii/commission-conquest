/**
 * Opening the books. An associate sits a week off the street, then the player
 * places 4 skill points. The trait's old hit bonus does not come with it.
 */
import type { CrewMember, CrewSkills, GameEvent, GameState, TurnLogEntry } from "@/types/game";
import { canPromote } from "./crew";
import {
  MAKING_PER_SKILL,
  MAKING_POINTS,
  SKILL_KEYS,
  allocationOk,
  applySkillPoints,
  pointsThatFit,
} from "./makingPoints";

export { MAKING_PER_SKILL, MAKING_POINTS, SKILL_KEYS, allocationOk, emptyAlloc, pointsThatFit } from "./makingPoints";

const LOYALTY_GRANT = 8;

const SKILL_LABEL: Record<(typeof SKILL_KEYS)[number], string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

export function describeAlloc(alloc: CrewSkills): string {
  const parts = SKILL_KEYS.filter((k) => (alloc[k] ?? 0) > 0).map((k) => `${SKILL_LABEL[k]} +${alloc[k]}`);
  return parts.length > 0 ? parts.join(", ") : "No skill had room for a point";
}

export function sittingOut(state: Pick<GameState, "making">, crewId: string): boolean {
  return state.making?.crewId === crewId;
}

function idle(member: CrewMember): CrewMember {
  return { ...member, assignment: { type: "idle" } };
}

/** Off garrison, off the racket, off a hit, off a delivery. Does not kill him. */
function pullOffStreet(
  state: GameState,
  crewId: string,
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const territories = state.territories.map((t) => ({
    ...t,
    garrisonIds: t.garrisonIds.filter((id) => id !== crewId),
    rackets: t.rackets.map((r) => (r.managerId === crewId ? { ...r, managerId: null } : r)),
  }));

  const cancelled = new Set<string>();
  const operations = state.operations.map((op) => {
    if (op.resolved) return op;
    const wasShooter = op.shooterIds.includes(crewId);
    const involved =
      wasShooter ||
      op.wheelmanId === crewId ||
      op.lookoutId === crewId ||
      op.bombMakerId === crewId ||
      op.planterId === crewId ||
      op.negotiatorId === crewId;
    if (!involved) return op;
    const shooterIds = op.shooterIds.filter((id) => id !== crewId);
    const next = {
      ...op,
      shooterIds,
      wheelmanId: op.wheelmanId === crewId ? undefined : op.wheelmanId,
      lookoutId: op.lookoutId === crewId ? undefined : op.lookoutId,
      bombMakerId: op.bombMakerId === crewId ? undefined : op.bombMakerId,
      planterId: op.planterId === crewId ? undefined : op.planterId,
      negotiatorId: op.negotiatorId === crewId ? undefined : op.negotiatorId,
    };
    if (wasShooter && shooterIds.length === 0 && op.family === state.playerFamily) {
      cancelled.add(op.id);
      const block = state.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "that block";
      logs.push({
        id: `log_making_cancel_${op.id}`,
        turn: state.turn,
        category: "hit",
        text: `The job on ${block} is off — the shooter is sitting for the books.`,
        family: state.playerFamily ?? undefined,
      });
      return { ...next, resolved: true, resolvedTurn: state.turn };
    }
    return next;
  });

  const crew = state.crew.map((c) => {
    if (c.id === crewId) return idle(c);
    if (c.assignment.operationId && cancelled.has(c.assignment.operationId)) return idle(c);
    return c;
  });

  const routes = state.routes.filter((r) => {
    if (r.driverId !== crewId || r.status !== "active") return true;
    logs.push({
      id: `log_making_route_${r.id}`,
      turn: state.turn,
      category: "delivery",
      text: `The delivery is off — the driver is sitting for the books.`,
      family: state.playerFamily ?? undefined,
    });
    return false;
  });

  const supplyRoutes = (state.supplyRoutes ?? []).map((r) => {
    if (r.driverId === crewId && r.status !== "suspended") {
      logs.push({
        id: `log_making_supply_${r.id}`,
        turn: state.turn,
        category: "delivery",
        text: `The trucks wait — the driver is sitting for the books.`,
        family: state.playerFamily ?? undefined,
      });
      return { ...r, status: "suspended" as const, suspendedReason: "The driver is sitting for the books" };
    }
    if (r.escortId === crewId) return { ...r, escortId: undefined };
    return r;
  });

  return { state: { ...state, territories, operations, crew, routes, supplyRoutes }, logs };
}

function resultCard(id: string, title: string, description: string): GameEvent {
  return {
    id,
    templateId: "making_result",
    title,
    description,
    choices: [{ id: "leave", text: "Leave it", effects: {} }],
    isActive: true,
  };
}

export function beginMaking(
  state: GameState,
  crewId: string,
): { ok: true; state: GameState } | { ok: false; reason: string } {
  if (state.making) return { ok: false, reason: "The books are already open for someone else." };
  const member = state.crew.find((c) => c.id === crewId);
  if (!member || member.family !== state.playerFamily) return { ok: false, reason: "No such man." };
  if (member.traits.includes("made_man")) return { ok: false, reason: "He's already made." };
  if (member.role !== "associate") return { ok: false, reason: "Only an associate sits for the books." };
  if (member.status !== "active" && member.status !== "wounded") {
    return { ok: false, reason: `${member.name} isn't on the street.` };
  }
  const check = canPromote(member, "soldier", state.crew, state.money);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reasons.filter((r) => !r.met).map((r) => r.label).join(" · ") || "He isn't ready.",
    };
  }

  const pulled = pullOffStreet(state, crewId);
  const log: TurnLogEntry = {
    id: `log_making_${crewId}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text: `${member.name} sits the week out. The books open next week.`,
    family: state.playerFamily ?? undefined,
  };
  return {
    ok: true,
    state: {
      ...pulled.state,
      money: state.money - check.cost,
      making: { crewId, name: member.name, resolveTurn: state.turn + 1 },
      turnLog: [...pulled.state.turnLog, ...pulled.logs, log].slice(-200),
    },
  };
}

function openMakingCard(state: GameState, crewId: string, name: string): GameState {
  const man = state.crew.find((c) => c.id === crewId);
  const fit = man ? pointsThatFit(man.skills) : 0;
  const room =
    fit >= MAKING_POINTS
      ? `Place ${MAKING_POINTS} skill points.`
      : fit === 0
        ? "No skill has room for a point."
        : `Only ${fit} of the ${MAKING_POINTS} points fit.`;
  const card: GameEvent = {
    id: `evt_making_${crewId}_${state.turn}`,
    templateId: "making",
    title: "Open the Books",
    description: `${name} has sat the week out. ${room} No skill takes more than ${MAKING_PER_SKILL}, and none can pass 100. Loyalty +${LOYALTY_GRANT} comes with the books.`,
    choices: [],
    isActive: true,
    subjectCrewId: crewId,
  };
  return {
    ...state,
    activeEvent: card,
    events: [...state.events, card],
  };
}

/** Deal the card, or say the ceremony is off. Waits if another card is already up. */
export function advanceMaking(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const ceremony = state.making;
  if (!ceremony || state.turn < ceremony.resolveTurn) return { state, logs: [] };
  if (state.activeEvent) return { state, logs: [] };

  const man = state.crew.find((c) => c.id === ceremony.crewId);
  const gone =
    !man ||
    man.family !== state.playerFamily ||
    (man.status !== "active" && man.status !== "wounded");
  if (gone) {
    const card = resultCard(
      `evt_making_off_${ceremony.crewId}_${state.turn}`,
      "The Ceremony Is Off",
      `${ceremony.name} didn't make it to the books. The $300 stays spent.`,
    );
    return {
      state: {
        ...state,
        making: null,
        activeEvent: card,
        events: [...state.events, card],
      },
      logs: [],
    };
  }
  return { state: openMakingCard(state, ceremony.crewId, ceremony.name), logs: [] };
}

/** Place the points. Returns the same state when the split is illegal. */
export function commitBooks(state: GameState, alloc: CrewSkills): GameState {
  const event = state.activeEvent;
  const ceremony = state.making;
  if (!event || event.templateId !== "making" || !ceremony) return state;
  const man = state.crew.find((c) => c.id === ceremony.crewId);
  if (!man) return state;
  if (!allocationOk(man.skills, alloc)) return state;

  const made: CrewMember = {
    ...man,
    traits: man.traits.includes("made_man") ? man.traits : [...man.traits, "made_man"],
    skills: applySkillPoints(man.skills, alloc),
    loyalty: Math.min(100, man.loyalty + LOYALTY_GRANT),
    role: man.role === "associate" ? "soldier" : man.role,
    level: man.role === "associate" ? man.level + 1 : man.level,
    roleSinceTurn: man.role === "associate" ? state.turn : man.roleSinceTurn,
    assignment: { type: "idle" },
  };
  const card = resultCard(
    `evt_making_done_${man.id}_${state.turn}`,
    "He's Made",
    `${man.name} is a made man. ${describeAlloc(alloc)}. Loyalty +${LOYALTY_GRANT}.`,
  );
  const log: TurnLogEntry = {
    id: `log_made_${man.id}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text: `${man.name} is made. ${describeAlloc(alloc)}. Loyalty +${LOYALTY_GRANT}.`,
    family: state.playerFamily ?? undefined,
  };
  return {
    ...state,
    making: null,
    crew: state.crew.map((c) => (c.id === man.id ? made : c)),
    activeEvent: card,
    events: [...state.events.filter((e) => e.id !== event.id), { ...event, isActive: false }, card],
    turnLog: [...state.turnLog, log].slice(-200),
  };
}
