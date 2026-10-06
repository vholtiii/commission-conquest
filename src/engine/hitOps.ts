import type {
  CrewMember,
  FamilyName,
  GameState,
  HitApproach,
  HitBeat,
  HitComplication,
  HitCasualtyDetail,
  HitCinematic,
  HitPerspective,
  HitOutcome,
  HitResult,
  LookoutOutcome,
  LookoutReport,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import { CAR_BOMB_ARMED_MAX_TURNS } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { approachSpec, exposedCrewIds, hitCrewIds } from "@/data/hitApproaches";
import type { Rng } from "./rng";
import { aggregateTraitEffects, assignCrew, bumpLoyalty, crewCombatScore, funeralLoyaltyHit, grantXpToCrew } from "./crew";
import { unseatedCrew } from "./crews";
import { jailInCrew } from "./jail";
import { setRelationDelta } from "./relations";
import { crewPresentIn, familyHq, resolveCrewTerritoryId } from "./crewLocation";
import { safehouseCapacity } from "./safehouse";
import { isLegitBusiness } from "./economy";
import { emptyIntel, hasFreshCasing, recordIntel } from "./intel";
import { coverFire, getawayCover, isLaidLow, laidLowHouse, safehouseHitPenalty } from "./safehouse";
import { buildLookoutReport, runCasing, rungToOutcome, type CasingResult } from "./lookout";
import { applySuccession } from "./succession";
import { territoryHops } from "./territoryHops";
import { isDefunct, scatterFamily, settleRivalChair } from "./defection";
import { declareMourning, handsDown } from "./mourning";

export { territoryHops };
import {
  mattressDistrict,
  mattressLeaked,
  mattressesActive,
  mattressSoldierBonus,
  noteMattressWindow,
  MATTRESS_DISTRICT_RISK,
  MATTRESS_HIT_RISK,
} from "./mattresses";
import {
  ALERT_TURNS,
  BURN_TURNS,
  GRUDGE_TURNS,
  HELD_TURNS,
  cluesFor,
  findClue,
  garrisonWindowReduction,
  isDistrictAlerted,
  isLookoutBurned,
  lastName,
  clueHolds,
} from "./casing";
import { addEvidence, applyRetaliationJudgment, makeEvidence, openIncidentFromHit } from "./incidents";
import { learnFromCleanCasing } from "./crews";
import { hasPact, breakPact } from "./diplomacy";
import { LEVERAGE_TURNS, clearPassageGrudges } from "./passage";
import { aiDemandPassageSitdown } from "./sitdowns";

/**
 * A rival's message has been sent (landed or not): the grudges behind it are
 * spent, the family goes on cooldown, and — if both bosses still stand — they
 * ask the player to their table to settle the trucks on their terms.
 */
function afterAiMessageHit(
  state: GameState,
  op: Operation,
  landed: boolean,
  rng: Rng,
): GameState {
  let next = clearPassageGrudges(state, op.family);
  next = {
    ...next,
    messageHitTurns: { ...next.messageHitTurns, [op.family]: state.turn },
  };
  const invite = aiDemandPassageSitdown(next, op.family, rng, landed);
  next = invite.state;
  if (invite.log) next = { ...next, turnLog: [...next.turnLog, invite.log].slice(-200) };
  return next;
}

/** Odds options: `truth` ignores poisoned clues (used when a hit actually resolves). */
export interface OddsOptions {
  truth?: boolean;
}

/** Clue bookkeeping only applies to the player's own operations. */
function usesClues(state: GameState, op: Operation): boolean {
  return !!state.playerFamily && op.family === state.playerFamily;
}

const APPROACH_MODS: Record<
  HitApproach,
  { stealth: number; power: number; heat: number; betrayal?: boolean }
> = {
  ambush: { stealth: 0.15, power: 0.1, heat: 8 },
  drive_by: { stealth: -0.05, power: 0.05, heat: 12 },
  car_bomb: { stealth: 0.05, power: 0.25, heat: 20 },
  sitdown_betrayal: { stealth: 0.25, power: 0.15, heat: 6, betrayal: true },
  summons: { stealth: 0.3, power: 0.1, heat: 5 },
};

export type HitXpSeat = "lead" | "shooter" | "support";

/** XP when a casing report comes in. The lookout is already home before the weekly ticker. */
export const CASING_REPORT_XP = 10;

/**
 * The strongest shooter is the lead. One gun, and he is the lead.
 * A tie keeps the man listed first. Everyone else on the job is support:
 * wheelman, lookout, bomb maker, planter, negotiator.
 */
export function hitXpSeat(
  op: Pick<Operation, "shooterIds">,
  crewId: string,
  crew: CrewMember[],
  state?: Pick<GameState, "mattresses" | "turn">,
): HitXpSeat {
  if (!op.shooterIds.includes(crewId)) return "support";
  let leadId = op.shooterIds[0] ?? crewId;
  let best = -Infinity;
  for (const id of op.shooterIds) {
    const member = crew.find((c) => c.id === id);
    const score = member ? crewCombatScore(member, state ? mattressSoldierBonus(state, member) : 0) : -Infinity;
    if (score > best) {
      best = score;
      leadId = id;
    }
  }
  return crewId === leadId ? "lead" : "shooter";
}

/** Lead gun 30/50, other shooters 20/35, the wheel and the rest of the crew 15/25. */
export function hitResolveXp(targetDead: boolean, seat: HitXpSeat = "lead"): number {
  if (seat === "lead") return targetDead ? 50 : 30;
  if (seat === "shooter") return targetDead ? 35 : 20;
  return targetDead ? 25 : 15;
}

/** Diminishing returns for additional shooters (best first). */
const SHOOTER_WEIGHTS = [1, 0.6, 0.35, 0.2, 0.1, 0.05];

export interface HitOddsBreakdown {
  total: number;
  base: number;
  roles: number;
  target: number;
  district: number;
  garrison: number;
  getaway: number;
  tippedOff: number;
  intel: number;
  heat: number;
  approach: number;
  other: number;
  /** Sit-down fear bonus (subset of other). */
  fear: number;
}

function findCrew(state: GameState, id?: string): CrewMember | undefined {
  if (!id) return undefined;
  return state.crew.find((c) => c.id === id);
}

/** Active garrison soldiers of the target family in the hit district (excludes the mark). */
export function defendersFor(state: GameState, op: Operation, opts?: OddsOptions): number {
  const territory = state.territories.find((t) => t.id === op.targetTerritoryId);
  if (!territory) return 0;
  // Only count when the district belongs to the target family
  if (territory.owner !== op.targetFamily) return 0;
  const raw = territory.garrisonIds.filter((id) => {
    if (id === op.targetCrewId) return false;
    const c = state.crew.find((m) => m.id === id);
    return !!c && c.status === "active" && c.family === op.targetFamily;
  }).length;
  if (!usesClues(state, op)) return raw;
  // A garrison-window clue thins the block on its turn (unless it was planted).
  const reduction = garrisonWindowReduction(state, op.targetTerritoryId, {
    includePoisoned: !opts?.truth,
  });
  return Math.max(0, raw - reduction);
}

export function getawayRisk(state: GameState, op: Operation, opts?: OddsOptions): number {
  let hops = territoryHops(state, op.originTerritoryId, op.targetTerritoryId);
  if (usesClues(state, op)) {
    const getaway = findClue(state, op.targetTerritoryId, "getaway");
    if (clueHolds(getaway, opts?.truth)) hops = Math.max(1, hops - (getaway.value ?? 1));
  }
  const wheelman = findCrew(state, op.wheelmanId);
  const driving = wheelman?.skills.driving ?? 0;
  let raw = (hops - 1) * 0.08 - driving / 250;
  // A safehouse near the job is a door to run through.
  const cover = getawayCover(state, op.family, op.targetTerritoryId);
  if (cover) raw -= cover.bonus;
  return Math.max(-0.1, Math.min(0.3, raw));
}

/**
 * Defenders plus the men shooting from a nearby safehouse: what the hit team
 * faces after the shot, as opposed to what stands between them and the mark.
 */
export function firefightStrength(
  state: GameState,
  op: Operation,
  opts?: OddsOptions,
): { defenders: number; cover: ReturnType<typeof coverFire>; total: number } {
  const defenders = defendersFor(state, op, opts);
  const cover = coverFire(state, op.targetFamily, op.targetTerritoryId);
  return { defenders, cover, total: defenders + cover.weight };
}

function weightedShooterBonus(
  state: GameState,
  shooterIds: string[],
  combatDivisor: number,
): number {
  const contribs = shooterIds
    .map((id) => {
      const s = findCrew(state, id);
      if (!s) return 0;
      const traits = aggregateTraitEffects(s.traits);
      return crewCombatScore(s, mattressSoldierBonus(state, s)) / combatDivisor + traits.hitMod;
    })
    .sort((a, b) => b - a);
  let total = 0;
  for (let i = 0; i < contribs.length; i++) {
    const w = SHOOTER_WEIGHTS[Math.min(i, SHOOTER_WEIGHTS.length - 1)] ?? 0.05;
    total += contribs[i]! * w;
  }
  return total;
}

export function calculateHitOddsBreakdown(
  state: GameState,
  op: Operation,
  opts?: OddsOptions,
): HitOddsBreakdown {
  const approach = op.approach ?? "ambush";
  const mods = APPROACH_MODS[approach];
  const spec = approachSpec(approach);
  const target = op.targetCrewId
    ? state.crew.find((c) => c.id === op.targetCrewId)
    : undefined;
  const territory = state.territories.find((t) => t.id === op.targetTerritoryId);
  const exposed = exposedCrewIds(op);
  const defenders = defendersFor(state, op, opts);
  const clues = usesClues(state, op);

  const base = 0.35;
  let roles = 0;
  let targetMod = 0;
  let district = 0;
  let garrison = 0;
  let getaway = 0;
  let tipped = 0;
  let intel = 0;
  let heat = 0;
  const approachMod = mods.stealth + mods.power;
  let other = 0;
  let fear = 0;

  if (approach === "ambush") {
    roles += weightedShooterBonus(state, op.shooterIds, 400);
    for (const id of op.shooterIds) {
      const s = findCrew(state, id);
      if (s) roles += aggregateTraitEffects(s.traits).stealthMod * 0.5;
    }
    const lookout = findCrew(state, op.lookoutId);
    if (lookout) roles += lookout.skills.stealth / 400 + lookout.skills.smarts / 500;
  } else if (approach === "drive_by") {
    const wheelman = findCrew(state, op.wheelmanId);
    if (wheelman) {
      roles += wheelman.skills.driving / 120;
      roles += aggregateTraitEffects(wheelman.traits).hitMod * 0.5;
    } else {
      roles -= 0.18;
    }
    roles += weightedShooterBonus(state, op.shooterIds, 450);
  } else if (approach === "car_bomb") {
    const maker = findCrew(state, op.bombMakerId);
    const planter = findCrew(state, op.planterId);
    if (maker) roles += maker.skills.smarts / 140;
    else roles -= 0.2;
    if (planter) {
      roles += planter.skills.stealth / 160;
      roles += aggregateTraitEffects(planter.traits).stealthMod;
    } else {
      roles -= 0.15;
    }
    const lookout = findCrew(state, op.lookoutId);
    if (lookout) roles += lookout.skills.stealth / 450;
    if (target) targetMod -= target.role === "boss" ? 0.08 : target.role === "underboss" ? 0.05 : 0.02;
  } else if (approach === "sitdown_betrayal") {
    const nego = findCrew(state, op.negotiatorId);
    if (nego) {
      roles += nego.skills.charm / 130;
      roles += aggregateTraitEffects(nego.traits).stealthMod * 1.5;
    } else {
      roles -= 0.2;
    }
    roles += weightedShooterBonus(state, op.shooterIds, 500);
    if (target) targetMod -= target.skills.smarts / 280;
    // Feared families get the mark to the table
    fear = Math.min(0.1, state.reputation.fear / 500);
    other += fear;
  }

  if (op.surveilled) other += 0.12;
  if (op.blind) intel -= 0.12;

  // Casing clues. The routine is the main payoff, and it only pays if you match it.
  // Does not stack with Surveil-first (the hit team cased it themselves).
  if (clues && !op.surveilled) {
    const routine = op.targetCrewId
      ? findClue(state, op.targetTerritoryId, "routine", op.targetCrewId)
      : cluesFor(state, op.targetTerritoryId).find((c) => c.kind === "routine");
    if (clueHolds(routine, opts?.truth)) {
      intel += routine.approach === approach ? 0.08 : 0.02;
    }
  }
  if (clues) {
    // A weak link comes to the table.
    if (approach === "sitdown_betrayal" && op.targetCrewId) {
      const weak = findClue(state, op.targetTerritoryId, "weak_link", op.targetCrewId);
      if (clueHolds(weak, opts?.truth)) other += 0.1;
    }
    // They know a face on your crew.
    const burned = hitCrewIds(op).some((id) => isLookoutBurned(state, id, op.targetFamily));
    if (burned) intel -= 0.05;
  }

  if (target && approach !== "car_bomb") {
    targetMod -= target.skills.stealth / 300;
    targetMod -=
      target.role === "boss" ? 0.15 : target.role === "underboss" ? 0.1 : 0.05;
    if (target.traits.includes("ghost")) targetMod -= 0.1;
  }
  // Even found, a man inside a safehouse is behind a door with his back to a wall.
  if (target && isLaidLow(target)) {
    const house = laidLowHouse(state, target);
    if (house) targetMod -= safehouseHitPenalty(house.level);
  }

  if (territory) {
    district -= territory.defenseBonus * 0.2;
    if (territory.owner === op.targetFamily) district -= 0.05;
  }

  // Scaled garrison penalty
  if (defenders > 0 && spec.garrisonExposure > 0) {
    const pressure = defenders >= exposed.length ? 1.25 : 0.75;
    garrison = -spec.garrisonExposure * Math.min(0.35, defenders * 0.08 * pressure);
  }

  // Getaway distance (small odds hit)
  const gRisk = getawayRisk(state, op, opts);
  getaway = -Math.max(0, gRisk) * 0.5;

  if (op.tippedOff) tipped = -0.2;

  const attackerDef = getFamilyDef(op.family);
  if (attackerDef.bonuses.hitBonus) other += attackerDef.bonuses.hitBonus;

  if (op.family === state.playerFamily) {
    const targetRel = territory?.owner ?? op.targetFamily;
    if (targetRel) {
      const key = [op.family, targetRel].sort().join("|");
      const score = state.relations.scores[key] ?? 0;
      if (score < -30) other += 0.05;
    }
  }

  if (mattressesActive(state)) {
    const playerShot = op.family === state.playerFamily;
    const playerMarked = op.targetFamily === state.playerFamily;
    if (playerShot || playerMarked) other -= MATTRESS_HIT_RISK;
    if (mattressDistrict(state, op.targetTerritoryId) && !mattressLeaked(state)) {
      other -= MATTRESS_DISTRICT_RISK;
    }
  }

  heat -= state.heat.level / 200;

  const total = Math.max(
    0.08,
    Math.min(
      0.92,
      base +
        roles +
        targetMod +
        district +
        garrison +
        getaway +
        tipped +
        intel +
        heat +
        approachMod +
        other,
    ),
  );

  return {
    total,
    base,
    roles,
    target: targetMod,
    district,
    garrison,
    getaway,
    tippedOff: tipped,
    intel,
    heat,
    approach: approachMod,
    other,
    fear,
  };
}

export function calculateHitOdds(state: GameState, op: Operation, opts?: OddsOptions): number {
  return calculateHitOddsBreakdown(state, op, opts).total;
}

/** Estimated per-member firefight hit chance for planner display. */
export function estimateFirefightRisk(state: GameState, op: Operation): number {
  const approach = op.approach ?? "ambush";
  const exposure = approachSpec(approach).garrisonExposure;
  const guns = firefightStrength(state, op).total;
  const exposed = exposedCrewIds(op);
  if (guns <= 0 || exposure <= 0 || exposed.length === 0) return 0;
  const raw = exposure * 0.06 * guns / Math.sqrt(exposed.length);
  let mult = 1;
  if (op.surveilled) mult *= 0.7;
  if (op.lookoutId) mult *= 0.8;
  if (op.tippedOff) mult *= 1.6;
  if (op.blind) mult *= 0.9;
  return Math.min(0.4, raw * mult);
}

/** Player casing is intel; a rival's is a surveillance job on that block. */
function venueCasedBy(state: GameState, family: FamilyName, territoryId: string): boolean {
  if (family === state.playerFamily) return hasFreshCasing(state, territoryId);
  return state.operations.some(
    (o) =>
      o.family === family &&
      o.kind === "surveillance" &&
      o.targetTerritoryId === territoryId &&
      (o.resolved || o.pendingTurns <= 1),
  );
}

export function tipOffChance(state: GameState, op: Operation): number {
  const approach = op.approach ?? "ambush";
  const defenders = defendersFor(state, op);
  const target = op.targetCrewId
    ? state.crew.find((c) => c.id === op.targetCrewId)
    : undefined;
  const lookout = findCrew(state, op.lookoutId);
  const surveilling = op.pendingTurns > 1;
  let chance =
    0.08 +
    (surveilling ? 0.06 : 0) +
    state.heat.level / 400 +
    defenders * 0.03 +
    (target?.skills.smarts ?? 30) / 500 -
    (lookout?.skills.stealth ?? 0) / 600;

  if (approach === "car_bomb" || approach === "sitdown_betrayal") chance *= 0.7;
  if (op.blind) chance *= 0.6;
  // A meeting this turn: extra eyes (entourage) and a cased venue both smell a setup.
  if (approach === "sitdown_betrayal" || approach === "car_bomb") {
    const meeting = (state.sitdowns ?? []).find(
      (sd) =>
        sd.heldTurn === state.turn &&
        (sd.status === "scheduled" || sd.status === "at_table") &&
        (sd.venueTerritoryId === op.targetTerritoryId ||
          sd.proposer === op.targetFamily ||
          sd.other === op.targetFamily),
    );
    if (meeting) {
      const eyes =
        op.family === meeting.proposer
          ? (meeting.rivalEntourageIds?.length ?? 0)
          : (meeting.playerEntourageIds?.length ?? 0);
      chance += eyes * 0.05;
      if (venueCasedBy(state, op.targetFamily, meeting.venueTerritoryId)) chance += 0.2;
    }
  }
  // The block is watching for you after a spotted lookout.
  if (isDistrictAlerted(state, op.targetTerritoryId)) chance += 0.05;
  if (usesClues(state, op)) {
    // You found your rat and sat him down: the leak is plugged.
    const rat = findClue(state, op.targetTerritoryId, "rat");
    if (rat?.ratCrewId) {
      const leaker = findCrew(state, rat.ratCrewId);
      const benched =
        !leaker ||
        leaker.status !== "active" ||
        (leaker.assignment.type === "idle" && !hitCrewIds(op).includes(leaker.id));
      if (benched) chance -= 0.05;
    }
  }
  return Math.max(0.03, Math.min(0.45, chance));
}

/** Arrest-weight modifier from cop/patrol clues; extra heat when the corner cop is theirs. */
export function copCluesFor(
  state: GameState,
  op: Operation,
  opts?: OddsOptions,
): { arrestMod: number; extraHeat: number; notes: string[] } {
  const out = { arrestMod: 0, extraHeat: 0, notes: [] as string[] };
  if (!usesClues(state, op)) return out;
  const approach = op.approach ?? "ambush";
  const exposure = approachSpec(approach).garrisonExposure;

  const patrol = findClue(state, op.targetTerritoryId, "patrol");
  if (clueHolds(patrol, opts?.truth) && exposure >= 0.7) {
    out.arrestMod += 0.15;
    out.notes.push("Patrol pattern: loud work here draws the wagon.");
  }
  const cop = findClue(state, op.targetTerritoryId, "cop_on_payroll");
  if (clueHolds(cop, opts?.truth)) {
    const bribedHere = (state.intel?.districtReveal?.[op.targetTerritoryId] ?? 0) > state.turn;
    if (cop.copBuyable && bribedHere) {
      out.arrestMod -= 0.2;
      out.notes.push("Corner cop paid off: he'll be around the block when it happens.");
    } else if (!cop.copBuyable) {
      out.extraHeat += 3;
      out.notes.push("Corner cop is theirs: expect the whistle early.");
    } else {
      out.notes.push("Corner cop would take an envelope — bribe the cops here first.");
    }
  }
  return out;
}

export interface HitSeats {
  shooterIds: string[];
  wheelmanId?: string;
  lookoutId?: string;
  bombMakerId?: string;
  planterId?: string;
  negotiatorId?: string;
}

function seatIds(seats: HitSeats): string[] {
  return [
    ...seats.shooterIds,
    seats.wheelmanId,
    seats.lookoutId,
    seats.bombMakerId,
    seats.planterId,
    seats.negotiatorId,
  ].filter((id): id is string => !!id);
}

/**
 * A boss, capo, or consigliere on the job brings his free crew. Empty single
 * seats fill first; anyone left rides as a shooter.
 */
export function bringCrewOnHit(crew: CrewMember[], seats: HitSeats, approach: HitApproach): HitSeats {
  const spec = approachSpec(approach);
  const next: HitSeats = { ...seats, shooterIds: [...seats.shooterIds] };
  for (const group of unseatedCrew(crew, seatIds(next))) {
    for (const man of group.men) {
      if (seatIds(next).includes(man.id)) continue;
      let placed = false;
      for (const slot of spec.roles) {
        if (slot.multi || slot.role === "shooter" || slot.role === "backup") continue;
        if (slot.role === "wheelman" && !next.wheelmanId) {
          next.wheelmanId = man.id;
          placed = true;
          break;
        }
        if (slot.role === "lookout" && !next.lookoutId) {
          next.lookoutId = man.id;
          placed = true;
          break;
        }
        if (slot.role === "bomb_maker" && !next.bombMakerId) {
          next.bombMakerId = man.id;
          placed = true;
          break;
        }
        if (slot.role === "planter" && !next.planterId) {
          next.planterId = man.id;
          placed = true;
          break;
        }
        if (slot.role === "negotiator" && !next.negotiatorId) {
          next.negotiatorId = man.id;
          placed = true;
          break;
        }
      }
      if (!placed) next.shooterIds = [...next.shooterIds, man.id];
    }
  }
  return next;
}

/** The men on a hit leave their garrison and any racket they were running. */
export function commitHitCrew(
  state: GameState,
  op: Operation,
  assignmentType: "operation" | "surveillance" = "operation",
): GameState {
  const ids = hitCrewIds(op);
  if (ids.length === 0) return state;
  const idSet = new Set(ids);
  let crew = state.crew;
  for (const id of ids) {
    crew = assignCrew(crew, id, {
      type: assignmentType,
      operationId: op.id,
      territoryId: op.targetTerritoryId,
    });
  }
  const territories = state.territories.map((t) => ({
    ...t,
    garrisonIds: t.garrisonIds.filter((id) => !idSet.has(id)),
    rackets: t.rackets.map((r) =>
      r.managerId && idSet.has(r.managerId) ? { ...r, managerId: null } : r,
    ),
  }));
  return { ...state, crew, territories };
}

export function planHit(
  state: GameState,
  params: {
    family: FamilyName;
    targetTerritoryId: string;
    targetFamily: FamilyName;
    targetCrewId?: string;
    approach: HitApproach;
    shooterIds: string[];
    wheelmanId?: string;
    lookoutId?: string;
    bombMakerId?: string;
    planterId?: string;
    negotiatorId?: string;
    surveilled?: boolean;
    pendingTurns?: number;
    originTerritoryId?: string;
    blind?: boolean;
    intent?: Operation["intent"];
    motive?: Operation["motive"];
  },
  rng: Rng,
): Operation {
  return {
    id: `op_hit_${rng.int(10000, 99999)}`,
    intent: params.intent,
    motive: params.motive,
    family: params.family,
    kind: "hit",
    targetCrewId: params.blind ? undefined : params.targetCrewId,
    targetTerritoryId: params.targetTerritoryId,
    originTerritoryId: params.originTerritoryId,
    targetFamily: params.targetFamily,
    approach: params.approach,
    shooterIds: params.shooterIds,
    wheelmanId: params.wheelmanId,
    lookoutId: params.lookoutId,
    bombMakerId: params.bombMakerId,
    planterId: params.planterId,
    negotiatorId: params.negotiatorId,
    surveilled: params.surveilled ?? false,
    tippedOff: false,
    blind: !!params.blind,
    pendingTurns: params.pendingTurns ?? 1,
    resolved: false,
  };
}

function pickBlindTarget(
  state: GameState,
  op: Operation,
  rng: Rng,
): CrewMember | undefined {
  const present = crewPresentIn(state, op.targetTerritoryId).filter(
    (c) => c.family === op.targetFamily && c.status === "active" && !isLaidLow(c),
  );
  if (present.length === 0) return undefined;
  const weight = (c: CrewMember) =>
    c.role === "boss"
      ? 5
      : c.role === "underboss"
        ? 4
        : c.role === "capo"
          ? 3
          : c.role === "hitman"
            ? 2
            : 1;
  const bag: CrewMember[] = [];
  for (const c of present) {
    const w = weight(c);
    for (let i = 0; i < w; i++) bag.push(c);
  }
  return rng.pick(bag);
}

export interface ResolveHitResult {
  state: GameState;
  result: HitResult;
  /**
   * Car bomb on a boss who never left his site: the package stays armed and
   * the op is not resolved. `discovered` ends it early (found, or fuse stale).
   */
  waiting?: { discovered: boolean; reason: "found" | "stale" };
}

/** Placeholder result for an op that did not actually resolve this turn. */
function emptyResult(op: Operation): HitResult {
  return {
    operationId: op.id,
    outcome: "target_escaped",
    beats: [],
    heatGain: 0,
    fearGain: 0,
    casualties: [],
    casualtyDetail: [],
    defenders: 0,
    tippedOff: false,
    targetDead: false,
    headline: "",
    successChance: 0,
    revealedIds: [],
    blind: !!op.blind,
    respectDelta: 0,
    influenceDelta: 0,
  };
}

/** Chance per waiting turn that a planted car bomb is found before it goes off. */
function bombDiscoveryChance(state: GameState, op: Operation): number {
  const maker = op.bombMakerId ? state.crew.find((c) => c.id === op.bombMakerId) : undefined;
  let chance = 0.15 + 0.1 * (op.armedTurns ?? 0);
  if (isDistrictAlerted(state, op.targetTerritoryId)) chance += 0.15;
  if (maker) chance -= maker.skills.smarts / 500;
  return Math.max(0.05, Math.min(0.75, chance));
}

export function resolveHit(
  state: GameState,
  op: Operation,
  rng: Rng,
): ResolveHitResult {
  const approach = op.approach ?? "ambush";
  const mods = APPROACH_MODS[approach];
  const spec = approachSpec(approach);
  const exposed = exposedCrewIds(op);
  const TRUTH: OddsOptions = { truth: true };
  const gRisk = getawayRisk(state, op, TRUTH);
  const tippedOff = !!op.tippedOff;
  const blind = !!op.blind;

  // Blind: pick whoever is actually there (weighted)
  let workingOp = op;
  let emptyBlock = false;
  if (blind && !op.targetCrewId) {
    const picked = pickBlindTarget(state, op, rng);
    if (!picked) emptyBlock = true;
    else workingOp = { ...op, targetCrewId: picked.id };
  }

  // The mark isn't where you planned for him (moved, jailed, dead, or held): no body tonight.
  const plannedTarget = workingOp.targetCrewId
    ? state.crew.find((c) => c.id === workingOp.targetCrewId)
    : undefined;

  // A car bomb on a boss rides on his car. It only goes off when he travels,
  // and it goes off wherever he travels to.
  const bossBomb = approach === "car_bomb" && plannedTarget?.role === "boss" && !blind;
  if (bossBomb && plannedTarget && plannedTarget.status === "active") {
    const now = resolveCrewTerritoryId(state, plannedTarget.id);
    const travelled = plannedTarget.lastSiteId !== undefined && now !== plannedTarget.lastSiteId;
    if (!travelled) {
      const armed = op.armedTurns ?? 0;
      const stale = armed >= CAR_BOMB_ARMED_MAX_TURNS;
      const found = !stale && rng.chance(bombDiscoveryChance(state, op));
      if (!stale && !found) {
        return {
          state,
          result: emptyResult(op),
          waiting: { discovered: false, reason: "found" },
        };
      }
      return {
        state,
        result: emptyResult(op),
        waiting: { discovered: true, reason: stale ? "stale" : "found" },
      };
    }
    if (now) workingOp = { ...workingOp, targetTerritoryId: now };
  }

  const defenders = defendersFor(state, workingOp, TRUTH);

  // Laid low behind a door nobody watched: the crew never finds him.
  const markHidden =
    !!plannedTarget &&
    !blind &&
    !bossBomb &&
    isLaidLow(plannedTarget) &&
    !venueCasedBy(state, op.family, op.targetTerritoryId);
  const markMoved =
    !!plannedTarget &&
    !blind &&
    !bossBomb &&
    (markHidden ||
      plannedTarget.status === "dead" ||
      plannedTarget.status === "jailed" ||
      plannedTarget.status === "held" ||
      resolveCrewTerritoryId(state, plannedTarget.id) !== op.targetTerritoryId);
  const markAbsent = !emptyBlock && (markMoved || (tippedOff && rng.chance(0.35)));

  const copClues = copCluesFor(state, workingOp, TRUTH);
  const successChance = calculateHitOdds(state, workingOp, TRUTH);
  const outcome: HitOutcome =
    emptyBlock || markAbsent
      ? "target_escaped"
      : rollOutcome(rng, successChance, gRisk, copClues.arrestMod);

  const trap = tippedOff && !markAbsent && !emptyBlock && outcome === "botched_killed";

  const target = workingOp.targetCrewId
    ? state.crew.find((c) => c.id === workingOp.targetCrewId)
    : state.crew.find(
        (c) => c.family === op.targetFamily && c.role === "boss" && c.status === "active",
      );

  const districtName =
    state.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "the district";
  const targetName = emptyBlock
    ? "nobody"
    : (target?.name ?? `a ${op.targetFamily} soldier`);

  const casualties: string[] = [];
  const casualtyDetail: HitCasualtyDetail[] = [];
  let crew = [...state.crew];
  let heatGain = mods.heat + Math.max(0, exposed.length - 2) * 3 + copClues.extraHeat;
  let fearGain = 5;
  let targetDead = false;
  let headline = "";

  switch (outcome) {
    case "clean_kill":
      targetDead = true;
      fearGain = 15;
      heatGain += 5;
      headline = `${targetName} found dead — professional work.`;
      break;
    case "messy_kill":
      targetDead = true;
      fearGain = 10;
      heatGain += 12;
      headline = `Blood on the pavement — ${targetName} killed in public.`;
      break;
    case "botched_wounded":
      fearGain = 3;
      heatGain += 8;
      headline = `Hit team scattered; target wounded but alive.`;
      if (target) {
        crew = crew.map((c) =>
          c.id === target.id ? { ...c, status: "wounded" as const } : c,
        );
      }
      break;
    case "botched_arrested":
      fearGain = 1;
      heatGain += 15;
      headline = `Cops nabbed part of the hit squad.`;
      if (exposed.length > 0) {
        const arrested = rng.pick(exposed);
        casualties.push(arrested);
        casualtyDetail.push({ crewId: arrested, fate: "jailed", cause: "botch" });
        crew = jailInCrew(crew, arrested, state.turn);
      }
      break;
    case "botched_killed":
      fearGain = 2;
      heatGain += 18;
      headline = trap
        ? `Ambush reversed — the hit squad cut down in a trap.`
        : `Disaster — the hit squad is cut down, target survives.`;
      if (exposed.length > 0) {
        const killed = rng.pick(exposed);
        casualties.push(killed);
        casualtyDetail.push({ crewId: killed, fate: "dead", cause: "botch" });
        crew = crew.map((c) =>
          c.id === killed ? { ...c, status: "dead" as const } : c,
        );
        crew = funeralLoyaltyHit(crew, killed);
      }
      break;
    case "target_escaped":
      fearGain = 0;
      heatGain += 6;
      if (emptyBlock) {
        headline = `Blind hit on ${districtName} found nothing.`;
      } else if (markHidden) {
        headline = `${targetName} was nowhere on the street — he's gone to ground.`;
      } else if (markMoved) {
        headline = `${targetName} wasn't there — he'd already moved on.`;
      } else if (markAbsent) {
        headline = `${targetName} never showed — someone tipped them.`;
      } else {
        headline = `${targetName} slipped the trap — embarrassment on the street.`;
      }
      break;
  }

  // Blind reputation: fear up, respect/influence down
  if (blind) {
    if (targetDead) fearGain = Math.round(fearGain * 1.4);
    else fearGain += 4;
  }

  // Garrison return fire, plus whoever comes out of a nearby safehouse shooting.
  const firefightNames: string[] = [];
  const cover = coverFire(state, workingOp.targetFamily, workingOp.targetTerritoryId);
  const guns = defenders + cover.weight;
  if (!emptyBlock && guns > 0 && spec.garrisonExposure > 0 && exposed.length > 0) {
    let mult = 1;
    if (outcome === "clean_kill") mult *= 0.5;
    else if (outcome === "messy_kill") mult *= 1.0;
    else if (outcome.startsWith("botched")) mult *= 1.3;
    if (op.surveilled) mult *= 0.7;
    if (op.lookoutId) mult *= 0.8;
    if (tippedOff) mult *= 1.6;
    if (blind) mult *= 0.9;

    const perChance = Math.min(
      0.4,
      (spec.garrisonExposure * 0.06 * guns) / Math.sqrt(exposed.length) * mult,
    );
    const maxCas = Math.ceil((defenders + cover.men) / 2);
    let firefightCount = 0;
    const alreadyHit = new Set(casualtyDetail.map((d) => d.crewId));
    const shuffled = rng.shuffle([...exposed]);

    for (const id of shuffled) {
      if (firefightCount >= maxCas) break;
      if (alreadyHit.has(id)) continue;
      if (!rng.chance(perChance)) continue;
      const fate: "wounded" | "dead" = rng.chance(0.7) ? "wounded" : "dead";
      casualtyDetail.push({ crewId: id, fate, cause: "firefight" });
      if (!casualties.includes(id)) casualties.push(id);
      alreadyHit.add(id);
      firefightCount++;
      const member = crew.find((c) => c.id === id);
      if (member) firefightNames.push(member.name.split(" ").slice(-1)[0] ?? member.name);
      crew = crew.map((c) =>
        c.id === id
          ? {
              ...c,
              status: fate === "dead" ? ("dead" as const) : ("wounded" as const),
            }
          : c,
      );
      if (fate === "dead") crew = funeralLoyaltyHit(crew, id);
    }
  }

  if (targetDead && target) {
    crew = crew.map((c) =>
      c.id === target.id ? { ...c, status: "dead" as const } : c,
    );
    crew = funeralLoyaltyHit(crew, target.id);
    if (!casualties.includes(target.id)) casualties.push(target.id);
  }

  // The dead don't keep their travel plans.
  crew = crew.map((c) => (c.status === "dead" && c.awayAt ? { ...c, awayAt: undefined } : c));

  for (const sid of hitCrewIds(op)) {
    const granted = grantXpToCrew(crew, sid, hitResolveXp(targetDead, hitXpSeat(op, sid, crew, state)));
    crew = granted.crew.map((c) =>
      c.id === sid ? { ...c, hits: c.hits + 1 } : c,
    );
  }

  // A message hit is a point made, not a war declared: half the standing lost.
  const isMessage = op.intent === "message";
  let relations = setRelationDelta(
    state.relations,
    op.family,
    op.targetFamily,
    isMessage ? -12 : -25,
  );
  if (outcome === "clean_kill" || outcome === "messy_kill") {
    relations = setRelationDelta(relations, op.family, op.targetFamily, isMessage ? -8 : -15);
  }

  const operations = state.operations.map((o) =>
    o.id === op.id ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn } : o,
  );

  // The job is done: everyone staged for it goes home. (Casualties keep their
  // new status; only the stale operation assignment is cleared.)
  const staged = new Set(hitCrewIds(op));
  crew = crew.map((c) =>
    staged.has(c.id) &&
    (c.assignment.type === "operation" || c.assignment.type === "surveillance") &&
    (c.assignment.operationId === op.id || !c.assignment.operationId)
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );

  const door = getawayCover(state, op.family, workingOp.targetTerritoryId);
  const built = buildBeats(rng, approach, outcome, targetName, {
    tippedOff,
    markAbsent: markAbsent || emptyBlock,
    firefightNames,
    trap,
    coverFrom: cover.men > 0 && cover.weight >= defenders ? cover.from[0]?.territory.name : undefined,
    escapeDoor: door && door.hops <= 1 && !markAbsent && !emptyBlock ? door.territory.name : undefined,
  });
  let beats = built.beats;
  let complication = built.complication;
  if (emptyBlock) {
    beats = [...beats];
    beats[1] = { phase: "complication", text: "Empty block — nobody home." };
    beats[2] = { phase: "execution", text: "The crew packs up with nothing to show." };
    complication = "mark_absent";
  }

  // Blind reputation deltas
  let respectDelta = targetDead ? 8 : -3;
  let influenceDelta = 0;
  let streetDelta = 0;
  if (isMessage) {
    // Nobody admires a message; the street just learns you'll send one.
    respectDelta = targetDead ? 3 : -2;
    streetDelta = targetDead ? 4 : 0;
  }
  if (blind) {
    respectDelta -= 6;
    influenceDelta -= 5;
    streetDelta -= 3;
    if (emptyBlock) influenceDelta -= 3;
  }

  // Reveal everyone present after the hit
  const presentRivals = crewPresentIn({ ...state, crew }, op.targetTerritoryId).filter(
    (c) => c.family === op.targetFamily,
  );
  const revealedIds = presentRivals.map((c) => c.id);

  const loyaltyAmount = targetDead ? 4 : 2;
  const loyal = bumpLoyalty(crew, op.shooterIds ?? [], loyaltyAmount);
  crew = loyal.crew;
  const ours = op.family === state.playerFamily;

  const result: HitResult = {
    operationId: op.id,
    outcome,
    beats,
    heatGain,
    fearGain,
    casualties,
    casualtyDetail,
    defenders,
    tippedOff,
    targetDead,
    headline,
    successChance,
    revealedIds,
    blind,
    respectDelta,
    influenceDelta,
    complication,
    markAbsent: markAbsent || emptyBlock,
    trap,
    strikeTerritoryId: workingOp.targetTerritoryId,
    loyaltyDelta: ours && loyal.gained.length > 0 ? loyaltyAmount : undefined,
    loyaltyNames: ours && loyal.gained.length > 0 ? loyal.gained : undefined,
  };

  // Heat, fear, respect and influence belong to the player. A rival's hit only
  // touches them when the player pulled the trigger (full) or was the mark
  // (cops swarm your block: a third of the heat, no reputation swing). A
  // rival-on-rival hit across town is somebody else's problem.
  const playerShot = op.family === state.playerFamily;
  const playerMarked = op.targetFamily === state.playerFamily;
  const ownHeat = playerShot ? heatGain : playerMarked ? Math.round(heatGain / 3) : 0;
  const ownFear = playerShot ? fearGain : 0;
  const ownRespect = playerShot ? respectDelta : 0;
  const ownStreet = playerShot ? streetDelta : 0;
  const ownInfluence = playerShot ? influenceDelta : 0;

  let newState: GameState = {
    ...state,
    crew,
    relations,
    operations,
    influence: Math.max(0, Math.min(300, state.influence + ownInfluence)),
    reputation: {
      ...state.reputation,
      fear: Math.min(100, state.reputation.fear + ownFear),
      respect: Math.max(0, Math.min(100, state.reputation.respect + ownRespect)),
      streetInfluence: Math.max(
        0,
        Math.min(100, state.reputation.streetInfluence + ownStreet),
      ),
    },
    heat: {
      ...state.heat,
      level: Math.min(100, state.heat.level + ownHeat),
      sources: ownHeat > 0 ? [...state.heat.sources, `hit:${op.id}`].slice(-20) : state.heat.sources,
    },
    vendettas:
      isMessage || state.vendettas.includes(op.targetFamily)
        ? state.vendettas
        : [...state.vendettas, op.targetFamily],
    pendingHitResult: op.family === state.playerFamily ? result : state.pendingHitResult,
    hitFxTerritoryId: op.targetTerritoryId,
  };

  newState = recordIntel(newState, revealedIds, op.targetTerritoryId, "hit");

  let finalResult = result;

  // A rival hit on the player opens a case. The headline never names them.
  if (
    state.playerFamily &&
    op.targetFamily === state.playerFamily &&
    op.family !== state.playerFamily
  ) {
    const opened = openIncidentFromHit(newState, op, result, rng);
    newState = opened.state;
    if (isMessage) {
      // Left where he'd be found: it was meant to be read. Everyone you've
      // run hot past comes under the light.
      const shifts: Partial<Record<FamilyName, number>> = {};
      for (const g of newState.grudges ?? []) {
        if (g.reason === "passage" && g.against === state.playerFamily && g.expiresTurn > state.turn) {
          shifts[g.family] = 0.12;
        }
      }
      newState = addEvidence(
        newState,
        opened.incident.id,
        makeEvidence(
          "scene",
          state.turn,
          "He was left where he'd be found. This was a message about the trucks, not a war.",
          shifts,
          undefined,
          rng,
        ),
      );
      newState = afterAiMessageHit(newState, op, targetDead, rng);
    }
  }

  // The player's own message lands: the family knows the trucks are not to be touched.
  if (isMessage && state.playerFamily && op.family === state.playerFamily && targetDead) {
    newState = {
      ...newState,
      passageLeverage: {
        ...newState.passageLeverage,
        [op.targetFamily]: state.turn + LEVERAGE_TURNS,
      },
    };
  }

  // A player hit declared as the answer to an open case gets judged.
  if (state.playerFamily && op.family === state.playerFamily && op.answersIncidentId) {
    const judged = applyRetaliationJudgment(newState, op, rng);
    newState = judged.state;
    if (judged.logs.length) {
      newState = { ...newState, turnLog: [...newState.turnLog, ...judged.logs].slice(-200) };
    }
    if (judged.judgment.band !== "none") {
      finalResult = { ...finalResult, caseJudgment: judged.judgment.text };
      newState = { ...newState, pendingHitResult: finalResult };
    }
  }

  // Succession when any boss is killed this hit (mark or firefight casualty)
  const deadBossFamilies = new Set<FamilyName>();
  if (targetDead && target?.role === "boss") deadBossFamilies.add(target.family);
  for (const d of casualtyDetail) {
    if (d.fate !== "dead") continue;
    const m = crew.find((c) => c.id === d.crewId);
    if (m?.role === "boss") deadBossFamilies.add(m.family);
  }

  let bossFell = false;
  for (const fam of deadBossFamilies) {
    const stillBoss = newState.crew.find(
      (c) => c.family === fam && c.role === "boss" && c.status !== "dead",
    );
    if (stillBoss) continue;
    bossFell = true;
    const succ =
      fam === state.playerFamily
        ? applySuccession(newState, fam, rng)
        : settleRivalChair(newState, fam, rng);
    newState = succ.state;
    if (succ.logs.length) {
      newState = {
        ...newState,
        turnLog: [...newState.turnLog, ...succ.logs].slice(-200),
      };
    }
    if (succ.newBossName) {
      finalResult = {
        ...finalResult,
        headline: `${finalResult.headline} ${succ.newBossName} takes the chair.`,
      };
      if (op.family === state.playerFamily) {
        newState = { ...newState, pendingHitResult: finalResult };
      }
    }
  }

  if (bossFell) {
    const quiet = declareMourning(newState);
    newState = quiet.state;
    if (quiet.logs.length) {
      newState = {
        ...newState,
        turnLog: [...newState.turnLog, ...quiet.logs].slice(-200),
      };
    }
  }

  if (state.playerFamily && op.targetFamily === state.playerFamily && op.family !== state.playerFamily) {
    newState = noteMattressWindow(newState, op.targetFamily, op.family);
  }

  return { state: newState, result: finalResult };
}

