import type { CrewMember, FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation } from "./relations";
import { livingBoss } from "./jail";
import { familyInfluence } from "./victory";
import { territoryHops } from "./territoryHops";
import { resolveCrewTerritoryId } from "./crewLocation";
import { hitCrewIds } from "@/data/hitApproaches";
import { promoteToBoss, readyRivalHeir } from "./succession";

/**
 * When a rival boss dies and neither a ready underboss nor a ready consigliere
 * can take the chair, the family is finished. The survivors come to you as
 * free agents. Pass on one for long enough and he leaves town.
 */
export const DEFECTION = {
  /** Weeks a scattered man waits in your pool before he gives up. */
  poolWeeks: 3,
  /** Loyalty he arrives with. He's a stranger. */
  loyalty: 45,
} as const;

/** Ranks that can take a rival chair. A capo cannot. Readiness is a separate bar. */
export function canInheritChair(m: CrewMember): boolean {
  return m.role === "underboss" || m.role === "consigliere";
}

/** No living boss and nobody on the roster who could become one. */
export function isFamilyFinished(state: Pick<GameState, "crew">, family: FamilyName): boolean {
  if (livingBoss(state, family)) return false;
  return !state.crew.some(
    (c) =>
      c.family === family &&
      (c.status === "active" || c.status === "wounded") &&
      canInheritChair(c),
  );
}

export function isDefunct(state: Pick<GameState, "defunctFamilies">, family: FamilyName): boolean {
  return (state.defunctFamilies ?? []).includes(family);
}

/** Families still at the table that could take a man in. */
function openFamilies(state: GameState, exclude: FamilyName): FamilyName[] {
  return ALL_FAMILY_NAMES.filter(
    (f) =>
      f !== exclude &&
      !isDefunct(state, f) &&
      state.territories.some((t) => t.owner === f) &&
      (f === state.playerFamily || !isFamilyFinished(state, f)),
  );
}

function nearestBlock(state: GameState, from: string | null, family: FamilyName): Territory | undefined {
  const owned = state.territories.filter((t) => t.owner === family);
  if (owned.length === 0) return undefined;
  if (!from) return owned[0];
  return [...owned].sort(
    (a, b) => territoryHops(state, from, a.id) - territoryHops(state, from, b.id),
  )[0];
}

/**
 * How much a man from `origin` standing on `from` likes family `f`. Standing
 * is the biggest pull; nearby turf and a friendly history help; a family his
 * old one was at war with barely gets a look.
 */
function appeal(state: GameState, origin: FamilyName, from: string | null, f: FamilyName): number {
  const top = Math.max(1, ...ALL_FAMILY_NAMES.map((x) => familyInfluence(state, x)));
  const standing = (familyInfluence(state, f) / top) * 3;
  const near = nearestBlock(state, from, f);
  const hops = near && from ? territoryHops(state, from, near.id) : 3;
  const proximity = hops <= 1 ? 2 : hops === 2 ? 1 : 0;
  const rel = getRelation(state.relations, origin, f);
  const history = Math.max(-1, Math.min(1.5, rel / 40));
  const score = 1 + standing + proximity + history;
  return rel <= -60 ? score * 0.25 : score;
}

