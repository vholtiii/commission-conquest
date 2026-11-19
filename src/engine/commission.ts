/**
 * Calling the Commission to rule on a war. The ruling is advisory: both sides
 * accept or refuse it. Refusing costs standing with every seat that voted for
 * it, and the table may answer a refusal with a hit — a message, not a war.
 */
import type {
  AgendaTerms,
  CommissionCall,
  CommissionCallKind,
  CommissionRuling,
  FamilyName,
  GameState,
  SeatVote,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { getRelation, setRelation, setRelationDelta } from "./relations";
import { CUT_DEFAULT_SHARE, TRUCE_DEFAULT_WEEKS, applyAgendaTerms, bleeding, cutOn, districtTake } from "./agendas";
import { makeDeal, truceBetween } from "./deals";
import { bossIsJailed, livingBoss } from "./jail";
import { isDefunct } from "./defection";
import { familyWealth } from "./victory";
import { signRivalPact } from "./ai/rivalDiplomacy";
import { getActiveCrew } from "./crew";
import { bringCrewOnHit, commitHitCrew, planHit } from "./hitOps";
import { pickMessageTarget } from "./rivalAI";
import { resolveCrewTerritoryId } from "./crewLocation";
import { withCooldown } from "./diplomacy";
import { cadence } from "./tempo";
import { seatVotes, seatsHeld } from "./boroughSeats";

export const COMMISSION_INFLUENCE = 25;
export const COMMISSION_COOLDOWN = 8;
export const LOBBY_CASH = 400;
export const LOBBY_INFLUENCE = 5;
export const MESSAGE_BASE = 0.35;
export const MESSAGE_REFUSAL_STEP = 0.15;
export const SANCTION_WEEKS = 4;
/** Standing the loser of a ruling or a tax pays. */
export const RULING_STANDING = 8;
/** Standing a family pays for refusing the table, on top of a sanction. */
export const DEFIANCE_STANDING = 12;
const REFUSAL_RELATION = -10;
/** How long the table remembers a ruling being ignored. */
export const DEFIANCE_WINDOW = 12;
/** Relation every other living family drops to when the table goes to war. */
const WAR_RELATION = -70;
/** Relation the player's seat gains with the side it backs, and loses with the other. */
const PLEDGE_RELATION = 8;
/** Share of a rival's treasury a tax ruling takes at once. */
const RIVAL_TAX_SHARE = 0.2;
/** Already this bad, and a war ask is refused. */
const ALREADY_AT_WAR = -60;
/** No case against them: every seat leans this much against a truce or a tax. */
const FRIVOLOUS_LEAN = -0.3;
/** No ignored ruling: every seat starts this far against a war. */
const WAR_UNPROVOKED_LEAN = -0.6;
/** A tax asks for money on top of peace. */
const TAX_GREED_LEAN = -0.25;
/** Economic and smuggler seats dislike the table setting a price. */
const TAX_MERCHANT_LEAN = -0.15;

const WAR_LINES: Record<string, { for: string; against: string; abstain: string }> = {
  volatile: {
    for: "They spat on the table. Now they bleed.",
    against: "Not our war. Not yet.",
    abstain: "We'll watch how it goes.",
  },
  economic: {
    for: "A table nobody listens to is worth nothing. Make it cost them.",
    against: "War is expensive. We'll send a message instead.",
    abstain: "Show us the numbers first.",
  },
  covert: {
    for: "Quietly, then. They won't see us coming.",
    against: "We don't go to war in daylight.",
    abstain: "We'd rather not be counted.",
  },
  smuggler: {
    for: "They ignored the table; our trucks pay for it. Guns up.",
    against: "A war closes roads. No.",
    abstain: "Keep it off the routes and do what you like.",
  },
  expansionist: {
    for: "Weakness invites more of it. We move.",
    against: "We won't spend men on your grudge.",
    abstain: "We'll take what's left when it's over.",
  },
};

const VOTE_LINES: Record<string, { for: string; against: string; abstain: string }> = {
  volatile: {
    for: "Enough. Somebody has to stop this.",
    against: "Let them bleed. It's no business of ours.",
    abstain: "Settle it yourselves.",
  },
  economic: {
    for: "The war is bad for business. End it.",
    against: "We don't spend standing on other people's fights.",
    abstain: "The numbers don't say either way.",
  },
  covert: {
    for: "Quietly, we think this should stop.",
    against: "We'll remember who asked.",
    abstain: "We'd rather not be seen choosing.",
  },
  smuggler: {
    for: "The roads have to stay open. Make peace.",
    against: "Our trucks aren't the ones getting hit.",
    abstain: "Keep it off our routes and we don't care.",
  },
  expansionist: {
    for: "A war you can't finish makes us all look weak.",
    against: "Win it or don't. Don't bring it here.",
    abstain: "We'll see who comes out of it standing.",
  },
};

function dockStanding(state: GameState, family: FamilyName, amount: number): GameState {
  if (amount <= 0) return state;
  if (family === state.playerFamily) return { ...state, influence: Math.max(0, state.influence - amount) };
  return {
    ...state,
    rivalInfluence: { ...state.rivalInfluence, [family]: Math.max(0, (state.rivalInfluence?.[family] ?? 0) - amount) },
  };
}

function standing(state: GameState, family: FamilyName): number {
  return family === state.playerFamily ? state.influence : (state.rivalInfluence?.[family] ?? 0);
}

export interface CommissionHealth {
  score: number;
  tier: string;
  /** 0..1, how much the table listens. */
  sway: number;
  parts: { standing: number; fear: number; relations: number; wealth: number };
}

/**
 * How much weight the player's family carries at the Commission: standing
 * against the strongest family, fear, relations with the living rivals, and
 * wealth against the richest. 100 is a family the table listens to.
 */
export function commissionHealth(state: GameState): CommissionHealth {
  const empty: CommissionHealth = {
    score: 0,
    tier: "Nobody at the table",
    sway: 0,
    parts: { standing: 0, fear: 0, relations: 0, wealth: 0 },
  };
  const player = state.playerFamily;
  if (!player) return empty;

  const topInfluence = Math.max(1, ...ALL_FAMILY_NAMES.map((f) => standing(state, f)));
  const standingPart = 30 * Math.min(1, state.influence / topInfluence);
  const fearPart = 20 * (state.reputation.fear / 100);
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== player && !isDefunct(state, f));
  const avg =
    rivals.length === 0
      ? 0
      : rivals.reduce((sum, f) => sum + getRelation(state.relations, player, f), 0) / rivals.length;
  const relationsPart = ((avg + 100) / 200) * 30;
  const topWealth = Math.max(1, ...ALL_FAMILY_NAMES.map((f) => familyWealth(state, f)));
  const wealthPart = 20 * Math.min(1, (state.money + state.dirtyMoney) / topWealth);
  const parts = {
    standing: Math.round(standingPart),
    fear: Math.round(fearPart),
    relations: Math.round(relationsPart),
    wealth: Math.round(wealthPart),
  };
  const score = Math.max(0, Math.min(100, parts.standing + parts.fear + parts.relations + parts.wealth));
  const tier =
    score < 25 ? "Nobody at the table" : score < 50 ? "A voice" : score < 75 ? "Respected" : "The table listens";
  return { score, tier, sway: score / 100, parts };
}

