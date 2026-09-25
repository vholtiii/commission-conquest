/**
 * Passage: the price of running trucks through another family's turf.
 *
 * A PassageDeal is struck at a sit-down (see sitdowns.ts) and lets the
 * player's supply routes cross that family's districts for a toll, a cut of
 * the crates, and sometimes a gift up front. Running without one is "hot":
 * their men stop the truck for a tax, hijack odds climb, and every hot run
 * adds a passage grudge that eventually earns a message hit.
 *
 * Pure except for the state-returning functions.
 */
import type {
  CrewMember,
  FamilyName,
  GameState,
  Grudge,
  PassageDeal,
  PassageTerms,
  SupplyRoute,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation, setRelationDelta, statusFromScore } from "./relations";
import { openIncidents, topSuspect } from "./incidents";
import { BOSS_PRESENCE, bossPresenceDistrict } from "./bossPresence";

/** Turns a passage grudge stays warm. */
export const PASSAGE_GRUDGE_TURNS = 8;
/** Turns the leverage from a landed message hit lasts. */
export const LEVERAGE_TURNS = 6;
/** Street value of a crate when a rival pockets it. */
export const CRATE_STREET_VALUE = 12;

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function activeDeal(
  state: Pick<GameState, "passageDeals" | "turn" | "playerFamily">,
  family: FamilyName,
): PassageDeal | undefined {
  return (state.passageDeals ?? []).find(
    (d) =>
      d.family === family &&
      d.holder === state.playerFamily &&
      d.status === "active" &&
      (d.untilTurn === null || d.untilTurn > state.turn),
  );
}

export function hasLeverage(
  state: Pick<GameState, "passageLeverage" | "turn">,
  family: FamilyName,
): boolean {
  return (state.passageLeverage?.[family] ?? 0) > state.turn;
}

export function passageGrudges(
  state: Pick<GameState, "grudges" | "turn" | "playerFamily">,
  family: FamilyName,
): Grudge[] {
  const player = state.playerFamily;
  if (!player) return [];
  return (state.grudges ?? []).filter(
    (g) =>
      g.family === family &&
      g.against === player &&
      g.reason === "passage" &&
      g.expiresTurn > state.turn,
  );
}

/** Rival families whose districts a path crosses. */
export function familiesOnPath(
  state: Pick<GameState, "territories">,
  path: string[],
  family: FamilyName,
): FamilyName[] {
  const seen = new Set<FamilyName>();
  for (const tid of path) {
    const owner = state.territories.find((t) => t.id === tid)?.owner;
    if (owner && owner !== family) seen.add(owner);
  }
  return [...seen];
}

/* ------------------------------------------------------------------ */
/* Terms                                                               */
/* ------------------------------------------------------------------ */

const STATUS_TOLL = { war: 6, hostile: 3, cold: 1, neutral: 0, truce: -1, allied: -2 };

/**
 * The player's boss holds court on a block that borders where the rival boss
 * sits. The table is a short walk, and the family across it knows who's
 * next door — the ask comes down.
 */
export function bossNextDoorToTable(state: GameState, family: FamilyName): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  const mine = bossPresenceDistrict(state, player);
  const theirs = bossPresenceDistrict(state, family);
  if (!mine || !theirs) return false;
  const block = state.territories.find((t) => t.id === mine);
  return !!block && block.adjacentTerritories.includes(theirs);
}

/**
 * What a family asks for at the table. Hostile families and smugglers want
 * more; a landed message hit or a feared player brings the number down; a
 * family that came to the table after a hot run or a message hit of their
 * own wants payback on top. A boss who holds court next door pays less.
 */
export function openingAsk(
  state: GameState,
  family: FamilyName,
  opts: { crates?: number; demanded?: boolean } = {},
): PassageTerms {
  const player = state.playerFamily;
  const status = player ? statusFromScore(getRelation(state.relations, player, family)) : "neutral";
  const def = getFamilyDef(family);

  let toll = 3 + STATUS_TOLL[status];
  let cut = 0.1;
  let gift = 200;
  let duration: number | null = 8;

  switch (def.personality) {
    case "smuggler":
      toll += 2;
      cut = 0.15;
      break;
    case "economic":
      toll += 1;
      cut = 0.05;
      duration = 12;
      break;
    case "volatile":
      gift += 200;
      duration = 6;
      break;
    case "covert":
      cut = 0.12;
      break;
    default:
      break;
  }

  if (status === "hostile" || status === "war") gift += 300;
  toll -= Math.floor(state.reputation.respect / 40);
  toll -= Math.floor(state.reputation.fear / 50);

  if (opts.demanded) {
    toll = Math.ceil(toll * 1.4);
    gift += 400 + passageGrudges(state, family).length * 100;
  }
  if (hasLeverage(state, family)) {
    toll = Math.ceil(toll * 0.6);
    gift = Math.floor(gift * 0.5);
    cut = Math.max(0.03, cut - 0.05);
  }
  let giftOut = Math.max(0, Math.round(gift / 50) * 50);
  if (bossNextDoorToTable(state, family)) {
    // Rounded down so the discount shows at small numbers too.
    toll = Math.floor(toll * BOSS_PRESENCE.askMult);
    giftOut = Math.max(0, Math.floor((giftOut * BOSS_PRESENCE.askMult) / 50) * 50);
  }

  return {
    tollPerCrate: Math.max(1, toll),
    cratesCut: Math.round(Math.max(0, Math.min(0.3, cut)) * 100) / 100,
    gift: giftOut,
    durationTurns: duration,
  };
}