function pickWeighted<T>(rng: Rng, items: T[], weight: (x: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  const w = items.map((x) => Math.max(0, weight(x)));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return rng.pick(items);
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= w[i]!;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Strip a man's ties to his old family so he can be placed clean. */
function untie(state: GameState, id: string): Pick<GameState, "territories"> {
  return {
    territories: state.territories.map((t) => {
      const inGarrison = t.garrisonIds.includes(id);
      const managing = t.rackets.some((r) => r.managerId === id);
      if (!inGarrison && !managing) return t;
      return {
        ...t,
        garrisonIds: inGarrison ? t.garrisonIds.filter((g) => g !== id) : t.garrisonIds,
        rackets: managing ? t.rackets.map((r) => (r.managerId === id ? { ...r, managerId: null } : r)) : t.rackets,
      };
    }),
  };
}

/** Put a man on a rival's roster, garrisoned on their nearest block. */
function joinRival(state: GameState, man: CrewMember, to: FamilyName): GameState {
  const from = resolveCrewTerritoryId(state, man.id);
  const block = nearestBlock(state, from, to);
  const cleared = untie(state, man.id);
  const placed: CrewMember = {
    ...man,
    family: to,
    origin: man.origin ?? man.family,
    capoId: undefined,
    crewSinceTurn: undefined,
    awayAt: undefined,
    actingBoss: undefined,
    loyalty: DEFECTION.loyalty,
    assignment: block ? { type: "garrison", territoryId: block.id } : { type: "idle" },
  };
  const crew = state.crew.some((c) => c.id === man.id)
    ? state.crew.map((c) => (c.id === man.id ? placed : c))
    : [...state.crew, placed];
  const territories = cleared.territories.map((t) =>
    block && t.id === block.id && !t.garrisonIds.includes(man.id)
      ? { ...t, garrisonIds: [...t.garrisonIds, man.id] }
      : t,
  );
  return { ...state, crew, territories };
}

/**
 * A man who won't stay after one of his own was killed. He picks a rival the
 * way a scattered man does and garrisons their nearest block.
 */
export function walkToRival(
  state: GameState,
  manId: string,
  rng: Rng,
): { state: GameState; to?: FamilyName } {
  const man = state.crew.find((c) => c.id === manId);
  const player = state.playerFamily;
  if (!man || !player) return { state };
  const from = resolveCrewTerritoryId(state, man.id);
  const options = openFamilies(state, player);
  const to = pickWeighted(rng, options, (f) => appeal(state, player, from, f));
  if (!to) return { state };
  return { state: joinRival(state, man, to), to };
}

/** Move a man off the roster into the player's pool, asking for nothing. */
function offerToPlayer(state: GameState, man: CrewMember): GameState {
  const cleared = untie(state, man.id);
  const waiting: CrewMember = {
    ...man,
    origin: man.origin ?? man.family,
    capoId: undefined,
    crewSinceTurn: undefined,
    awayAt: undefined,
    actingBoss: undefined,
    loyalty: DEFECTION.loyalty,
    assignment: { type: "idle" },
    freeUntilTurn: state.turn + DEFECTION.poolWeeks,
  };
  return {
    ...state,
    territories: cleared.territories,
    crew: state.crew.filter((c) => c.id !== man.id),
    recruitmentPool: [...(state.recruitmentPool ?? []), waiting],
  };
}

/** Call off hits and casing aimed at a finished family, and send those crews home. */
function dropJobs(state: GameState, family: FamilyName): { state: GameState; calledOff: number } {
  const dropped = state.operations.filter(
    (o) => !o.resolved && o.targetFamily === family && (o.kind === "hit" || o.kind === "surveillance"),
  );
  if (dropped.length === 0) return { state, calledOff: 0 };
  const home = new Set(dropped.flatMap((o) => hitCrewIds(o)));
  const crew = state.crew.map((c) =>
    home.has(c.id) && (c.assignment.type === "operation" || c.assignment.type === "surveillance")
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );
  const operations = state.operations.map((o) =>
    !o.resolved && o.targetFamily === family && (o.kind === "hit" || o.kind === "surveillance")
      ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn }
      : o,
  );
  return { state: { ...state, crew, operations }, calledOff: dropped.length };
}

/**
 * Mark a rival family finished. Everyone still on his feet or wounded comes to
 * the player's pool as a free agent. Men in a cell or a basement stay put.
 * Jobs aimed at the family are called off.
 */
export function scatterFamily(
  state: GameState,
  family: FamilyName,
  _rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  if (family === state.playerFamily) return { state, logs: [] };
  // Already finished: still call off any job that slipped through.
  if (isDefunct(state, family)) {
    const jobs = dropJobs(state, family);
    if (jobs.calledOff === 0) return { state, logs: [] };
    return {
      state: jobs.state,
      logs: [
        {
          id: `log_defunct_jobs_${family}_${state.turn}`,
          turn: state.turn,
          category: "hit",
          text: `The work on the ${family} family is called off. There's no one left to hit.`,
          family: state.playerFamily ?? undefined,
        },
      ],
    };
  }
  const logs: TurnLogEntry[] = [];
  let current: GameState = {
    ...state,
    defunctFamilies: [...(state.defunctFamilies ?? []), family],
  };
  logs.push({
    id: `log_defunct_${family}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text: `The ${family} family is finished — no one is left to take the chair. Their men are looking for a home.`,
    family,
  });

  const men = state.crew.filter(
    (c) => c.family === family && (c.status === "active" || c.status === "wounded"),
  );
  for (const man of men) current = offerToPlayer(current, man);

  if (men.length > 0) {
    const names = men.map((c) => c.name).join(", ");
    logs.push({
      id: `log_defect_${family}_player_${state.turn}`,
      turn: state.turn,
      category: "system",
      text:
        men.length === 1
          ? `${men[0]!.name}, a ${family} ${men[0]!.role}, came asking for a place. He'll work for nothing.`
          : `${men.length} ${family} men came asking for a place — ${names}. They'll work for nothing.`,
      family: current.playerFamily ?? undefined,
    });
  }

  const jobs = dropJobs(current, family);
  current = jobs.state;
  if (jobs.calledOff > 0) {
    logs.push({
      id: `log_defunct_jobs_${family}_${state.turn}`,
      turn: state.turn,
      category: "hit",
      text: `The work on the ${family} family is called off. There's no one left to hit.`,
      family: current.playerFamily ?? undefined,
    });
  }

  return { state: current, logs };
}

/**
 * The week a rival boss dies: a ready underboss takes the chair, else a ready
 * consigliere. Otherwise the outfit breaks and the survivors become free agents.
 */
export function settleRivalChair(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[]; newBossName?: string } {
  if (family === state.playerFamily || isDefunct(state, family) || livingBoss(state, family)) {
    return { state, logs: [] };
  }
  const heir = readyRivalHeir(state.crew, family, state.turn);
  if (heir) {
    const promoted = promoteToBoss(state, family, heir);
    return { state: promoted.state, logs: promoted.logs, newBossName: promoted.newBossName };
  }
  return scatterFamily(state, family, rng);
}

/**
 * Turn-start pass: scattered men the player hasn't hired by their deadline
 * leave town. They do not join a family that can still be shot at.
 */
export function expireFreeAgents(
  state: GameState,
  _rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const pool = state.recruitmentPool ?? [];
  const leaving = pool.filter((c) => c.freeUntilTurn != null && c.freeUntilTurn <= state.turn);
  if (leaving.length === 0) return { state, logs };

  const current: GameState = {
    ...state,
    recruitmentPool: pool.filter((c) => !leaving.includes(c)),
  };
  for (const man of leaving) {
    logs.push({
      id: `log_defect_wait_${man.id}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `${man.name} got tired of waiting and left town.`,
      family: current.playerFamily ?? undefined,
    });
  }
  return { state: current, logs };
}
