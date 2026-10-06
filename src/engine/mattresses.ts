/**
 * Go to the mattresses. The boss pulls the family into the safehouses.
 * Heat and fear ease, the rackets collect unmanned, and those blocks get hard.
 */
import type { CrewMember, GameState, Territory, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { assignCrew } from "./crew";
import { safehouseCapacity } from "./safehouse";
import { bossIsJailed } from "./jail";
import { isDefunct } from "./defection";
import { getRelation } from "./relations";
import { decayHeat } from "./heat";
import { CRATE_STREET_VALUE } from "./passage";

export const MATTRESS_WEEKS = 4;
export const MATTRESS_COST = 1500;
export const MATTRESS_HEAT_DECAY = 2;
export const MATTRESS_FEAR_DECAY = 2;
export const MATTRESS_HIT_RISK = 0.08;
export const MATTRESS_DISTRICT_RISK = 0.12;
export const MATTRESS_DEFENCE = 0.4;
export const MATTRESS_MUSCLE = 8;
const WAR_LINE = -60;

export interface Mattresses {
  startTurn: number;
  reason: "war" | "hit";
}

/** Exclusive turn the call ends. Called on T, it holds through T+3. */
function mattressUntil(startTurn: number): number {
  return startTurn + MATTRESS_WEEKS;
}

export function mattressesActive(state: {
  mattresses?: GameState["mattresses"];
  turn?: number;
}): boolean {
  const m = state.mattresses;
  return !!m && (state.turn ?? 0) < mattressUntil(m.startTurn);
}

export function mattressWeek(state: {
  mattresses?: GameState["mattresses"];
  turn?: number;
}): number {
  const m = state.mattresses;
  if (!m) return 0;
  return Math.min(MATTRESS_WEEKS, Math.max(1, (state.turn ?? 0) - m.startTurn + 1));
}

/** Chiefs or the mayor on the payroll, and the address is an open secret. */
export function mattressLeaked(state: Pick<GameState, "bribes">): boolean {
  return !!(state.bribes.chiefs.isActive || state.bribes.mayor.isActive);
}

export function mattressHouses(
  state: Pick<GameState, "playerFamily" | "territories"> & {
    mattresses?: GameState["mattresses"];
    turn?: number;
  },
): Territory[] {
  if (!state.playerFamily) return [];
  const turn = state.turn ?? 0;
  return state.territories
    .filter((t) => t.owner === state.playerFamily && safehouseCapacity(t, turn) > 0)
    .sort((a, b) => safehouseCapacity(b, turn) - safehouseCapacity(a, turn));
}

export function mattressDistrict(
  state: Pick<GameState, "playerFamily" | "territories"> & {
    mattresses?: GameState["mattresses"];
    turn?: number;
  },
  territoryId: string,
): boolean {
  if (!mattressesActive(state)) return false;
  return mattressHouses(state).some((t) => t.id === territoryId);
}

export function mattressSoldierBonus(
  state: { mattresses?: GameState["mattresses"]; turn?: number },
  member: CrewMember,
): number {
  if (!mattressesActive(state) || member.role !== "soldier") return 0;
  return MATTRESS_MUSCLE;
}

function atWar(state: GameState): boolean {
  if (!state.playerFamily) return false;
  const player = state.playerFamily;
  return ALL_FAMILY_NAMES.some((f) => {
    if (f === player || isDefunct(state, f)) return false;
    return getRelation(state.relations, player, f) <= WAR_LINE;
  });
}

function dinnerOn(state: GameState): boolean {
  const d = state.familyDinner;
  return !!d && state.turn < d.startTurn + 3;
}

function playerBoss(state: GameState): CrewMember | undefined {
  if (!state.playerFamily) return undefined;
  return state.crew.find(
    (c) => c.family === state.playerFamily && (c.isPlayerBoss || c.role === "boss") && c.status !== "dead",
  );
}

export function canCallMattresses(state: GameState): { ok: boolean; reason?: string } {
  if (!state.playerFamily) return { ok: false, reason: "No family." };
  if (mattressesActive(state)) return { ok: false, reason: "The family is already on the mattresses." };
  if (dinnerOn(state)) return { ok: false, reason: "The family is at the table." };
  const boss = playerBoss(state);
  if (!boss || bossIsJailed(state, state.playerFamily)) {
    return { ok: false, reason: "The boss is in the Tombs." };
  }
  if (boss.status !== "active" && boss.status !== "wounded") {
    return { ok: false, reason: "The boss can't give the order." };
  }
  if (state.dirtyMoney < MATTRESS_COST) {
    return { ok: false, reason: `You need $${MATTRESS_COST.toLocaleString()} dirty.` };
  }
  if (mattressHouses(state).length === 0) {
    return { ok: false, reason: "You need a safehouse." };
  }
  const hitWindow = (state.mattressReadyUntil ?? 0) > state.turn;
  if (!atWar(state) && !hitWindow) {
    return { ok: false, reason: "Nothing has opened the door. No war, and no hit on the family." };
  }
  return { ok: true };
}

function onAJob(member: CrewMember): boolean {
  const t = member.assignment.type;
  return t === "operation" || t === "surveillance" || t === "delivery";
}

function canPack(member: CrewMember, state: GameState, turn: number): boolean {
  if (member.family !== state.playerFamily) return false;
  if (member.status !== "active" && member.status !== "wounded") return false;
  if (member.awayAt && member.awayAt.untilTurn > turn) return false;
  if (onAJob(member)) return false;
  return true;
}

/** Beds across the houses, then the rest garrison the largest house's block. */
function packInto(state: GameState, movers: CrewMember[]): GameState {
  const houses = mattressHouses(state);
  if (houses.length === 0 || movers.length === 0) return state;
  const ids = new Set(movers.map((m) => m.id));
  let crew = state.crew;
  let territories = state.territories.map((t) => ({
    ...t,
    garrisonIds: t.garrisonIds.filter((id) => !ids.has(id)),
    rackets:
      t.owner === state.playerFamily
        ? t.rackets.map((r) => (r.managerId && ids.has(r.managerId) ? { ...r, managerId: null } : r))
        : t.rackets,
  }));

  const occupied = new Map<string, number>();
  for (const c of state.crew) {
    if (ids.has(c.id)) continue;
    if (c.assignment.type !== "safehouse" || !c.assignment.territoryId) continue;
    occupied.set(c.assignment.territoryId, (occupied.get(c.assignment.territoryId) ?? 0) + 1);
  }
  const beds: { territoryId: string }[] = [];
  for (const house of houses) {
    const open = Math.max(0, safehouseCapacity(house, state.turn) - (occupied.get(house.id) ?? 0));
    for (let i = 0; i < open; i++) beds.push({ territoryId: house.id });
  }
  const overflowBlock = houses[0]!.id;
  const bossFirst = [...movers].sort((a, b) => (a.role === "boss" ? -1 : b.role === "boss" ? 1 : 0));

  const garrisonAdd: string[] = [];
  bossFirst.forEach((man, i) => {
    const bed = beds[i];
    if (bed) {
      crew = assignCrew(crew, man.id, { type: "safehouse", territoryId: bed.territoryId });
    } else {
      crew = assignCrew(crew, man.id, { type: "garrison", territoryId: overflowBlock });
      garrisonAdd.push(man.id);
    }
  });
  if (garrisonAdd.length > 0) {
    territories = territories.map((t) =>
      t.id === overflowBlock ? { ...t, garrisonIds: [...t.garrisonIds, ...garrisonAdd] } : t,
    );
  }
  return { ...state, crew, territories };
}

function clearPlayerManagers(state: GameState): GameState {
  if (!state.playerFamily) return state;
  const player = state.playerFamily;
  return {
    ...state,
    territories: state.territories.map((t) =>
      t.owner !== player
        ? t
        : { ...t, rackets: t.rackets.map((r) => (r.managerId ? { ...r, managerId: null } : r)) },
    ),
  };
}

export function callMattresses(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const check = canCallMattresses(state);
  if (!check.ok || !state.playerFamily) return { state, logs: [] };
  const reason: Mattresses["reason"] = atWar(state) ? "war" : "hit";
  let next = clearPlayerManagers(state);
  const movers = next.crew.filter((c) => canPack(c, next, next.turn));
  next = packInto(next, movers);
  next = easeTheStreet({
    ...next,
    dirtyMoney: next.dirtyMoney - MATTRESS_COST,
    mattresses: { startTurn: next.turn, reason },
  });
  const house = mattressHouses(next)[0];
  return {
    state: next,
    logs: [
      {
        id: `log_mattress_${next.turn}`,
        turn: next.turn,
        category: "event",
        text: `The family goes to the mattresses${house ? ` at ${house.name}` : ""}. The rackets collect without their men.`,
        family: state.playerFamily,
      },
    ],
  };
}

function standDown(state: GameState): GameState {
  const houses = new Set(mattressHouses(state).map((t) => t.id));
  const leaving = new Set(
    state.crew
      .filter((c) => {
        if (c.family !== state.playerFamily) return false;
        if (c.assignment.type === "safehouse" && c.assignment.territoryId && houses.has(c.assignment.territoryId)) {
          return true;
        }
        return (
          c.assignment.type === "garrison" &&
          !!c.assignment.territoryId &&
          houses.has(c.assignment.territoryId)
        );
      })
      .map((c) => c.id),
  );
  let crew = state.crew;
  for (const id of leaving) crew = assignCrew(crew, id, { type: "idle" });
  const territories = state.territories.map((t) =>
    houses.has(t.id) ? { ...t, garrisonIds: t.garrisonIds.filter((id) => !leaving.has(id)) } : t,
  );
  return { ...state, crew, territories, mattresses: null };
}

/** Home early, the war cooled, or the four weeks ran out. */
export function tickMattresses(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const m = state.mattresses;
  if (!m || !mattressesActive(state)) {
    if (m && state.turn >= mattressUntil(m.startTurn)) {
      const next = standDown(state);
      return {
        state: next,
        logs: [
          {
            id: `log_mattress_end_${state.turn}`,
            turn: state.turn,
            category: "event",
            text: "The family comes off the mattresses. The men are idle, and the rackets are still unmanned.",
            family: state.playerFamily ?? undefined,
          },
        ],
      };
    }
    return { state, logs: [] };
  }
  if (m.reason === "war" && !atWar(state)) {
    const next = standDown(state);
    return {
      state: next,
      logs: [
        {
          id: `log_mattress_peace_${state.turn}`,
          turn: state.turn,
          category: "event",
          text: "The war cools. The family comes off the mattresses.",
          family: state.playerFamily ?? undefined,
        },
      ],
    };
  }
  const waiting = state.crew.filter(
    (c) => canPack(c, state, state.turn) && (c.assignment.type === "idle" || c.assignment.type === "racket"),
  );
  let next = waiting.length > 0 ? packInto(state, waiting) : state;
  next = easeTheStreet(next);
  return { state: next, logs: [] };
}

/** One week's ease. The call week counts, then each week the tick still finds them out. */
function easeTheStreet(state: GameState): GameState {
  return {
    ...state,
    heat: decayHeat(state.heat, MATTRESS_HEAT_DECAY),
    reputation: {
      ...state.reputation,
      fear: Math.max(0, state.reputation.fear - MATTRESS_FEAR_DECAY),
    },
  };
}

export function sendThemHome(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  if (!mattressesActive(state)) return { state, logs: [] };
  return {
    state: standDown(state),
    logs: [
      {
        id: `log_mattress_home_${state.turn}`,
        turn: state.turn,
        category: "event",
        text: "The boss calls them home. The men are idle, and the rackets are still unmanned.",
        family: state.playerFamily ?? undefined,
      },
    ],
  };
}

/** A rival truck whose road touches a secret mattress district loses the load. */
export function ambushRivalTraffic(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  if (!mattressesActive(state) || mattressLeaked(state) || !state.playerFamily) {
    return { state, logs: [] };
  }
  const houses = new Set(mattressHouses(state).map((t) => t.id));
  if (houses.size === 0) return { state, logs: [] };
  const player = state.playerFamily;
  const logs: TurnLogEntry[] = [];
  let dirty = state.dirtyMoney;
  const routes = state.routes.map((route) => {
    if (route.status !== "active" || route.family === player) return route;
    if (!route.path.some((id) => houses.has(id))) return route;
    dirty += route.cargo * CRATE_STREET_VALUE;
    logs.push({
      id: `log_mattress_truck_${route.id}_${state.turn}`,
      turn: state.turn,
      category: "delivery",
      text: `A ${route.family} truck drove into the wrong block. ${route.cargo} crates gone.`,
      family: player,
    });
    return { ...route, status: "hijacked" as const };
  });
  let supplyRoutes = state.supplyRoutes ?? [];
  supplyRoutes = supplyRoutes.map((route) => {
    if (route.status !== "active" || route.family === player) return route;
    if (!route.path.some((id) => houses.has(id))) return route;
    dirty += route.cratesPerTurn * CRATE_STREET_VALUE;
    logs.push({
      id: `log_mattress_supply_${route.id}_${state.turn}`,
      turn: state.turn,
      category: "delivery",
      text: `A ${route.family} route drove into the wrong block. ${route.cratesPerTurn} crates gone.`,
      family: player,
    });
    return {
      ...route,
      last: {
        turn: state.turn,
        outcome: "hijacked" as const,
        text: "Drove into the wrong block.",
      },
    };
  });
  if (logs.length === 0) return { state, logs: [] };
  return { state: { ...state, routes, supplyRoutes, dirtyMoney: dirty }, logs };
}

/** This week and next, after a hit on the family. The new boss keeps it. */
export function noteMattressWindow(state: GameState, targetFamily: string, attacker: string): GameState {
  if (!state.playerFamily || targetFamily !== state.playerFamily || attacker === state.playerFamily) return state;
  const until = state.turn + 2;
  return {
    ...state,
    mattressReadyUntil: Math.max(state.mattressReadyUntil ?? 0, until),
  };
}
