/**
 * A family dinner at a safehouse. Two weeks of loyalty, thin rackets, and an
 * open street for anyone who hears where the family went.
 */
import type { CrewMember, FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { safehouseLevel } from "./economy";
import { livingBoss } from "./jail";
import { isDefunct } from "./defection";
import { getRelation, statusFromScore } from "./relations";

export const DINNER_TURNS = 2;
export const DINNER_COOLDOWN = 8;
export const DINNER_LOYALTY = 10;
export const DINNER_MORALE = 5;
export const DINNER_LEAK = 0.35;
export const DINNER_LEAK_HOSTILE = 0.6;
export const DINNER_INCOME_MULT = 0.6;
export const DINNER_RAT_GRACE = 4;
export const DINNER_SEATS_PER_LEVEL = 4;

/** Exclusive turn the gathering ends. Called on turn T, it holds through T+2. */
function dinnerUntil(startTurn: number): number {
  return startTurn + DINNER_TURNS + 1;
}

export function dinnerActive(state: Pick<GameState, "familyDinner" | "turn">): boolean {
  const d = state.familyDinner;
  return !!d && state.turn < dinnerUntil(d.startTurn);
}

export function dinnerSeats(t: Territory, turn: number): number {
  return safehouseLevel(t, turn) * DINNER_SEATS_PER_LEVEL;
}

function houses(state: GameState): { territory: Territory; seats: number }[] {
  if (!state.playerFamily) return [];
  return state.territories
    .filter((t) => t.owner === state.playerFamily)
    .map((t) => ({ territory: t, seats: dinnerSeats(t, state.turn) }))
    .filter((h) => h.seats > 0)
    .sort((a, b) => b.seats - a.seats);
}

/** The living boss can host if he is on his feet or wounded. A corpse still titled boss does not count. */
function hostBoss(state: GameState) {
  if (!state.playerFamily) return undefined;
  const boss = livingBoss(state, state.playerFamily);
  if (!boss || (boss.status !== "active" && boss.status !== "wounded")) return undefined;
  return boss;
}

/** Active men, plus a wounded boss. He sits with them. */
function dinnerParty(state: GameState): CrewMember[] {
  if (!state.playerFamily) return [];
  const boss = hostBoss(state);
  return state.crew.filter(
    (c) =>
      c.family === state.playerFamily &&
      (c.status === "active" || (!!boss && c.id === boss.id)),
  );
}

const SEAT_RANK: Record<string, number> = {
  boss: 0,
  underboss: 1,
  consigliere: 2,
  capo: 3,
  hitman: 4,
  soldier: 5,
  associate: 6,
};

/** Largest safehouse. The boss sits first, then the chairs, then the rest, until the seats run out. */
function hosting(state: GameState): { house: Territory; seated: CrewMember[]; left: number } | null {
  const options = houses(state);
  const best = options[0];
  if (!best || best.seats < 1) return null;
  const party = dinnerParty(state).sort(
    (a, b) => (SEAT_RANK[a.role] ?? 9) - (SEAT_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );
  if (party.length === 0) return null;
  const seated = party.slice(0, best.seats);
  return { house: best.territory, seated, left: party.length - seated.length };
}

export function canCallDinner(state: GameState): { ok: boolean; reason?: string } {
  if (!state.playerFamily) return { ok: false, reason: "No family." };
  if (dinnerActive(state)) return { ok: false, reason: "The family is already at the table." };
  if (state.mattresses && state.turn < state.mattresses.startTurn + 4) {
    return { ok: false, reason: "The family is on the mattresses." };
  }
  if (!hostBoss(state)) {
    return { ok: false, reason: "The boss isn't free to host it." };
  }
  const last = state.lastDinnerTurn;
  if (last != null && state.turn < last + DINNER_COOLDOWN) {
    const ago = state.turn - last;
    return {
      ok: false,
      reason:
        ago <= 0
          ? "Too soon — the family just ate."
          : `Too soon — the family ate ${ago} week${ago === 1 ? "" : "s"} ago.`,
    };
  }
  const job = state.operations.some(
    (o) => o.family === state.playerFamily && o.kind === "hit" && !o.resolved,
  );
  if (job) return { ok: false, reason: "You've got a job in the works — the whole family has to be free." };
  const clash = (state.sitdowns ?? []).find(
    (s) =>
      (s.proposer === state.playerFamily || s.other === state.playerFamily) &&
      (s.status === "proposed" || s.status === "scheduled" || s.status === "at_table") &&
      s.heldTurn < dinnerUntil(state.turn),
  );
  if (clash) {
    const other = clash.proposer === state.playerFamily ? clash.other : clash.proposer;
    return { ok: false, reason: `The boss sits down with ${other} that week.` };
  }
  const table = hosting(state);
  if (!table) return { ok: false, reason: "You need a safehouse to host it." };
  if (table.left > 0) {
    return {
      ok: true,
      reason: `${table.house.name} seats ${table.seated.length}. ${table.left} stay on the street.`,
    };
  }
  return { ok: true };
}

function rivalCasedPlayer(state: GameState, family: FamilyName): boolean {
  const known = state.intel?.known ?? {};
  for (const [id, k] of Object.entries(known)) {
    if (k.source !== "surveillance" || k.turn < state.turn - 2) continue;
    const man = state.crew.find((c) => c.id === id);
    if (man?.family !== family) continue;
    const block = state.territories.find((t) => t.id === k.territoryId);
    if (block?.owner === state.playerFamily) return true;
  }
  return false;
}

function watching(state: GameState, family: FamilyName): boolean {
  if (!state.playerFamily) return false;
  const status = statusFromScore(getRelation(state.relations, state.playerFamily, family));
  return status === "war" || status === "hostile";
}

export function callFamilyDinner(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const check = canCallDinner(state);
  const table = hosting(state);
  if (!check.ok || !table || !state.playerFamily) return { state, logs: [] };
  const house = table.house;

  const logs: TurnLogEntry[] = [
    {
      id: `log_dinner_${state.turn}`,
      turn: state.turn,
      category: "event",
      text:
        table.left > 0
          ? `The family sits down to eat at ${house.name}. ${table.seated.length} have a chair. The rest stay on the street.`
          : `The family sits down to eat at ${house.name}. For two weeks the streets are thin.`,
      family: state.playerFamily,
    },
  ];

  const crewRequests = state.crewRequests.map((r) => {
    if (r.kind !== "walk" || r.status !== "pending") return r;
    const man = state.crew.find((c) => c.id === r.candidateId);
    logs.push({
      id: `log_dinner_stay_${r.id}`,
      turn: state.turn,
      category: "event",
      text: `${man?.name ?? "He"} sits back down. He's staying.`,
      family: state.playerFamily ?? undefined,
    });
    return { ...r, status: "expired" as const };
  });

  const until = dinnerUntil(state.turn);
  const seated = new Set(table.seated.map((c) => c.id));
  const crew = state.crew.map((c) =>
    seated.has(c.id)
      ? {
          ...c,
          loyalty: Math.min(100, c.loyalty + DINNER_LOYALTY),
          awayAt: { territoryId: house.id, untilTurn: until, reason: "dinner" as const },
        }
      : c,
  );

  const knownBy: FamilyName[] = [];
  for (const family of ALL_FAMILY_NAMES) {
    if (family === state.playerFamily || isDefunct(state, family)) continue;
    const chance = rivalCasedPlayer(state, family)
      ? 1
      : watching(state, family)
        ? DINNER_LEAK_HOSTILE
        : DINNER_LEAK;
    if (rng.chance(chance)) knownBy.push(family);
  }

  return {
    logs,
    state: {
      ...state,
      crew,
      crewRequests,
      familyDinner: { startTurn: state.turn, territoryId: house.id, knownBy },
      lastDinnerTurn: state.turn,
      reputation: {
        ...state.reputation,
        loyalty: Math.min(100, state.reputation.loyalty + DINNER_MORALE),
      },
    },
  };
}

export function expireDinner(state: GameState): { state: GameState; log?: TurnLogEntry } {
  const d = state.familyDinner;
  if (!d || state.turn < dinnerUntil(d.startTurn)) return { state };
  const names = d.knownBy;
  const who =
    names.length === 0
      ? "Nobody outside heard a thing."
      : `Word had got around — ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`} knew.`;
  return {
    state: { ...state, familyDinner: null },
    log: {
      id: `log_dinner_end_${state.turn}`,
      turn: state.turn,
      category: "event",
      text: `The family goes back to work. ${who}`,
      family: state.playerFamily ?? undefined,
    },
  };
}

/** Week 1 or 2, for the banner. */
export function dinnerWeek(state: GameState): number {
  const d = state.familyDinner;
  if (!d) return 0;
  return Math.min(DINNER_TURNS, Math.max(1, state.turn - d.startTurn + 1));
}
