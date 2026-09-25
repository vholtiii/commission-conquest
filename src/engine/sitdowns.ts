/**
 * Sit-downs both bosses must attend in person.
 *
 * Proposing one schedules it for the next turn. The venue decides who travels:
 *  - "ours"    held at the player's boss's current site (he stays put)
 *  - "theirs"  held at the rival boss's current site (they stay put)
 *  - "neutral" held somewhere neither family owns (both travel)
 * Travel is what springs a car bomb: the package on a boss's car goes off the
 * first turn he changes sites, and a sit-down is a guaranteed change of site
 * for whoever isn't hosting.
 *
 * Pure except for the state-returning functions.
 */
import type {
  AgendaTerms,
  FamilyName,
  GameState,
  Operation,
  PassageTerms,
  Sitdown,
  SitdownAgenda,
  SitdownCinematic,
  SitdownFollow,
  SitdownResult,
  SitdownVenue,
  TurnLogEntry,
} from "@/types/game";
import {
  INSULT_RELATION,
  INSULT_WALK_CHANCE,
  TABLE_ROUNDS,
  agendaAvailable,
  agendaTermsText,
  applyAgendaTerms,
  blendAgenda,
  canAfford,
  counterChance,
  cutOn,
  isInsult,
  openingTerms,
  pickRivalAgenda,
} from "./agendas";
import { atPeace } from "./deals";
import type { Rng } from "./rng";
import { getFamilyDef } from "@/data/families";
import { getActiveCrew, getBoss } from "./crew";
import { resolveCrewLocation, resolveCrewTerritoryId } from "./crewLocation";
import {
  SITDOWN_COOLDOWN,
  SITDOWN_INFLUENCE,
  SITDOWN_MONEY,
  canDiplomacy,
  hasConsigliere,
  sitdownOdds,
  withCooldown,
} from "./diplomacy";
import { getRelation, setRelationDelta, statusFromScore } from "./relations";
import { bossIsJailed } from "./jail";
import {
  blendTerms,
  counterAcceptance,
  openingAsk,
  passageGrudges,
  strikeDeal,
  termsText,
} from "./passage";

/** Tables with terms on them, beyond the passage flow. */
export function isAgendaTable(purpose: SitdownAgenda | undefined): boolean {
  return !!purpose && purpose !== "general" && purpose !== "passage";
}

/** What the player brings to the table when he asks for a meeting about something. */
export interface AgendaPick {
  agenda: SitdownAgenda;
  /** Which district / man / family the talk is about. */
  seed?: Partial<AgendaTerms>;
  /** The number he walks in with; absent = let them open. */
  opening?: AgendaTerms;
}

/* ------------------------------------------------------------------ */
/* Venues                                                              */
/* ------------------------------------------------------------------ */

/** Where a family's boss stands right now. */
function bossSite(state: GameState, family: FamilyName): string | null {
  const boss = getBoss(state.crew, family);
  return boss ? resolveCrewTerritoryId(state, boss.id) : null;
}

export const HOST_FEE = 75;
/** Weeks between agreeing to a table and sitting at it. Leaves one to case the block. */
export const SITDOWN_LAG = 2;

function hostBanKey(host: FamilyName, guest: FamilyName): string {
  return `${host}|${guest}`;
}

/** A host who was burned won't let this family through the door yet. */
export function hostRefuses(state: GameState, host: FamilyName, guest: FamilyName): boolean {
  return (state.diplomacy?.hostBans?.[hostBanKey(host, guest)] ?? 0) > state.turn;
}

/** A block neither family owns, nearest to both bosses' current sites. */
function neutralVenue(
  state: GameState,
  player: FamilyName,
  other: FamilyName,
): string | null {
  const a = bossSite(state, player);
  const b = bossSite(state, other);
  const pa = state.territories.find((t) => t.id === a);
  const pb = state.territories.find((t) => t.id === b);
  const candidates = state.territories.filter(
    (t) =>
      t.owner !== player &&
      t.owner !== other &&
      !(t.owner && (hostRefuses(state, t.owner, player) || hostRefuses(state, t.owner, other))),
  );
  if (candidates.length === 0) return null;
  const dist = (t: (typeof candidates)[number]) =>
    (pa ? Math.hypot(t.x - pa.x, t.y - pa.y) : 0) +
    (pb ? Math.hypot(t.x - pb.x, t.y - pb.y) : 0);
  return candidates.sort((p, q) => dist(p) - dist(q))[0]!.id;
}

/** The district a venue choice resolves to, or null if it can't be held there. */
export function resolveVenue(
  state: GameState,
  other: FamilyName,
  venue: SitdownVenue,
): string | null {
  const player = state.playerFamily;
  if (!player) return null;
  if (venue === "ours") return bossSite(state, player);
  if (venue === "theirs") return bossSite(state, other);
  return neutralVenue(state, player, other);
}

export function venueLabel(venue: SitdownVenue): string {
  if (venue === "ours") return "your turf";
  if (venue === "theirs") return "their turf";
  return "neutral ground";
}

/** Who has to leave his current site to reach the venue. */
export function venueTravel(
  state: GameState,
  other: FamilyName,
  venue: SitdownVenue,
): { playerTravels: boolean; rivalTravels: boolean } {
  const territoryId = resolveVenue(state, other, venue);
  const player = state.playerFamily;
  return {
    playerTravels: !!player && territoryId !== null && territoryId !== bossSite(state, player),
    rivalTravels: territoryId !== null && territoryId !== bossSite(state, other),
  };
}

/* ------------------------------------------------------------------ */
/* Negotiation                                                         */
/* ------------------------------------------------------------------ */

/** A live car bomb on the player boss's car is a reason to get him moving. */
export function hasArmedBombOnPlayerBoss(state: GameState, family: FamilyName): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  const boss = getBoss(state.crew, player);
  if (!boss) return false;
  return state.operations.some(
    (o) =>
      !o.resolved &&
      o.kind === "hit" &&
      o.approach === "car_bomb" &&
      o.family === family &&
      o.targetCrewId === boss.id,
  );
}

const STATUS_MOD = { war: -1, hostile: -0.25, cold: -0.1, neutral: 0, truce: 0.15, allied: 0.3 };

/**
 * Chance the rival agrees to meet on the player's terms. `theirs` is always
 * taken. A rival sitting on a live package refuses `ours` outright.
 */
export function venueAcceptance(
  state: GameState,
  other: FamilyName,
  venue: SitdownVenue,
  entourage = 0,
): number {
  const player = state.playerFamily;
  if (!player) return 0;
  const score = getRelation(state.relations, player, other);
  const status = statusFromScore(score);
  if (venue === "theirs") return 1;
  if (status === "war") return venue === "neutral" ? 0.5 : 0;
  if (hasArmedBombOnPlayerBoss(state, other) && venue === "ours") return 0;
  const heavy = Math.pow(0.85, Math.max(0, entourage - 1));

  if (venue === "ours") {
    let chance = 0.35 + state.reputation.respect / 200 + STATUS_MOD[status];
    if (getFamilyDef(other).personality === "covert") chance -= 0.1;
    return Math.max(0.05, Math.min(0.9, chance * heavy));
  }
  // neutral
  return Math.max(0.3, Math.min(0.95, (0.8 + STATUS_MOD[status] / 2) * heavy));
}

