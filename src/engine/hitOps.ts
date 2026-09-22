import type {
  CrewMember,
  FamilyName,
  GameState,
  HitApproach,
  HitBeat,
  HitCasualtyDetail,
  HitOutcome,
  HitResult,
  LookoutReport,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { approachSpec, exposedCrewIds, hitCrewIds } from "@/data/hitApproaches";
import type { Rng } from "./rng";
import { aggregateTraitEffects, crewCombatScore, funeralLoyaltyHit, grantXpToCrew } from "./crew";
import { setRelationDelta } from "./relations";
import { crewPresentIn } from "./crewLocation";
import { hasFreshCasing, recordIntel } from "./intel";
import { buildLookoutReport } from "./lookout";
import { applySuccession } from "./succession";

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
export function defendersFor(state: GameState, op: Operation): number {
  const territory = state.territories.find((t) => t.id === op.targetTerritoryId);
  if (!territory) return 0;
  // Only count when the district belongs to the target family
  if (territory.owner !== op.targetFamily) return 0;
  return territory.garrisonIds.filter((id) => {
    if (id === op.targetCrewId) return false;
    const c = state.crew.find((m) => m.id === id);
    return !!c && c.status === "active" && c.family === op.targetFamily;
  }).length;
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

export function getawayRisk(state: GameState, op: Operation): number {
  const hops = territoryHops(state, op.originTerritoryId, op.targetTerritoryId);
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

export function calculateHitOddsBreakdown(state: GameState, op: Operation): HitOddsBreakdown {
  const approach = op.approach ?? "ambush";
  const mods = APPROACH_MODS[approach];
  const spec = approachSpec(approach);
  const target = op.targetCrewId
    ? state.crew.find((c) => c.id === op.targetCrewId)
    : undefined;
  const territory = state.territories.find((t) => t.id === op.targetTerritoryId);
  const exposed = exposedCrewIds(op);
  const defenders = defendersFor(state, op);

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

  // Fresh district casing (standalone lookout) — does not stack with Surveil-first
  if (!op.surveilled) {
    if (op.targetCrewId) {
      const k = state.intel?.known[op.targetCrewId];
      if (
        k &&
        k.territoryId === op.targetTerritoryId &&
        k.source === "surveillance" &&
        k.turn >= state.turn - 2
      ) {
        intel += 0.06;
      }
    } else if (hasFreshCasing(state, op.targetTerritoryId)) {
      intel += 0.06;
    }
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
  const gRisk = getawayRisk(state, op);
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

export function calculateHitOdds(state: GameState, op: Operation): number {
  return calculateHitOddsBreakdown(state, op).total;
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
  if (hasFreshCasing(state, op.targetTerritoryId)) chance -= 0.03;
  return Math.max(0.03, Math.min(0.45, chance));
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
  const gRisk = getawayRisk(state, op);
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

  const defenders = defendersFor(state, workingOp);
  const markAbsent = !emptyBlock && tippedOff && rng.chance(0.35);

  let successChance = calculateHitOdds(state, workingOp);
  let outcome: HitOutcome =
    emptyBlock || markAbsent ? "target_escaped" : rollOutcome(rng, successChance, gRisk);

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
  let heatGain = mods.heat + Math.max(0, exposed.length - 2) * 3;
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
        ? `Ambush reversed — ${op.family} muscle cut down in a trap.`
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

  // Succession when any boss is killed this hit (mark or firefight casualty)
  const deadBossFamilies = new Set<FamilyName>();
  if (targetDead && target?.role === "boss") deadBossFamilies.add(target.family);
  for (const d of casualtyDetail) {
    if (d.fate !== "dead") continue;
    const m = crew.find((c) => c.id === d.crewId);
    if (m?.role === "boss") deadBossFamilies.add(m.family);
  }

  let finalResult = result;
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
): HitOutcome {
  const roll = rng.next();
  if (roll > successChance + 0.15) return "target_escaped";
  if (roll > successChance) {
    // Arrest weight rises with getaway risk
    const arrestWeight = Math.max(0.15, Math.min(0.75, 0.5 + gRisk));
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

      if (o.targetFamily === current.playerFamily) {
        const district =
          current.territories.find((t) => t.id === o.targetTerritoryId)?.name ?? "your turf";
        tipLogs.push({
          id: `tip_${o.id}_${current.turn}`,
          turn: current.turn,
          category: "hit",
          text: `Your lookouts report ${o.family} muscle casing ${district}.`,
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
    const territory = current.territories.find((t) => t.id === op.targetTerritoryId);
    const present = crewPresentIn(current, op.targetTerritoryId).filter(
      (c) => c.family === op.targetFamily,
    );
    const presentIds = present.map((c) => c.id);
    current = recordIntel(current, presentIds, op.targetTerritoryId, "surveillance");

    let crew = current.crew;
    let relations = current.relations;
    let relationDelta = 0;
    let wounded = false;
    if (op.tippedOff) {
      relations = setRelationDelta(relations, op.family, op.targetFamily, -5);
      relationDelta = -5;
      if (op.lookoutId && rng.chance(0.15)) {
        wounded = true;
        crew = crew.map((c) =>
          c.id === op.lookoutId ? { ...c, status: "wounded" as const } : c,
        );
      }
    }
    // Free lookout assignment
    if (op.lookoutId) {
      crew = crew.map((c) =>
        c.id === op.lookoutId && c.assignment.operationId === op.id
          ? { ...c, assignment: { type: "idle" as const } }
          : c,
      );
    }

    const outcome = op.tippedOff
      ? wounded
        ? ("spotted_wounded" as const)
        : ("spotted" as const)
      : ("clean" as const);

    const district = territory?.name ?? "the district";
    const logText =
      outcome === "clean"
        ? `Your lookout reports ${present.length} ${op.targetFamily} men in ${district} (clean).`
        : outcome === "spotted_wounded"
          ? `Your lookout was spotted casing ${district} and wounded — the block is on alert.`
          : `Your lookout was spotted casing ${district} — the block is on alert.`;

    tipLogs.push({
      id: `surv_${op.id}_${current.turn}`,
      turn: current.turn,
      category: "hit",
      text: logText,
      family: op.family,
    });

    current = {
      ...current,
      crew,
      relations,
      operations: current.operations.map((o) =>
        o.id === op.id ? { ...o, resolved: true, pendingTurns: 0 } : o,
      ),
    };

    if (op.family === current.playerFamily) {
      reports.push(
        buildLookoutReport(stateBefore, current, op, presentIds, outcome, relationDelta),
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

  for (const o of casingFinished) {
    const stateBefore = current;
    const present = crewPresentIn(current, o.targetTerritoryId).filter(
      (c) => c.family === o.targetFamily,
    );
    const presentIds = present.map((c) => c.id);
    current = recordIntel(current, presentIds, o.targetTerritoryId, "surveillance");

    if (o.family === current.playerFamily) {
      const outcome = o.tippedOff ? ("spotted" as const) : ("clean" as const);
      reports.push(
        buildLookoutReport(stateBefore, current, o, presentIds, outcome, 0, {
          forHit: true,
        }),
      );
      const district =
        current.territories.find((t) => t.id === o.targetTerritoryId)?.name ?? "the district";
      tipLogs.push({
        id: `surv_hit_${o.id}_${current.turn}`,
        turn: current.turn,
        category: "hit",
        text:
          outcome === "clean"
            ? `Casing complete: ${present.length} ${o.targetFamily} men in ${district}. Hit ready next turn.`
            : `Casing complete but you were spotted in ${district}. Hit ready — block is alert.`,
        family: o.family,
      });
    }
  }

  current = {
    ...current,
    operations: nextOps,
    turnLog: [...current.turnLog, ...tipLogs],
  };

  return { state: current, results, tipLogs, reports };
}