function buildBeats(
  rng: Rng,
  approach: HitApproach,
  outcome: HitOutcome,
  targetName: string,
  opts: {
    tippedOff: boolean;
    markAbsent: boolean;
    firefightNames: string[];
    trap: boolean;
    /** Block name of the safehouse the shooting came from, when it wasn't the garrison. */
    coverFrom?: string;
    /** Block name of the attackers' own safehouse they ran to. */
    escapeDoor?: string;
  },
): { beats: HitBeat[]; complication: HitComplication } {
  const approachText: Record<HitApproach, string> = {
    ambush: "The crew takes position in a blind alley, waiting for the mark.",
    drive_by: "A black sedan rolls slow past the target's hangout.",
    car_bomb: "A wired Packard is parked on the mark's usual route.",
    sitdown_betrayal: "A friendly sit-down is arranged over coffee and lies.",
    summons: "A trusted man is told to come by the house tonight.",
  };

  const complicationByApproach: Record<HitApproach, { key: HitComplication; text: string }[]> = {
    ambush: [
      { key: "patrol", text: "A patrol wagon turns the corner — everyone freezes." },
      { key: "rival_muscle", text: "Rival muscle appears across the street." },
      { key: "rain", text: "Rain slicks the pavement, ruining footing." },
      { key: "backup", text: "The target arrives with unexpected backup." },
    ],
    drive_by: [
      { key: "stall", text: "The wheelman stalls at a red light with cops behind." },
      { key: "blocked_lane", text: "A civilian wagon blocks the escape lane." },
      { key: "fruit_cart", text: "The mark ducks behind a fruit cart." },
      { key: "escort", text: "A motorcycle escort flanks the target." },
    ],
    car_bomb: [
      { key: "dud", text: "The fuse sputters — a dud for a heartbeat." },
      { key: "wrong_car", text: "Wrong Packard: another car sits in the spot." },
      { key: "cop_on_fender", text: "A beat cop leans on the fender to light a smoke." },
      { key: "rain", text: "Rain soaks the detonator wiring." },
    ],
    sitdown_betrayal: [
      { key: "pat_down", text: "The negotiator is patted down at the door." },
      { key: "witness", text: "The mark brings a silent witness to the booth." },
      { key: "kitchen_backup", text: "Hidden backup is spotted in the kitchen." },
      { key: "toast", text: "The sit-down starts with an unexpected toast — delay." },
    ],
    summons: [
      { key: "witness", text: "A neighbour is on the stoop when he pulls up." },
      { key: "patrol", text: "A patrol wagon idles at the corner as he parks." },
    ],
  };

  const executionClean: Record<HitApproach, string> = {
    ambush: `Clean shot. ${targetName} drops without a sound.`,
    drive_by: `Windows shatter — ${targetName} never sees the car leave.`,
    car_bomb: `The Packard erupts. ${targetName} never makes the corner.`,
    sitdown_betrayal: `The handshake ends under the table. ${targetName} is finished.`,
    summons: `The back room. One shot. ${targetName} doesn't come back out.`,
  };
  const executionMessy: Record<HitApproach, string> = {
    ambush: `Lead flies wild. ${targetName} is hit but the block erupts in chaos.`,
    drive_by: `Spray paints the sidewalk — ${targetName} goes down in full view.`,
    car_bomb: `The blast takes half the street with ${targetName}.`,
    sitdown_betrayal: `Chairs overturn; ${targetName} dies loud in the cafe.`,
    summons: `${targetName} puts up a fight. It takes two shots and the neighbours hear.`,
  };
  const executionBotched: Record<HitApproach, string> = {
    ambush: `The hit goes sideways — sirens already wail in the distance.`,
    drive_by: `The sedan catches fire from return shots; abort.`,
    car_bomb: `The package fails. Smoke and panic, no body.`,
    sitdown_betrayal: `The mark smells the trap and flips the table.`,
    summons: `${targetName} smells it and runs. The street saw him go.`,
  };
  const executionEscape = `${targetName} slips away in the confusion.`;

  const picked = rng.pick(complicationByApproach[approach]);
  let complication: HitComplication = picked.key;
  let complicationText = picked.text;
  if (opts.tippedOff && opts.markAbsent) {
    complication = "mark_absent";
    complicationText = "The mark never showed. Someone talked.";
  } else if (opts.markAbsent) {
    complication = "mark_absent";
  } else if (opts.trap) {
    complication = "trap";
    complicationText = "It was a trap. They were waiting.";
  } else if (opts.tippedOff) {
    complication = "tipped";
    complicationText = "Word leaked — the street feels wrong before the first shot.";
  }

  let executionText = executionClean[approach];
  if (opts.markAbsent) executionText = "Empty alley. The job dies without a body.";
  else if (outcome === "messy_kill") executionText = executionMessy[approach];
  else if (outcome.startsWith("botched")) executionText = executionBotched[approach];
  else if (outcome === "target_escaped") executionText = executionEscape;

  let getawayText = "The crew vanishes into the tenements before uniforms arrive.";
  if (opts.escapeDoor) {
    getawayText = `The crew is through the ${opts.escapeDoor} safehouse door before the first siren.`;
  }
  if (outcome === "botched_arrested" || outcome === "botched_killed") {
    getawayText = "Police blockades seal off the neighborhood.";
  }
  if (opts.firefightNames.length > 0) {
    const who =
      opts.firefightNames.length === 1
        ? opts.firefightNames[0]
        : `${opts.firefightNames[0]} and others`;
    getawayText = opts.coverFrom
      ? `Windows open in the ${opts.coverFrom} safehouse and the lead comes down — ${who} takes a slug on the way out.`
      : `The garrison returns fire from the stoops — ${who} takes a slug on the way out.`;
  }

  return {
    beats: [
      { phase: "approach", text: approachText[approach] },
      { phase: "complication", text: complicationText },
      { phase: "execution", text: executionText },
      { phase: "getaway", text: getawayText },
    ],
    complication,
  };
}

