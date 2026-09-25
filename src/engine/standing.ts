import type { GameState, RacketType, TurnLogEntry } from "@/types/game";
import { isRacketFrozen } from "./economy";
import { familyHq } from "./crewLocation";
import { bossPresenceDistrict, bossStayTurns } from "./bossPresence";

/** Rackets with a door on the street. A still or a laundry does not put your name out. */
export const PUBLIC_RACKETS: readonly RacketType[] = ["speakeasy", "gambling", "brothel", "restaurant"];

/** Storefronts stop adding Street past this, no matter how many you run. */
export const STREET_STOREFRONT_CAP = 2;

/** A block the boss was seen arriving on pays again only after this many weeks. */
export const STREET_SEEN_MEMORY_TURNS = 10;

/** Respect for keeping your word when a deal is honored. Same size as a sit-down that lands. */
export const HONOR_RESPECT = 2;

/**
 * Street earned this week, applied before the influence drift so it counts now.
 *
 * +1 per live public racket you own, capped at 2. Plus 1 when the boss was
 * seen: on the road to a sit-down, or arriving on a block off the HQ that he
 * hasn't held in ten weeks. Sitting on a block pays nothing after the first
 * week, so parking him somewhere is not a Street farm.
 */
export function applyWeeklyStreet(state: GameState): { state: GameState; log?: TurnLogEntry } {
  const player = state.playerFamily;
  if (!player) return { state };

  let fronts = 0;
  for (const t of state.territories) {
    if (t.owner !== player) continue;
    for (const r of t.rackets) {
      if (!PUBLIC_RACKETS.includes(r.type) || isRacketFrozen(r, state.turn)) continue;
      fronts += 1;
    }
  }
  const fromFronts = Math.min(STREET_STOREFRONT_CAP, fronts);

  const boss =
    state.crew.find((c) => c.family === player && c.actingBoss && c.status === "active") ??
    state.crew.find((c) => c.family === player && c.role === "boss" && c.status === "active");
  const seen = { ...(state.streetSeen ?? {}) };
  let bossLine: string | null = null;
  if (boss) {
    const onTheRoad = !!boss.awayAt && boss.awayAt.untilTurn > state.turn;
    if (onTheRoad) {
      const where = state.territories.find((t) => t.id === boss.awayAt!.territoryId)?.name ?? "town";
      bossLine = `+1, the boss was seen on the road to ${where}`;
    } else {
      const hq = familyHq(state, player);
      const here = bossPresenceDistrict(state, player);
      const arrived = !!here && here !== hq && bossStayTurns(state, player) === 0;
      const fresh = !!here && (seen[here] === undefined || state.turn - seen[here]! >= STREET_SEEN_MEMORY_TURNS);
      if (arrived && fresh && here) {
        seen[here] = state.turn;
        const where = state.territories.find((t) => t.id === here)?.name ?? "a new block";
        bossLine = `+1, the boss was seen arriving in ${where}`;
      }
    }
  }
  const fromBoss = bossLine ? 1 : 0;

  const gain = fromFronts + fromBoss;
  if (gain <= 0) return { state };

  const parts: string[] = [];
  if (fromFronts > 0) parts.push(`+${fromFronts} from the storefronts`);
  if (bossLine) parts.push(bossLine);
  return {
    state: {
      ...state,
      streetSeen: seen,
      reputation: {
        ...state.reputation,
        streetInfluence: Math.min(100, state.reputation.streetInfluence + gain),
      },
    },
    log: {
      id: `log_street_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: `The street took notice (${parts.join("; ")}).`,
      family: player,
    },
  };
}
