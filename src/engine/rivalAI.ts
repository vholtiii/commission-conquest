import type {
  CrewMember,
  FamilyName,
  GameState,
  RacketType,
  Territory,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { createCrewMember, getActiveCrew, getBoss, assignCrew, promoteCrew } from "./crew";
import {
  createRacket,
  createDeliveryRoute,
  RACKET_BUILD_COST,
  findDeliveryPath,
  racketIncome,
  hasSafehouse,
} from "./economy";
import { nextRacketSiteIndex } from "./cityLayout";
import { getRelation, setRelationDelta } from "./relations";
import { hasPact } from "./diplomacy";
import { atPeace, contractedTargets } from "./deals";
import { captureAllowance, recordCapture } from "./capture";
import { aiFillCrews, canLeadCrew, freeCrewOf, isHeldOff, placeCrewAt } from "./crews";
import { AI_SITDOWN_CHANCE, AI_SITDOWN_TRAP_CHANCE, aiProposeSitdown, hasArmedBombOnPlayerBoss } from "./sitdowns";
import { bringCrewOnHit, commitHitCrew, planHit } from "./hitOps";
import { dinnerActive } from "./dinner";
import { familyHq, isBossUnderground, resolveCrewTerritoryId } from "./crewLocation";
import { isLaidLow, SAFEHOUSE, safehouseCaptureDefence } from "./safehouse";
import { BOSS_PRESENCE, bossPresentIn, hqIsSoft } from "./bossPresence";
import { actingUnderboss, bossIsJailed } from "./jail";
import { canInheritChair, isDefunct, isFamilyFinished, scatterFamily } from "./defection";
import { familiesPressingSuddenDeath } from "./victory";
import { recordIntel } from "./intel";
import {
  isUnguarded,
  maxRacketsFor,
  valueScore,
  allowedRacketTypes,
} from "./territoryValue";
import { withdrawCrates } from "./liquor";
import { openIncidentFromHijack } from "./incidents";
import { CRATE_STREET_VALUE, passageGrudges } from "./passage";
import type { HitApproach } from "@/types/game";

const RACKET_PRIORITY: Record<string, RacketType[]> = {
  economic: ["restaurant", "gambling", "loan_shark", "speakeasy"],
  expansionist: ["warehouse", "speakeasy", "brothel"],
  covert: ["deli", "loan_shark", "gambling"],
  smuggler: ["warehouse", "brewery", "still", "speakeasy"],
  volatile: ["brothel", "gambling", "loan_shark"],
};

function pickWeighted<T>(
  rng: Rng,
  items: T[],
  weightFn: (item: T) => number,
): T | undefined {
  if (items.length === 0) return undefined;
  const weights = items.map((item) => Math.max(0, weightFn(item)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return rng.pick(items);
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function ownedTerritories(state: GameState, family: FamilyName): Territory[] {
  return state.territories.filter((t) => t.owner === family);
}

function adjacentNeutralOrEnemy(
  state: GameState,
  family: FamilyName,
): Territory[] {
  const owned = ownedTerritories(state, family);
  const candidates = new Map<string, Territory>();
  for (const t of owned) {
    for (const adjId of t.adjacentTerritories) {
      const adj = state.territories.find((x) => x.id === adjId);
      if (adj && adj.owner !== family) {
        candidates.set(adj.id, adj);
      }
    }
  }
  return [...candidates.values()];
}

function tryBuildRacket(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const def = getFamilyDef(family);
  const priorities = RACKET_PRIORITY[def.personality] ?? RACKET_PRIORITY.economic!;
  const owned = ownedTerritories(state, family);
  const open = owned.filter((t) => t.rackets.length < maxRacketsFor(t));
  if (open.length === 0) return { state };
  const target = pickWeighted(
    rng,
    open,
    (t) => Math.max(1, maxRacketsFor(t) - t.rackets.length),
  );
  if (!target) return { state };

  const allowed = allowedRacketTypes(target);
  const preferred = priorities.filter((type) => allowed.includes(type));
  const pool = preferred.length > 0 ? preferred : allowed;
  if (pool.length === 0) return { state };
  const type = rng.pick(pool);
  const cost = RACKET_BUILD_COST[type];
  const treasury = state.rivalTreasury?.[family] ?? 0;
  if (treasury < cost) return { state };

  const racket = createRacket(
    `racket_${family}_${rng.int(1000, 9999)}`,
    target.id,
    type,
    1,
    state.turn,
    nextRacketSiteIndex(target.rackets),
  );
  const territories = state.territories.map((t) =>
    t.id === target.id ? { ...t, rackets: [...t.rackets, racket] } : t,
  );

  return {
    state: {
      ...state,
      territories,
      rivalTreasury: {
        ...(state.rivalTreasury ?? {}),
        [family]: treasury - cost,
      },
    },
    log: {
      id: `ai_racket_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} opens a new ${type.replace("_", " ")} in ${target.name}.`,
      family,
    },
  };
}

/** Garrison a rival counts when muscling in. A dinner empties the player's blocks. */
export function expandGarrisonCount(state: GameState, territory: Territory): number {
  if (dinnerActive(state) && territory.owner === state.playerFamily) return 0;
  return territory.garrisonIds.length;
}

function tryExpand(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  // One district a turn, same as the player. Once the base move is spent, only
  // special-case grabs (leadership vacuum, vendetta target) stay on the table.
  const targets = adjacentNeutralOrEnemy(state, family).filter(
    (t) =>
      (!t.owner || !atPeace(state, family, t.owner)) &&
      captureAllowance(state, family, t).ok,
  );
  if (targets.length === 0) return { state };

  // An HQ whose boss is holding court elsewhere is soft; the block he stands
  // on is not. Rivals read both.
  const bossWeight = (t: Territory): number => {
    if (!t.owner || t.owner === family) return 0;
    if (bossPresentIn(state, t.owner, t.id)) return BOSS_PRESENCE.aiBossBlockRoll;
    if (hqIsSoft(state, t.owner) && familyHq(state, t.owner) === t.id) return -BOSS_PRESENCE.aiHqSoftRoll;
    return 0;
  };
  // A safehouse on the block is a fortified door: it reads as extra defence.
  const fortification = (t: Territory): number =>
    t.owner ? safehouseCaptureDefence(t, state.turn) - 1 : 0;
  const openStreet = (t: Territory) => dinnerActive(state) && t.owner === state.playerFamily;
  const scored = targets
    .map((t) => {
      const garrison = expandGarrisonCount(state, t);
      const softness =
        (t.owner ? 2 : 0) + t.defenseBonus + fortification(t) + garrison + bossWeight(t) * 10;
      const pressing = t.owner && familiesPressingSuddenDeath(state).includes(t.owner) ? 1.6 : 1;
      const heard = openStreet(t) && state.familyDinner?.knownBy.includes(family) ? 1.6 : 1;
      const score = (valueScore(t) / (1 + Math.max(0, softness))) * pressing * heard;
      return { t, softness, score };
    })
    .sort((a, b) => b.score - a.score);
  const target = scored[0]!.t;
  const garrison = expandGarrisonCount(state, target);
  const softness =
    (target.owner ? 2 : 0) + target.defenseBonus + fortification(target) + garrison;

  // A capo (or the consigliere, or the boss) brings his free crew. Their muscle softens the door.
  const rank = (c: CrewMember) => (c.role === "capo" ? 0 : c.role === "consigliere" ? 1 : 2);
  const grab = getActiveCrew(state.crew, family)
    .filter((c) => canLeadCrew(c) && !isHeldOff(c))
    .map((leader) => ({ leader, men: freeCrewOf(state.crew, leader.id) }))
    .filter((x) => x.men.length > 0)
    .sort((a, b) => rank(a.leader) - rank(b.leader) || b.men.length - a.men.length)[0];
  const crewBoost = grab ? 0.04 * grab.men.length : 0;

  const roll = rng.next();
  const success =
    !target.owner ||
    roll >
      Math.max(
        0.05,
        0.35 +
          target.defenseBonus +
          fortification(target) +
          garrison * 0.05 -
          0.05 * Math.min(2, maxRacketsFor(target) - 3) +
          bossWeight(target) -
          crewBoost,
      );

  if (!success) {
    return {
      state,
      log: {
        id: `ai_expand_fail_${family}_${state.turn}`,
        turn: state.turn,
        category: "ai",
        text: `${family} failed to muscle into ${target.name}.`,
        family,
      },
    };
  }

  const prevOwner = target.owner;
  let territories = state.territories.map((t) =>
    t.id === target.id
      ? {
          ...t,
          owner: family,
          leadershipVacuum: 0,
          garrisonIds: [],
        }
      : t,
  );

  let relations = state.relations;
  if (prevOwner) {
    relations = setRelationDelta(relations, family, prevOwner, -20);
  }

  let crew = state.crew;
  if (grab) {
    const placed = placeCrewAt({ crew, territories }, grab.leader.id, target.id);
    crew = assignCrew(placed.crew, grab.leader.id, { type: "garrison", territoryId: target.id });
    const leadId = grab.leader.id;
    territories = placed.territories.map((t) => ({
      ...t,
      garrisonIds:
        t.id === target.id
          ? [...new Set([...t.garrisonIds, leadId])]
          : t.garrisonIds.filter((id) => id !== leadId),
    }));
  }

  const withCrew = grab ? ` ${grab.leader.name} brings ${grab.men.length} of his crew.` : "";
  return {
    state: recordCapture({ ...state, crew, territories, relations }, family),
    log: {
      id: `ai_expand_${family}_${state.turn}_${target.id}`,
      turn: state.turn,
      category: "ai",
      text: `${family} seized ${target.name}${prevOwner ? ` from ${prevOwner}` : ""}${softness < 1 ? " (lightly held)" : ""}.${withCrew}`,
      family,
    },
  };
}

/**
 * Chance per planned hit that the street has already placed a boss who has
 * gone underground (holding court away from his HQ). Otherwise the rival
 * plans on the address everyone knows and finds an empty chair.
 */
export const BOSS_UNDERGROUND_LEAK = 0.4;

/**
 * Where a rival family believes a boss is this week. The HQ is public, and so
 * is any trip (sit-down, weekly visit). A boss underground is only found by
 * a crew that cased him first, or by a leak.
 */
export function believedBossSite(
  state: GameState,
  boss: CrewMember,
  surveilled: boolean,
  rng: Rng,
  observer?: FamilyName,
): string | null {
  const real = resolveCrewTerritoryId(state, boss.id);
  if (!real) return null;
  if (surveilled) return real;
  // A dinner only the families who heard about it can place. Everyone else
  // still thinks he's at the HQ and finds an empty chair.
  if (
    boss.awayAt?.reason === "dinner" &&
    observer &&
    !state.familyDinner?.knownBy.includes(observer)
  ) {
    return familyHq(state, boss.family) ?? real;
  }
  // Laid low: the street barely talks, even if it's the HQ block.
  if (isLaidLow(boss)) {
    return rng.chance(SAFEHOUSE.bossLeak) ? real : (familyHq(state, boss.family) ?? real);
  }
  if (!isBossUnderground(state, boss)) return real;
  if (rng.chance(BOSS_UNDERGROUND_LEAK)) return real;
  return familyHq(state, boss.family) ?? real;
}

function tryHit(
  state: GameState,
  family: FamilyName,
  rng: Rng,
  vendetta: boolean,
  contracted?: FamilyName,
): { state: GameState; log?: TurnLogEntry } {
  const def = getFamilyDef(family);
  const crew = getActiveCrew(state.crew, family);
  if (crew.filter((c) => c.role !== "boss").length < 1 && crew.length < 1) return { state };

  let targetFamily: FamilyName | undefined;
  // A job they've been paid for comes first, unless they've since given that family their word.
  if (contracted && !atPeace(state, family, contracted)) {
    targetFamily = contracted;
  }
  if (!targetFamily && vendetta && state.vendettas.includes(family)) {
    const vendettaTargets = state.vendettas.filter(
      (v) => v !== family && !atPeace(state, family, v),
    );
    if (vendettaTargets.length > 0) {
      targetFamily = rng.pick(vendettaTargets);
    }
  }
  if (!targetFamily) {
    const open = ALL_FAMILY_NAMES.filter(
      (f) => f !== family && !atPeace(state, family, f),
    );
    if (open.length === 0) return { state };
    const hostile = open.filter(
      (f) => getRelation(state.relations, family, f) < -20,
    );
    const pressing = familiesPressingSuddenDeath(state).filter((f) => open.includes(f));
    const pool = hostile.length > 0 ? hostile : open;
    targetFamily =
      pressing.length > 0 && rng.chance(0.7) ? rng.pick(pressing) : rng.pick(pool);
  }

  const targetTerritory =
    state.territories.find((t) => t.owner === targetFamily) ??
    adjacentNeutralOrEnemy(state, family)[0];
  if (!targetTerritory) return { state };

  const targetBoss = getBoss(state.crew, targetFamily!);
  const surveilled = def.personality === "covert" && rng.chance(0.6);
  const bossTerritoryId = targetBoss
    ? believedBossSite(state, targetBoss, surveilled, rng, family)
    : null;
  // The street's address, not the man's: a boss underground was not found.
  const badAddress =
    !!targetBoss &&
    !!bossTerritoryId &&
    bossTerritoryId !== resolveCrewTerritoryId(state, targetBoss.id);
  const hitTerritory =
    (bossTerritoryId && state.territories.find((t) => t.id === bossTerritoryId)) ||
    targetTerritory;

  let approach: HitApproach =
    def.personality === "covert" && rng.chance(0.5)
      ? "sitdown_betrayal"
      : def.personality === "volatile" && rng.chance(0.4)
        ? "drive_by"
        : rng.chance(0.3)
          ? "ambush"
          : "car_bomb";
  // A car bomb rides the boss's car; a crew sent to the wrong kerb has nothing
  // to wire, so they lie in wait for him instead — and find an empty chair.
  if (badAddress && approach === "car_bomb") approach = "ambush";

  const pool = rng.shuffle([...crew]);
  let shooterIds: string[] = [];
  let wheelmanId: string | undefined;
  let lookoutId: string | undefined;
  let bombMakerId: string | undefined;
  let planterId: string | undefined;
  let negotiatorId: string | undefined;

  if (approach === "ambush") {
    shooterIds = pool
      .filter((c) => c.role !== "boss")
      .slice(0, Math.min(2, pool.length))
      .map((c) => c.id);
    lookoutId = pool.find((c) => !shooterIds.includes(c.id) && c.role !== "boss")?.id;
  } else if (approach === "drive_by") {
    wheelmanId =
      pool.find((c) => c.traits.includes("wheelman"))?.id ??
      [...pool].sort((a, b) => b.skills.driving - a.skills.driving)[0]?.id;
    shooterIds = pool
      .filter((c) => c.id !== wheelmanId && c.role !== "boss")
      .slice(0, Math.min(2, pool.length))
      .map((c) => c.id);
  } else if (approach === "car_bomb") {
    bombMakerId = [...pool]
      .filter((c) => c.role !== "boss")
      .sort((a, b) => b.skills.smarts - a.skills.smarts)[0]?.id;
    planterId = [...pool]
      .filter((c) => c.id !== bombMakerId && c.role !== "boss")
      .sort((a, b) => b.skills.stealth - a.skills.stealth)[0]?.id;
    lookoutId = pool.find(
      (c) => c.id !== bombMakerId && c.id !== planterId && c.role !== "boss",
    )?.id;
  } else {
    negotiatorId =
      getBoss(state.crew, family)?.id ??
      [...pool].sort((a, b) => b.skills.charm - a.skills.charm)[0]?.id;
    shooterIds = pool
      .filter((c) => c.id !== negotiatorId && c.role !== "boss")
      .slice(0, 1)
      .map((c) => c.id);
  }

  if (
    (approach === "ambush" || approach === "drive_by") && shooterIds.length < 1
  ) {
    return { state };
  }
  if (approach === "car_bomb" && (!bombMakerId || !planterId)) return { state };
  if (approach === "sitdown_betrayal" && !negotiatorId) return { state };

  const seated = bringCrewOnHit(
    state.crew,
    { shooterIds, wheelmanId, lookoutId, bombMakerId, planterId, negotiatorId },
    approach,
  );

  const op = planHit(
    state,
    {
      family,
      targetTerritoryId: hitTerritory.id,
      targetFamily: targetFamily!,
      targetCrewId: targetBoss?.id,
      approach,
      shooterIds: seated.shooterIds,
      wheelmanId: seated.wheelmanId,
      lookoutId: seated.lookoutId,
      bombMakerId: seated.bombMakerId,
      planterId: seated.planterId,
      negotiatorId: seated.negotiatorId,
      originTerritoryId:
        ownedTerritories(state, family)[0]?.id ?? hitTerritory.id,
      surveilled,
      pendingTurns: 1,
    },
    rng,
  );

  const committed = commitHitCrew(state, op);
  return {
    state: { ...committed, operations: [...committed.operations, op] },
    log: {
      id: `ai_hit_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} puts a ${approach.replace("_", " ")} on ${targetFamily} in ${hitTerritory.name}.`,
      family,
    },
  };
}

function tryDelivery(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const owned = ownedTerritories(state, family);
  if (owned.length < 2) return { state };

  const source = rng.pick(owned);
  const dest = rng.pick(owned.filter((t) => t.id !== source.id) || owned);
  const path = findDeliveryPath(state.territories, source.id, dest.id, family);
  if (!path) return { state };

  const drivers = getActiveCrew(state.crew, family).filter(
    (c) => c.assignment.type === "idle" || c.traits.includes("wheelman"),
  );
  if (drivers.length === 0) return { state };

  const driver = rng.pick(drivers);
  const route = createDeliveryRoute(
    rng,
    state,
    family,
    driver.id,
    source.id,
    dest.id,
    rng.int(5, 20),
  );
  if (!route) return { state };

  return {
    state: { ...state, routes: [...state.routes, route] },
    log: {
      id: `ai_delivery_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} runs ${route.cargo} crates from ${source.name} to ${dest.name}.`,
      family,
    },
  };
}

function tryHijack(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const enemyRoutes = state.routes.filter(
    (r) =>
      r.status === "active" &&
      r.family !== family &&
      !hasPact(state, family, r.family),
  );
  if (enemyRoutes.length === 0) return { state };

  const route = rng.pick(enemyRoutes);
  const passesThrough = route.path.some((tid) => {
    const t = state.territories.find((x) => x.id === tid);
    return t?.owner === family;
  });

  if (!passesThrough && !rng.chance(0.25)) return { state };

  const routes = state.routes.map((r) =>
    r.id === route.id ? { ...r, status: "hijacked" as const } : r,
  );

  const relations = setRelationDelta(state.relations, family, route.family, -15);
  let next: GameState = {
    ...state,
    routes,
    relations,
    rivalTreasury: {
      ...state.rivalTreasury,
      [family]: (state.rivalTreasury?.[family] ?? 0) + route.cargo * CRATE_STREET_VALUE,
    },
  };

  // The player's truck: a case, not a confession.
  if (route.family === state.playerFamily) {
    next = openIncidentFromHijack(next, route, family, rng).state;
    return {
      state: next,
      log: {
        id: `ai_hijack_${family}_${state.turn}`,
        turn: state.turn,
        category: "delivery",
        text: `Your liquor truck was hijacked on the road. ${route.cargo} crates gone.`,
        family: route.family,
      },
    };
  }

  return {
    state: next,
    log: {
      id: `ai_hijack_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} hijacks a ${route.family} liquor shipment.`,
      family,
    },
  };
}

/** Skilled non-boss the family wants found in the street. */
export function pickMessageTarget(state: GameState, victim: FamilyName): CrewMember | undefined {
  const men = getActiveCrew(state.crew, victim).filter((c) => c.role !== "boss");
  const weight = (c: CrewMember): number => {
    switch (c.role) {
      case "hitman":
        return 3 + c.level * 0.5;
      case "consigliere":
        return 2.5 + c.level * 0.4;
      case "underboss":
        return 1.5 + c.level * 0.3;
      case "capo":
        return c.level >= 3 ? 2 + c.level * 0.4 : 0;
      default:
        return 0;
    }
  };
  return men
    .map((c) => ({ c, w: weight(c) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)[0]?.c;
}

const MESSAGE_COOLDOWN = 6;
const MESSAGE_THRESHOLD: Record<string, number> = {
  volatile: 1,
  smuggler: 1,
  expansionist: 2,
  covert: 2,
  economic: 3,
};

/**
 * Enough trucks through their turf without a deal, a broken deal, and the
 * family sends a message: an ambush or drive-by on one of the player's good
 * men — never the boss. A sit-down on their terms follows.
 */
function tryMessageHit(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const player = state.playerFamily;
  if (!player || family === player) return { state };
  if (atPeace(state, family, player)) return { state };
  const grudges = passageGrudges(state, family);
  const def = getFamilyDef(family);
  if (grudges.length < (MESSAGE_THRESHOLD[def.personality] ?? 2)) return { state };
  if ((state.messageHitTurns?.[family] ?? -99) + MESSAGE_COOLDOWN > state.turn) return { state };
  if (
    state.operations.some(
      (o) => !o.resolved && o.kind === "hit" && o.family === family && o.intent === "message",
    )
  ) {
    return { state };
  }

  const target = pickMessageTarget(state, player);
  if (!target) return { state };
  const where = resolveCrewTerritoryId(state, target.id);
  if (!where) return { state };

  const pool = rng
    .shuffle(getActiveCrew(state.crew, family).filter((c) => c.role !== "boss"))
    .sort((a, b) => b.skills.muscle - a.skills.muscle);
  if (pool.length < 2) return { state };
  const wheelman = pool.find((c) => c.traits.includes("wheelman")) ?? [...pool].sort((a, b) => b.skills.driving - a.skills.driving)[0];
  const approach: HitApproach = wheelman && rng.chance(0.6) ? "drive_by" : "ambush";
  const shooters = pool
    .filter((c) => approach !== "drive_by" || c.id !== wheelman?.id)
    .slice(0, 2)
    .map((c) => c.id);
  if (shooters.length < 1) return { state };

  const seated = bringCrewOnHit(
    state.crew,
    {
      shooterIds: shooters,
      wheelmanId: approach === "drive_by" ? wheelman?.id : undefined,
      lookoutId: pool.find((c) => !shooters.includes(c.id) && c.id !== wheelman?.id)?.id,
    },
    approach,
  );

  const op = planHit(
    state,
    {
      family,
      targetTerritoryId: where,
      targetFamily: player,
      targetCrewId: target.id,
      approach,
      shooterIds: seated.shooterIds,
      wheelmanId: seated.wheelmanId,
      lookoutId: seated.lookoutId,
      originTerritoryId: ownedTerritories(state, family)[0]?.id ?? where,
      pendingTurns: 1,
      intent: "message",
      motive: "route_dispute",
    },
    rng,
  );
  // No public log: the rumor mill is the only warning the player gets.
  const committed = commitHitCrew(state, op);
  return { state: { ...committed, operations: [...committed.operations, op] } };
}

function tryShiftGarrison(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  if (!rng.chance(0.2)) return { state };
  const owned = ownedTerritories(state, family);
  if (owned.length < 2) return { state };

  const sources = owned.filter((t) => {
    if (t.garrisonIds.length === 0) return false;
    // Don't strip the last man from a big block
    if (maxRacketsFor(t) >= 4 && t.garrisonIds.length <= 1) return false;
    return true;
  });
  if (sources.length === 0) return { state };
  const from = rng.pick(sources);
  const movable = from.garrisonIds
    .map((id) => state.crew.find((c) => c.id === id))
    .filter((c) => c && c.status === "active" && c.role !== "boss") as NonNullable<
    ReturnType<typeof state.crew.find>
  >[];
  if (movable.length === 0) return { state };
  const soldier = rng.pick(movable);
  const dests = owned.filter((t) => t.id !== from.id);
  const to = pickWeighted(rng, dests, (t) => maxRacketsFor(t));
  if (!to) return { state };

  const crew = assignCrew(state.crew, soldier.id, {
    type: "garrison",
    territoryId: to.id,
  });
  const territories = state.territories.map((t) => {
    if (t.id === from.id) {
      return { ...t, garrisonIds: t.garrisonIds.filter((id) => id !== soldier.id) };
    }
    if (t.id === to.id) {
      return { ...t, garrisonIds: [...t.garrisonIds, soldier.id] };
    }
    return t;
  });

  return {
    state: { ...state, crew, territories },
    log: {
      id: `ai_shift_${family}_${state.turn}_${soldier.id}`,
      turn: state.turn,
      category: "ai",
      text: `${family} shifts muscle to ${to.name}.`,
      family,
    },
  };
}

export function tryShakedown(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const owned = ownedTerritories(state, family);
  const adjacentIds = new Set(owned.flatMap((t) => t.adjacentTerritories));
  const activeIds = new Set(
    state.crew.filter((c) => c.status === "active").map((c) => c.id),
  );
  const victims = state.territories.filter(
    (t) =>
      adjacentIds.has(t.id) &&
      t.owner &&
      t.owner !== family &&
      !hasPact(state, family, t.owner) &&
      isUnguarded(t, activeIds),
  );
  if (victims.length === 0) return { state };
  const target =
    pickWeighted(
      rng,
      victims,
      (t) =>
        valueScore(t) +
        t.rackets.reduce((n, r) => n + (r.stock > 0 ? r.stock * 5 : 0), 0),
    ) ?? victims[0]!;
  if (!rng.chance(hasSafehouse(target, state.turn) ? 0.35 : 0.6)) {
    return {
      state,
      log: {
        id: `ai_shake_fail_${family}_${state.turn}_${target.id}`,
        turn: state.turn,
        category: "ai",
        text: `${family} tried to shake down ${target.name} but got nothing.`,
        family,
      },
    };
  }

  const skim = Math.floor(
    target.rackets.reduce((n, r) => n + racketIncome(r), 0) * 0.5,
  );
  let territories = state.territories;
  let downgradeNote = "";
  if (rng.chance(0.25) && target.rackets.length > 0) {
    const top = [...target.rackets].sort((a, b) => b.level - a.level)[0]!;
    if (top.level > 1) {
      territories = state.territories.map((t) =>
        t.id === target.id
          ? {
              ...t,
              rackets: t.rackets.map((r) =>
                r.id === top.id ? { ...r, level: r.level - 1 } : r,
              ),
            }
          : t,
      );
      downgradeNote = ` Knocked a ${top.type.replace("_", " ")} down a level.`;
    }
  }

  const victimIsPlayer = target.owner === state.playerFamily;
  const nextDirty = victimIsPlayer
    ? Math.max(0, state.dirtyMoney - skim)
    : state.dirtyMoney;
  let treasury = state.rivalTreasury?.[family] ?? 0;
  treasury += skim;

  // Steal crates from unguarded stash
  let stolenNote = "";
  const liveTarget = territories.find((t) => t.id === target.id) ?? target;
  const cratesOnHand = liveTarget.rackets.reduce((n, r) => n + r.stock, 0);
  if (cratesOnHand > 0) {
    const steal = Math.min(cratesOnHand, 10 + rng.int(0, 15));
    const wd = withdrawCrates(liveTarget, steal, state.turn);
    territories = territories.map((t) =>
      t.id === target.id ? wd.territory : t,
    );
    if (wd.moved > 0) {
      treasury += wd.moved * 12;
      stolenNote = ` Stole ${wd.moved} crates.`;
    }
  }

  const victimLabel =
    victimIsPlayer ? "your unguarded" : `${target.owner}'s unguarded`;

  return {
    state: {
      ...state,
      territories,
      dirtyMoney: nextDirty,
      rivalTreasury: {
        ...(state.rivalTreasury ?? {}),
        [family]: treasury,
      },
    },
    log: {
      id: `ai_shake_${family}_${state.turn}_${target.id}`,
      turn: state.turn,
      category: "ai",
      text: `${family} shook down ${victimLabel} ${target.name}${skim > 0 ? ` for $${skim}` : ""}.${stolenNote}${downgradeNote}`,
      family,
    },
  };
}

function tryBribe(state: GameState, family: FamilyName, rng: Rng): GameState {
  if (family === state.playerFamily) return state;
  if (!rng.chance(0.15)) return state;
  return state;
}

/** Same street price the player pays for a new man. */
const AI_RECRUIT_COST = 800;

function tryRecruit(state: GameState, family: FamilyName, rng: Rng): GameState {
  const count = getActiveCrew(state.crew, family).length;
  if (count >= 12 || !rng.chance(0.2)) return state;
  const treasury = state.rivalTreasury?.[family] ?? 0;
  if (treasury < AI_RECRUIT_COST) return state;
  const recruit = createCrewMember(rng, family, "associate");
  return {
    ...state,
    crew: [...state.crew, recruit],
    rivalTreasury: { ...(state.rivalTreasury ?? {}), [family]: treasury - AI_RECRUIT_COST },
  };
}

export interface AiTurnResult {
  state: GameState;
  logs: TurnLogEntry[];
}

export function runAiTurn(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): AiTurnResult {
  if (family === state.playerFamily) return { state, logs: [] };

  const def = getFamilyDef(family);
  const aggression =
    state.settings.aiAggression *
    (def.personality === "volatile" ? 1.4 : def.personality === "covert" ? 0.8 : 1);

  const logs: TurnLogEntry[] = [];
  let current = tryRecruit(state, family, rng);
  // Capos fill their crews from the family's loose soldiers.
  current = { ...current, crew: aiFillCrews(current.crew, family, current.turn) };

  const actions: Array<() => { state: GameState; log?: TurnLogEntry }> = [];

  switch (def.personality) {
    case "economic":
      actions.push(
        () => tryBuildRacket(current, family, rng),
        () => tryBuildRacket(current, family, rng),
        () => tryExpand(current, family, rng),
        () => tryShakedown(current, family, rng),
      );
      break;
    case "expansionist":
      actions.push(
        () => tryExpand(current, family, rng),
        () => tryExpand(current, family, rng),
        () => tryHit(current, family, rng, false),
        () => tryShakedown(current, family, rng),
      );
      break;
    case "covert":
      actions.push(
        () => tryHit(current, family, rng, false),
        () => tryBuildRacket(current, family, rng),
        () => tryHijack(current, family, rng),
      );
      break;
    case "smuggler":
      actions.push(
        () => tryDelivery(current, family, rng),
        () => tryDelivery(current, family, rng),
        () => tryBuildRacket(current, family, rng),
        () => tryHijack(current, family, rng),
      );
      break;
    case "volatile":
      actions.push(
        () => tryHit(current, family, rng, true),
        () => tryExpand(current, family, rng),
        () => tryHit(current, family, rng, true),
        () => tryShakedown(current, family, rng),
      );
      break;
  }

  if (current.vendettas.includes(family)) {
    actions.unshift(() => tryHit(current, family, rng, true));
  }

  const actionCount = Math.max(1, Math.floor(aggression * 2));
  const picked = rng.shuffle(actions).slice(0, actionCount);

  // A contract the player paid for is worked every week, outside the normal budget.
  const owed = contractedTargets(current, family)[0];
  if (owed) {
    picked.unshift(() => tryHit(current, family, rng, false, owed));
  }

  for (const act of picked) {
    if (!rng.chance(Math.min(0.95, 0.5 + aggression * 0.15))) continue;
    const result = act();
    current = result.state;
    if (result.log) logs.push(result.log);
  }

  // Trucks through their turf without a word: a message, outside the normal budget.
  {
    const msg = tryMessageHit(current, family, rng);
    current = msg.state;
    if (msg.log) logs.push(msg.log);
  }

  current = tryBribe(current, family, rng);

  // Promote a capo to underboss if the seat is empty
  const hasUb = current.crew.some(
    (c) =>
      c.family === family &&
      c.role === "underboss" &&
      (c.status === "active" || c.status === "wounded"),
  );
  if (!hasUb && rng.chance(0.3)) {
    const capo = current.crew.find(
      (c) =>
        c.family === family &&
        c.role === "capo" &&
        c.status === "active" &&
        c.level >= 3,
    );
    if (capo) {
      current = {
        ...current,
        crew: promoteCrew(current.crew, capo.id, "underboss", current.turn),
      };
      logs.push({
        id: `ai_ub_${family}_${current.turn}`,
        turn: current.turn,
        category: "ai",
        text: `${family} elevates ${capo.name} to underboss.`,
        family,
      });
    }
  }

  const shift = tryShiftGarrison(current, family, rng);
  current = shift.state;
  if (shift.log) logs.push(shift.log);

  const travel = tryBossTravel(current, family, rng);
  current = travel.state;
  if (travel.log) logs.push(travel.log);

  // A sit-down gets the other boss out of his house.
  const trapping = hasArmedBombOnPlayerBoss(current, family);
  if (rng.chance(trapping ? AI_SITDOWN_TRAP_CHANCE : AI_SITDOWN_CHANCE)) {
    const invite = aiProposeSitdown(current, family, rng);
    current = invite.state;
    if (invite.log) logs.push(invite.log);
  }

  return { state: current, logs };
}

/**
 * The boss doesn't live behind one desk. Once in a while he spends the week in
 * another of his districts — and the drive home the week after. Both legs are
 * the kind of trip a car bomb is waiting for, so a tipped-off boss stays in.
 */
function tryBossTravel(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const boss = getBoss(state.crew, family);
  if (!boss || boss.status !== "active" || boss.awayAt) return { state };

  const owned = state.territories.filter((t) => t.owner === family);
  if (owned.length < 2) return { state };

  const def = getFamilyDef(family);
  let chance = 0.25;
  if (def.personality === "expansionist" || def.personality === "volatile") chance += 0.1;
  if (def.personality === "covert") chance -= 0.1;
  const marked = state.operations.some(
    (o) =>
      !o.resolved &&
      o.kind === "hit" &&
      o.approach === "car_bomb" &&
      o.tippedOff &&
      o.targetFamily === family,
  );
  if (marked) chance = 0.05;
  if (!rng.chance(chance)) return { state };

  const home = resolveCrewTerritoryId(state, boss.id);
  const options = owned.filter((t) => t.id !== home);
  if (options.length === 0) return { state };
  const dest = pickWeighted(
    rng,
    options,
    (t) => t.rackets.length + 1 + (t.leadershipVacuum > 0 ? 3 : 0),
  );
  if (!dest) return { state };

  const travelled: GameState = {
    ...state,
    crew: state.crew.map((c) =>
      c.id === boss.id
        ? {
            ...c,
            awayAt: { territoryId: dest.id, untilTurn: state.turn + 1, reason: "visit" as const },
          }
        : c,
    ),
  };

  return {
    // "Seen in" is public: the street knows where his car is parked this week.
    state: recordIntel(travelled, [boss.id], dest.id, "sighting"),
    log: {
      id: `ai_boss_visit_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${boss.name} was seen in ${dest.name} this week.`,
      family,
    },
  };
}

/**
 * A headless rival family doesn't stay headless. After the funeral someone
 * grabs the chair: the underboss if there is one, else the senior capo, else
 * the consigliere. Until then the family is frozen and its turf is soft.
 * Soldiers don't inherit — a family down to soldiers is finished (defection.ts).
 */
function tryInterimBoss(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const living = state.crew.filter(
    (c) => c.family === family && (c.status === "active" || c.status === "wounded"),
  );
  if (living.length === 0) return { state };
  // Funerals take a week; the scramble starts after.
  if (!rng.chance(0.5)) return { state };

  const rank = (c: CrewMember) =>
    c.role === "underboss" ? 3 : c.role === "capo" ? 2 : c.role === "consigliere" ? 1 : 0;
  const heir = [...living]
    .filter((c) => canInheritChair(c))
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        rank(b) - rank(a) ||
        b.level - a.level ||
        b.loyalty - a.loyalty,
    )[0];
  if (!heir) return { state };

  const crew = state.crew.map((c) =>
    c.id === heir.id
      ? {
          ...c,
          role: "boss" as const,
          roleSinceTurn: state.turn,
          level: Math.max(c.level, 5),
          capoId: undefined,
          crewSinceTurn: undefined,
        }
      : c,
  );
  const territories = state.territories.map((t) =>
    t.owner === family ? { ...t, leadershipVacuum: 0 } : t,
  );
  return {
    state: { ...state, crew, territories },
    log: {
      id: `ai_interim_boss_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${heir.name} takes the ${family} chair after the funeral.`,
      family,
    },
  };
}

export function runAllAiTurns(state: GameState, rng: Rng): AiTurnResult {
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
  let current = state;
  const logs: TurnLogEntry[] = [];

  for (const family of rivals) {
    if (isDefunct(current, family)) continue;
    const boss = getBoss(current.crew, family);
    if (!boss && isFamilyFinished(current, family)) {
      const gone = scatterFamily(current, family, rng);
      current = gone.state;
      logs.push(...gone.logs);
      continue;
    }
    if (boss && bossIsJailed(current, family)) {
      if (!actingUnderboss(current, family)) continue;
      const result = runAiTurn(current, family, rng);
      current = result.state;
      logs.push(...result.logs);
      continue;
    }
    if (boss) {
      const result = runAiTurn(current, family, rng);
      current = result.state;
      logs.push(...result.logs);
    } else {
      const interim = tryInterimBoss(current, family, rng);
      current = interim.state;
      if (interim.log) logs.push(interim.log);
    }
  }

  return { state: current, logs };
}