/** Map payload the cinematic director plays. Strike site follows a travelling boss bomb. */
export function buildHitCinematic(
  state: GameState,
  op: Operation,
  result: HitResult,
  perspective: HitPerspective,
  path: string[],
): HitCinematic {
  const target = op.targetCrewId
    ? state.crew.find((c) => c.id === op.targetCrewId)
    : undefined;
  const strike = result.strikeTerritoryId ?? op.targetTerritoryId;
  const origin = path[0] ?? op.originTerritoryId ?? strike;
  return {
    operationId: op.id,
    originTerritoryId: origin,
    targetTerritoryId: strike,
    path: path[path.length - 1] === strike ? path : [...path.slice(0, -1), strike],
    approach: op.approach ?? "ambush",
    result,
    perspective,
    attackerFamily: op.family,
    targetFamily: op.targetFamily,
    targetCrewId: op.targetCrewId,
    targetName: target?.name ?? "the mark",
  };
}

/**
 * The reel for calling one of your own in. He drives to your safehouse, your
 * HQ, or a legit front, and doesn't come back out. No result card.
 */
export function buildSummonsCinematic(state: GameState, victim: CrewMember, innocent = false): HitCinematic {
  const player = state.playerFamily ?? victim.family;
  const turn = state.turn;
  const from = resolveCrewTerritoryId(state, victim.id);
  const house = state.territories.find((t) => t.owner === player && safehouseCapacity(t, turn) > 0);
  const front = state.territories.find(
    (t) => t.owner === player && t.rackets.some((r) => isLegitBusiness(r.type)),
  );
  const venue = house?.id ?? familyHq(state, player) ?? front?.id ?? from ?? state.territories[0]?.id ?? "";
  const path = from && from !== venue ? [from, venue] : [venue];
  const where = state.territories.find((t) => t.id === venue)?.name ?? "the house";
  const beats: HitBeat[] = [
    { phase: "approach", text: `The call goes out: ${victim.name}, come by ${where} tonight.` },
    { phase: "complication", text: `He parks outside ${where} and checks the street before he goes in.` },
    { phase: "execution", text: `The back room. One shot. ${victim.name} doesn't come back out.` },
    { phase: "getaway", text: "His car is driven off. By morning it's somebody else's problem." },
  ];
  const result: HitResult = {
    operationId: `summons_${victim.id}_${turn}`,
    outcome: "clean_kill",
    beats,
    heatGain: 5,
    fearGain: 8,
    casualties: [victim.id],
    casualtyDetail: [{ crewId: victim.id, fate: "dead", cause: "firefight" }],
    defenders: 0,
    tippedOff: false,
    targetDead: true,
    headline: `${victim.name} was called in.`,
    successChance: 1,
    complication: innocent ? "innocent" : undefined,
    strikeTerritoryId: venue,
  };
  return {
    operationId: result.operationId,
    originTerritoryId: path[0] ?? venue,
    targetTerritoryId: venue,
    path,
    approach: "summons",
    result,
    perspective: "ours",
    attackerFamily: player,
    targetFamily: player,
    targetCrewId: victim.id,
    targetName: victim.name,
  };
}