/** How far the player's weight at the table moves a lean. Positive favors him. */
function healthLean(state: GameState, caller: FamilyName, accused: FamilyName): number {
  const player = state.playerFamily;
  if (!player) return 0;
  const toward = (commissionHealth(state).sway - 0.5) * 0.4;
  if (caller === player) return toward;
  if (accused === player) return -toward;
  return 0;
}

/** Lean a lobby buys. A weak family pays the same and gets less. */
export function lobbyLean(state: GameState): number {
  return 0.35 * (0.7 + 0.6 * commissionHealth(state).sway);
}

/** Resolved hits one family landed on another in the last six weeks. */
function recentHits(state: GameState, from: FamilyName, to: FamilyName): number {
  return state.operations.filter(
    (o) =>
      o.kind === "hit" &&
      o.family === from &&
      o.targetFamily === to &&
      o.resolved &&
      (o.resolvedTurn ?? -99) > state.turn - 6,
  ).length;
}

/** Supply routes `family` runs that cross blocks `turf` owns. */
function routesThrough(state: GameState, family: FamilyName, turf: FamilyName): number {
  const owned = new Set(state.territories.filter((t) => t.owner === turf).map((t) => t.id));
  return (state.supplyRoutes ?? []).filter(
    (r) => r.family === family && r.path.some((id) => owned.has(id)),
  ).length;
}

/**
 * How a seat leans. Positive favors the caller. Relation is the bulk of it;
 * the aggressor is penalized, a seat whose trucks cross someone's turf wants
 * that someone leaned on, and standing counts for a little.
 */
export function seatLean(state: GameState, seat: FamilyName, caller: FamilyName, accused: FamilyName): number {
  const relation = (getRelation(state.relations, seat, caller) - getRelation(state.relations, seat, accused)) / 40;
  const aggression = (recentHits(state, accused, caller) - recentHits(state, caller, accused)) * 0.3;
  const routes = (routesThrough(state, seat, accused) - routesThrough(state, seat, caller)) * 0.25;
  const clout = (standing(state, caller) - standing(state, accused)) / 80;
  const grievances = (recentHits(state, accused, seat) - recentHits(state, caller, seat)) * 0.25;
  return relation + aggression + routes + clout + grievances + healthLean(state, caller, accused);
}

/** Whether a settled ruling was ignored by `family`. */
function refusedBy(ruling: CommissionRuling, family: FamilyName): boolean {
  if (ruling.kind === "war" || ruling.verdict === "deadlock") return false;
  return (
    (ruling.caller === family && ruling.callerAnswer === "refuse") ||
    (ruling.accused === family && ruling.accusedAnswer === "refuse")
  );
}

/**
 * Rulings `family` has ignored that the table still remembers: inside the
 * window, and since the last time the table went to war over it.
 */
export function defiances(state: GameState, family: FamilyName): CommissionRuling[] {
  const history = state.commissionHistory ?? [];
  const lastWar = history
    .filter((r) => r.kind === "war" && r.accused === family && r.verdict === "caller")
    .reduce((t, r) => Math.max(t, r.turn), -1);
  return history.filter(
    (r) => refusedBy(r, family) && r.turn > lastWar && r.turn > state.turn - DEFIANCE_WINDOW,
  );
}

/** The accused has actually given the caller something to bring to the table. */
export function caseAgainst(state: GameState, caller: FamilyName, target: FamilyName): boolean {
  if (caller === state.playerFamily && state.vendettas.includes(target)) return true;
  if (getRelation(state.relations, caller, target) <= -30) return true;
  return recentHits(state, target, caller) > 0;
}

/** The accused has actually given the player something to bring to the table. */
export function hasCase(state: GameState, target: FamilyName): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  return caseAgainst(state, player, target);
}

function eligibleSeats(state: GameState, caller: FamilyName, accused: FamilyName): FamilyName[] {
  return ALL_FAMILY_NAMES.filter(
    (f) => f !== caller && f !== accused && !isDefunct(state, f) && !!livingBoss(state, f),
  );
}

function livingFamilies(state: GameState): FamilyName[] {
  return ALL_FAMILY_NAMES.filter((f) => !isDefunct(state, f) && !!livingBoss(state, f));
}

/** Their richest owned block that is not already under a cut. */
export function taxBlock(state: GameState, family: FamilyName) {
  return state.territories
    .filter((t) => t.owner === family && !cutOn(state, t.id))
    .sort((a, b) => districtTake(b) - districtTake(a))[0];
}

/**
 * How the seats lean on this ask, before lobbying. Opening a call copies these
 * leans, so the forecast and the vote start from the same place.
 */
export function previewSeats(state: GameState, kind: CommissionCallKind, target: FamilyName): SeatVote[] {
  const player = state.playerFamily;
  if (!player) return [];
  return askSeats(state, kind, player, target);
}

/** The opening leans on any family's ask. The player and a rival are weighed the same way. */
export function askSeats(state: GameState, kind: CommissionCallKind, caller: FamilyName, target: FamilyName): SeatVote[] {
  const ignored = kind === "war" ? defiances(state, target) : [];
  const slighted = new Set(ignored.flatMap((r) => r.forRuling));
  const frivolous = kind !== "war" && !caseAgainst(state, caller, target);
  return eligibleSeats(state, caller, target).map((family) => {
    let lean = seatLean(state, family, caller, target);
    if (kind === "war") {
      lean += ignored.length === 0 ? WAR_UNPROVOKED_LEAN : 0.15 * ignored.length + (slighted.has(family) ? 0.15 : 0);
    } else {
      if (frivolous) lean += FRIVOLOUS_LEAN;
      if (kind === "tax") {
        lean += TAX_GREED_LEAN;
        const personality = getFamilyDef(family).personality;
        if (personality === "economic" || personality === "smuggler") lean += TAX_MERCHANT_LEAN;
      }
    }
    const extra = seatsHeld(state, family);
    return { family, lean, extra };
  });
}

