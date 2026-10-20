/**
 * The chair is empty. The family fractures once, then has five weeks to put
 * an underboss in the seat. Fail that and the player loses, or a rival
 * outfit scatters.
 */
import type { CrewMember, FamilyName, GameState, Territory, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { familyHq } from "./crewLocation";
import { promoteToBoss } from "./succession";
import { promoteCrew } from "./crew";
import { releaseToPool, scatterFamily, walkToRival } from "./defection";

export const INTERREGNUM_WEEKS = 5;

export function playerLeaderless(state: Pick<GameState, "playerFamily" | "interregnum">): boolean {
  return !!state.playerFamily && state.interregnum?.family === state.playerFamily;
}

function hops(from: string, to: string, territories: Territory[]): number {
  const adj = new Map(territories.map((t) => [t.id, t.adjacentTerritories]));
  if (from === to) return 0;
  const dist = new Map<string, number>([[from, 0]]);
  const q = [from];
  while (q.length > 0) {
    const cur = q.shift()!;
    const d = dist.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (dist.has(next)) continue;
      if (next === to) return d + 1;
      dist.set(next, d + 1);
      q.push(next);
    }
  }
  return 99;
}

function strongestNeighbour(
  territories: Territory[],
  district: Territory,
  except: FamilyName,
): FamilyName | null {
  let best: FamilyName | null = null;
  let bestN = -1;
  for (const id of district.adjacentTerritories) {
    const owner = territories.find((t) => t.id === id)?.owner;
    if (!owner || owner === except) continue;
    const n = territories.filter((t) => t.owner === owner).length;
    if (n > bestN) {
      bestN = n;
      best = owner;
    }
  }
  return best;
}

function crownable(c: CrewMember, turn: number): boolean {
  return (
    c.role === "underboss" &&
    c.status === "active" &&
    c.loyalty >= 30 &&
    turn - (c.roleSinceTurn ?? 0) >= 1
  );
}

/** Fracture once and start the five-week clock. A second family, while one clock is running, collapses the old way. */
export function startInterregnum(
  state: GameState,
  family: FamilyName,
  cause: "killed" | "put_away",
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  if (state.interregnum?.family === family) return { state, logs: [] };
  const logs: TurnLogEntry[] = [];
  if (state.interregnum && state.interregnum.family !== family) {
    // One clock at a time. A rival waits and tries again; the player takes the slot.
    if (family !== state.playerFamily) return { state, logs: [] };
    const scattered = scatterFamily(state, state.interregnum.family, rng);
    state = { ...scattered.state, interregnum: null };
    logs.push(...scattered.logs);
  }

  const seat = familyHq(state, family);
  const owned = state.territories.filter((t) => t.owner === family && t.id !== seat);
  const loseCount = owned.length === 0 ? 0 : Math.max(1, Math.round(owned.length / 3));
  const ranked = [...owned].sort((a, b) => {
    const gar = a.garrisonIds.length - b.garrisonIds.length;
    if (gar !== 0) return gar;
    const far = (seat ? hops(seat, b.id, state.territories) : 0) - (seat ? hops(seat, a.id, state.territories) : 0);
    return far;
  });
  const lost = new Set(ranked.slice(0, loseCount).map((t) => t.id));
  const lostNames: string[] = [];
  const territories = state.territories.map((t) => {
    if (!lost.has(t.id)) return t;
    const nextOwner = strongestNeighbour(state.territories, t, family);
    lostNames.push(`${t.name}${nextOwner ? ` to ${nextOwner}` : ""}`);
    return { ...t, owner: nextOwner, garrisonIds: [], leadershipVacuum: 0 };
  });
  const cutLoose = new Set(
    state.territories.filter((t) => lost.has(t.id)).flatMap((t) => t.garrisonIds),
  );
  const crew = state.crew.map((c) =>
    cutLoose.has(c.id) && c.family === family ? { ...c, assignment: { type: "idle" as const } } : c,
  );
  let current: GameState = { ...state, territories, crew };

  const men = current.crew.filter((c) => c.family === family && c.status === "active");
  const shaky = rng
    .shuffle(men.filter((c) => (c.role === "soldier" || c.role === "associate") && c.loyalty < 55))
    .slice(0, Math.floor(men.length * 0.4));
  const walked: string[] = [];
  for (const man of shaky) {
    if (family === current.playerFamily) {
      const left = walkToRival(current, man.id, rng);
      current = left.state;
      if (left.to) walked.push(`${man.name} to ${left.to}`);
    } else {
      current = releaseToPool(current, man.id);
      walked.push(man.name);
    }
  }

  logs.push({
    id: `log_interregnum_${family}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text:
      cause === "put_away"
        ? `The ${family} boss is gone for good. The family has ${INTERREGNUM_WEEKS} weeks to crown an heir.`
        : `The ${family} boss is dead. The family has ${INTERREGNUM_WEEKS} weeks to crown an heir.`,
    family,
  });
  if (lostNames.length > 0) {
    logs.push({
      id: `log_fracture_turf_${family}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `With nobody in the chair, ${lostNames.join(", ")} ${lostNames.length === 1 ? "slips" : "slip"} away.`,
      family,
    });
  }
  if (walked.length > 0) {
    logs.push({
      id: `log_fracture_men_${family}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `Men walk: ${walked.join(", ")}.`,
      family,
    });
  }

  return {
    state: {
      ...current,
      interregnum: {
        family,
        startedTurn: state.turn,
        deadline: state.turn + INTERREGNUM_WEEKS,
        cause,
      },
    },
    logs,
  };
}

/** Loyalty drips, a rival may name a capo, and a worthy underboss takes the chair. */
export function tickInterregnum(
  state: GameState,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const reg = state.interregnum;
  if (!reg) return { state, logs: [] };
  const logs: TurnLogEntry[] = [];
  let current = state;
  const family = reg.family;

  const heir = current.crew.find((c) => c.family === family && crownable(c, current.turn));
  if (heir) {
    const crowned = promoteToBoss(current, family, heir);
    logs.push(...crowned.logs);
    logs.push({
      id: `log_crowned_${family}_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: `${heir.name} takes the chair. The family holds.`,
      family,
    });
    return { state: { ...crowned.state, interregnum: null }, logs };
  }

  if (family !== current.playerFamily && current.turn >= reg.deadline) {
    const scattered = scatterFamily({ ...current, interregnum: null }, family, rng);
    return { state: scattered.state, logs: [...logs, ...scattered.logs] };
  }

  if (family !== current.playerFamily && rng.chance(0.5)) {
    const capo = current.crew
      .filter(
        (c) =>
          c.family === family &&
          c.role === "capo" &&
          (c.status === "active" || c.status === "wounded") &&
          c.level >= 3,
      )
      .sort((a, b) => b.loyalty - a.loyalty)[0];
    if (capo) {
      const raised = promoteCrew(current.crew, capo.id, "underboss", current.turn).map((c) =>
        c.id === capo.id ? { ...c, loyalty: Math.max(c.loyalty, 30), status: "active" as const } : c,
      );
      current = { ...current, crew: raised };
      logs.push({
        id: `log_regent_${family}_${current.turn}`,
        turn: current.turn,
        category: "ai",
        text: `${family} names ${capo.name} underboss and hopes he can hold the chair.`,
        family,
      });
    }
  }

  const crew = current.crew.map((c) => {
    if (c.family !== family || c.status !== "active" || c.roleSinceTurn === current.turn) return c;
    return { ...c, loyalty: Math.max(0, c.loyalty - 3) };
  });
  return { state: { ...current, crew }, logs };
}