export interface SitdownParty {
  entourageIds?: string[];
  bringConsigliere?: boolean;
}

function partyFields(state: GameState, party?: SitdownParty): Pick<Sitdown, "playerEntourageIds" | "bringConsigliere"> {
  const player = state.playerFamily;
  const ids = (party?.entourageIds ?? [])
    .filter((id, i, all) => all.indexOf(id) === i)
    .filter((id) => {
      const c = state.crew.find((m) => m.id === id);
      return !!c && c.family === player && c.status === "active" && c.role !== "boss" && c.role !== "consigliere";
    })
    .slice(0, 2);
  const consigliere = state.crew.find(
    (c) => c.family === player && c.role === "consigliere" && c.status === "active",
  );
  return {
    playerEntourageIds: ids,
    bringConsigliere: !!party?.bringConsigliere && !!consigliere,
  };
}

/** Third-family owner of a neutral venue, if there is one. */
export function hostOf(
  state: GameState,
  other: FamilyName,
  venue: SitdownVenue,
): FamilyName | null {
  if (venue !== "neutral" || !state.playerFamily) return null;
  const id = resolveVenue(state, other, venue);
  const owner = state.territories.find((t) => t.id === id)?.owner ?? null;
  if (!owner || owner === state.playerFamily || owner === other) return null;
  return owner;
}

function counterFor(venue: SitdownVenue, rng: Rng): SitdownVenue {
  if (venue === "neutral") return rng.chance(0.5) ? "ours" : "theirs";
  return rng.chance(0.7) ? "neutral" : "theirs";
}

function districtName(state: GameState, id: string): string {
  return state.territories.find((t) => t.id === id)?.name ?? "a back room";
}

export interface SitdownProposal {
  state: GameState;
  sitdown: Sitdown | null;
  log: TurnLogEntry;
  /** The rival pushed back with a different venue. */
  countered: boolean;
}

/**
 * The player asks for a sit-down at `venue`. Cost and cooldown are paid now;
 * the meeting itself happens next turn. A refused venue becomes a counter-offer
 * the player can take or walk away from.
 */
export function proposeSitdown(
  state: GameState,
  other: FamilyName,
  venue: SitdownVenue,
  rng: Rng,
  party?: SitdownParty,
  pick?: AgendaPick,
): SitdownProposal {
  const player = state.playerFamily;
  const fail = (text: string): SitdownProposal => ({
    state,
    sitdown: null,
    countered: false,
    log: {
      id: `log_sitdown_no_${other}_${state.turn}`,
      turn: state.turn,
      category: "diplomacy",
      text,
      family: player ?? undefined,
    },
  });
  if (!player) return fail("No family at the table.");

  const check = canDiplomacy(state, "sitdown", other);
  if (!check.ok) return fail(check.reason ?? "They won't meet.");
  if (!getBoss(state.crew, player) || !getBoss(state.crew, other)) {
    return fail(`${other} has nobody who can speak for them.`);
  }
  if (bossIsJailed(state, other)) {
    return fail(`${other}'s boss is in the Tombs.`);
  }
  const agenda: SitdownAgenda = pick?.agenda ?? "general";
  if (isAgendaTable(agenda)) {
    const can = agendaAvailable(state, other, agenda);
    if (!can.ok) return fail(can.reason ?? "Nothing to talk about.");
  }

  const territoryId = resolveVenue(state, other, venue);
  if (!territoryId) return fail("Nowhere to hold it.");

  const brought = partyFields(state, party);
  const accepted = rng.chance(
    venueAcceptance(state, other, venue, brought.playerEntourageIds?.length ?? 0),
  );
  const id = `sitdown_${player}_${other}_${state.turn}_${rng.int(100, 999)}`;

  let next: GameState = {
    ...state,
    money: state.money - SITDOWN_MONEY,
    influence: Math.max(0, state.influence - SITDOWN_INFLUENCE),
  };

  const sitdown: Sitdown = {
    id,
    proposedTurn: state.turn,
    heldTurn: state.turn + SITDOWN_LAG,
    proposer: player,
    other,
    venue: accepted ? venue : counterFor(venue, rng),
    venueTerritoryId: territoryId,
    status: accepted ? "scheduled" : "proposed",
    counterVenue: accepted ? undefined : undefined,
    ...brought,
    hostFamily: hostOf(state, other, venue) ?? undefined,
    purpose: agenda,
    table: isAgendaTable(agenda)
      ? {
          // Priced again when the bosses actually sit; this holds the subject.
          ask: openingTerms(state, other, agenda, pick?.seed),
          rounds: 0,
          opener: pick?.opening ? player : other,
          playerOpening: pick?.opening,
        }
      : undefined,
  };
  if (!accepted) {
    sitdown.counterVenue = sitdown.venue;
    sitdown.venue = venue;
    const counterId = resolveVenue(state, other, sitdown.counterVenue);
    if (counterId) sitdown.venueTerritoryId = counterId;
    sitdown.hostFamily = hostOf(state, other, sitdown.counterVenue) ?? undefined;
  }

  next = { ...next, sitdowns: [...(next.sitdowns ?? []), sitdown] };

  const where = districtName(next, sitdown.venueTerritoryId);
  const about = isAgendaTable(agenda) ? ` about ${agendaLabelLower(agenda)}` : "";
  const text = accepted
    ? `Sit-down with ${other}${about} set for the week after next at ${where} (${venueLabel(venue)}).`
    : `${other} won't meet on ${venueLabel(venue)}. They'll come to ${where} (${venueLabel(sitdown.counterVenue!)}) instead.`;

  return {
    state: next,
    sitdown,
    countered: !accepted,
    log: {
      id: `log_sitdown_prop_${id}`,
      turn: state.turn,
      category: "diplomacy",
      text,
      family: player,
    },
  };
}

