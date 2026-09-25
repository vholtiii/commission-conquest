/**
 * Agendas: what gets haggled over at a sit-down, and what the numbers mean.
 *
 * Every agenda table works the same way: one side names terms, the other
 * accepts, counters, or walks. This module prices the opening ask, judges a
 * counter, blends the rival's number toward the player's, and applies the
 * struck terms to the game. The state machine itself lives in sitdowns.ts.
 *
 * Cash is signed from the player's side: positive = the player pays.
 *
 * Pure except for the state-returning functions.
 */
import type {
  AgendaTerms,
  CrewMember,
  FamilyName,
  GameState,
  SitdownAgenda,
  Territory,
} from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation, setRelationDelta, statusFromScore } from "./relations";
import { RACKET_BUILD_COST, racketIncome } from "./economy";
import { familyHq } from "./crewLocation";
import { familiesPressingSuddenDeath } from "./victory";
import { hasConsigliere, hasPact } from "./diplomacy";
import { activeDeals, atPeace, inTruce, makeDeal } from "./deals";
import { CRATE_STREET_VALUE } from "./passage";

/** Counters the player gets before the other side leaves the table. */
export const TABLE_ROUNDS = 3;
/** Standing the player can throw on the table at most. */
export const MAX_STANDING_CHIP = 30;
/** Acceptance bought per point of standing. Ten points is about five percent. */
export const STANDING_CHIP_RATE = 0.005;
/** Acceptance bought by owing them one. */
export const FAVOR_CHIP = 0.15;
/** Below this share of the ask (after chips) the number is an insult. */
export const INSULT_FLOOR = 0.6;
export const INSULT_RELATION = -8;
/** Chance a volatile family leaves the table over an insult. */
export const INSULT_WALK_CHANCE = 0.25;
/** Truce lengths on offer. */
export const TRUCE_MIN_WEEKS = 4;
export const TRUCE_MAX_WEEKS = 12;
export const TRUCE_DEFAULT_WEEKS = 6;
/** Weeks the rival gives the player to run a liquor order. */
export const LIQUOR_WEEKS = 2;
/** What they pay per crate over the street price. */
export const LIQUOR_PREMIUM = 1.5;
/** Weeks either side gets to make a contract hit. */
export const ALLIANCE_WEEKS = 6;
/** A cut of a district's take: how much, for how long. */
export const CUT_MIN_SHARE = 0.1;
export const CUT_MAX_SHARE = 0.5;
export const CUT_DEFAULT_SHARE = 0.25;
export const CUT_MIN_WEEKS = 4;
export const CUT_MAX_WEEKS = 16;
export const CUT_DEFAULT_WEEKS = 8;
/** Sellers want more than the stream is worth; buyers offer less. */
export const CUT_SELL_PREMIUM = 1.2;
export const CUT_BUY_DISCOUNT = 0.8;

export const PLAYER_AGENDAS: SitdownAgenda[] = [
  "general",
  "truce",
  "territory",
  "racket",
  "release",
  "vendetta",
  "alliance",
];

export function agendaLabel(agenda: SitdownAgenda | undefined): string {
  switch (agenda) {
    case "passage":
      return "Passage";
    case "truce":
      return "Truce";
    case "territory":
      return "A district";
    case "release":
      return "A man held";
    case "vendetta":
      return "End the vendetta";
    case "alliance":
      return "A contract";
    case "liquor":
      return "Liquor";
    case "racket":
      return "A cut of the take";
    default:
      return "Ease off";
  }
}

export function agendaBlurb(agenda: SitdownAgenda): string {
  switch (agenda) {
    case "truce":
      return "No hits, no captures, either way, for a set number of weeks.";
    case "territory":
      return "Buy one of their districts outright. They never sell the house.";
    case "release":
      return "Ransom a man of yours they're holding. He's home next week.";
    case "vendetta":
      return "Pay them to drop the vendetta. Cash and standing.";
    case "alliance":
      return "Pay them to put a third family's man in the ground within a deadline. Cash on delivery.";
    case "liquor":
      return "They buy crates for a speakeasy of theirs. You deliver.";
    case "racket":
      return "Buy a share of one of their districts' weekly take for a stretch of weeks. Cash up front.";
    case "passage":
      return "Right of way for your trucks.";
    default:
      return "The usual talk: one roll, and they ease off if it lands.";
  }
}