function rollOutcome(
  rng: Rng,
  successChance: number,
  gRisk: number,
  arrestMod = 0,
): HitOutcome {
  const roll = rng.next();
  if (roll > successChance + 0.15) return "target_escaped";
  if (roll > successChance) {
    // Arrest weight rises with getaway risk; cop/patrol clues push it either way
    const arrestWeight = Math.max(0.15, Math.min(0.75, 0.5 + gRisk + arrestMod));
    if (rng.chance(0.4)) return "botched_wounded";
    if (rng.chance(arrestWeight)) return "botched_arrested";
    return "botched_killed";
  }
  if (roll > successChance - 0.2 && rng.chance(0.35)) return "messy_kill";
  return "clean_kill";
}

/**
 * A car bomb that never got its trip: found by the mark's people, or the fuse
 * went stale. The crew comes home; the block is on alert; the planter may not.
 */
function fizzleCarBomb(
  state: GameState,
  op: Operation,
  reason: "found" | "stale",
  rng: Rng,
): GameState {
  const turn = state.turn;
  let crew = state.crew.map((c) =>
    hitCrewIds(op).includes(c.id) &&
    (c.assignment.type === "operation" || c.assignment.type === "surveillance") &&
    c.assignment.operationId === op.id
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );

  const planter = op.planterId ? crew.find((c) => c.id === op.planterId) : undefined;
  if (planter && planter.status === "active" && reason === "found") {
    const caught = rng.chance(0.3);
    if (caught) {
      crew = jailInCrew(crew, planter.id, turn).map((c) =>
        c.id === planter.id ? { ...c, wanted: c.wanted + 1 } : c,
      );
    } else {
      crew = crew.map((c) =>
        c.id === planter.id ? { ...c, wanted: c.wanted + 1 } : c,
      );
    }
  }

  const intel = {
    ...(state.intel ?? emptyIntel()),
    alerted: {
      ...(state.intel?.alerted ?? {}),
      [op.targetTerritoryId]: turn + ALERT_TURNS,
    },
  };

  const playerInvolved =
    op.family === state.playerFamily || op.targetFamily === state.playerFamily;

  return {
    ...state,
    crew,
    intel,
    relations: setRelationDelta(state.relations, op.family, op.targetFamily, -10),
    heat: playerInvolved
      ? {
          ...state.heat,
          level: Math.min(100, state.heat.level + 10),
          sources: [...state.heat.sources, `bomb_found:${op.id}`].slice(-20),
        }
      : state.heat,
    operations: state.operations.map((o) =>
      o.id === op.id ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn } : o,
    ),
  };
}