/** Rough eight-week cost of a set of terms for `crates` a run. */
export function termsValue(terms: PassageTerms, crates: number): number {
  const weekly = terms.tollPerCrate * crates + terms.cratesCut * crates * CRATE_STREET_VALUE;
  const weeks = terms.durationTurns === null ? 10 : Math.min(terms.durationTurns, 10);
  // Open-ended deals are worth a little more to the granter.
  return weekly * weeks + terms.gift + (terms.durationTurns === null ? weekly : 0);
}

export function termsText(terms: PassageTerms): string {
  const bits = [`$${terms.tollPerCrate}/crate`];
  if (terms.cratesCut > 0) bits.push(`${Math.round(terms.cratesCut * 100)}% of the crates`);
  if (terms.gift > 0) bits.push(`$${terms.gift} up front`);
  bits.push(terms.durationTurns === null ? "open-ended" : `${terms.durationTurns} weeks`);
  return bits.join(", ");
}

const STATUS_MOD = { war: -0.5, hostile: -0.2, cold: -0.08, neutral: 0, truce: 0.1, allied: 0.25 };

/** Chance the family takes the player's counter instead of holding to their ask. */
export function counterAcceptance(
  state: GameState,
  family: FamilyName,
  ask: PassageTerms,
  offer: PassageTerms,
  crates: number,
): number {
  const player = state.playerFamily;
  if (!player) return 0;
  const askV = Math.max(1, termsValue(ask, crates));
  const offerV = termsValue(offer, crates);
  const ratio = offerV / askV;
  const status = statusFromScore(getRelation(state.relations, player, family));
  let chance = ratio - 0.4 + STATUS_MOD[status] + state.reputation.respect / 300;
  if (hasLeverage(state, family)) chance += 0.2;
  if (getFamilyDef(family).personality === "economic") chance += 0.05;
  if (getFamilyDef(family).personality === "volatile") chance -= 0.1;
  return Math.max(0.05, Math.min(0.95, chance));
}

