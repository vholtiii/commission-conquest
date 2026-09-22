import type {
  CrewMember,
  FamilyName,
  GameState,
  HitApproach,
  HitBeat,
  HitCasualtyDetail,
  HitOutcome,
  HitResult,
  LookoutOutcome,
  LookoutReport,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { approachSpec, exposedCrewIds, hitCrewIds } from "@/data/hitApproaches";
import type { Rng } from "./rng";
import { aggregateTraitEffects, crewCombatScore, funeralLoyaltyHit, grantXpToCrew } from "./crew";
import { setRelationDelta } from "./relations";
import { crewPresentIn, resolveCrewTerritoryId } from "./crewLocation";
import { emptyIntel, recordIntel } from "./intel";
import { buildLookoutReport, runCasing, rungToOutcome, type CasingResult } from "./lookout";
import { applySuccession } from "./succession";
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
import { applyRetaliationJudgment, openIncidentFromHit } from "./incidents";
import { hasPact, breakPact } from "./diplomacy";

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
};

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

/** BFS hop count between territories via adjacency; 0 if same, large if unreachable. */
export function territoryHops(
  state: GameState,
  originId: string | undefined,
  targetId: string,
): number {
  if (!originId || originId === targetId) return 0;
  const byId = new Map(state.territories.map((t) => [t.id, t]));
  if (!byId.has(originId) || !byId.has(targetId)) return 4;
  const queue: { id: string; dist: number }[] = [{ id: originId, dist: 0 }];
  const seen = new Set<string>([originId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = byId.get(cur.id);
    if (!node) continue;
    for (const adj of node.adjacentTerritories) {
      if (seen.has(adj)) continue;
      if (adj === targetId) return cur.dist + 1;
      seen.add(adj);
      queue.push({ id: adj, dist: cur.dist + 1 });
    }
  }
  return 5;
}

export function getawayRisk(state: GameState, op: Operation, opts?: OddsOptions): number {
  let hops = territoryHops(state, op.originTerritoryId, op.targetTerritoryId);
  if (usesClues(state, op)) {
    const getaway = findClue(state, op.targetTerritoryId, "getaway");
    if (clueHolds(getaway, opts?.truth)) hops = Math.max(1, hops - (getaway.value ?? 1));
  }
  const wheelman = findCrew(state, op.wheelmanId);
  const driving = wheelman?.skills.driving ?? 0;
  const raw = (hops - 1) * 0.08 - driving / 250;
  return Math.max(-0.1, Math.min(0.3, raw));
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
      return crewCombatScore(s) / combatDivisor + traits.hitMod;
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

  let base = 0.35;
  let roles = 0;
  let targetMod = 0;
  let district = 0;
  let garrison = 0;
  let getaway = 0;
  let tipped = 0;
  let intel = 0;
  let heat = 0;
  let approachMod = mods.stealth + mods.power;
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
  const defenders = defendersFor(state, op);
  const exposed = exposedCrewIds(op);
  if (defenders <= 0 || exposure <= 0 || exposed.length === 0) return 0;
  const raw = exposure * 0.06 * defenders / Math.sqrt(exposed.length);
  let mult = 1;
  if (op.surveilled) mult *= 0.7;
  if (op.lookoutId) mult *= 0.8;
  if (op.tippedOff) mult *= 1.6;
  if (op.blind) mult *= 0.9;
  return Math.min(0.4, raw * mult);
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
  },
  rng: Rng,
): Operation {
  return {
    id: `op_hit_${rng.int(10000, 99999)}`,
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
    (c) => c.family === op.targetFamily && c.status === "active",
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

  const defenders = defendersFor(state, workingOp, TRUTH);

  // The mark isn't where you planned for him (moved, jailed, dead, or held): no body tonight.
  const plannedTarget = workingOp.targetCrewId
    ? state.crew.find((c) => c.id === workingOp.targetCrewId)
    : undefined;
  const markMoved =
    !!plannedTarget &&
    !blind &&
    (plannedTarget.status === "dead" ||
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
        crew = crew.map((c) =>
          c.id === arrested ? { ...c, status: "jailed" as const } : c,
        );
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

  // Garrison return fire
  const firefightNames: string[] = [];
  if (!emptyBlock && defenders > 0 && spec.garrisonExposure > 0 && exposed.length > 0) {
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
      (spec.garrisonExposure * 0.06 * defenders) / Math.sqrt(exposed.length) * mult,
    );
    const maxCas = Math.ceil(defenders / 2);
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

  const xpPer = targetDead ? 15 : 10;
  for (const sid of hitCrewIds(op)) {
    const granted = grantXpToCrew(crew, sid, xpPer);
    crew = granted.crew.map((c) =>
      c.id === sid ? { ...c, hits: c.hits + 1 } : c,
    );
  }

  let relations = setRelationDelta(state.relations, op.family, op.targetFamily, -25);
  if (outcome === "clean_kill" || outcome === "messy_kill") {
    relations = setRelationDelta(relations, op.family, op.targetFamily, -15);
  }

  const operations = state.operations.map((o) =>
    o.id === op.id ? { ...o, resolved: true, pendingTurns: 0 } : o,
  );

  const beats = buildBeats(rng, approach, outcome, targetName, {
    tippedOff,
    markAbsent: markAbsent || emptyBlock,
    firefightNames,
    trap,
  });
  if (emptyBlock) {
    beats[1] = { phase: "complication", text: "Empty block — nobody home." };
    beats[2] = { phase: "execution", text: "The crew packs up with nothing to show." };
  }

  // Blind reputation deltas
  let respectDelta = targetDead ? 8 : -3;
  let influenceDelta = 0;
  let streetDelta = 0;
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
  };

  let newState: GameState = {
    ...state,
    crew,
    relations,
    operations,
    influence: Math.max(0, Math.min(300, state.influence + influenceDelta)),
    reputation: {
      ...state.reputation,
      fear: Math.min(100, state.reputation.fear + fearGain),
      respect: Math.max(0, Math.min(100, state.reputation.respect + respectDelta)),
      streetInfluence: Math.max(
        0,
        Math.min(100, state.reputation.streetInfluence + streetDelta),
      ),
    },
    heat: {
      ...state.heat,
      level: Math.min(100, state.heat.level + heatGain),
      sources: [...state.heat.sources, `hit:${op.id}`].slice(-20),
    },
    vendettas: state.vendettas.includes(op.targetFamily)
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
    newState = openIncidentFromHit(newState, op, result, rng).state;
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

  for (const fam of deadBossFamilies) {
    const stillBoss = newState.crew.find(
      (c) => c.family === fam && c.role === "boss" && c.status !== "dead",
    );
    if (stillBoss) continue;
    const succ = applySuccession(newState, fam, rng);
    newState = succ.state;
    if (succ.logs.length) {
      newState = {
        ...newState,
        turnLog: [...newState.turnLog, ...succ.logs].slice(-200),
      };
    }
    if (succ.succeeded && succ.newBossName) {
      finalResult = {
        ...finalResult,
        headline: `${finalResult.headline} ${succ.newBossName} takes the chair.`,
      };
      if (op.family === state.playerFamily) {
        newState = { ...newState, pendingHitResult: finalResult };
      }
    }
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
  },
): HitBeat[] {
  const approachText: Record<HitApproach, string> = {
    ambush: "The crew takes position in a blind alley, waiting for the mark.",
    drive_by: "A black sedan rolls slow past the target's hangout.",
    car_bomb: "A wired Packard is parked on the mark's usual route.",
    sitdown_betrayal: "A friendly sit-down is arranged over coffee and lies.",
  };

  const complicationByApproach: Record<HitApproach, string[]> = {
    ambush: [
      "A patrol wagon turns the corner — everyone freezes.",
      "Rival muscle appears across the street.",
      "Rain slicks the pavement, ruining footing.",
      "The target arrives with unexpected backup.",
    ],
    drive_by: [
      "The wheelman stalls at a red light with cops behind.",
      "A civilian wagon blocks the escape lane.",
      "The mark ducks behind a fruit cart.",
      "A motorcycle escort flanks the target.",
    ],
    car_bomb: [
      "The fuse sputters — a dud for a heartbeat.",
      "Wrong Packard: another car sits in the spot.",
      "A beat cop leans on the fender to light a smoke.",
      "Rain soaks the detonator wiring.",
    ],
    sitdown_betrayal: [
      "The negotiator is patted down at the door.",
      "The mark brings a silent witness to the booth.",
      "Hidden backup is spotted in the kitchen.",
      "The sit-down starts with an unexpected toast — delay.",
    ],
  };

  const executionClean: Record<HitApproach, string> = {
    ambush: `Clean shot. ${targetName} drops without a sound.`,
    drive_by: `Windows shatter — ${targetName} never sees the car leave.`,
    car_bomb: `The Packard erupts. ${targetName} never makes the corner.`,
    sitdown_betrayal: `The handshake ends under the table. ${targetName} is finished.`,
  };
  const executionMessy: Record<HitApproach, string> = {
    ambush: `Lead flies wild. ${targetName} is hit but the block erupts in chaos.`,
    drive_by: `Spray paints the sidewalk — ${targetName} goes down in full view.`,
    car_bomb: `The blast takes half the street with ${targetName}.`,
    sitdown_betrayal: `Chairs overturn; ${targetName} dies loud in the cafe.`,
  };
  const executionBotched: Record<HitApproach, string> = {
    ambush: `The hit goes sideways — sirens already wail in the distance.`,
    drive_by: `The sedan catches fire from return shots; abort.`,
    car_bomb: `The package fails. Smoke and panic, no body.`,
    sitdown_betrayal: `The mark smells the trap and flips the table.`,
  };
  const executionEscape = `${targetName} slips away in the confusion.`;

  let complicationText = rng.pick(complicationByApproach[approach]);
  if (opts.tippedOff && opts.markAbsent) {
    complicationText = "The mark never showed. Someone talked.";
  } else if (opts.trap) {
    complicationText = "It was a trap. They were waiting.";
  } else if (opts.tippedOff) {
    complicationText = "Word leaked — the street feels wrong before the first shot.";
  }

  let executionText = executionClean[approach];
  if (opts.markAbsent) executionText = "Empty alley. The job dies without a body.";
  else if (outcome === "messy_kill") executionText = executionMessy[approach];
  else if (outcome.startsWith("botched")) executionText = executionBotched[approach];
  else if (outcome === "target_escaped") executionText = executionEscape;

  let getawayText = "The crew vanishes into the tenements before uniforms arrive.";
  if (outcome === "botched_arrested" || outcome === "botched_killed") {
    getawayText = "Police blockades seal off the neighborhood.";
  }
  if (opts.firefightNames.length > 0) {
    const who =
      opts.firefightNames.length === 1
        ? opts.firefightNames[0]
        : `${opts.firefightNames[0]} and others`;
    getawayText = `The garrison returns fire from the stoops — ${who} takes a slug on the way out.`;
  }

  return [
    { phase: "approach", text: approachText[approach] },
    { phase: "complication", text: complicationText },
    { phase: "execution", text: executionText },
    { phase: "getaway", text: getawayText },
  ];
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

export function resolvePendingOperations(
  state: GameState,
  rng: Rng,
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
    (o) => !o.resolved && o.pendingTurns <= 0 && o.kind === "hit",
  );
  for (const op of pendingHits) {
    const { state: next, result } = resolveHit(current, op, rng);
    current = next;
    results.push(result);
  }

  // Resolve ready surveillance ops (pendingTurns <= 1 → report next turn)
  const pendingSurv = current.operations.filter(
    (o) => !o.resolved && o.pendingTurns <= 1 && o.kind === "surveillance",
  );
  for (const op of pendingSurv) {
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
        o.id === op.id ? { ...o, resolved: true, pendingTurns: 0 } : o,
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
    .filter((o) => !o.resolved);

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
  const territoryName =
    state.territories.find((t) => t.id === op.targetTerritoryId)?.name ?? "the district";
  const lookoutName = lookout ? lastName(lookout) : "Your man";

  // Cops.
  if (lookout && casing.roll.copTrouble === "wanted") {
    setCrew(lookout.id, { wanted: lookout.wanted + 1 });
    consequences.push(`${lookoutName} got his name taken by a beat cop.`);
  } else if (lookout && casing.roll.copTrouble === "arrested") {
    setCrew(lookout.id, { status: "jailed", wanted: lookout.wanted + 1, assignment: { type: "idle" } });
    consequences.push(`${lookoutName} was picked up loitering. He saw nothing.`);
    return {
      state: { ...next, crew },
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
    return { state: { ...next, crew }, outcome: "clean", relationDelta, consequences };
  }

  if (rung === "clean") {
    return { state: next, outcome: "clean", relationDelta, consequences };
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

  relations = setRelationDelta(relations, op.family, op.targetFamily, relationDelta);

  next = {
    ...next,
    crew,
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
  switch (rung) {
    case "clean":
    case "turned":
      return `Your lookout reports ${n} ${op.targetFamily} men in ${district} (clean).`;
    case "noticed":
      return `Your lookout was noticed casing ${district} — the block is on alert.`;
    case "made":
      return `Your lookout was made casing ${district}. They know his face.`;
    case "grabbed":
      return `Your lookout was grabbed casing ${district}. ${fallout.consequences[fallout.consequences.length - 1] ?? ""}`.trim();
    default:
      return `Your lookout reports from ${district}.`;
  }
}