export function canAsk(
  state: GameState,
  kind: CommissionCallKind,
  target: FamilyName,
): { ok: boolean; reason?: string } {
  const base = canCallCommission(state, target);
  if (!base.ok) return base;
  const player = state.playerFamily!;
  if (kind === "ruling" && truceBetween(state, player, target)) {
    return { ok: false, reason: `A truce already holds with ${target}.` };
  }
  if (kind === "war" && getRelation(state.relations, player, target) <= ALREADY_AT_WAR) {
    return { ok: false, reason: `You're already at war with ${target}.` };
  }
  if (kind === "tax" && !taxBlock(state, target)) {
    return { ok: false, reason: `${target} has no take left to tax.` };
  }
  return { ok: true };
}

export function canCallCommission(
  state: GameState,
  target: FamilyName,
): { ok: boolean; reason?: string } {
  const player = state.playerFamily;
  if (!player) return { ok: false, reason: "No family." };
  if (bossIsJailed(state, player)) return { ok: false, reason: "The boss is in the Tombs." };
  if (state.influence < COMMISSION_INFLUENCE) return { ok: false, reason: `The call costs ${COMMISSION_INFLUENCE} standing.` };
  if (state.commissionCall) return { ok: false, reason: "The Commission is already sitting on something." };
  if ((state.diplomacy?.commissionCooldown ?? 0) > state.turn) return { ok: false, reason: "Too soon to call them again." };
  if ((state.diplomacy?.sanctionUntil ?? 0) > state.turn) {
    return { ok: false, reason: "The table won't hear you. You're under sanction." };
  }
  if (eligibleSeats(state, player, target).length === 0) return { ok: false, reason: "There's no one left to sit in judgment." };
  return { ok: true };
}

function log(state: GameState, id: string, text: string): TurnLogEntry {
  return { id, turn: state.turn, category: "diplomacy", text, family: state.playerFamily ?? undefined };
}

const ASK_LOG: Record<CommissionCallKind, (target: FamilyName) => string> = {
  ruling: (target) => `You call the Commission over a truce with ${target}. It costs ${COMMISSION_INFLUENCE} standing.`,
  war: (target) => `You ask the Commission to go to war with ${target}. It costs ${COMMISSION_INFLUENCE} standing.`,
  tax: (target) => `You ask the Commission to tax ${target}. It costs ${COMMISSION_INFLUENCE} standing.`,
};

/** Spend the standing and open the call. The seats lean; the vote is at the end of the week. */
export function openCommissionCall(
  state: GameState,
  kind: CommissionCallKind,
  target: FamilyName,
): { state: GameState; log: TurnLogEntry } {
  const player = state.playerFamily;
  const check = canAsk(state, kind, target);
  if (!player || !check.ok) {
    return { state, log: log(state, `log_commission_no_${kind}_${state.turn}`, check.reason ?? "You can't call them.") };
  }

  const call: CommissionCall = {
    id: `commission_${kind}_${player}_${target}_${state.turn}`,
    turn: state.turn,
    kind: kind === "ruling" ? undefined : kind,
    caller: player,
    accused: target,
    seats: previewSeats(state, kind, target),
    lobbied: {},
    phase: "lobby",
  };
  return {
    state: {
      ...state,
      influence: state.influence - COMMISSION_INFLUENCE,
      commissionCall: call,
      diplomacy: { ...state.diplomacy, commissionCooldown: state.turn + cadence(state.seed, "commission") },
    },
    log: log(state, `log_commission_call_${call.id}`, ASK_LOG[kind](target)),
  };
}

/** A truce call. Kept so a broken sit-down can still take that one ask to the table. */
export function openCall(state: GameState, target: FamilyName): { state: GameState; log: TurnLogEntry } {
  return openCommissionCall(state, "ruling", target);
}

/** A war call. The forecast starts against you unless they have ignored a ruling. */
export function openWarCall(state: GameState, target: FamilyName): { state: GameState; log: TurnLogEntry } {
  return openCommissionCall(state, "war", target);
}

/** Whether a war ask can be made. Defiance changes the leans, not this gate. */
export function canCallWar(state: GameState, target: FamilyName): { ok: boolean; reason?: string } {
  return canAsk(state, "war", target);
}

/** Buy one seat's ear, once per call. Cash or standing; either way they lean your way. */
export function lobbySeat(
  state: GameState,
  family: FamilyName,
  kind: "cash" | "influence",
): { state: GameState; log: TurnLogEntry } {
  const call = state.commissionCall;
  const player = state.playerFamily;
  if (!call || call.phase !== "lobby" || !player) {
    return { state, log: log(state, `log_lobby_no_${state.turn}`, "There's no call open to lobby.") };
  }
  const seat = call.seats.find((s) => s.family === family);
  if (!seat) return { state, log: log(state, `log_lobby_no_${family}_${state.turn}`, `${family} isn't sitting on this.`) };
  if (call.lobbied[family]) return { state, log: log(state, `log_lobby_twice_${family}_${state.turn}`, `${family} has already been spoken to.`) };
  if (kind === "cash" && state.money < LOBBY_CASH) {
    return { state, log: log(state, `log_lobby_broke_${state.turn}`, `Lobbying costs $${LOBBY_CASH}.`) };
  }
  if (kind === "influence" && state.influence < LOBBY_INFLUENCE) {
    return { state, log: log(state, `log_lobby_broke_${state.turn}`, `Lobbying costs ${LOBBY_INFLUENCE} standing.`) };
  }

  const bought = lobbyLean(state);
  const seats = call.seats.map((s) => (s.family === family ? { ...s, lean: s.lean + bought } : s));
  return {
    state: {
      ...state,
      money: state.money - (kind === "cash" ? LOBBY_CASH : 0),
      influence: state.influence - (kind === "influence" ? LOBBY_INFLUENCE : 0),
      relations: setRelationDelta(state.relations, player, family, 5),
      commissionCall: { ...call, seats, lobbied: { ...call.lobbied, [family]: kind } },
    },
    log: log(
      state,
      `log_lobby_${family}_${state.turn}`,
      kind === "cash" ? `$${LOBBY_CASH} to ${family}. They'll hear your side.` : `${family} takes ${LOBBY_INFLUENCE} standing and leans your way.`,
    ),
  };
}

function voteLine(family: FamilyName, side: "for" | "against" | "abstain", kind: CommissionCallKind = "ruling"): string {
  const table = kind === "war" ? WAR_LINES : VOTE_LINES;
  const lines = table[getFamilyDef(family).personality] ?? table.economic!;
  return lines[side];
}