/* ------------------------------------------------------------------ */
/* What's on the table                                                 */
/* ------------------------------------------------------------------ */

function turfOf(state: GameState, family: FamilyName): Territory[] {
  return state.territories.filter((t) => t.owner === family);
}

/** Their men the player's hits have put down in the last six weeks. */
export function bleeding(state: GameState, family: FamilyName): number {
  const player = state.playerFamily;
  if (!player) return 0;
  return state.operations.filter(
    (o) =>
      o.kind === "hit" &&
      o.family === player &&
      o.targetFamily === family &&
      o.resolved &&
      (o.resolvedTurn ?? -99) > state.turn - 6,
  ).length;
}

/** Men of `family` the player is holding. */
export function heldBy(state: GameState, holder: FamilyName, family: FamilyName): CrewMember[] {
  return state.crew.filter((c) => c.family === family && c.status === "held" && c.heldBy === holder);
}

/** Districts of theirs the player could buy: everything but the house. */
export function buyableDistricts(state: GameState, family: FamilyName): Territory[] {
  const hq = familyHq(state, family);
  return turfOf(state, family).filter((t) => t.id !== hq && t.discovered);
}

/** Districts of the player's a rival might want, cheapest first. */
export function sellableDistricts(state: GameState): Territory[] {
  const player = state.playerFamily;
  if (!player) return [];
  const hq = familyHq(state, player);
  return turfOf(state, player)
    .filter((t) => t.id !== hq)
    .sort((a, b) => districtPrice(state, a) - districtPrice(state, b));
}

/** Their speakeasies running dry, driest first. */
export function drySpeakeasies(state: GameState, family: FamilyName): { territory: Territory; stock: number }[] {
  return turfOf(state, family)
    .flatMap((t) =>
      t.rackets
        .filter((r) => r.type === "speakeasy")
        .map((r) => ({ territory: t, stock: r.stock })),
    )
    .filter((x) => x.stock < 3)
    .sort((a, b) => a.stock - b.stock);
}

/** What a district clears in a week, rackets included. */
export function districtTake(t: Territory): number {
  return t.baseIncome + t.rackets.reduce((n, r) => n + racketIncome(r), 0);
}

/** Districts of `family` with something running in them, richest first. Only ones the player has seen. */
export function cutDistricts(state: GameState, family: FamilyName): Territory[] {
  const player = state.playerFamily;
  return turfOf(state, family)
    .filter((t) => t.rackets.length > 0 && (family === player || t.discovered))
    .sort((a, b) => districtTake(b) - districtTake(a));
}

/** A cut of a district's take already sold or bought on this block. */
export function cutOn(state: GameState, territoryId: string): boolean {
  return activeDeals(state).some((d) => d.kind === "cut" && d.terms.territoryId === territoryId);
}

export function playerWarehouseStock(state: GameState): number {
  const player = state.playerFamily;
  if (!player) return 0;
  return turfOf(state, player).reduce(
    (n, t) => n + t.rackets.reduce((m, r) => m + (r.type === "warehouse" ? r.stock : 0), 0),
    0,
  );
}