/** Take the rival's counter-offer, or walk (influence comes back, the cash doesn't). */
export function answerCounter(
  state: GameState,
  id: string,
  accept: boolean,
): { state: GameState; log: TurnLogEntry } {
  const player = state.playerFamily;
  const sitdown = (state.sitdowns ?? []).find((s) => s.id === id);
  const log = (text: string): TurnLogEntry => ({
    id: `log_sitdown_counter_${id}_${state.turn}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: player ?? undefined,
  });
  if (!sitdown || sitdown.status !== "proposed" || !sitdown.counterVenue || !player) {
    return { state, log: log("That offer is off the table.") };
  }

  const sitdowns = state.sitdowns.map((s) =>
    s.id !== id
      ? s
      : accept
        ? {
            ...s,
            status: "scheduled" as const,
            venue: s.counterVenue!,
            counterVenue: undefined,
            heldTurn: state.turn + SITDOWN_LAG,
          }
        : { ...s, status: "declined" as const },
  );

  const next: GameState = accept
    ? { ...state, sitdowns }
    : { ...state, sitdowns, influence: state.influence + SITDOWN_INFLUENCE };

  const where = districtName(state, sitdown.venueTerritoryId);
  return {
    state: next,
    log: log(
      accept
        ? `You took ${sitdown.other}'s terms. Sit-down in two weeks at ${where}.`
        : `You walked away from ${sitdown.other}'s counter-offer.`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* AI invitations                                                      */
/* ------------------------------------------------------------------ */

export const AI_SITDOWN_CHANCE = 0.08;
/** A family with a live package on the player boss wants him out of the house. */
export const AI_SITDOWN_TRAP_CHANCE = 0.5;

/** A rival asks the player to the table. Lands as a turn-start prompt. */
export function aiProposeSitdown(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const player = state.playerFamily;
  if (!player || family === player) return { state };
  if (!getBoss(state.crew, player) || !getBoss(state.crew, family)) return { state };
  if (bossIsJailed(state, family) || bossIsJailed(state, player)) return { state };
  const standing = state.rivalInfluence?.[family] ?? 0;
  if (standing < SITDOWN_INFLUENCE) return { state };
  if ((state.sitdowns ?? []).some((s) => s.status === "proposed" && s.proposer === family)) {
    return { state };
  }

  const trapping = hasArmedBombOnPlayerBoss(state, family);
  const score = getRelation(state.relations, player, family);
  const status = statusFromScore(score);
  if (!trapping && (state.diplomacy?.cooldowns?.[family] ?? 0) > state.turn) return { state };
  // A family that wants something specific calls regardless of the mood.
  const ask = trapping ? null : pickRivalAgenda(state, family, rng);
  if (!trapping && !ask && status !== "cold" && status !== "hostile") return { state };

  const venue: SitdownVenue = trapping ? "theirs" : rng.chance(0.6) ? "neutral" : "theirs";
  const territoryId = resolveVenue(state, family, venue);
  if (!territoryId) return { state };

  const sitdown: Sitdown = {
    id: `sitdown_${family}_${player}_${state.turn}_${rng.int(100, 999)}`,
    proposedTurn: state.turn,
    heldTurn: state.turn + SITDOWN_LAG,
    proposer: family,
    other: player,
    venue,
    venueTerritoryId: territoryId,
    status: "proposed",
    purpose: ask?.agenda ?? "general",
    table: ask ? { ask: ask.terms, rounds: 0, opener: family } : undefined,
  };
  const where = districtName(state, territoryId);
  return {
    state: {
      ...state,
      sitdowns: [...(state.sitdowns ?? []), sitdown],
      rivalInfluence: { ...state.rivalInfluence, [family]: standing - SITDOWN_INFLUENCE },
    },
    log: {
      id: `log_sitdown_invite_${sitdown.id}`,
      turn: state.turn,
      category: "diplomacy",
      text: ask
        ? `${family} wants a sit-down about ${agendaLabelLower(ask.agenda)} in two weeks at ${where} (${venueLabel(venue)}).`
        : `${family} wants a sit-down in two weeks at ${where} (${venueLabel(venue)}).`,
      family,
    },
  };
}

function agendaLabelLower(agenda: SitdownAgenda): string {
  switch (agenda) {
    case "truce":
      return "a truce";
    case "territory":
      return "a district";
    case "release":
      return "a man being held";
    case "vendetta":
      return "ending the vendetta";
    case "alliance":
      return "a contract";
    case "liquor":
      return "liquor";
    case "racket":
      return "a cut of the take";
    case "passage":
      return "passage";
    default:
      return "easing off";
  }
}

export type InviteAnswer = "accept" | "counter" | "decline";

/** The player's answer to a rival's invitation. */
export function answerInvite(
  state: GameState,
  id: string,
  answer: InviteAnswer,
  counterVenue: SitdownVenue | undefined,
  rng: Rng,
  party?: SitdownParty,
): { state: GameState; log: TurnLogEntry } {
  const player = state.playerFamily;
  const sitdown = (state.sitdowns ?? []).find((s) => s.id === id);
  const log = (text: string, family?: FamilyName): TurnLogEntry => ({
    id: `log_sitdown_invite_${id}_${state.turn}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: family ?? player ?? undefined,
  });
  if (!sitdown || sitdown.status !== "proposed" || sitdown.proposer === player || !player) {
    return { state, log: log("That invitation has expired.") };
  }
  const family = sitdown.proposer;

  const update = (patch: Partial<Sitdown>, extra?: Partial<GameState>): GameState => ({
    ...state,
    ...extra,
    sitdowns: state.sitdowns.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    relations: extra?.relations ?? state.relations,
  });

  if (answer === "decline") {
    return {
      state: update(
        { status: "declined" },
        { relations: setRelationDelta(state.relations, player, family, -5) },
      ),
      log: log(`You declined ${family}'s sit-down. They took it badly.`),
    };
  }

  const brought = partyFields(state, party);

  if (answer === "accept") {
    return {
      state: update({
        status: "scheduled",
        heldTurn: state.turn + SITDOWN_LAG,
        ...brought,
        hostFamily: hostOf(state, family, sitdown.venue) ?? undefined,
      }),
      log: log(
        `Sit-down with ${family} set for the week after next at ${districtName(state, sitdown.venueTerritoryId)}.`,
      ),
    };
  }

  // Counter: the same acceptance table, mirrored (we are asking them to move).
  const venue = counterVenue ?? "neutral";
  const territoryId = resolveVenue(state, family, venue);
  if (!territoryId) return { state, log: log("Nowhere to move it to.") };

  const n = brought.playerEntourageIds?.length ?? 0;
  const mirrored =
    venue === "ours"
      ? venueAcceptance(state, family, "theirs", n) // they stay home: always fine
      : venueAcceptance(state, family, "ours", n);
  // A trap-setter will not come to us.
  const chance = hasArmedBombOnPlayerBoss(state, family) && venue === "ours" ? 0 : mirrored;
  if (!rng.chance(Math.max(0.15, chance)) && venue !== "theirs") {
    return {
      state: update({ status: "declined" }),
      log: log(`${family} won't move the meeting. The sit-down is off.`, family),
    };
  }
  return {
    state: update({
      status: "scheduled",
      venue,
      venueTerritoryId: territoryId,
      heldTurn: state.turn + SITDOWN_LAG,
      ...brought,
      hostFamily: hostOf(state, family, venue) ?? undefined,
    }),
    log: log(`Sit-down with ${family} moved to ${districtName(state, territoryId)} (${venueLabel(venue)}).`),
  };
}

/* ------------------------------------------------------------------ */
/* The meeting itself                                                  */
/* ------------------------------------------------------------------ */

function rivalEntourage(state: GameState, family: FamilyName): string[] {
  const n = getFamilyDef(family).personality === "volatile" ? 2 : 1;
  return getActiveCrew(state.crew, family)
    .filter((c) => c.role !== "boss" && c.role !== "consigliere")
    .sort((a, b) => b.skills.muscle - a.skills.muscle)
    .slice(0, n)
    .map((c) => c.id);
}

function trip(
  crew: GameState["crew"],
  id: string,
  territoryId: string,
  turn: number,
): GameState["crew"] {
  return crew.map((c) =>
    c.id === id && c.status === "active"
      ? {
          ...c,
          awayAt: { territoryId, untilTurn: turn + 1, reason: "sitdown" as const },
        }
      : c,
  );
}

/** Bosses with a meeting this turn leave for the venue before anything resolves. */
export function stageSitdowns(state: GameState): GameState {
  const dueIds = new Set(
    (state.sitdowns ?? [])
      .filter((s) => s.status === "scheduled" && s.heldTurn === state.turn)
      .map((s) => s.id),
  );
  if (dueIds.size === 0) return state;

  const player = state.playerFamily;
  const sitdowns = state.sitdowns.map((s) => {
    if (!dueIds.has(s.id) || !player) return s;
    const other = s.proposer === player ? s.other : s.proposer;
    if (other === player || (s.rivalEntourageIds?.length ?? 0) > 0) return s;
    return { ...s, rivalEntourageIds: rivalEntourage(state, other) };
  });

  let crew = state.crew;
  const staged = sitdowns.map((s) => {
    if (!dueIds.has(s.id)) return s;
    const travelFrom: Partial<Record<FamilyName, string>> = { ...(s.travelFrom ?? {}) };
    for (const family of [s.proposer, s.other]) {
      const boss = getBoss(crew, family);
      if (!boss || boss.status !== "active") continue;
      // Hosting on your own ground is not a trip: the car never moves, so a
      // bomb planted on it doesn't get its chance. Compare against where he
      // stands with no trip set, or the override would count as travel.
      const home = resolveCrewLocation({ ...state, crew }, boss.id);
      if (home.territoryId === s.venueTerritoryId) continue;
      if (home.territoryId) travelFrom[family] = home.territoryId;
      crew = trip(crew, boss.id, s.venueTerritoryId, state.turn);
      const extras =
        family === player
          ? [
              ...(s.playerEntourageIds ?? []),
              ...(s.bringConsigliere
                ? [
                    crew.find((c) => c.family === player && c.role === "consigliere" && c.status === "active")
                      ?.id,
                  ]
                : []),
            ]
          : (s.rivalEntourageIds ?? []);
      for (const id of extras) {
        if (id) crew = trip(crew, id, s.venueTerritoryId, state.turn);
      }
    }
    return { ...s, travelFrom };
  });
  return { ...state, crew, sitdowns: staged };
}

export interface HoldResult {
  state: GameState;
  logs: TurnLogEntry[];
}

/** After the week's violence: the meeting happens, or it doesn't. */
export function holdSitdowns(state: GameState, rng: Rng): HoldResult {
  const player = state.playerFamily;
  const logs: TurnLogEntry[] = [];
  if (!player) return { state, logs };

  let next = state;
  const sitdowns = (state.sitdowns ?? []).map((s) => {
    if (s.status !== "scheduled" || s.heldTurn !== state.turn) return s;

    const bosses = [s.proposer, s.other].map((f) => getBoss(next.crew, f));
    const missing = bosses.find((b) => !b || b.status !== "active");
    const rival = s.proposer === player ? s.other : s.proposer;

    if (missing) {
      const who = !bosses[0] || bosses[0].status !== "active" ? s.proposer : s.other;
      logs.push({
        id: `log_sitdown_abort_${s.id}`,
        turn: state.turn,
        category: "diplomacy",
        text: `The sit-down with ${rival} never happened — the ${who} boss didn't make it to the table.`,
        family: player,
      });
      if (s.proposer === player && s.purpose !== "passage") {
        next = withCooldown(next, s.other, SITDOWN_COOLDOWN);
      }
      return { ...s, status: "aborted" as const };
    }

    if (s.hostFamily && s.hostFamily !== player && s.hostFamily !== rival) {
      const host = s.hostFamily;
      next = {
        ...next,
        money: next.money - HOST_FEE,
        rivalTreasury: {
          ...next.rivalTreasury,
          [rival]: (next.rivalTreasury?.[rival] ?? 0) - HOST_FEE,
          [host]: (next.rivalTreasury?.[host] ?? 0) + HOST_FEE * 2,
        },
      };
      logs.push({
        id: `log_sitdown_host_${s.id}`,
        turn: state.turn,
        category: "diplomacy",
        text: `${host} hosts the table. $${HOST_FEE} from each family.`,
        family: player,
      });
    }

    // Passage talks: the bosses sit; the rival names a price; the player
    // answers from the modal. Nothing else moves until he does.
    if (s.purpose === "passage") {
      const route = (next.supplyRoutes ?? []).find((r) => r.id === s.passage?.routeId);
      const ask = openingAsk(next, rival, {
        crates: route?.cratesPerTurn ?? 10,
        demanded: s.passage?.demanded,
      });
      const where = districtName(next, s.venueTerritoryId);
      logs.push({
        id: `log_sitdown_table_${s.id}`,
        turn: state.turn,
        category: "diplomacy",
        text: `At the table in ${where}, ${rival} names a price for passage: ${termsText(ask)}.`,
        family: player,
      });
      return {
        ...s,
        status: "at_table" as const,
        passage: { ...(s.passage ?? { rounds: 0 }), ask, rounds: 0 },
      };
    }

    // Agenda talks: the subject was fixed when the meeting was set; the
    // number is priced now. If the player walked in with terms, they answer
    // on the spot — taken, or met with their own ask.
    if (isAgendaTable(s.purpose) && s.table) {
      const agenda = s.purpose!;
      const can = agendaAvailable(next, rival, agenda);
      const stale = !subjectStillStands(next, rival, agenda, s.table.ask);
      if ((s.proposer === player && !can.ok) || stale) {
        logs.push({
          id: `log_sitdown_moot_${s.id}`,
          turn: state.turn,
          category: "diplomacy",
          text: `The talk with ${rival} about ${agendaLabelLower(agenda)} is moot now. The bosses trade pleasantries and leave.`,
          family: player,
        });
        next = { ...next, relations: setRelationDelta(next.relations, player, rival, 3) };
        if (s.proposer === player) next = withCooldown(next, rival, SITDOWN_COOLDOWN);
        return {
          ...s,
          status: "held" as const,
          success: false,
          table: { ...s.table, moot: true, lines: ["Nothing left to settle. The bosses trade pleasantries and leave."] },
        };
      }
      const ask = openingTerms(next, rival, agenda, s.table.ask);
      const where = districtName(next, s.venueTerritoryId);
      const opening = s.table.playerOpening;
      if (opening) {
        const chance = counterChance(next, rival, agenda, ask, opening, { consigliere: s.bringConsigliere });
        if (rng.chance(chance) && canAfford(next, opening).ok) {
          const struck = applyAgendaTerms(next, rival, agenda, opening, rng);
          next = { ...struck.state, relations: setRelationDelta(struck.state.relations, player, rival, 8) };
          if (s.proposer === player) next = withCooldown(next, rival, SITDOWN_COOLDOWN);
          const text = `${rival} takes your terms at ${where}: ${agendaTermsText(next, agenda, opening)}.`;
          logs.push({ id: `log_sitdown_table_${s.id}`, turn: state.turn, category: "diplomacy", text, family: player });
          return {
            ...s,
            status: "held" as const,
            success: true,
            table: { ...s.table, ask, struck: opening, lines: [text, ...struck.lines] },
          };
        }
        const insult = isInsult(next, rival, agenda, ask, opening);
        if (insult) next = { ...next, relations: setRelationDelta(next.relations, player, rival, INSULT_RELATION) };
        logs.push({
          id: `log_sitdown_table_${s.id}`,
          turn: state.turn,
          category: "diplomacy",
          text: insult
            ? `${rival} hears your number at ${where} and takes it as an insult. Theirs: ${agendaTermsText(next, agenda, ask)}.`
            : `${rival} won't take your opener at ${where}. Theirs: ${agendaTermsText(next, agenda, ask)}.`,
          family: player,
        });
        return { ...s, status: "at_table" as const, table: { ...s.table, ask, rounds: 0 } };
      }
      logs.push({
        id: `log_sitdown_table_${s.id}`,
        turn: state.turn,
        category: "diplomacy",
        text: `At the table in ${where}, ${rival} names terms on ${agendaLabelLower(agenda)}: ${agendaTermsText(next, agenda, ask)}.`,
        family: player,
      });
      return { ...s, status: "at_table" as const, table: { ...s.table, ask, rounds: 0 } };
    }

    const success = rng.chance(sitdownOdds(next, rival, s.playerEntourageIds?.length ?? 0));
    const playerProposed = s.proposer === player;
    const relationGain = success ? (playerProposed ? 15 : 10) : 3;
    next = {
      ...next,
      relations: setRelationDelta(next.relations, player, rival, relationGain),
      reputation: {
        ...next.reputation,
        respect: Math.min(100, next.reputation.respect + (success ? 2 : 0)),
      },
    };
    if (playerProposed) next = withCooldown(next, rival, SITDOWN_COOLDOWN);

    const where = districtName(next, s.venueTerritoryId);
    logs.push({
      id: `log_sitdown_held_${s.id}`,
      turn: state.turn,
      category: "diplomacy",
      text: success
        ? `Sit-down with ${rival} at ${where} went well. They agree to ease off.`
        : `Sit-down with ${rival} at ${where} went nowhere.`,
      family: player,
    });
    return { ...s, status: "held" as const, success };
  });

  // Keep the recent history; drop the rest.
  const trimmed = sitdowns.filter(
    (s) =>
      s.status === "proposed" ||
      s.status === "scheduled" ||
      s.status === "at_table" ||
      state.turn - s.heldTurn < 12,
  );
  return { state: { ...next, sitdowns: trimmed }, logs };
}

/** Invitations, counter-offers and open tables the player hasn't answered. */
export function pendingSitdowns(state: Pick<GameState, "sitdowns" | "playerFamily">): Sitdown[] {
  const player = state.playerFamily;
  if (!player) return [];
  return (state.sitdowns ?? []).filter(
    (s) =>
      s.status === "at_table" ||
      (s.status === "proposed" &&
        (s.proposer !== player || s.counterVenue !== undefined)),
  );
}

/* ------------------------------------------------------------------ */
/* Passage talks                                                       */
/* ------------------------------------------------------------------ */

/** Is there already a passage sit-down with this family in the works? */
export function passageTalksPending(
  state: Pick<GameState, "sitdowns" | "playerFamily">,
  family: FamilyName,
): boolean {
  const player = state.playerFamily;
  return (state.sitdowns ?? []).some(
    (s) =>
      s.purpose === "passage" &&
      (s.status === "proposed" || s.status === "scheduled" || s.status === "at_table") &&
      ((s.proposer === player && s.other === family) ||
        (s.proposer === family && s.other === player)),
  );
}

/**
 * A supply route needs a right of way: the player asks the family to the
 * table. Held on their turf in two weeks (they always take that), no fee — the
 * terms are the price. Nothing to talk about while at war.
 */
export function proposePassageSitdown(
  state: GameState,
  family: FamilyName,
  routeId: string | undefined,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const player = state.playerFamily;
  if (!player || family === player) return { state };
  if (passageTalksPending(state, family)) return { state };
  const log = (text: string): TurnLogEntry => ({
    id: `log_passage_ask_${family}_${state.turn}_${rng.int(10, 99)}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: player,
  });
  if (!getBoss(state.crew, player) || !getBoss(state.crew, family)) {
    return { state, log: log(`${family} has nobody to speak for them on passage.`) };
  }
  if (statusFromScore(getRelation(state.relations, player, family)) === "war") {
    return { state, log: log(`${family} won't talk passage while you're at war.`) };
  }
  const territoryId = resolveVenue(state, family, "theirs");
  if (!territoryId) return { state, log: log("Nowhere to hold the talks.") };

  const sitdown: Sitdown = {
    id: `sitdown_passage_${player}_${family}_${state.turn}_${rng.int(100, 999)}`,
    proposedTurn: state.turn,
    heldTurn: state.turn + SITDOWN_LAG,
    proposer: player,
    other: family,
    venue: "theirs",
    venueTerritoryId: territoryId,
    status: "scheduled",
    purpose: "passage",
    passage: {
      routeId,
      ask: openingAsk(state, family),
      rounds: 0,
    },
  };
  return {
    state: { ...state, sitdowns: [...(state.sitdowns ?? []), sitdown] },
    log: log(
      `Passage talks with ${family} set for the week after next at ${districtName(state, territoryId)}. Your boss travels.`,
    ),
  };
}

/**
 * After a message hit (or a run of hot trucks) the family comes asking: they
 * want the player at their table to settle the routes on their terms.
 */
export function aiDemandPassageSitdown(
  state: GameState,
  family: FamilyName,
  rng: Rng,
  demanded: boolean,
): { state: GameState; log?: TurnLogEntry } {
  const player = state.playerFamily;
  if (!player || family === player) return { state };
  if (passageTalksPending(state, family)) return { state };
  if (!getBoss(state.crew, player) || !getBoss(state.crew, family)) return { state };
  const territoryId = resolveVenue(state, family, "theirs");
  if (!territoryId) return { state };

  const sitdown: Sitdown = {
    id: `sitdown_passage_${family}_${player}_${state.turn}_${rng.int(100, 999)}`,
    proposedTurn: state.turn,
    heldTurn: state.turn + SITDOWN_LAG,
    proposer: family,
    other: player,
    venue: "theirs",
    venueTerritoryId: territoryId,
    status: "proposed",
    purpose: "passage",
    passage: { ask: openingAsk(state, family, { demanded }), rounds: 0, demanded },
  };
  return {
    state: { ...state, sitdowns: [...(state.sitdowns ?? []), sitdown] },
    log: {
      id: `log_passage_demand_${sitdown.id}`,
      turn: state.turn,
      category: "diplomacy",
      text: demanded
        ? `${family} wants you at their table in two weeks to settle the trucks — their way.`
        : `${family} wants a word about your trucks. Sit-down in two weeks at ${districtName(state, territoryId)}.`,
      family,
    },
  };
}

export type PassageAnswer = "accept" | "counter" | "walk";

/**
 * The player's move at an open passage table. Accepting the ask strikes the
 * deal. A counter is answered on the spot: taken, or met with a softer ask —
 * twice at most, then it's their last word. Walking ends the talks; routes
 * that were waiting go hot if the player said so, otherwise they sit.
 */
export function answerPassage(
  state: GameState,
  id: string,
  answer: PassageAnswer,
  offer: PassageTerms | undefined,
  rng: Rng,
): { state: GameState; log: TurnLogEntry; struck?: PassageTerms; lastWord?: boolean; result?: SitdownResult } {
  const player = state.playerFamily;
  const sitdown = (state.sitdowns ?? []).find((s) => s.id === id);
  const log = (text: string, family?: FamilyName): TurnLogEntry => ({
    id: `log_passage_${id}_${state.turn}_${rng.int(10, 99)}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: family ?? player ?? undefined,
  });
  if (!sitdown || sitdown.status !== "at_table" || !sitdown.passage || !player) {
    return { state, log: log("That table has broken up.") };
  }
  const family = sitdown.proposer === player ? sitdown.other : sitdown.proposer;
  const route = (state.supplyRoutes ?? []).find((r) => r.id === sitdown.passage?.routeId);
  const crates = route?.cratesPerTurn ?? 10;

  const finish = (
    base: GameState,
    status: Sitdown["status"],
    success: boolean,
    patch?: Partial<Sitdown>,
  ): GameState => ({
    ...base,
    sitdowns: base.sitdowns.map((s) =>
      s.id === id ? { ...s, ...patch, status, success } : s,
    ),
  });

  const strike = (terms: PassageTerms, text: string) => {
    let next = strikeDeal(state, family, terms, rng);
    next = {
      ...next,
      relations: setRelationDelta(next.relations, player, family, 6),
    };
    next = finish(next, "held", true);
    return {
      state: next,
      log: log(text),
      struck: terms,
      result: passageResult(next, sitdown, family, true, [text], terms),
    };
  };

  if (answer === "accept") {
    return strike(
      sitdown.passage.ask,
      `Deal with ${family}: passage at ${termsText(sitdown.passage.ask)}.`,
    );
  }

  if (answer === "walk") {
    let next: GameState = {
      ...state,
      relations: setRelationDelta(state.relations, player, family, -5),
    };
    // Routes that were waiting on this family: roll hot or sit.
    next = {
      ...next,
      supplyRoutes: (next.supplyRoutes ?? []).map((r) => {
        if (!r.awaitingFamilies.includes(family)) return r;
        const awaiting = r.awaitingFamilies.filter((f) => f !== family);
        if (r.runHot) {
          return {
            ...r,
            awaitingFamilies: awaiting,
            status: awaiting.length === 0 ? ("active" as const) : r.status,
          };
        }
        return {
          ...r,
          awaitingFamilies: awaiting,
          status: "suspended" as const,
          suspendedReason: `No passage deal with ${family}`,
        };
      }),
    };
    next = finish(next, "held", false);
    const text = `You walked away from ${family}'s table. No deal on the trucks.`;
    return {
      state: next,
      log: log(text),
      result: passageResult(next, sitdown, family, false, [text]),
    };
  }

  // Counter.
  if (!offer) return { state, log: log("Name your terms first.") };
  const ask = sitdown.passage.ask;
  const chance = counterAcceptance(state, family, ask, offer, crates);
  if (rng.chance(chance)) {
    return strike(offer, `${family} takes your number: passage at ${termsText(offer)}.`);
  }
  const rounds = sitdown.passage.rounds + 1;
  if (rounds >= 2) {
    // Last word: they hold their current ask; the player accepts or walks.
    const next = finish(state, "at_table", false, {
      passage: { ...sitdown.passage, rounds },
    });
    return {
      state: next,
      log: log(`${family} won't move again: ${termsText(ask)}. Take it or leave it.`, family),
      lastWord: true,
    };
  }
  const softer = blendTerms(ask, offer, 0.4);
  const next = finish(state, "at_table", false, {
    passage: { ...sitdown.passage, ask: softer, rounds },
  });
  return {
    state: next,
    log: log(`${family} comes down a little: ${termsText(softer)}.`, family),
  };
}

/* ------------------------------------------------------------------ */
/* Agenda tables                                                       */
/* ------------------------------------------------------------------ */

/** Is what the table is about still true when the bosses sit? */
function subjectStillStands(
  state: GameState,
  rival: FamilyName,
  agenda: SitdownAgenda,
  ask: AgendaTerms,
): boolean {
  const player = state.playerFamily!;
  switch (agenda) {
    case "territory": {
      const t = state.territories.find((x) => x.id === ask.territoryId);
      return !!t && (t.owner === rival || t.owner === player);
    }
    case "release": {
      const c = state.crew.find((x) => x.id === ask.crewId);
      return !!c && c.status === "held";
    }
    case "vendetta":
      return state.vendettas.includes(rival);
    case "liquor":
      return state.territories.find((x) => x.id === ask.destTerritoryId)?.owner === rival;
    case "alliance":
      return (
        !!ask.targetFamily &&
        ask.targetFamily !== player &&
        ask.targetFamily !== rival &&
        !atPeace(state, ask.obligor ?? player, ask.targetFamily)
      );
    case "racket": {
      const t = state.territories.find((x) => x.id === ask.territoryId);
      return !!t && (t.owner === rival || t.owner === player) && t.rackets.length > 0 && !cutOn(state, t.id);
    }
    default:
      return true;
  }
}

export type TableAnswer = "accept" | "counter" | "walk";

/**
 * The player's move at an open agenda table. Accepting the ask strikes it.
 * A counter is answered on the spot: taken, or met with a number a little
 * closer to his — three times, then they leave. A lowball costs standing
 * with them, and a hot-headed family may leave over it. Walking ends it.
 */
export function answerTable(
  state: GameState,
  id: string,
  answer: TableAnswer,
  offer: AgendaTerms | undefined,
  rng: Rng,
): { state: GameState; log: TurnLogEntry; struck?: AgendaTerms; result?: SitdownResult; walkedOut?: boolean } {
  const player = state.playerFamily;
  const sitdown = (state.sitdowns ?? []).find((s) => s.id === id);
  const log = (text: string, family?: FamilyName): TurnLogEntry => ({
    id: `log_table_${id}_${state.turn}_${rng.int(10, 99)}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: family ?? player ?? undefined,
  });
  if (!sitdown || sitdown.status !== "at_table" || !sitdown.table || !player || !isAgendaTable(sitdown.purpose)) {
    return { state, log: log("That table has broken up.") };
  }
  const family = sitdown.proposer === player ? sitdown.other : sitdown.proposer;
  const agenda = sitdown.purpose!;
  const table = sitdown.table;
  const playerProposed = sitdown.proposer === player;

  const finish = (
    base: GameState,
    status: Sitdown["status"],
    success: boolean,
    patch: Partial<Sitdown["table"]> = {},
  ): GameState => ({
    ...base,
    sitdowns: base.sitdowns.map((s) =>
      s.id === id ? { ...s, status, success, table: { ...table, ...patch } } : s,
    ),
  });

  const strike = (terms: AgendaTerms, text: string) => {
    const afford = canAfford(state, terms);
    if (!afford.ok) return { state, log: log(afford.reason ?? "You can't cover that.") };
    const applied = applyAgendaTerms(state, family, agenda, terms, rng);
    let next: GameState = {
      ...applied.state,
      relations: setRelationDelta(applied.state.relations, player, family, 8),
      reputation: { ...applied.state.reputation, respect: Math.min(100, applied.state.reputation.respect + 2) },
    };
    if (playerProposed) next = withCooldown(next, family, SITDOWN_COOLDOWN);
    const lines = [text, ...applied.lines];
    next = finish(next, "held", true, { struck: terms, lines });
    const settled = next.sitdowns.find((s) => s.id === id)!;
    return { state: next, log: log(text), struck: terms, result: agendaResult(next, settled, family) };
  };

  const leave = (base: GameState, text: string, theyWalked: boolean) => {
    let next: GameState = {
      ...base,
      relations: setRelationDelta(base.relations, player, family, theyWalked ? -3 : -5),
    };
    if (playerProposed) next = withCooldown(next, family, theyWalked ? SITDOWN_COOLDOWN * 2 : SITDOWN_COOLDOWN);
    next = finish(next, "held", false, { lines: [text], walkedOut: theyWalked });
    const settled = next.sitdowns.find((s) => s.id === id)!;
    return { state: next, log: log(text, theyWalked ? family : undefined), result: agendaResult(next, settled, family), walkedOut: theyWalked };
  };

  if (answer === "accept") {
    return strike(table.ask, `Done with ${family}: ${agendaTermsText(state, agenda, table.ask)}.`);
  }
  if (answer === "walk") {
    return leave(state, `You walked away from ${family}'s table. Nothing on ${agendaLabelLower(agenda)}.`, false);
  }

  if (!offer) return { state, log: log("Name your terms first.") };
  const ask = table.ask;
  const chance = counterChance(state, family, agenda, ask, offer, { consigliere: sitdown.bringConsigliere });
  if (rng.chance(chance)) {
    return strike(offer, `${family} takes your number: ${agendaTermsText(state, agenda, offer)}.`);
  }

  const rounds = table.rounds + 1;
  let next: GameState = state;
  const insult = isInsult(state, family, agenda, ask, offer);
  if (insult) {
    next = { ...next, relations: setRelationDelta(next.relations, player, family, INSULT_RELATION) };
    if (getFamilyDef(family).personality === "volatile" && rng.chance(INSULT_WALK_CHANCE)) {
      return leave(next, `${family} hears your number and gets up. "Don't waste my time."`, true);
    }
  }
  if (rounds >= TABLE_ROUNDS) {
    return leave(next, `${family} has heard enough. They leave the table with nothing settled.`, true);
  }
  // They come down a little — unless the number was an insult.
  const softer = insult ? ask : blendAgenda(ask, offer, 0.35);
  next = finish(next, "at_table", false, { ask: softer, rounds });
  return {
    state: next,
    log: log(
      insult
        ? `${family} takes that as an insult and holds their number: ${agendaTermsText(state, agenda, softer)}.`
        : `${family} comes down a little: ${agendaTermsText(state, agenda, softer)}.`,
      family,
    ),
  };
}

const DEAL_AGENDAS: SitdownAgenda[] = ["truce", "alliance", "liquor", "racket"];

function agendaResult(state: GameState, s: Sitdown, family: FamilyName): SitdownResult {
  const success = !!s.success;
  const struck = s.table?.struck;
  const recorded = success && (DEAL_AGENDAS.includes(s.purpose!) || !!struck?.favor);
  const lines = s.table?.lines ?? [];
  return {
    sitdownId: s.id,
    family,
    venueTerritoryId: s.venueTerritoryId,
    purpose: s.purpose,
    success,
    lines: recorded ? [...lines, "Deal recorded. Break it and every family hears."] : lines,
    deltas: {
      relation: success ? 8 : s.table?.moot ? 3 : s.table?.walkedOut ? -3 : -5,
      respect: success ? 2 : 0,
    },
    struckTerms: struck,
    hostFee: s.hostFamily ? HOST_FEE : undefined,
    follow: recorded ? "open_deals" : success || s.table?.moot ? "open_commission" : "plan_hit",
  };
}

/** Sit-downs on the books. */
export function scheduledSitdowns(state: Pick<GameState, "sitdowns">): Sitdown[] {
  return (state.sitdowns ?? []).filter((s) => s.status === "scheduled");
}

function passageResult(
  state: GameState,
  sitdown: Sitdown,
  family: FamilyName,
  success: boolean,
  lines: string[],
  struck?: PassageTerms,
): SitdownResult {
  return {
    sitdownId: sitdown.id,
    family,
    venueTerritoryId: sitdown.venueTerritoryId,
    purpose: "passage",
    success,
    lines,
    deltas: { relation: success ? 6 : -5, respect: success ? 2 : 0 },
    struck,
    hostFee: sitdown.hostFamily ? HOST_FEE : undefined,
    follow: success ? "open_liquor" : "plan_hit",
  };
}

const TABLE_OPENERS: Record<string, string> = {
  volatile: "They come in hot. Somebody is going to answer for the last month.",
  economic: "They talk numbers before they talk names.",
  covert: "They let you talk. They're listening for what you don't say.",
  smuggler: "They want the roads quiet and their cut understood.",
  expansionist: "They talk borders — what's yours, and what's about to be theirs.",
};

/** Three lines for the letterboxed table. Passage talks use the negotiation instead. */
export function tableScript(
  state: GameState,
  s: Sitdown,
  outcome: SitdownCinematic["outcome"],
): string[] {
  const player = state.playerFamily;
  const family = !player || s.proposer === player ? s.other : s.proposer;
  const lines = [TABLE_OPENERS[getFamilyDef(family).personality] ?? TABLE_OPENERS.economic!];
  if (s.bringConsigliere) {
    lines.push("Your consigliere leans in. Give them the small concession. Leave them the pride.");
  }
  if (outcome === "aborted") lines.push("The chair across from you stays empty.");
  else if (outcome === "trap") lines.push("The street outside answers before anyone does.");
  else if (outcome === "betrayed") lines.push("Steel shows under the table. This was never a talk.");
  else if (outcome === "handshake") lines.push("Hands are shaken. They'll ease off — for now.");
  else lines.push("Nobody raises their voice. Nobody gives an inch.");
  return lines;
}

/**
 * Hits that landed this week. Rival jobs resolve after the date turns; the
 * player's go on his Next Turn, just before it, so they carry last week's number.
 */
function hitsThisWeek(state: GameState): Operation[] {
  return state.operations.filter(
    (o) =>
      o.resolved &&
      (o.resolvedTurn === state.turn ||
        (o.family === state.playerFamily && o.resolvedTurn === state.turn - 1)),
  );
}

/** How the drive should end, from what already resolved this turn. */
export function classifyMeeting(state: GameState, s: Sitdown): SitdownCinematic["outcome"] {
  const ops = hitsThisWeek(state);
  const bosses = [s.proposer, s.other]
    .map((f) => getBoss(state.crew, f)?.id)
    .filter((id): id is string => !!id);
  if (ops.some((o) => o.approach === "car_bomb" && !!o.targetCrewId && bosses.includes(o.targetCrewId))) {
    return "trap";
  }
  if (
    ops.some(
      (o) =>
        o.approach === "sitdown_betrayal" &&
        o.targetTerritoryId === s.venueTerritoryId &&
        (o.targetFamily === s.proposer || o.targetFamily === s.other),
    )
  ) {
    return "betrayed";
  }
  if (s.status === "aborted") return "aborted";
  if (s.status === "at_table") return "handshake";
  return s.success ? "handshake" : "walk";
}

export function meetingBetrayer(state: GameState, s: Sitdown): FamilyName | undefined {
  const ops = hitsThisWeek(state);
  const bosses = [s.proposer, s.other]
    .map((f) => getBoss(state.crew, f)?.id)
    .filter((id): id is string => !!id);
  return (
    ops.find((o) => o.approach === "sitdown_betrayal" && o.targetTerritoryId === s.venueTerritoryId)?.family ??
    ops.find((o) => o.approach === "car_bomb" && !!o.targetCrewId && bosses.includes(o.targetCrewId))?.family
  );
}

/** A bloodied neutral table: the betrayer is banned, and standing with the host moves. */
export function applyHostFallout(state: GameState): GameState {
  let next = state;
  for (const s of state.sitdowns ?? []) {
    if (!s.hostFamily || s.heldTurn !== state.turn) continue;
    if (s.status !== "held" && s.status !== "at_table" && s.status !== "aborted") continue;
    const outcome = classifyMeeting(next, s);
    if (outcome !== "betrayed" && outcome !== "trap") continue;
    const betrayer = meetingBetrayer(next, s);
    if (!betrayer) continue;
    const victim = betrayer === s.proposer ? s.other : s.proposer;
    const host = s.hostFamily;
    next = {
      ...next,
      relations: setRelationDelta(
        setRelationDelta(next.relations, betrayer, host, -20),
        victim,
        host,
        5,
      ),
      diplomacy: {
        ...next.diplomacy,
        hostBans: {
          ...(next.diplomacy?.hostBans ?? {}),
          [hostBanKey(host, betrayer)]: state.turn + 8,
        },
      },
    };
  }
  return next;
}

export function resultForMeeting(state: GameState, s: Sitdown): SitdownResult {
  const player = state.playerFamily;
  const family = player && s.proposer === player ? s.other : s.proposer;
  const outcome = classifyMeeting(state, s);
  // An agenda table that settled on arrival (or was moot) carries its own lines.
  if (isAgendaTable(s.purpose) && s.status === "held" && outcome !== "betrayed" && outcome !== "trap") {
    return agendaResult(state, s, family);
  }
  const success = outcome === "handshake";
  const relation =
    outcome === "aborted" ? 0 : success ? (player && s.proposer === player ? 15 : 10) : 3;
  const betrayer = outcome === "betrayed" || outcome === "trap" ? meetingBetrayer(state, s) : undefined;
  const follow: SitdownFollow =
    outcome === "handshake" ? "open_commission" : "plan_hit";
  return {
    sitdownId: s.id,
    family,
    venueTerritoryId: s.venueTerritoryId,
    purpose: s.purpose ?? "general",
    success,
    lines: tableScript(state, s, outcome),
    deltas: { relation, respect: success ? 2 : 0 },
    betrayal: betrayer ? (betrayer === player ? "ours" : "theirs") : undefined,
    hostFee: s.hostFamily ? HOST_FEE : undefined,
    follow,
  };
}

export interface StanceRead {
  mood: string;
  wants: string;
  tell?: string;
  odds: number;
}

/** What the rival is likely to want, before anyone sits down. */
export function stanceRead(state: GameState, family: FamilyName): StanceRead {
  const player = state.playerFamily;
  const score = player ? getRelation(state.relations, player, family) : 0;
  const status = statusFromScore(score);
  const mood =
    status === "allied" || status === "truce"
      ? "Warm"
      : status === "neutral"
        ? "Cool"
        : status === "cold"
          ? "Cold"
          : status === "hostile"
            ? "Hostile"
            : "At war";
  let wants = "Open to easing off.";
  if (player && state.vendettas.includes(family)) wants = "Wants you gone.";
  else if (player && passageGrudges(state, family).length > 0) wants = "Wants the trucks settled.";
  else if (player) {
    const theirs = state.territories.filter((t) => t.owner === family).length;
    const ours = state.territories.filter((t) => t.owner === player).length;
    if (theirs > ours && state.reputation.fear >= 40) wants = "Wants tribute.";
  }
  const tell =
    player && hasConsigliere(state) && hasArmedBombOnPlayerBoss(state, family)
      ? "Awfully eager to host."
      : undefined;
  return { mood, wants, tell, odds: sitdownOdds(state, family) };
}
