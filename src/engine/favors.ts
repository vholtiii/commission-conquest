/**
 * Favors called in.
 *
 * A favor owed is an open-ended Deal the player signed at a table to sweeten
 * a number. Sooner or later the family that holds it wants something for it:
 * a hit on someone they're feuding with, crates for a dry speakeasy, or one
 * of their men back. Nothing is paid for the job — that was the favor. The
 * request lands as a normal obligation with a deadline; letting it lapse or
 * breaking it is a breach like any other.
 *
 * Pure except for the state-returning function.
 */
import type { Deal, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation } from "./relations";
import { activeDeals, atPeace, makeDeal, queueSettlement } from "./deals";
import { ALLIANCE_WEEKS, LIQUOR_WEEKS, drySpeakeasies, heldBy, playerWarehouseStock } from "./agendas";

/** Per-turn chance a family holding a favor calls it in, once it has a use. */
export const FAVOR_CALL_CHANCE = 0.12;
/** Crates a favor is worth when it's called in as liquor. */
export const FAVOR_CRATES = 8;
/** A favor isn't called in the week it was given. */
const FAVOR_GRACE_TURNS = 2;

export type FavorCall =
  | { kind: "hit"; target: FamilyName }
  | { kind: "liquor"; destTerritoryId: string; crates: number }
  | { kind: "release"; crewId: string };

/** What `family` would ask for if it called its favor in this week. */
export function favorUse(state: GameState, family: FamilyName): FavorCall | null {
  const player = state.playerFamily;
  if (!player) return null;

  // Someone they're feuding with, and the player hasn't given his word to.
  const feud = ALL_FAMILY_NAMES.filter(
    (f) =>
      f !== player &&
      f !== family &&
      getRelation(state.relations, family, f) < -20 &&
      !atPeace(state, player, f) &&
      !atPeace(state, family, f) &&
      !activeDeals(state).some((d) => d.kind === "alliance" && d.obligor === player && d.terms.targetFamily === f),
  ).sort((a, b) => getRelation(state.relations, family, a) - getRelation(state.relations, family, b));
  if (feud[0]) return { kind: "hit", target: feud[0] };

  const dry = drySpeakeasies(state, family)[0];
  if (dry && playerWarehouseStock(state) >= FAVOR_CRATES) {
    return { kind: "liquor", destTerritoryId: dry.territory.id, crates: FAVOR_CRATES };
  }

  const held = heldBy(state, player, family)[0];
  if (held) return { kind: "release", crewId: held.id };

  return null;
}

/** Turn a favor into what it's worth to them this week. */
function callIn(
  state: GameState,
  favor: Deal,
  family: FamilyName,
  use: FavorCall,
  rng: Rng,
): { state: GameState; log: TurnLogEntry } {
  const player = state.playerFamily!;
  const closed: GameState = {
    ...state,
    deals: state.deals.map((d) =>
      d.id === favor.id ? { ...d, status: "honored" as const, untilTurn: state.turn } : d,
    ),
  };
  const base = { id: `log_favor_call_${favor.id}_${state.turn}`, turn: state.turn, category: "diplomacy" as const, family };
  const card = (next: GameState, text: string, becameDealId?: string) => ({
    state: queueSettlement(next, favor, { outcome: "called_in", cash: 0, relation: 0, standing: 0, text, becameDealId }),
    log: { ...base, text },
  });

  switch (use.kind) {
    case "hit": {
      const made = makeDeal(
        closed,
        "alliance",
        family,
        { cash: 0, standing: 0, weeks: ALLIANCE_WEEKS, targetFamily: use.target, obligor: player, calledIn: true },
        { obligor: player, weeks: ALLIANCE_WEEKS, rng },
      );
      return card(
        made.state,
        `${family} calls in the favor you owe: put a ${use.target} man in the ground within ${ALLIANCE_WEEKS} weeks. No money changes hands.`,
        made.deal.id,
      );
    }
    case "liquor": {
      const dest = state.territories.find((t) => t.id === use.destTerritoryId)?.name ?? "their speakeasy";
      const made = makeDeal(
        closed,
        "liquor",
        family,
        { cash: 0, standing: 0, weeks: LIQUOR_WEEKS, crates: use.crates, destTerritoryId: use.destTerritoryId, obligor: player, calledIn: true },
        { obligor: player, weeks: LIQUOR_WEEKS, rng },
      );
      return card(
        made.state,
        `${family} calls in the favor you owe: ${use.crates} crates to ${dest} within ${LIQUOR_WEEKS} weeks, on the house.`,
        made.deal.id,
      );
    }
    case "release": {
      const man = state.crew.find((c) => c.id === use.crewId);
      const next: GameState = {
        ...closed,
        crew: closed.crew.map((c) =>
          c.id === use.crewId
            ? { ...c, status: "active" as const, heldBy: undefined, heldUntilTurn: undefined, assignment: { type: "idle" as const } }
            : c,
        ),
      };
      return card(next, `${family} calls in the favor you owe: ${man?.name ?? "their man"} walks free tonight. The favor is paid.`);
    }
  }
}

/** Once a week, each family holding a favor may decide it's time. */
export function callInFavors(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  if (!player) return { state, logs };
  let next = state;
  for (const favor of activeDeals(state)) {
    if (favor.kind !== "favor" || favor.obligor !== player) continue;
    if (favor.sinceTurn > next.turn - FAVOR_GRACE_TURNS) continue;
    const family = favor.a === player ? favor.b : favor.a;
    const use = favorUse(next, family);
    if (!use || !rng.chance(FAVOR_CALL_CHANCE)) continue;
    const called = callIn(next, favor, family, use, rng);
    next = called.state;
    logs.push(called.log);
  }
  return { state: next, logs };
}