/**
 * The table decided. Every other living family drops to war with the condemned
 * one. `sitsOut` is a seat that did not back a call between two other families.
 */
function declareWar(state: GameState, condemned: FamilyName, sitsOut?: FamilyName): GameState {
  let relations = state.relations;
  for (const f of livingFamilies(state)) {
    if (f === condemned || f === sitsOut) continue;
    const now = getRelation(relations, f, condemned);
    relations = setRelation(relations, f, condemned, Math.min(now, WAR_RELATION));
  }
  return { ...state, relations };
}

/** One hit from a rival onto a man of the condemned family. The player plans his own. */
function queueWarHit(state: GameState, from: FamilyName, condemned: FamilyName, rng: Rng): GameState {
  if (from === state.playerFamily || from === condemned) return state;
  if (
    state.operations.some(
      (o) => !o.resolved && o.kind === "hit" && o.family === from && o.targetFamily === condemned,
    )
  ) {
    return state;
  }
  const ground = new Set(state.territories.filter((t) => t.owner === condemned).map((t) => t.id));
  const men = getActiveCrew(state.crew, condemned);
  const onGround = men.filter((c) => {
    const where = resolveCrewTerritoryId(state, c.id);
    return where != null && ground.has(where);
  });
  const mark = onGround.find((c) => c.role !== "boss") ?? onGround[0] ?? men.find((c) => c.role !== "boss") ?? men[0];
  if (!mark) return state;
  const where = resolveCrewTerritoryId(state, mark.id) ?? state.territories.find((t) => t.owner === condemned)?.id;
  if (!where) return state;

  const pool = rng
    .shuffle(getActiveCrew(state.crew, from).filter((c) => c.role !== "boss"))
    .sort((a, b) => b.skills.muscle - a.skills.muscle);
  if (pool.length < 1) return state;
  const wheelman = pool.find((c) => c.traits.includes("wheelman"));
  const approach = wheelman && rng.chance(0.5) ? "drive_by" : "ambush";
  const shooters = pool.filter((c) => approach !== "drive_by" || c.id !== wheelman?.id).slice(0, 2);
  if (shooters.length < 1) return state;
  const seated = bringCrewOnHit(
    state.crew,
    {
      shooterIds: shooters.map((c) => c.id),
      wheelmanId: approach === "drive_by" ? wheelman?.id : undefined,
    },
    approach,
  );
  const origin = state.territories.find((t) => t.owner === from)?.id ?? where;
  const op = planHit(
    state,
    {
      family: from,
      targetTerritoryId: where,
      targetFamily: condemned,
      targetCrewId: mark.id,
      approach,
      shooterIds: seated.shooterIds,
      wheelmanId: seated.wheelmanId,
      lookoutId: seated.lookoutId,
      originTerritoryId: origin,
      pendingTurns: 1,
      motive: "commission",
    },
    rng,
  );
  const committed = commitHitCrew(state, op);
  return { ...committed, operations: [...committed.operations, op] };
}

/**
 * The end-of-week vote on an open call. Majority rules; a tie settles nothing.
 * The ruling waits on the player's answer.
 */
