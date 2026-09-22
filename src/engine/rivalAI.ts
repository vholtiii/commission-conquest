import type {
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
import { getRelation, setRelationDelta } from "./relations";
import { hasPact } from "./diplomacy";
import { planHit } from "./hitOps";
import { resolveCrewTerritoryId } from "./crewLocation";
import {
  isUnguarded,
  maxRacketsFor,
  valueScore,
  allowedRacketTypes,
} from "./territoryValue";
import { withdrawCrates } from "./liquor";
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

function tryExpand(
  state: GameState,
  family: FamilyName,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const targets = adjacentNeutralOrEnemy(state, family).filter(
    (t) => !t.owner || !hasPact(state, family, t.owner),
  );
  if (targets.length === 0) return { state };

  const scored = targets
    .map((t) => {
      const softness =
        (t.owner ? 2 : 0) + t.defenseBonus + t.garrisonIds.length;
      const score = valueScore(t) / (1 + softness);
      return { t, softness, score };
    })
    .sort((a, b) => b.score - a.score);
  const target = scored[0]!.t;
  const softness =
    (target.owner ? 2 : 0) + target.defenseBonus + target.garrisonIds.length;

  const roll = rng.next();
  const success =
    !target.owner ||
    roll > 0.35 + target.defenseBonus + target.garrisonIds.length * 0.05 - 0.05 * Math.min(2, maxRacketsFor(target) - 3);

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
  const territories = state.territories.map((t) =>
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

  return {
    state: { ...state, territories, relations },
    log: {
      id: `ai_expand_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} seized ${target.name}${prevOwner ? ` from ${prevOwner}` : ""}${softness < 1 ? " (lightly held)" : ""}.`,
      family,
    },
  };
}

function tryHit(
  state: GameState,
  family: FamilyName,
  rng: Rng,
  vendetta: boolean,
): { state: GameState; log?: TurnLogEntry } {
  const def = getFamilyDef(family);
  const crew = getActiveCrew(state.crew, family);
  if (crew.filter((c) => c.role !== "boss").length < 1 && crew.length < 1) return { state };

  let targetFamily: FamilyName | undefined;
  if (vendetta && state.vendettas.includes(family)) {
    const vendettaTargets = state.vendettas.filter(
      (v) => v !== family && !hasPact(state, family, v),
    );
    if (vendettaTargets.length > 0) {
      targetFamily = rng.pick(vendettaTargets);
    }
  }
  if (!targetFamily) {
    const open = ALL_FAMILY_NAMES.filter(
      (f) => f !== family && !hasPact(state, family, f),
    );
    if (open.length === 0) return { state };
    const hostile = open.filter(
      (f) => getRelation(state.relations, family, f) < -20,
    );
    targetFamily = rng.pick(hostile.length > 0 ? hostile : open);
  }

  const targetTerritory =
    state.territories.find((t) => t.owner === targetFamily) ??
    adjacentNeutralOrEnemy(state, family)[0];
  if (!targetTerritory) return { state };

  const targetBoss = getBoss(state.crew, targetFamily!);
  const bossTerritoryId = targetBoss
    ? resolveCrewTerritoryId(
        { ...state, playerFamily: state.playerFamily },
        targetBoss.id,
      )
    : null;
  const hitTerritory =
    (bossTerritoryId && state.territories.find((t) => t.id === bossTerritoryId)) ||
    targetTerritory;

  const approach: HitApproach =
    def.personality === "covert" && rng.chance(0.5)
      ? "sitdown_betrayal"
      : def.personality === "volatile" && rng.chance(0.4)
        ? "drive_by"
        : rng.chance(0.3)
          ? "ambush"
          : "car_bomb";

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

  const op = planHit(
    state,
    {
      family,
      targetTerritoryId: hitTerritory.id,
      targetFamily: targetFamily!,
      targetCrewId: targetBoss?.id,
      approach,
      shooterIds,
      wheelmanId,
      lookoutId,
      bombMakerId,
      planterId,
      negotiatorId,
      originTerritoryId:
        ownedTerritories(state, family)[0]?.id ?? hitTerritory.id,
      surveilled: def.personality === "covert" && rng.chance(0.6),
      pendingTurns: 1,
    },
    rng,
  );

  return {
    state: { ...state, operations: [...state.operations, op] },
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

  let relations = setRelationDelta(state.relations, family, route.family, -15);

  return {
    state: { ...state, routes, relations },
    log: {
      id: `ai_hijack_${family}_${state.turn}`,
      turn: state.turn,
      category: "ai",
      text: `${family} hijacks a ${route.family} liquor shipment.`,
      family,
    },
  };
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

  let crew = assignCrew(state.crew, soldier.id, {
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

function tryRecruit(state: GameState, family: FamilyName, rng: Rng): GameState {
  const count = getActiveCrew(state.crew, family).length;
  if (count >= 12 || !rng.chance(0.2)) return state;
  const recruit = createCrewMember(rng, family, "associate");
  return { ...state, crew: [...state.crew, recruit] };
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

  for (const act of picked) {
    if (!rng.chance(Math.min(0.95, 0.5 + aggression * 0.15))) continue;
    const result = act();
    current = result.state;
    if (result.log) logs.push(result.log);
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

  return { state: current, logs };
}

export function runAllAiTurns(state: GameState, rng: Rng): AiTurnResult {
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
  let current = state;
  const logs: TurnLogEntry[] = [];

  for (const family of rivals) {
    if (getBoss(current.crew, family)) {
      const result = runAiTurn(current, family, rng);
      current = result.state;
      logs.push(...result.logs);
    }
  }

  return { state: current, logs };
}
