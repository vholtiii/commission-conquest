import type { CrewMember, FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation } from "./relations";
import { livingBoss } from "./jail";
import { familyInfluence } from "./victory";
import { territoryHops } from "./hitOps";
import { resolveCrewTerritoryId } from "./crewLocation";

/**
 * When a family runs out of men who could take the chair, it's finished.
 * Its soldiers and associates don't wait around: each one picks a new family
 * — yours included — weighted by standing, how close the turf is, and how the
 * two families got along. A man who picks you turns up in the recruitment
 * pool asking for nothing; pass on him for long enough and he goes to a rival.
 */
export const DEFECTION = {
  /** Weeks a scattered man waits in your pool before he gives up. */
  poolWeeks: 3,
  /** Loyalty he arrives with. He's a stranger. */
  loyalty: 45,
} as const;

/** Ranks that would take the chair after a funeral (see rivalAI.tryInterimBoss). */
export function canInheritChair(m: CrewMember): boolean {
  return m.role === "underboss" || m.role === "capo" || m.role === "consigliere";
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

function lastName(c: CrewMember): string {
  return c.name.replace(/"[^"]*"\s*/g, "").trim().split(/\s+/).pop() ?? c.name;
}

function countNoun(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * Mark a family finished and scatter its soldiers, hitmen and associates.
 * Men in a cell or a rival's basement stay where they are.
 */
export function scatterFamily(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
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

  // Everyone below the chair: soldiers, associates, and the family's hitmen.
  const men = state.crew.filter(
    (c) =>
      c.family === family &&
      (c.status === "active" || c.status === "wounded") &&
      !canInheritChair(c) &&
      c.role !== "boss",
  );
  if (men.length === 0) return { state: current, logs };

  const toPlayer: CrewMember[] = [];
  const toRival = new Map<FamilyName, CrewMember[]>();

  for (const man of men) {
    const from = resolveCrewTerritoryId(current, man.id);
    let options = openFamilies(current, family);
    // A wounded man can't sit in a pool waiting on a hire; he goes where there's a bed.
    if (man.status !== "active") options = options.filter((f) => f !== current.playerFamily);
    const to = pickWeighted(rng, options, (f) => appeal(current, family, from, f));
    if (!to) continue;
    if (to === current.playerFamily) {
      current = offerToPlayer(current, man);
      toPlayer.push(man);
    } else {
      current = joinRival(current, man, to);
      toRival.set(to, [...(toRival.get(to) ?? []), man]);
    }
  }

  for (const [to, group] of toRival) {
    const names = group.map(lastName).join(", ");
    logs.push({
      id: `log_defect_${family}_${to}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text:
        group.length === 1
          ? `${group[0]!.name}, late of the ${family}, went over to the ${to}.`
          : `${countNoun(group.length, "One", `${family} men`)} went over to the ${to} — ${names}.`,
      family: to,
      victim: family,
    });
  }
  if (toPlayer.length > 0) {
    const names = toPlayer.map((c) => c.name).join(", ");
    logs.push({
      id: `log_defect_${family}_player_${state.turn}`,
      turn: state.turn,
      category: "system",
      text:
        toPlayer.length === 1
          ? `${toPlayer[0]!.name}, a ${family} ${toPlayer[0]!.role}, came asking for a place. He'll work for nothing.`
          : `${toPlayer.length} ${family} men came asking for a place — ${names}. They'll work for nothing.`,
      family: current.playerFamily ?? undefined,
    });
  }

  return { state: current, logs };
}

/**
 * Turn-start pass: scattered men the player hasn't hired by their deadline
 * give up and go to a rival instead.
 */
export function expireFreeAgents(
  state: GameState,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const pool = state.recruitmentPool ?? [];
  const leaving = pool.filter((c) => c.freeUntilTurn != null && c.freeUntilTurn <= state.turn);
  if (leaving.length === 0) return { state, logs };

  let current: GameState = {
    ...state,
    recruitmentPool: pool.filter((c) => !leaving.includes(c)),
  };
  for (const man of leaving) {
    const origin = man.origin ?? man.family;
    const options = openFamilies(current, origin).filter((f) => f !== current.playerFamily);
    const to = pickWeighted(rng, options, (f) => appeal(current, origin, null, f));
    if (!to) continue;
    current = joinRival(current, { ...man, freeUntilTurn: undefined }, to);
    logs.push({
      id: `log_defect_wait_${man.id}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `${man.name} got tired of waiting on you and went to the ${to}.`,
      family: current.playerFamily ?? undefined,
    });
  }
  return { state: current, logs };
}