export function castVotes(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const call = state.commissionCall;
  if (!call || call.phase !== "lobby") return { state, logs: [] };
  if (call.thirdParty && call.turn >= state.turn) return { state, logs: [] };

  // A family that fell while the call was open has nothing left to answer for.
  const gone = [call.caller, call.accused].find((f) => isDefunct(state, f));
  if (gone) {
    const refund =
      call.caller === gone
        ? state
        : call.caller === state.playerFamily
          ? { ...state, influence: state.influence + COMMISSION_INFLUENCE }
          : {
              ...state,
              rivalInfluence: {
                ...state.rivalInfluence,
                [call.caller]: (state.rivalInfluence?.[call.caller] ?? 0) + COMMISSION_INFLUENCE,
              },
            };
    return {
      state: { ...refund, commissionCall: null },
      logs: [
        log(
          state,
          `log_commission_lapsed_${call.id}`,
          `The call on ${call.accused} lapses. ${gone} is no longer a family.${call.caller === gone ? "" : ` ${call.caller === state.playerFamily ? "You get" : `${call.caller} gets`} the ${COMMISSION_INFLUENCE} standing back.`}`,
        ),
      ],
    };
  }

  const kind: CommissionCallKind = call.kind ?? "ruling";
  const player = state.playerFamily;
  let relations = state.relations;
  if (call.thirdParty && player && call.pledge && call.pledge !== "abstain") {
    const backed = call.pledge === "caller" ? call.caller : call.accused;
    const other = call.pledge === "caller" ? call.accused : call.caller;
    relations = setRelationDelta(setRelationDelta(relations, player, backed, PLEDGE_RELATION), player, other, -PLEDGE_RELATION);
  }
  const pledged: GameState = relations === state.relations ? state : { ...state, relations };
  const seats: SeatVote[] = call.seats.filter((s) => !isDefunct(state, s.family)).map((s) => {
    if (call.thirdParty && s.family === player) {
      const vote = call.pledge ?? "abstain";
      const side = vote === "caller" ? "for" : vote === "accused" ? "against" : "abstain";
      const line = vote === "abstain" ? "The seat stays out of it." : voteLine(s.family, side, kind);
      return { ...s, lean: vote === "caller" ? 0.8 : vote === "accused" ? -0.8 : 0, vote, line };
    }
    const lean = s.lean + (rng.next() - 0.5) * 0.2;
    const vote = lean > 0.2 ? "caller" : lean < -0.2 ? "accused" : "abstain";
    const side = vote === "caller" ? "for" : vote === "accused" ? "against" : "abstain";
    return { ...s, lean, vote, line: voteLine(s.family, side, kind) };
  });
  const weight = (s: SeatVote) => 1 + (s.vote === "abstain" ? 0 : (s.extra ?? seatVotes(state, s.family, s.vote ?? "abstain")));
  let forCaller = seatVotes(state, call.caller, "caller");
  let against = seatVotes(state, call.accused, "accused");
  for (const s of seats) {
    if (s.vote === "caller") forCaller += weight(s);
    if (s.vote === "accused") against += weight(s);
  }
  const verdict = forCaller > against ? "caller" : against > forCaller ? "accused" : "deadlock";

  // War: the seats that said yes put their guns behind the caller. Nothing to accept.
  if (kind === "war") {
    const backers = seats.filter((s) => s.vote === "caller").map((s) => s.family);
    const ruling: CommissionRuling = {
      id: call.id,
      turn: state.turn,
      kind: "war",
      caller: call.caller,
      accused: call.accused,
      forCaller,
      against,
      terms: { cash: 0, standing: 0, weeks: 0 },
      verdict,
      forRuling: verdict === "caller" ? backers : [],
    };
    let next: GameState = { ...pledged, commissionCall: { ...call, seats, phase: "voted", ruling } };
    const logs: TurnLogEntry[] = [];
    if (verdict === "caller") {
      // On a call between two rivals the player goes to war only if his seat backed it.
      const sitsOut = call.thirdParty && player && call.pledge !== "caller" ? player : undefined;
      next = declareWar(next, call.accused, sitsOut);
      const moving: FamilyName[] = [];
      for (const family of livingFamilies(next)) {
        if (family === call.accused || family === next.playerFamily) continue;
        const before = next.operations.length;
        next = queueWarHit(next, family, call.accused, rng);
        if (next.operations.length > before) moving.push(family);
      }
      logs.push(
        log(
          state,
          `log_commission_war_${call.id}`,
          moving.length > 0
            ? `The Commission goes to war with ${call.accused}. ${moving.join(", ")} are moving on them.`
            : `The Commission goes to war with ${call.accused}. Nobody had a crew free to send.`,
        ),
      );
    } else {
      const playerCalled = call.caller === state.playerFamily;
      next = {
        ...next,
        reputation: playerCalled
          ? { ...next.reputation, respect: Math.max(0, next.reputation.respect - 3) }
          : next.reputation,
        relations: setRelationDelta(next.relations, call.caller, call.accused, -5),
      };
      logs.push(
        log(
          state,
          `log_commission_war_${call.id}`,
          verdict === "deadlock"
            ? playerCalled
              ? `The Commission deadlocks on war with ${call.accused}. You asked for guns and got silence.`
              : `The Commission deadlocks on ${call.caller}'s ask for guns on ${call.accused}.`
            : playerCalled
              ? `The Commission won't follow you into a war with ${call.accused}. It costs you face.`
              : `The Commission won't follow ${call.caller} into a war with ${call.accused}.`,
        ),
      );
    }
    return handOff(next, call, ruling, logs, rng);
  }

  if (kind === "tax") {
    const weeks = TRUCE_DEFAULT_WEEKS;
    const loser = verdict === "deadlock" ? null : verdict === "caller" ? call.accused : call.caller;
    const block = loser ? taxBlock(state, loser) : undefined;
    const terms: AgendaTerms = {
      cash: 0,
      standing: 0,
      weeks,
      territoryId: block?.id,
      share: block ? CUT_DEFAULT_SHARE : undefined,
    };
    const forRuling = seats
      .filter((s) => (verdict === "deadlock" ? false : s.vote === (verdict === "caller" ? "caller" : "accused")))
      .map((s) => s.family);
    const ruling: CommissionRuling = {
      id: call.id,
      turn: state.turn,
      kind: "tax",
      caller: call.caller,
      accused: call.accused,
      forCaller,
      against,
      terms,
      verdict,
      forRuling,
    };
    let next: GameState = { ...pledged, commissionCall: { ...call, seats, phase: "voted", ruling } };
    const pct = Math.round(CUT_DEFAULT_SHARE * 100);
    const logs = [
      log(
        state,
        `log_commission_tax_${call.id}`,
        verdict === "deadlock"
          ? `The Commission deadlocks on taxing ${call.accused}. Nothing is settled.`
          : block
            ? `The Commission taxes ${loser}: ${pct}% of ${block.name} for ${weeks} weeks, and the guns go down.`
            : `The Commission orders the guns down with ${call.accused} for ${weeks} weeks. ${loser} has no take left to tax.`,
      ),
    ];
    if (verdict === "deadlock" && call.caller === state.playerFamily) {
      next = {
        ...next,
        reputation: { ...next.reputation, respect: Math.max(0, next.reputation.respect - 2) },
      };
    }
    return handOff(next, call, ruling, logs, rng);
  }

  const loser = verdict === "caller" ? call.accused : call.caller;
  const weeks = TRUCE_DEFAULT_WEEKS;
  // The loser pays, more for every recent hit he landed. A deadlock names no price.
  const hits = verdict === "deadlock" ? 0 : recentHits(state, loser, verdict === "caller" ? call.caller : call.accused);
  const cash = verdict === "deadlock" ? 0 : 200 + hits * 150;
  // Signed from the player's side: positive means the player pays it.
  const terms: AgendaTerms = { cash: loser === state.playerFamily ? cash : -cash, standing: 0, weeks };
  const forRuling = seats.filter((s) => (verdict === "deadlock" ? false : s.vote === (verdict === "caller" ? "caller" : "accused"))).map((s) => s.family);

  const ruling: CommissionRuling = {
    id: call.id,
    turn: state.turn,
    caller: call.caller,
    accused: call.accused,
    forCaller,
    against,
    terms,
    verdict,
    forRuling,
  };

  let next: GameState = { ...pledged, commissionCall: { ...call, seats, phase: "voted", ruling } };
  const logs = [
    log(
      state,
      `log_commission_vote_${call.id}`,
      verdict === "deadlock"
        ? `The Commission deadlocks on the trouble between ${call.caller} and ${call.accused}. Nothing is settled.`
        : `The Commission rules for ${verdict === "caller" ? call.caller : call.accused} over the trouble with ${call.accused}: guns down for ${weeks} weeks${cash > 0 ? `, $${cash} from ${loser}` : ""}.`,
    ),
  ];
  if (verdict === "deadlock") {
    if (call.caller === state.playerFamily) {
      next = {
        ...next,
        reputation: { ...next.reputation, respect: Math.max(0, next.reputation.respect - 2) },
      };
    }
  } else if (
    call.caller === state.playerFamily &&
    verdict === "accused" &&
    !hasCase(state, call.accused)
  ) {
    next = {
      ...next,
      reputation: { ...next.reputation, respect: Math.max(0, next.reputation.respect - 3) },
    };
    logs.push(
      log(state, `log_commission_frivolous_${call.id}`, "You had no case. The table takes it out of your respect."),
    );
  }
  return handOff(next, call, ruling, logs, rng);
}