/** Can the player put this agenda to this family right now? */
export function agendaAvailable(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
): { ok: boolean; reason?: string } {
  const player = state.playerFamily;
  if (!player) return { ok: false, reason: "No family." };
  switch (agenda) {
    case "truce":
      if (hasPact(state, player, family)) return { ok: false, reason: "You already have a pact." };
      if (inTruce(state, player, family)) return { ok: false, reason: "A truce already holds." };
      return { ok: true };
    case "territory":
      if (buyableDistricts(state, family).length === 0) {
        return { ok: false, reason: "They hold nothing but the house." };
      }
      return { ok: true };
    case "release":
      if (heldBy(state, family, player).length === 0) {
        return { ok: false, reason: "They're holding none of your men." };
      }
      return { ok: true };
    case "vendetta":
      if (!state.vendettas.includes(family)) return { ok: false, reason: "There's no vendetta to end." };
      return { ok: true };
    case "alliance":
      if (activeDeals(state).some((d) => d.kind === "alliance" && d.obligor === family)) {
        return { ok: false, reason: "They already owe you a job." };
      }
      if (contractTargets(state, family).length === 0) {
        return { ok: false, reason: "There's no one they could move against for you." };
      }
      return { ok: true };
    case "racket":
      if (cutDistricts(state, family).filter((t) => !cutOn(state, t.id)).length === 0) {
        return { ok: false, reason: "You've seen nothing of theirs worth a cut." };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

function round50(n: number): number {
  return Math.max(0, Math.round(n / 50) * 50);
}

/** What a district is worth at the table: eight weeks of income plus what was built on it. */
export function districtPrice(state: GameState, t: Territory): number {
  const weekly = t.baseIncome + t.rackets.reduce((n, r) => n + racketIncome(r), 0);
  const built = t.rackets.reduce((n, r) => n + (RACKET_BUILD_COST[r.type] ?? 300) * r.level, 0);
  let price = weekly * 8 + built;
  const player = state.playerFamily;
  if (player && t.owner && t.owner !== player) {
    // A border block costs more; so does anything in the borough their house sits in.
    const mine = new Set(turfOf(state, player).map((x) => x.id));
    if (t.adjacentTerritories.some((id) => mine.has(id))) price *= 1.4;
    const hqId = familyHq(state, t.owner);
    const hq = state.territories.find((x) => x.id === hqId);
    if (hq && hq.borough === t.borough) price *= 1.3;
  }
  return round50(Math.max(400, price));
}

const RANSOM_BY_ROLE: Record<string, number> = {
  underboss: 700,
  consigliere: 700,
  capo: 400,
  hitman: 400,
  soldier: 150,
  associate: 50,
};

/** What a man is worth to the family holding him. */
export function ransomFor(c: CrewMember): number {
  return round50(300 + c.level * 150 + (RANSOM_BY_ROLE[c.role] ?? 150));
}

/** Cash the family wants to keep its guns down. Zero when it's the one bleeding. */
export function trucePrice(state: GameState, family: FamilyName): number {
  const player = state.playerFamily!;
  const theirs = turfOf(state, family).length;
  const ours = turfOf(state, player).length;
  const base = 300 + 100 * (theirs - ours) - 200 * bleeding(state, family);
  const status = statusFromScore(getRelation(state.relations, player, family));
  const grudge = status === "war" ? 400 : status === "hostile" ? 200 : 0;
  return round50(Math.max(0, base + grudge));
}

/** What a share of a district's take for N weeks costs. Signed from the player's side. */
export function cutPrice(state: GameState, t: Territory, share: number, weeks: number): number {
  const stream = districtTake(t) * share * weeks;
  return t.owner === state.playerFamily
    ? -round50(stream * CUT_BUY_DISCOUNT)
    : round50(Math.max(100, stream * CUT_SELL_PREMIUM));
}

/** What a contract on `target` costs, from whichever side is paying. */
export function contractPrice(state: GameState, target: FamilyName | undefined): number {
  const targetTurf = target ? turfOf(state, target).length : 3;
  return round50(800 + 120 * targetTurf);
}

export function vendettaPrice(state: GameState, family: FamilyName): { cash: number; standing: number } {
  const player = state.playerFamily!;
  const ours = turfOf(state, player).length;
  const hurt = state.operations.filter(
    (o) => o.kind === "hit" && o.family === family && o.targetFamily === player && o.resolved,
  ).length;
  return {
    cash: round50(600 + 150 * ours + Math.max(0, 3 - hurt) * 100),
    standing: 20,
  };
}

/**
 * The rival's opening number for an agenda. `seed` carries the things a
 * number is about (which district, which man, which speakeasy).
 */
export function openingTerms(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  seed: Partial<AgendaTerms> = {},
): AgendaTerms {
  const player = state.playerFamily!;
  const base: AgendaTerms = { cash: 0, standing: 0, ...seed };
  switch (agenda) {
    case "truce":
      return { ...base, weeks: seed.weeks ?? TRUCE_DEFAULT_WEEKS, cash: trucePrice(state, family) };
    case "territory": {
      const t = state.territories.find((x) => x.id === seed.territoryId);
      if (!t) return base;
      // Selling to the player, or buying from him (they pay less than it's worth).
      return { ...base, cash: t.owner === player ? -round50(districtPrice(state, t) * 0.8) : districtPrice(state, t) };
    }
    case "release": {
      const c = state.crew.find((x) => x.id === seed.crewId);
      if (!c) return base;
      return { ...base, cash: c.family === player ? ransomFor(c) : -round50(ransomFor(c) * 0.8) };
    }
    case "vendetta": {
      const p = vendettaPrice(state, family);
      return { ...base, cash: p.cash, standing: p.standing };
    }
    case "alliance": {
      // Whoever does the job gets paid. The rival asking for a hit pays the player;
      // the player asking the rival to move pays them, and pays more.
      const obligor = seed.obligor ?? player;
      const price = contractPrice(state, seed.targetFamily);
      return {
        ...base,
        obligor,
        weeks: seed.weeks ?? ALLIANCE_WEEKS,
        cash: obligor === player ? -price : round50(price * 1.25),
      };
    }
    case "racket": {
      const t = state.territories.find((x) => x.id === seed.territoryId);
      if (!t) return base;
      const share = seed.share ?? CUT_DEFAULT_SHARE;
      const weeks = seed.weeks ?? CUT_DEFAULT_WEEKS;
      return { ...base, share, weeks, cash: cutPrice(state, t, share, weeks) };
    }
    case "liquor": {
      const crates = seed.crates ?? 10;
      return {
        ...base,
        crates,
        weeks: seed.weeks ?? LIQUOR_WEEKS,
        cash: -Math.round(crates * CRATE_STREET_VALUE * LIQUOR_PREMIUM),
      };
    }
    default:
      return base;
  }
}

/** A reasonable first number for the player to walk in with. */
export function playerOpening(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  seed: Partial<AgendaTerms> = {},
): AgendaTerms {
  const ask = openingTerms(state, family, agenda, seed);
  return {
    ...ask,
    cash: ask.cash > 0 ? round50(ask.cash * 0.6) : ask.cash < 0 ? -round50(-ask.cash * 1.4) : 0,
    standing: agenda === "vendetta" ? 10 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Judging a counter                                                   */
/* ------------------------------------------------------------------ */

/** Does the family want the truce for its own sake? Bleeding families do. */
function wantsTruce(state: GameState, family: FamilyName): boolean {
  return bleeding(state, family) >= 2 || state.vendettas.includes(state.playerFamily!);
}

/**
 * What a set of terms is worth to the rival, in dollars. Cash counts
 * straight; a district thrown in counts at its price; truce weeks count for
 * or against depending on who's winning the war.
 */
export function termsValueTo(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  terms: AgendaTerms,
): number {
  let value = terms.cash;
  if (terms.territoryId && agenda !== "territory") {
    const t = state.territories.find((x) => x.id === terms.territoryId);
    if (t && t.owner === state.playerFamily) value += districtPrice(state, t);
  }
  if (agenda === "truce" && terms.weeks) {
    value += (wantsTruce(state, family) ? 40 : -30) * terms.weeks;
  }
  if (agenda === "alliance" && terms.weeks) {
    // A shorter deadline is worth more to whoever is buying the hit,
    // and costs whoever has to make it.
    const theyDoIt = terms.obligor === family;
    value += (ALLIANCE_WEEKS - terms.weeks) * 60 * (theyDoIt ? -1 : 1);
  }
  if (agenda === "liquor" && terms.crates) {
    value += terms.crates * CRATE_STREET_VALUE * 1.2;
  }
  if (agenda === "racket" && terms.territoryId) {
    const t = state.territories.find((x) => x.id === terms.territoryId);
    if (t) {
      const stream = districtTake(t) * (terms.share ?? CUT_DEFAULT_SHARE) * (terms.weeks ?? CUT_DEFAULT_WEEKS);
      // Selling the stream costs them the premium they'd want; buying it earns them the discount price.
      value += t.owner === state.playerFamily ? stream * CUT_BUY_DISCOUNT : -stream * CUT_SELL_PREMIUM;
    }
  }
  return value;
}

const STATUS_MOD: Record<string, number> = {
  war: -0.35,
  hostile: -0.15,
  cold: -0.05,
  neutral: 0,
  truce: 0.08,
  allied: 0.2,
};

/** The scale a gap in the numbers is judged against: the ask itself, or the cash on it. */
function askScale(askValue: number, ask?: AgendaTerms): number {
  return Math.max(600, Math.abs(askValue), Math.abs(ask?.cash ?? 0));
}

/** Chance the family takes the player's counter instead of holding to their ask. */
export function counterChance(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  ask: AgendaTerms,
  offer: AgendaTerms,
  opts: { consigliere?: boolean } = {},
): number {
  const player = state.playerFamily;
  if (!player) return 0;
  const askV = termsValueTo(state, family, agenda, ask);
  const offerV = termsValueTo(state, family, agenda, offer);
  const status = statusFromScore(getRelation(state.relations, player, family));
  const def = getFamilyDef(family);
  let chance = 0.55 + (offerV - askV) / askScale(askV, ask);
  chance += STATUS_MOD[status] ?? 0;
  chance += state.reputation.respect / 300;
  chance += Math.min(MAX_STANDING_CHIP, Math.max(0, offer.standing - ask.standing)) * STANDING_CHIP_RATE;
  if (offer.favor && !ask.favor) chance += FAVOR_CHIP;
  if (opts.consigliere) chance += 0.05;
  if (def.personality === "economic") chance += 0.05;
  if (def.personality === "volatile") chance -= 0.1;
  if (agenda === "truce" && wantsTruce(state, family)) chance += 0.15;
  return Math.max(0.03, Math.min(0.95, chance));
}

/** A number so low it costs the player just to say it. */
export function isInsult(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  ask: AgendaTerms,
  offer: AgendaTerms,
): boolean {
  const askV = termsValueTo(state, family, agenda, ask);
  const offerV = termsValueTo(state, family, agenda, offer);
  const chips = offer.standing * 15 + (offer.favor ? 300 : 0);
  return offerV + chips < askV - (1 - INSULT_FLOOR) * askScale(askV, ask);
}

/** The family moves part of the way toward the player's number. */
export function blendAgenda(ask: AgendaTerms, offer: AgendaTerms, k: number): AgendaTerms {
  const mix = (a: number, b: number) => a + (b - a) * k;
  // Small numbers move in tens so "a little" is visible; big ones in fifties.
  const unit = Math.abs(ask.cash) >= 500 ? 50 : 10;
  let cash = Math.round(mix(ask.cash, offer.cash) / unit) * unit;
  if (cash === ask.cash && offer.cash !== ask.cash) cash += offer.cash > ask.cash ? unit : -unit;
  return {
    ...ask,
    cash,
    standing: Math.round(mix(ask.standing, offer.standing)),
    weeks:
      ask.weeks !== undefined && offer.weeks !== undefined
        ? Math.round(mix(ask.weeks, offer.weeks))
        : ask.weeks,
    crates:
      ask.crates !== undefined && offer.crates !== undefined
        ? Math.round(mix(ask.crates, offer.crates))
        : ask.crates,
    share:
      ask.share !== undefined && offer.share !== undefined
        ? Math.round(mix(ask.share, offer.share) * 20) / 20
        : ask.share,
  };
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

function districtName(state: Pick<GameState, "territories">, id: string | undefined): string {
  return state.territories.find((t) => t.id === id)?.name ?? "a district";
}

function manName(state: Pick<GameState, "crew">, id: string | undefined): string {
  return state.crew.find((c) => c.id === id)?.name ?? "a man";
}

export function agendaTermsText(
  state: Pick<GameState, "territories" | "crew"> & Partial<Pick<GameState, "playerFamily">>,
  agenda: SitdownAgenda,
  terms: AgendaTerms,
): string {
  const bits: string[] = [];
  const pay = terms.cash > 0 ? `you pay $${terms.cash}` : terms.cash < 0 ? `they pay $${-terms.cash}` : "no cash";
  switch (agenda) {
    case "truce":
      bits.push(`${terms.weeks ?? TRUCE_DEFAULT_WEEKS} weeks, guns down both ways`);
      if (terms.cash !== 0) bits.push(pay);
      break;
    case "territory":
      bits.push(`${districtName(state, terms.territoryId)} changes hands`);
      bits.push(pay);
      break;
    case "release":
      bits.push(`${manName(state, terms.crewId)} goes home`);
      bits.push(pay);
      break;
    case "vendetta":
      bits.push("the vendetta ends");
      bits.push(pay);
      break;
    case "alliance": {
      const theyDoIt = !!terms.obligor && terms.obligor !== state.playerFamily;
      bits.push(`${theyDoIt ? "they" : "you"} hit ${terms.targetFamily ?? "a family"} within ${terms.weeks ?? ALLIANCE_WEEKS} weeks`);
      bits.push(terms.calledIn ? "for the favor owed" : `${pay} when it's done`);
      break;
    }
    case "liquor":
      bits.push(`${terms.crates ?? 0} crates to ${districtName(state, terms.destTerritoryId)} within ${terms.weeks ?? LIQUOR_WEEKS} weeks`);
      bits.push(terms.calledIn ? "for the favor owed" : pay);
      break;
    case "racket":
      bits.push(
        `${Math.round((terms.share ?? CUT_DEFAULT_SHARE) * 100)}% of ${districtName(state, terms.territoryId)}'s take for ${terms.weeks ?? CUT_DEFAULT_WEEKS} weeks`,
      );
      bits.push(`${pay} up front`);
      break;
    default:
      bits.push(pay);
  }
  if (terms.standing > 0) bits.push(`${terms.standing} standing`);
  if (terms.territoryId && agenda !== "territory" && agenda !== "racket") {
    bits.push(`${districtName(state, terms.territoryId)} thrown in`);
  }
  if (terms.favor) bits.push("you owe them one");
  return bits.join(", ");
}

/** What the consigliere reads across the table. */
export function agendaTell(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  terms?: AgendaTerms,
): string | undefined {
  if (!hasConsigliere(state)) return undefined;
  const def = getFamilyDef(family);
  if (agenda === "alliance" && terms?.obligor === family) {
    return def.personality === "volatile" ? "They'd do it for the sport. Don't pay them a fortune." : "Blood for money sits badly with them. Give them time on the deadline.";
  }
  if (agenda === "truce" && wantsTruce(state, family)) return "They need this more than they let on. Hold your number.";
  if (agenda === "truce") return "They're not hurting. A truce is a favor to you, and they'll price it that way.";
  if (agenda === "territory") return def.personality === "economic" ? "They'll sell anything but the house if the number is right." : "They hate parting with ground. Expect a stiff price.";
  if (agenda === "release") return "They'd rather have the cash than the man. Don't overpay.";
  if (agenda === "vendetta") return def.personality === "volatile" ? "Pride is the price here. Standing matters more than cash." : "They want to be seen winning. Give them the standing.";
  if (agenda === "alliance") return "They want the job done quietly. Ask more; they'll pay.";
  if (agenda === "liquor") return "Their shelves are bare. Every week you wait, the price goes up.";
  if (agenda === "racket") return def.personality === "economic" ? "Cash today beats cash next month to them. A long stretch buys you a better rate." : "They don't like strangers counting their money. Keep the share small.";
  return def.personality === "volatile" ? "Short fuse. Don't lowball twice." : undefined;
}

/** One word on their mood, for players without a consigliere. */
export function moodWord(chance: number): string {
  if (chance >= 0.7) return "Agreeable";
  if (chance >= 0.45) return "Listening";
  if (chance >= 0.25) return "Hard";
  return "Cold";
}

/* ------------------------------------------------------------------ */
/* The rival's ask                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a rival wants when it calls the player to the table. Priority:
 * a truce when it's bleeding; crates when a speakeasy runs dry and the
 * player is stocked; a man of theirs back; a border block when rich and
 * the player is weak; a contract when someone else is pressing sudden death.
 */
export function pickRivalAgenda(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { agenda: SitdownAgenda; terms: AgendaTerms } | null {
  const player = state.playerFamily;
  if (!player) return null;

  if (bleeding(state, family) >= 2 && !atPeace(state, player, family)) {
    return { agenda: "truce", terms: openingTerms(state, family, "truce") };
  }

  const dry = drySpeakeasies(state, family)[0];
  if (dry && playerWarehouseStock(state) >= 15) {
    const crates = 10;
    return {
      agenda: "liquor",
      terms: openingTerms(state, family, "liquor", { crates, destTerritoryId: dry.territory.id }),
    };
  }

  const held = heldBy(state, player, family)[0];
  if (held) {
    return { agenda: "release", terms: openingTerms(state, family, "release", { crewId: held.id }) };
  }

  const treasury = state.rivalTreasury?.[family] ?? 0;
  const border = sellableDistricts(state).find((t) => {
    const theirs = new Set(turfOf(state, family).map((x) => x.id));
    return t.adjacentTerritories.some((id) => theirs.has(id));
  });
  if (border && treasury >= districtPrice(state, border) && turfOf(state, player).length <= turfOf(state, family).length - 2) {
    return { agenda: "territory", terms: openingTerms(state, family, "territory", { territoryId: border.id }) };
  }

  const pressing = familiesPressingSuddenDeath(state).filter((f) => f !== family && f !== player);
  const target = pressing.find(
    (f) => !atPeace(state, player, f) && !hasPact(state, family, f) && getRelation(state.relations, family, f) < 0,
  );
  if (target && rng.chance(0.7)) {
    return {
      agenda: "alliance",
      terms: openingTerms(state, family, "alliance", { targetFamily: target, obligor: player }),
    };
  }

  // Flush and looking for a return: a cut of the player's best block.
  const block = cutDistricts(state, player).find((t) => !cutOn(state, t.id) && districtTake(t) >= 150);
  if (block) {
    const terms = openingTerms(state, family, "racket", { territoryId: block.id });
    if (treasury >= -terms.cash * 2 && rng.chance(0.5)) {
      return { agenda: "racket", terms };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Striking                                                            */
/* ------------------------------------------------------------------ */

/** A district changes hands. The old garrison walks; managers lose their posts. */
export function transferDistrict(state: GameState, territoryId: string, to: FamilyName): GameState {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t) return state;
  const leaving = new Set(t.garrisonIds);
  const crew = state.crew.map((c) => {
    if (leaving.has(c.id) || (c.assignment.type === "racket" && c.assignment.territoryId === territoryId && c.family !== to)) {
      return { ...c, assignment: { type: "idle" as const } };
    }
    return c;
  });
  const territories = state.territories.map((x) =>
    x.id === territoryId
      ? {
          ...x,
          owner: to,
          garrisonIds: [],
          leadershipVacuum: 0,
          discovered: to === state.playerFamily ? true : x.discovered,
          rackets: x.rackets.map((r) => {
            const m = state.crew.find((c) => c.id === r.managerId);
            return m && m.family !== to ? { ...r, managerId: null } : r;
          }),
        }
      : x,
  );
  return { ...state, crew, territories };
}

function payCash(state: GameState, family: FamilyName, cash: number): GameState {
  if (cash === 0) return state;
  if (cash > 0) {
    const dirty = Math.min(state.dirtyMoney, cash);
    return {
      ...state,
      dirtyMoney: state.dirtyMoney - dirty,
      money: state.money - (cash - dirty),
      rivalTreasury: { ...state.rivalTreasury, [family]: (state.rivalTreasury?.[family] ?? 0) + cash },
    };
  }
  const paid = -cash;
  return {
    ...state,
    money: state.money + paid,
    rivalTreasury: { ...state.rivalTreasury, [family]: (state.rivalTreasury?.[family] ?? 0) - paid },
  };
}

/** Can the player cover his side of these terms right now? */
export function canAfford(state: GameState, terms: AgendaTerms): { ok: boolean; reason?: string } {
  if (terms.cash > 0 && state.money + state.dirtyMoney < terms.cash) {
    return { ok: false, reason: `You can't cover $${terms.cash}.` };
  }
  if (terms.standing > 0 && state.influence < terms.standing) {
    return { ok: false, reason: `You don't have ${terms.standing} standing to spend.` };
  }
  return { ok: true };
}

/**
 * The struck terms take effect. Cash moves now; a truce, a job owed or a
 * favor becomes a Deal. Lines describe what changed, for the result card.
 */
export function applyAgendaTerms(
  state: GameState,
  family: FamilyName,
  agenda: SitdownAgenda,
  terms: AgendaTerms,
  rng: Rng,
): { state: GameState; lines: string[] } {
  const player = state.playerFamily!;
  const lines: string[] = [];
  let next = state;

  // Cash on immediate agendas moves now. Jobs owed pay out when done.
  const payLater = agenda === "alliance" || agenda === "liquor";
  if (!payLater) next = payCash(next, family, terms.cash);
  if (agenda === "racket" && terms.cash !== 0) {
    lines.push(terms.cash > 0 ? `$${terms.cash} changes hands, up front.` : `They put $${-terms.cash} on the table, up front.`);
  }

  if (terms.standing > 0) {
    next = {
      ...next,
      influence: Math.max(0, next.influence - terms.standing),
      rivalInfluence: {
        ...next.rivalInfluence,
        [family]: (next.rivalInfluence?.[family] ?? 0) + Math.round(terms.standing / 2),
      },
    };
    lines.push(`You give up ${terms.standing} standing to seal it.`);
  }

  if (terms.territoryId && agenda !== "territory" && agenda !== "racket") {
    next = transferDistrict(next, terms.territoryId, family);
    lines.push(`${districtName(state, terms.territoryId)} is theirs now — the sweetener.`);
  }

  if (terms.favor) {
    next = makeDeal(next, "favor", family, { cash: 0, standing: 0, favor: true }, { obligor: player, weeks: null, rng }).state;
    lines.push(`You owe ${family} one. They'll remember.`);
  }

  switch (agenda) {
    case "truce": {
      const weeks = terms.weeks ?? TRUCE_DEFAULT_WEEKS;
      next = makeDeal(next, "truce", family, { ...terms, weeks }, { weeks, rng }).state;
      next = { ...next, relations: setRelationDelta(next.relations, player, family, 5) };
      lines.push(`Guns down with ${family} for ${weeks} weeks, both ways.`);
      break;
    }
    case "territory": {
      const t = state.territories.find((x) => x.id === terms.territoryId);
      if (t) {
        const to = t.owner === player ? family : player;
        next = transferDistrict(next, t.id, to);
        lines.push(
          to === player
            ? `${t.name} is yours. Their men have cleared out.`
            : `${t.name} goes to ${family}. Your men come home.`,
        );
      }
      break;
    }
    case "release": {
      const c = state.crew.find((x) => x.id === terms.crewId);
      if (c) {
        next = {
          ...next,
          crew: next.crew.map((x) =>
            x.id === c.id
              ? { ...x, status: "active" as const, heldBy: undefined, heldUntilTurn: undefined, assignment: { type: "idle" as const } }
              : x,
          ),
        };
        lines.push(c.family === player ? `${c.name} walks out with you.` : `${c.name} goes back to ${family}.`);
      }
      break;
    }
    case "vendetta": {
      const score = getRelation(next.relations, player, family);
      const lift = Math.max(0, -25 - score);
      next = {
        ...next,
        vendettas: next.vendettas.filter((f) => f !== family),
        relations: setRelationDelta(next.relations, player, family, lift),
      };
      lines.push(`${family} calls off the vendetta. Things are merely cold now.`);
      break;
    }
    case "alliance": {
      const weeks = terms.weeks ?? ALLIANCE_WEEKS;
      const obligor = terms.obligor ?? player;
      next = makeDeal(next, "alliance", family, { ...terms, weeks, obligor }, { obligor, weeks, rng }).state;
      lines.push(
        obligor === player
          ? `Put ${terms.targetFamily} in the ground within ${weeks} weeks and ${family} pays $${-terms.cash}.`
          : `${family} moves on ${terms.targetFamily} within ${weeks} weeks. You pay $${terms.cash} when a body drops.`,
      );
      break;
    }
    case "racket": {
      const t = state.territories.find((x) => x.id === terms.territoryId);
      if (t) {
        const weeks = terms.weeks ?? CUT_DEFAULT_WEEKS;
        const share = terms.share ?? CUT_DEFAULT_SHARE;
        // Whoever owns the block pays the cut out of its take each week.
        const payer = t.owner === player ? player : family;
        next = makeDeal(next, "cut", family, { ...terms, weeks, share }, { obligor: payer, weeks, rng }).state;
        const pct = Math.round(share * 100);
        lines.push(
          payer === player
            ? `${family} takes ${pct}% of ${t.name}'s take for ${weeks} weeks.`
            : `${pct}% of ${t.name}'s take comes to you every week for ${weeks} weeks.`,
        );
      }
      break;
    }
    case "liquor": {
      const weeks = terms.weeks ?? LIQUOR_WEEKS;
      next = makeDeal(next, "liquor", family, { ...terms, weeks }, { obligor: player, weeks, rng }).state;
      lines.push(`${terms.crates} crates to ${districtName(state, terms.destTerritoryId)} within ${weeks} weeks, $${-terms.cash} on delivery.`);
      break;
    }
    default:
      break;
  }

  return { state: next, lines };
}

/** Other families that could be a contract's mark: no one either side has given their word to. */
export function contractTargets(state: GameState, family: FamilyName): FamilyName[] {
  const player = state.playerFamily;
  if (!player) return [];
  return ALL_FAMILY_NAMES.filter(
    (f) => f !== player && f !== family && !atPeace(state, player, f) && !atPeace(state, family, f),
  );
}