/** Resolved ops stay on the books this long so deals, agendas and reels can read them. */
export const RESOLVED_OP_MEMORY_TURNS = 8;

/**
 * One ready hit. Usually it resolves; a car bomb riding on a boss who never
 * left the house stays armed (`result` undefined), or is found and fizzles.
 */
export function settleReadyHit(
  current: GameState,
  op: Operation,
  rng: Rng,
): { state: GameState; result?: HitResult; log?: TurnLogEntry } {
  const { state: next, result, waiting } = resolveHit(current, op, rng);
  if (waiting && !waiting.discovered) {
    // The boss never left the house. The package stays armed another week.
    return {
      state: {
        ...next,
        operations: next.operations.map((o) =>
          o.id === op.id ? { ...o, pendingTurns: 0, armedTurns: (o.armedTurns ?? 0) + 1 } : o,
        ),
      },
    };
  }
  if (waiting && waiting.discovered) {
    const fizzled = fizzleCarBomb(next, op, waiting.reason, rng);
    const district =
      fizzled.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "the block";
    return {
      state: fizzled,
      log: {
        id: `log_bomb_fizzle_${op.id}_${fizzled.turn}`,
        turn: fizzled.turn,
        category: "hit",
        text:
          waiting.reason === "stale"
            ? `The fuse on the car in ${district} went stale. The crew pulled the package.`
            : `The package under the car in ${district} was found before it could be used.`,
        family: op.family,
      },
    };
  }
  return { state: next, result };
}