/** Whether the rival accepts a ruling that went against, or for, them. */
function rivalAccepts(state: GameState, family: FamilyName, ruling: CommissionRuling): boolean {
  if (ruling.verdict === "deadlock") return false;
  const won = (ruling.verdict === "caller") === (family === ruling.caller);
  if (won) return true;
  const personality = getFamilyDef(family).personality;
  const seats = ruling.forRuling;
  const avg = seats.length === 0 ? 0 : seats.reduce((sum, f) => sum + getRelation(state.relations, family, f), 0) / seats.length;
  const losing = family === state.playerFamily ? 0 : bleeding(state, family);
  if (losing >= 2) return true;
  const player = state.playerFamily;
  const playerParty = !!player && (player === ruling.caller || player === ruling.accused);
  const playerWon = playerParty && (ruling.verdict === "caller") === (player === ruling.caller);
  const bar = playerWon ? -10 - 20 * commissionHealth(state).sway : -10;
  return avg > bar && personality !== "volatile";
}

/** The seat that carried the ruling, and so delivers the message. */
function messenger(call: CommissionCall, ruling: CommissionRuling): FamilyName | undefined {
  const sided = call.seats.filter((s) => ruling.forRuling.includes(s.family));
  return sided.sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean))[0]?.family;
}

/** A warning hit on one of the refuser's men. Never the boss. */
function sendMessage(state: GameState, from: FamilyName, refuser: FamilyName, rng: Rng): GameState {
  const target = pickMessageTarget(state, refuser);
  if (!target) return state;
  const where = resolveCrewTerritoryId(state, target.id);
  if (!where) return state;
  const pool = rng
    .shuffle(getActiveCrew(state.crew, from).filter((c) => c.role !== "boss"))
    .sort((a, b) => b.skills.muscle - a.skills.muscle);
  if (pool.length < 2) return state;
  const wheelman = pool.find((c) => c.traits.includes("wheelman"));
  const approach = wheelman && rng.chance(0.6) ? "drive_by" : "ambush";
  const shooters = pool.filter((c) => approach !== "drive_by" || c.id !== wheelman?.id).slice(0, 2);
  if (shooters.length < 1) return state;
  const seated = bringCrewOnHit(
    state.crew,
    {
      shooterIds: shooters.map((c) => c.id),
      wheelmanId: approach === "drive_by" ? wheelman?.id : undefined,
    },
    approach,
  );
  const origin = state.territories.find((t) => t.owner === from)?.id ?? where;
  const op = planHit(
    state,
    {
      family: from,
      targetTerritoryId: where,
      targetFamily: refuser,
      targetCrewId: target.id,
      approach,
      shooterIds: seated.shooterIds,
      wheelmanId: seated.wheelmanId,
      lookoutId: seated.lookoutId,
      originTerritoryId: origin,
      pendingTurns: 1,
      intent: "commission_message",
      motive: "commission",
    },
    rng,
  );
  const committed = commitHitCrew(state, op);
  return { ...committed, operations: [...committed.operations, op] };
}

/**
 * The player's answer to a ruling. The other side answers for itself. Both
 * accepting strikes the truce; a refusal costs relations with every seat that
 * voted for it, and the table may send a message.
 */
export function answerRuling(
  state: GameState,
  answer: "accept" | "refuse",
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const call = state.commissionCall;
  const ruling = call?.ruling ?? state.pendingRulings?.[0];
  const player = state.playerFamily;
  if (!ruling || !player) return { state, logs: [] };
  const logs: TurnLogEntry[] = [];

  // A tie settles nothing. The respect was already docked when the vote was counted.
  // A war vote was carried out when it was counted; the card only tells him.
  if (ruling.verdict === "deadlock" || ruling.kind === "war") {
    const settled: CommissionRuling = { ...ruling, callerAnswer: "accept", accusedAnswer: "accept" };
    return {
      state: {
        ...state,
        commissionCall: null,
        commissionHistory: [...(state.commissionHistory ?? []), settled],
        pendingRulings: (state.pendingRulings ?? []).filter((r) => r.id !== ruling.id),
      },
      logs: [],
    };
  }

  const playerIsCaller = ruling.caller === player;
  const rival = playerIsCaller ? ruling.accused : ruling.caller;
  const rivalAnswer = rivalAccepts(state, rival, ruling) ? "accept" : "refuse";
  const callerAnswer = playerIsCaller ? answer : rivalAnswer;
  const accusedAnswer = playerIsCaller ? rivalAnswer : answer;
  return applyRuling(state, ruling, callerAnswer, accusedAnswer, rng, { call, playerRefused: answer === "refuse" });
}

/**
 * Standing, defiance and sanction for a counted ruling. The player path and a
 * rival calling on a rival both come through here.
 */