/** The family moves part of the way toward the player's number. */
export function blendTerms(ask: PassageTerms, offer: PassageTerms, k: number): PassageTerms {
  const mix = (a: number, b: number) => a + (b - a) * k;
  return {
    tollPerCrate: Math.max(1, Math.round(mix(ask.tollPerCrate, offer.tollPerCrate))),
    cratesCut: Math.round(mix(ask.cratesCut, offer.cratesCut) * 100) / 100,
    gift: Math.max(0, Math.round(mix(ask.gift, offer.gift) / 50) * 50),
    durationTurns:
      ask.durationTurns === null || offer.durationTurns === null
        ? offer.durationTurns
        : Math.round(mix(ask.durationTurns, offer.durationTurns)),
  };
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

/** Routes waiting on this family now have their deal. Idle ones start rolling. */
export function applyDealToRoutes(routes: SupplyRoute[], family: FamilyName): SupplyRoute[] {
  return routes.map((r) => {
    if (!r.awaitingFamilies.includes(family)) return r;
    const awaiting = r.awaitingFamilies.filter((f) => f !== family);
    return {
      ...r,
      awaitingFamilies: awaiting,
      status: awaiting.length === 0 && r.status === "negotiating" ? "active" : r.status,
    };
  });
}

/** Strike a deal on `terms`. The gift comes out of dirty cash first. */
export function strikeDeal(
  state: GameState,
  family: FamilyName,
  terms: PassageTerms,
  rng?: Rng,
): GameState {
  const player = state.playerFamily;
  if (!player) return state;
  const dirtyPart = Math.min(state.dirtyMoney, terms.gift);
  const cleanPart = terms.gift - dirtyPart;
  const deal: PassageDeal = {
    id: `deal_${family}_${state.turn}_${rng ? rng.int(100, 999) : 0}`,
    family,
    holder: player,
    terms,
    sinceTurn: state.turn,
    untilTurn: terms.durationTurns === null ? null : state.turn + terms.durationTurns,
    status: "active",
    missedTolls: 0,
  };
  const others = (state.passageDeals ?? []).map((d) =>
    d.family === family && d.status === "active" ? { ...d, status: "expired" as const } : d,
  );
  return {
    ...state,
    dirtyMoney: state.dirtyMoney - dirtyPart,
    money: state.money - cleanPart,
    rivalTreasury: {
      ...state.rivalTreasury,
      [family]: (state.rivalTreasury?.[family] ?? 0) + terms.gift,
    },
    passageDeals: [...others, deal],
    supplyRoutes: applyDealToRoutes(state.supplyRoutes ?? [], family),
  };
}

/**
 * A deal ends badly. "holder" = the player stiffed them (grudge, relations);
 * "granter" = they hijacked a truck they'd promised safe passage (relations,
 * and the player is free to answer).
 */
export function breachDeal(
  state: GameState,
  dealId: string,
  by: "holder" | "granter",
): GameState {
  const deal = (state.passageDeals ?? []).find((d) => d.id === dealId);
  if (!deal || deal.status !== "active" || !state.playerFamily) return state;
  let next: GameState = {
    ...state,
    passageDeals: state.passageDeals.map((d) =>
      d.id === dealId ? { ...d, status: "breached" as const, untilTurn: state.turn } : d,
    ),
    relations: setRelationDelta(
      state.relations,
      state.playerFamily,
      deal.family,
      by === "holder" ? -12 : -15,
    ),
  };
  if (by === "holder") {
    next = addPassageGrudge(next, deal.family, routeSceneFor(next, deal.family));
  }
  return next;
}

function routeSceneFor(state: GameState, family: FamilyName): string {
  return (
    state.territories.find((t) => t.owner === family)?.id ??
    state.territories[0]?.id ??
    ""
  );
}

/** Note the offence. Several of these get a family to send a message. */
export function addPassageGrudge(
  state: GameState,
  family: FamilyName,
  territoryId: string,
): GameState {
  const player = state.playerFamily;
  if (!player || family === player) return state;
  const grudge: Grudge = {
    id: `grudge_passage_${family}_${state.turn}_${(state.grudges ?? []).length}`,
    family,
    against: player,
    territoryId,
    reason: "passage",
    turn: state.turn,
    expiresTurn: state.turn + PASSAGE_GRUDGE_TURNS,
  };
  return { ...state, grudges: [...(state.grudges ?? []), grudge] };
}

/** Message sent: the family's passage grudges are spent. */
export function clearPassageGrudges(state: GameState, family: FamilyName): GameState {
  const player = state.playerFamily;
  const rest = (state.grudges ?? []).filter(
    (g) => !(g.family === family && g.against === player && g.reason === "passage"),
  );
  return rest.length === (state.grudges ?? []).length ? state : { ...state, grudges: rest };
}

/** Deals that ran out this turn, and the routes now waiting on a renewal. */
export function tickPassageDeals(state: GameState): {
  state: GameState;
  expired: FamilyName[];
} {
  const expired: FamilyName[] = [];
  const deals = (state.passageDeals ?? []).map((d) => {
    if (d.status !== "active" || d.untilTurn === null || d.untilTurn > state.turn) return d;
    expired.push(d.family);
    return { ...d, status: "expired" as const };
  });
  if (expired.length === 0) return { state, expired };

  const player = state.playerFamily;
  const routes = (state.supplyRoutes ?? []).map((r) => {
    if (!player || r.family !== player || r.status === "suspended") return r;
    const crossing = familiesOnPath(state, r.path, r.family).filter((f) => expired.includes(f));
    if (crossing.length === 0) return r;
    const awaiting = [...new Set([...r.awaitingFamilies, ...crossing])];
    return { ...r, awaitingFamilies: awaiting, status: r.runHot ? r.status : ("negotiating" as const) };
  });
  // History: keep the last dozen turns of dead deals.
  const trimmed = deals.filter(
    (d) => d.status === "active" || (d.untilTurn ?? state.turn) > state.turn - 12,
  );
  return { state: { ...state, passageDeals: trimmed, supplyRoutes: routes }, expired };
}

/* ------------------------------------------------------------------ */
/* Disputes (what justifies a message hit)                             */
/* ------------------------------------------------------------------ */

/** Who a message can be sent through: skilled, senior, and not the boss. */
export function isMessageTargetRole(c: Pick<CrewMember, "role" | "level">): boolean {
  if (c.role === "hitman" || c.role === "consigliere" || c.role === "underboss") return true;
  return c.role === "capo" && c.level >= 3;
}

/**
 * Why the player has a route beef with this family, or null. A message hit
 * needs one: a hijack case pointing their way, a deal they broke, or a truck
 * their men stopped.
 */
export function routeDisputeWith(state: GameState, family: FamilyName): string | null {
  const player = state.playerFamily;
  if (!player) return null;
  const broke = (state.passageDeals ?? []).find(
    (d) => d.family === family && d.status === "breached" && (d.untilTurn ?? 0) > state.turn - 10,
  );
  if (broke) return `They broke the passage deal in week ${broke.untilTurn}.`;
  const stopped = (state.supplyRoutes ?? []).find(
    (r) =>
      r.last?.outcome === "stopped" &&
      r.last.stoppedBy === family &&
      r.last.turn > state.turn - 8,
  );
  if (stopped) return `Their men taxed your truck in week ${stopped.last!.turn}.`;
  const hijack = openIncidents(state).find((inc) => {
    if (inc.kind !== "hijack") return false;
    const top = topSuspect(inc);
    return top?.family === family && top.confidence >= 0.4;
  });
  if (hijack) return `A hijack case points their way (${Math.round((topSuspect(hijack)?.confidence ?? 0) * 100)}%).`;
  return null;
}