export function resolvePendingOperations(
  state: GameState,
  rng: Rng,
  opts: {
    /** Hits by this family are left alone (the player's resolve on his own Next Turn, with a reel). */
    skipFamily?: FamilyName | null;
  } = {},
): { state: GameState; results: HitResult[]; tipLogs: TurnLogEntry[]; reports: LookoutReport[] } {
  const results: HitResult[] = [];
  const tipLogs: TurnLogEntry[] = [];
  const reports: LookoutReport[] = [];
  let current = state;

  // Tip-off rolls for still-pending hits / surveillance
  current = {
    ...current,
    operations: current.operations.map((o) => {
      if (o.resolved || o.pendingTurns <= 0 || o.tippedOff) return o;
      if (o.kind !== "hit" && o.kind !== "surveillance") return o;
      const chance = tipOffChance(current, o);
      if (!rng.chance(chance)) return o;

      // Rival casing your turf still gets called out. Pending hits do not:
      // warnings about those come through the rumor mill, and not always.
      if (o.targetFamily === current.playerFamily && o.kind === "surveillance") {
        const district =
          current.territories.find((t) => t.id === o.targetTerritoryId)?.name ?? "your turf";
        tipLogs.push({
          id: `tip_${o.id}_${current.turn}`,
          turn: current.turn,
          category: "hit",
          text: `Your boys chased a stranger off ${district}. Somebody's casing you.`,
          family: current.playerFamily ?? undefined,
        });
      }

      return { ...o, tippedOff: true };
    }),
  };

  // Resolve ready hits
  const pendingHits = current.operations.filter(
    (o) =>
      !o.resolved &&
      o.pendingTurns <= 0 &&
      o.kind === "hit" &&
      (!opts.skipFamily || o.family !== opts.skipFamily),
  );
  for (const op of pendingHits) {
    if (handsDown(current)) continue;
    if (isDefunct(current, op.targetFamily)) {
      const stopped = scatterFamily(current, op.targetFamily, rng);
      current = stopped.state;
      if (stopped.logs.length) {
        current = { ...current, turnLog: [...current.turnLog, ...stopped.logs].slice(-200) };
      }
      continue;
    }
    const settled = settleReadyHit(current, op, rng);
    current = settled.state;
    if (settled.log) tipLogs.push(settled.log);
    if (settled.result) results.push(settled.result);
  }

  // Resolve ready surveillance ops (pendingTurns <= 1 → report next turn)
  const pendingSurv = current.operations.filter(
    (o) => !o.resolved && o.pendingTurns <= 1 && o.kind === "surveillance",
  );
  for (const op of pendingSurv) {
    if (isDefunct(current, op.targetFamily)) {
      const stopped = scatterFamily(current, op.targetFamily, rng);
      current = stopped.state;
      if (stopped.logs.length) {
        current = { ...current, turnLog: [...current.turnLog, ...stopped.logs].slice(-200) };
      }
      continue;
    }
    const stateBefore = current;
    const casing = runCasing(current, op, rng);
    current = casing.state;
    const presentIds = casing.present.map((c) => c.id);
    if (casing.roll.copTrouble !== "arrested") {
      current = recordIntel(current, presentIds, op.targetTerritoryId, "surveillance");
    }

    const fallout = applyCasingFallout(current, op, casing);
    current = fallout.state;

    // Free lookout assignment
    if (op.lookoutId) {
      current = {
        ...current,
        crew: current.crew.map((c) =>
          c.id === op.lookoutId && c.assignment.operationId === op.id
            ? { ...c, assignment: { type: "idle" as const } }
            : c,
        ),
      };
    }

    const district =
      current.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "the district";
    tipLogs.push({
      id: `surv_${op.id}_${current.turn}`,
      turn: current.turn,
      category: "hit",
      text: casingLogText(op, casing, fallout, district),
      family: op.family,
    });

    current = {
      ...current,
      operations: current.operations.map((o) =>
        o.id === op.id ? { ...o, resolved: true, pendingTurns: 0, resolvedTurn: state.turn } : o,
      ),
    };

    if (op.family === current.playerFamily) {
      reports.push(
        buildLookoutReport(stateBefore, current, op, presentIds, fallout.outcome, fallout.relationDelta, {
          casing,
          consequences: fallout.consequences,
        }),
      );
    }
  }

  // Tick pending ops; surveil-first hits grant intel when casing finishes (2→1)
  const casingFinished: Operation[] = [];
  const nextOps = current.operations
    .map((o) => {
      if (o.resolved || o.pendingTurns <= 0) return o;
      const nextTurns = o.pendingTurns - 1;
      const becameReady = nextTurns === 0 && o.kind === "hit";
      const finishedCasing = o.kind === "hit" && o.pendingTurns > 1 && nextTurns <= 1;
      if (finishedCasing) casingFinished.push(o);
      return {
        ...o,
        pendingTurns: nextTurns,
        surveilled: o.surveilled || becameReady || finishedCasing,
      };
    })
    // Resolved ops linger a few weeks: the reel, deal settlement, sit-down
    // classification and "bleeding" all look them up by id after the fact.
    .filter(
      (o) => !o.resolved || (o.resolvedTurn ?? -99) > current.turn - RESOLVED_OP_MEMORY_TURNS,
    );

  // Ops list must be swapped in before casing fallout touches crew/intel.
  current = { ...current, operations: nextOps };

  for (const o of casingFinished) {
    const stateBefore = current;
    const casing = runCasing(current, o, rng, { forHit: true });
    current = casing.state;
    const presentIds = casing.present.map((c) => c.id);
    if (casing.roll.copTrouble !== "arrested") {
      current = recordIntel(current, presentIds, o.targetTerritoryId, "surveillance");
    }

    const fallout = applyCasingFallout(current, o, casing);
    current = fallout.state;

    if (o.family === current.playerFamily) {
      reports.push(
        buildLookoutReport(stateBefore, current, o, presentIds, fallout.outcome, fallout.relationDelta, {
          forHit: true,
          casing,
          consequences: fallout.consequences,
        }),
      );
      const district =
        current.territories.find((t) => t.id === o.targetTerritoryId)?.name ?? "the district";
      tipLogs.push({
        id: `surv_hit_${o.id}_${current.turn}`,
        turn: current.turn,
        category: "hit",
        text:
          fallout.outcome === "clean"
            ? `Casing complete: ${presentIds.length} ${o.targetFamily} men in ${district}. Hit ready next turn.`
            : `Casing complete but you were spotted in ${district}. Hit ready — block is alert.`,
        family: o.family,
      });
    }
  }

  current = {
    ...current,
    turnLog: [...current.turnLog, ...tipLogs],
  };

  return { state: current, results, tipLogs, reports };
}