function applyRuling(
  state: GameState,
  ruling: CommissionRuling,
  callerAnswer: "accept" | "refuse",
  accusedAnswer: "accept" | "refuse",
  rng: Rng,
  opts: { call?: CommissionCall | null; playerRefused?: boolean },
): { state: GameState; logs: TurnLogEntry[] } {
  const player = state.playerFamily;
  const call = opts.call ?? null;
  const logs: TurnLogEntry[] = [];
  const settled: CommissionRuling = { ...ruling, callerAnswer, accusedAnswer };
  const playerParty = !!player && (player === ruling.caller || player === ruling.accused);
  const other = player === ruling.caller ? ruling.accused : ruling.caller;

  let next = state;
  if (ruling.verdict !== "deadlock" && ruling.kind !== "war") {
    const loser = ruling.verdict === "caller" ? ruling.accused : ruling.caller;
    next = dockStanding(next, loser, RULING_STANDING);
    logs.push(log(state, `log_commission_standing_${ruling.id}`, `${loser} loses ${RULING_STANDING} standing on the ruling.`));
  }
  const both = callerAnswer === "accept" && accusedAnswer === "accept";
  if (both && ruling.kind === "tax" && playerParty && player) {
    const weeks = ruling.terms.weeks ?? TRUCE_DEFAULT_WEEKS;
    if (!truceBetween(next, player, other)) {
      const struck = makeDeal(next, "truce", other, { cash: 0, standing: 0, weeks }, { weeks, rng });
      next = { ...struck.state, relations: setRelationDelta(struck.state.relations, player, other, 5) };
    }
    const block = ruling.terms.territoryId
      ? next.territories.find((t) => t.id === ruling.terms.territoryId)
      : undefined;
    if (block && ruling.terms.share && (block.owner === player || block.owner === other)) {
      const payer = block.owner === player ? player : other;
      const struck = makeDeal(
        next,
        "cut",
        other,
        { ...ruling.terms, weeks, share: ruling.terms.share, territoryId: block.id },
        { obligor: payer, weeks, rng },
      );
      next = struck.state;
      const pct = Math.round((ruling.terms.share ?? 0) * 100);
      logs.push(
        log(
          state,
          `log_commission_tax_deal_${ruling.id}`,
          payer === player
            ? `Guns down with ${other} for ${weeks} weeks. ${pct}% of ${block.name}'s take goes to them.`
            : `Guns down with ${other} for ${weeks} weeks. ${pct}% of ${block.name}'s take comes to you.`,
        ),
      );
    } else {
      logs.push(log(state, `log_commission_tax_deal_${ruling.id}`, `Guns down with ${other} for ${weeks} weeks.`));
    }
  } else if (both && ruling.kind === "tax") {
    const loser = ruling.verdict === "caller" ? ruling.accused : ruling.caller;
    const winner = loser === ruling.caller ? ruling.accused : ruling.caller;
    const paid = Math.floor((next.rivalTreasury?.[loser] ?? 0) * RIVAL_TAX_SHARE);
    next = {
      ...next,
      rivalTreasury: {
        ...(next.rivalTreasury ?? {}),
        [loser]: Math.max(0, (next.rivalTreasury?.[loser] ?? 0) - paid),
        [winner]: (next.rivalTreasury?.[winner] ?? 0) + paid,
      },
    };
    const signed = signRivalPact(next, ruling.caller, ruling.accused, "truce", ruling.terms.weeks ?? TRUCE_DEFAULT_WEEKS);
    next = signed.state;
    logs.push(signed.log);
    logs.push(
      log(state, `log_commission_tax_deal_${ruling.id}`, `${loser} pays ${winner} $${paid} on the tax, and the guns go down.`),
    );
  } else if (both && !playerParty) {
    const signed = signRivalPact(next, ruling.caller, ruling.accused, "truce", ruling.terms.weeks ?? TRUCE_DEFAULT_WEEKS);
    next = signed.state;
    logs.push(signed.log);
  } else if (both && player) {
    const applied = applyAgendaTerms(next, other, "truce", ruling.terms, rng);
    next = applied.state;
    logs.push(log(state, `log_commission_truce_${ruling.id}`, applied.lines.join(" ") || `The truce with ${other} holds.`));
  }

  const refusers: FamilyName[] = [];
  if (callerAnswer === "refuse") refusers.push(ruling.caller);
  if (accusedAnswer === "refuse") refusers.push(ruling.accused);

  for (const refuser of refusers) {
    next = dockStanding(next, refuser, DEFIANCE_STANDING);
    for (const seat of ruling.forRuling) {
      next = { ...next, relations: setRelationDelta(next.relations, refuser, seat, REFUSAL_RELATION) };
    }
    logs.push(
      log(state, `log_commission_refuse_${refuser}_${ruling.id}`, `${refuser} refuses the Commission's ruling. The seats that voted for it take it badly.`),
    );
  }

  for (const refuser of refusers) {
    if (refuser === player) continue;
    if (defiances(state, refuser).length + 1 < 2) continue;
    next = {
      ...next,
      diplomacy: {
        ...next.diplomacy,
        rivalSanctions: { ...(next.diplomacy.rivalSanctions ?? {}), [refuser]: state.turn + SANCTION_WEEKS },
      },
    };
    logs.push(
      log(state, `log_commission_rival_sanction_${refuser}_${state.turn}`, `${refuser} is under sanction for ${SANCTION_WEEKS} weeks. The table won't hear them.`),
    );
  }

  if (opts.playerRefused && playerParty) {
    const refusals = (next.diplomacy?.refusals ?? 0) + 1;
    let diplomacy = { ...next.diplomacy, refusals };
    if (refusals >= 2) {
      diplomacy = { ...diplomacy, sanctionUntil: state.turn + SANCTION_WEEKS };
      for (const seat of ruling.forRuling) next = withCooldown(next, seat, SANCTION_WEEKS);
      logs.push(
        log(state, `log_commission_sanction_${state.turn}`, `Twice you've defied the table. For ${SANCTION_WEEKS} weeks, no family will sit down with you.`),
      );
    }
    next = { ...next, diplomacy };
  }

  const lobbiedForRuling = call ? ruling.forRuling.filter((f) => call.lobbied[f]).length : 0;
  for (const refuser of refusers) {
    const prior = refuser === player ? (state.diplomacy?.refusals ?? 0) : defiances(state, refuser).length;
    const weight = refuser === player ? 0.2 * commissionHealth(state).sway : 0;
    const softened = refuser === player ? 0.1 * lobbiedForRuling : 0;
    const chance = Math.max(0, MESSAGE_BASE + MESSAGE_REFUSAL_STEP * prior - softened - weight);
    if (ruling.forRuling.length > 0 && rng.chance(chance)) {
      const from = (call ? messenger(call, ruling) : undefined) ?? ruling.forRuling[0];
      if (!from) continue;
      const sent = sendMessage(next, from, refuser, rng);
      if (sent !== next) {
        next = sent;
        settled.messageSent = from;
        logs.push(log(state, `log_commission_message_${refuser}_${state.turn}`, `The table sends a message. ${from} moves on one of ${refuser}'s men.`));
      }
    } else if (refuser !== player && prior > 0) {
      logs.push(
        log(
          state,
          `log_commission_defiance_${refuser}_${state.turn}`,
          `${refuser} has now ignored the table ${prior + 1} times. The seats remember.`,
        ),
      );
    }
  }

  const line = logs[logs.length - 1];
  const headlines =
    call?.thirdParty && line
      ? [...(next.headlines ?? []), { ...line, id: `headline_${line.id}` }].slice(-100)
      : next.headlines;
  return {
    state: {
      ...next,
      headlines,
      commissionCall: null,
      commissionHistory: [...(next.commissionHistory ?? []), settled],
      pendingRulings: (next.pendingRulings ?? []).filter((r) => r.id !== ruling.id),
    },
    logs,
  };
}

/** A third-party call is settled the week it is counted. The player's card is not it. */
function handOff(
  state: GameState,
  call: CommissionCall,
  ruling: CommissionRuling,
  logs: TurnLogEntry[],
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  if (!call.thirdParty) {
    return { state: { ...state, pendingRulings: [...(state.pendingRulings ?? []), ruling] }, logs };
  }
  if (ruling.kind === "war" || ruling.verdict === "deadlock") {
    const settled: CommissionRuling = { ...ruling, callerAnswer: "accept", accusedAnswer: "accept" };
    const line = logs[logs.length - 1];
    return {
      state: {
        ...state,
        commissionCall: null,
        commissionHistory: [...(state.commissionHistory ?? []), settled],
        headlines: line ? [...(state.headlines ?? []), { ...line, id: `headline_${line.id}` }].slice(-100) : state.headlines,
      },
      logs,
    };
  }
  const callerAnswer = rivalAccepts(state, ruling.caller, ruling) ? "accept" : "refuse";
  const accusedAnswer = rivalAccepts(state, ruling.accused, ruling) ? "accept" : "refuse";
  const finished = applyRuling(state, ruling, callerAnswer, accusedAnswer, rng, { call });
  return { state: finished.state, logs: [...logs, ...finished.logs] };
}

/**
 * A rival who's being ground down calls the Commission on the player. The vote
 * is cast at once; the player answers from the card.
 */
export function aiCallCommission(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const player = state.playerFamily;
  if (!player || family === player) return { state, logs: [] };
  if (state.commissionCall || (state.pendingRulings?.length ?? 0) > 0) return { state, logs: [] };
  if (getFamilyDef(family).personality === "volatile") return { state, logs: [] };
  if (bleeding(state, family) < 3) return { state, logs: [] };
  if (standing(state, family) < COMMISSION_INFLUENCE) return { state, logs: [] };
  if (!livingBoss(state, family) || bossIsJailed(state, player)) return { state, logs: [] };
  if (!rng.chance(0.08 * (1.25 - 0.5 * commissionHealth(state).sway))) return { state, logs: [] };
  const seats = eligibleSeats(state, family, player);
  if (seats.length === 0) return { state, logs: [] };

  const call: CommissionCall = {
    id: `commission_${family}_${player}_${state.turn}`,
    turn: state.turn,
    caller: family,
    accused: player,
    seats: seats.map((f) => ({ family: f, lean: seatLean(state, f, family, player) })),
    lobbied: {},
    phase: "lobby",
  };
  const opened: GameState = {
    ...state,
    rivalInfluence: { ...state.rivalInfluence, [family]: standing(state, family) - COMMISSION_INFLUENCE },
    commissionCall: call,
  };
  const voted = castVotes(opened, rng);
  return {
    state: voted.state,
    logs: [log(state, `log_commission_called_${call.id}`, `${family} calls the Commission over the trouble with you.`), ...voted.logs],
  };
}

const TRACK_KIND = { influence: "ruling", wealth: "tax", turf: "war" } as const;

/** Whether the table would hear `family` on `target` this week. The same gates the player's call has. */
export function canPetition(state: GameState, family: FamilyName, target: FamilyName): boolean {
  if (family === target || family === state.playerFamily) return false;
  if (state.commissionCall || (state.pendingRulings?.length ?? 0) > 0) return false;
  if ((state.diplomacy.rivalCallCooldown?.[family] ?? 0) > state.turn) return false;
  if ((state.diplomacy.rivalSanctions?.[family] ?? 0) > state.turn) return false;
  if (standing(state, family) < COMMISSION_INFLUENCE) return false;
  if (isDefunct(state, family) || isDefunct(state, target)) return false;
  if (!livingBoss(state, family) || !livingBoss(state, target)) return false;
  if (bossIsJailed(state, family)) return false;
  if (target === state.playerFamily && bossIsJailed(state, target)) return false;
  return eligibleSeats(state, family, target).length > 0;
}

/**
 * How a rival reads the room before it spends standing on a call: votes for
 * less votes against, from the opening leans. The player's seat is left out.
 */
export function petitionMargin(state: GameState, family: FamilyName, target: FamilyName, kind: CommissionCallKind): number {
  let margin = seatVotes(state, family, "caller") - seatVotes(state, target, "accused");
  for (const s of askSeats(state, kind, family, target)) {
    if (s.family === state.playerFamily) continue;
    const weight = 1 + (s.extra ?? 0);
    if (s.lean > 0.2) margin += weight;
    else if (s.lean < -0.2) margin -= weight;
  }
  return margin;
}

/**
 * A rival asks the table to answer a family pulling ahead. A call on the player
 * is voted the same week. A call on another rival waits a week for the player's seat.
 */
export function aiPetition(
  state: GameState,
  family: FamilyName,
  target: FamilyName,
  kind: CommissionCallKind,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  if (!canPetition(state, family, target)) return { state, logs: [] };
  const seats = askSeats(state, kind, family, target);
  const thirdParty = target !== state.playerFamily;
  const track = (Object.entries(TRACK_KIND).find(([, k]) => k === kind)?.[0] ?? "influence") as CommissionCall["track"];
  const call: CommissionCall = {
    id: `commission_${family}_${target}_${state.turn}`,
    turn: state.turn,
    kind,
    caller: family,
    accused: target,
    seats,
    lobbied: {},
    phase: "lobby",
    thirdParty,
    pledge: thirdParty ? "abstain" : undefined,
    track,
  };
  const opened: GameState = {
    ...state,
    rivalInfluence: { ...state.rivalInfluence, [family]: standing(state, family) - COMMISSION_INFLUENCE },
    diplomacy: {
      ...state.diplomacy,
      rivalCallCooldown: { ...(state.diplomacy.rivalCallCooldown ?? {}), [family]: state.turn + COMMISSION_COOLDOWN },
    },
    commissionCall: call,
  };
  const why =
    kind === "war"
      ? `${family} asks the Commission for guns on ${target}.`
      : kind === "tax"
        ? `${family} asks the Commission to tax ${target}.`
        : `${family} calls the Commission on ${target}.`;
  const openedLog = log(state, `log_commission_petition_${call.id}`, why);
  if (thirdParty) return { state: opened, logs: [openedLog] };
  const voted = castVotes(opened, rng);
  return { state: voted.state, logs: [openedLog, ...voted.logs] };
}

/** The player's seat on a call between two rivals. Abstaining is the default. */
export function pledgeSeat(
  state: GameState,
  side: "caller" | "accused" | "abstain",
): { state: GameState; log: TurnLogEntry } {
  const call = state.commissionCall;
  const player = state.playerFamily;
  if (!call?.thirdParty || call.phase !== "lobby" || !player) {
    return { state, log: log(state, `log_pledge_none_${state.turn}`, "There is no call waiting on your seat.") };
  }
  const word = side === "caller" ? call.caller : side === "accused" ? call.accused : "neither side";
  return {
    state: { ...state, commissionCall: { ...call, pledge: side } },
    log: log(state, `log_pledge_${call.id}_${side}`, `Your seat backs ${word}.`),
  };
}

/** Drop a call that's been answered and let a lapsed sanction fall away in the log. */
export function expireCommission(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  let next = state;
  if (next.commissionCall?.phase === "answered") next = { ...next, commissionCall: null };
  return { state: next, logs };
}