/* ------------------------------------------------------------------ */
/* Casing fallout                                                      */
/* ------------------------------------------------------------------ */

interface CasingFallout {
  state: GameState;
  outcome: LookoutOutcome;
  relationDelta: number;
  consequences: string[];
}

/**
 * Apply what the detection rung and the cops did to the lookout, the district,
 * and relations. Shared by standalone casing and surveil-first hits.
 */
function applyCasingFallout(
  state: GameState,
  op: Operation,
  casing: CasingResult,
): CasingFallout {
  const turn = state.turn;
  const lookout = casing.lookout;
  const consequences: string[] = [];
  let relationDelta = 0;
  let crew = state.crew;
  let relations = state.relations;
  let grudges = state.grudges ?? [];
  const intel = { ...(state.intel ?? emptyIntel()) };
  let next = state;

  const setCrew = (id: string, patch: Partial<CrewMember>) => {
    crew = crew.map((c) => (c.id === id ? { ...c, ...patch } : c));
  };
  const payLookout = (nextCrew: CrewMember[]) =>
    lookout ? grantXpToCrew(nextCrew, lookout.id, CASING_REPORT_XP).crew : nextCrew;
  const territoryName =
    state.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "the district";
  const lookoutName = lookout ? lastName(lookout) : "Your man";

  // Cops.
  if (lookout && casing.roll.copTrouble === "wanted") {
    setCrew(lookout.id, { wanted: lookout.wanted + 1 });
    consequences.push(`${lookoutName} got his name taken by a beat cop.`);
  } else if (lookout && casing.roll.copTrouble === "arrested") {
    crew = jailInCrew(crew, lookout.id, turn).map((c) =>
      c.id === lookout.id
        ? { ...c, wanted: lookout.wanted + 1, assignment: { type: "idle" as const } }
        : c,
    );
    consequences.push(`${lookoutName} was picked up loitering. He saw nothing.`);
    return {
      state: { ...next, crew: payLookout(crew) },
      outcome: "clean",
      relationDelta,
      consequences,
    };
  }

  // A legacy tip-off on the op counts as at least "noticed".
  let rung = casing.roll.rung;
  if (op.tippedOff && rung === "clean") rung = "noticed";

  if (rung === "turned" && lookout) {
    // He came back smiling. He's theirs now.
    setCrew(lookout.id, {
      loyalty: Math.max(0, lookout.loyalty - 10),
      traits: lookout.traits.includes("rat_risk") ? lookout.traits : [...lookout.traits, "rat_risk"],
    });
    return { state: { ...next, crew: payLookout(crew) }, outcome: "clean", relationDelta, consequences };
  }

  if (rung === "clean") {
    // A clean job on the street teaches a loose soldier something.
    const learned = learnFromCleanCasing(crew, lookout?.id);
    if (learned !== crew && lookout && op.family === state.playerFamily) {
      consequences.push(`${lookoutName} is getting quieter on his feet. Stealth +1.`);
    }
    const paid = lookout ? bumpLoyalty(learned, [lookout.id], 3) : { crew: learned, gained: [] as string[] };
    if (paid.gained.length > 0 && op.family === state.playerFamily) consequences.push("Loyalty +3.");
    return { state: { ...next, crew: payLookout(paid.crew) }, outcome: "clean", relationDelta, consequences };
  }

  // noticed / made / grabbed all put the block on alert.
  intel.alerted = { ...intel.alerted, [op.targetTerritoryId]: turn + ALERT_TURNS };
  consequences.push(`${territoryName} is on alert for ${ALERT_TURNS} turns.`);

  // The mark saw him: his habits change.
  if (casing.roll.markSawHim) {
    const mark = casing.clues.find((c) => c.kind === "routine")?.targetCrewId;
    if (mark) {
      const live = (intel.clues[op.targetTerritoryId] ?? []).filter(
        (c) => !(c.kind === "routine" && c.targetCrewId === mark),
      );
      intel.clues = { ...intel.clues, [op.targetTerritoryId]: live };
      const markCrew = state.crew.find((c) => c.id === mark);
      consequences.push(`${markCrew ? lastName(markCrew) : "The mark"} saw him and changed his routine.`);
    }
  }

  if (rung === "noticed") {
    relationDelta = -5;
  } else {
    // made or grabbed
    relationDelta = rung === "made" ? -10 : -15;
    if (lookout) {
      intel.burned = {
        ...intel.burned,
        [lookout.id]: { family: op.targetFamily, expiresTurn: turn + BURN_TURNS },
      };
      consequences.push(`${op.targetFamily} knows ${lookoutName}'s face now.`);
    }
    // Only rivals hold grudges the AI acts on.
    if (op.family === state.playerFamily) {
      grudges = [
        ...grudges,
        {
          id: `grudge_casing_${op.id}_${turn}`,
          family: op.targetFamily,
          against: op.family,
          crewId: lookout?.id,
          territoryId: op.originTerritoryId ?? op.targetTerritoryId,
          reason: "casing",
          turn,
          expiresTurn: turn + GRUDGE_TURNS,
        },
      ];
      consequences.push(`${op.targetFamily} are asking about you. They want ${lookoutName}.`);
    }

    if (hasPact(next, op.family, op.targetFamily) && op.family === state.playerFamily) {
      next = breakPact(next, op.targetFamily);
      relations = next.relations;
      consequences.push(`Your pact with ${op.targetFamily} is finished.`);
    }
  }

  let wounded = false;
  if (rung === "grabbed" && lookout) {
    switch (casing.roll.grabbedFate) {
      case "killed":
        setCrew(lookout.id, { status: "dead", assignment: { type: "idle" } });
        crew = funeralLoyaltyHit(crew, lookout.id);
        consequences.push(`${lookoutName} was found in the river.`);
        break;
      case "held":
        setCrew(lookout.id, {
          status: "held",
          heldUntilTurn: turn + HELD_TURNS,
          heldBy: op.targetFamily,
          assignment: { type: "idle" },
        });
        consequences.push(`${lookoutName} is being held by ${op.targetFamily}. ${HELD_TURNS} turns, if he's lucky.`);
        break;
      default:
        wounded = true;
        setCrew(lookout.id, { status: "wounded" });
        consequences.push(`${lookoutName} took a beating and crawled home.`);
        break;
    }
  }

  if (lookout && rung !== "grabbed") {
    const paid = bumpLoyalty(crew, [lookout.id], 2);
    crew = paid.crew;
    if (paid.gained.length > 0 && op.family === state.playerFamily) consequences.push("Loyalty +2.");
  } else if (lookout && casing.roll.grabbedFate !== "killed") {
    const paid = bumpLoyalty(crew, [lookout.id], 1);
    crew = paid.crew;
    if (paid.gained.length > 0 && op.family === state.playerFamily) consequences.push("Loyalty +1.");
  }

  relations = setRelationDelta(relations, op.family, op.targetFamily, relationDelta);

  next = {
    ...next,
    crew: payLookout(crew),
    relations,
    grudges,
    intel: op.family === state.playerFamily ? intel : next.intel,
  };

  return { state: next, outcome: rungToOutcome(rung, wounded), relationDelta, consequences };
}

function casingLogText(
  op: Operation,
  casing: CasingResult,
  fallout: CasingFallout,
  district: string,
): string {
  const n = casing.present.length;
  const rung = fallout.outcome === "clean" ? "clean" : casing.roll.rung;
  if (casing.roll.copTrouble === "arrested") {
    return `Your lookout was picked up by the cops before he saw anything in ${district}.`;
  }
  const loyal = fallout.consequences.find((c) => c.startsWith("Loyalty +"));
  const withLoyal = (text: string) => (loyal ? `${text} ${loyal}` : text);
  switch (rung) {
    case "clean":
    case "turned":
      return withLoyal(`Your lookout reports ${n} ${op.targetFamily} men in ${district} (clean).`);
    case "noticed":
      return withLoyal(`Your lookout was noticed casing ${district} — the block is on alert.`);
    case "made":
      return withLoyal(`Your lookout was made casing ${district}. They know his face.`);
    case "grabbed":
      return withLoyal(
        `Your lookout was grabbed casing ${district}. ${fallout.consequences.filter((c) => !c.startsWith("Loyalty +")).at(-1) ?? ""}`.trim(),
      );
    default:
      return withLoyal(`Your lookout reports from ${district}.`);
  }
}
