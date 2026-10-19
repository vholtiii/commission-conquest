import { assignCrew, canPromote, isUnmade, promoteCrew } from "../crew";
import { captureAllowance, eligibleCaptureCrew, resolveCapture } from "../capture";
import { inTruce } from "../deals";
import { dinnerActive } from "../dinner";
import {
  canManageRacket,
  createRacket,
  RACKET_BUILD_COST,
  racketPayment,
} from "../economy";
import { planHit } from "../hitOps";
import { handsDown } from "../mourning";
import { isFreeAgent, recruitPrice } from "../recruiting";
import { allowedRacketTypes, maxRacketsFor } from "../territoryValue";
import { placementBonus } from "../districtFeatures";
import { playerLeaderless } from "../interregnum";
import { nextRacketSiteIndex } from "../cityLayout";
import type { Rng } from "../rng";
import type { CrewMember, FamilyName, GameState, RacketType } from "@/types/game";

function assignManagers(state: GameState): GameState {
  const family = state.playerFamily;
  if (!family) return state;
  let crew = state.crew;
  let territories = state.territories;
  const used = new Set<string>();
  for (const t of territories) {
    if (t.owner !== family) continue;
    for (const racket of t.rackets) {
      if (racket.managerId) continue;
      const man = crew.find(
        (c) => !used.has(c.id) && canManageRacket(c, family, racket.type),
      );
      if (!man) continue;
      used.add(man.id);
      crew = assignCrew(crew, man.id, { type: "racket", territoryId: t.id, racketId: racket.id });
      territories = territories.map((terr) => ({
        ...terr,
        garrisonIds: terr.garrisonIds.filter((id) => id !== man.id),
        rackets: terr.rackets.map((r) => {
          if (r.id === racket.id) return { ...r, managerId: man.id };
          if (r.managerId === man.id) return { ...r, managerId: null };
          return r;
        }),
      }));
    }
  }
  return { ...state, crew, territories };
}

function maybeBuild(state: GameState, rng: Rng): GameState {
  const family = state.playerFamily;
  if (!family) return state;
  const mine = state.territories.filter((t) => t.owner === family);
  const hasStill = mine.some((t) => t.rackets.some((r) => r.type === "still" || r.type === "brewery"));
  const hasWarehouse = mine.some((t) => t.rackets.some((r) => r.type === "warehouse"));
  const prefer: RacketType[] = hasStill && !hasWarehouse ? ["warehouse"] : ["gambling", "speakeasy", "warehouse"];
  const open = mine.filter((t) => t.rackets.length < maxRacketsFor(t));
  if (open.length === 0) return state;
  const ranked = open
    .map((t) => {
      const type = prefer.find((candidate) => allowedRacketTypes(t).includes(candidate));
      return { t, type, mult: type ? placementBonus(t, { type }, t.rackets).mult : 0 };
    })
    .filter((row) => row.type)
    .sort((a, b) => b.mult - a.mult);
  const best = ranked.filter((row) => row.mult === ranked[0]?.mult);
  const choice = best[rng.int(0, Math.max(0, best.length - 1))];
  const home = choice?.t;
  const type = choice?.type;
  if (!home || !type) return state;
  const cost = RACKET_BUILD_COST[type] ?? 2000;
  const pay = racketPayment(type, cost, state.money, state.dirtyMoney);
  if (!pay) return state;
  const racket = createRacket(
    `rkt_sim_${state.turn}_${home.id}_${type}`,
    home.id,
    type,
    1,
    state.turn,
    nextRacketSiteIndex(home.rackets),
  );
  return {
    ...state,
    money: state.money - pay.clean,
    dirtyMoney: state.dirtyMoney - pay.dirty,
    territories: state.territories.map((t) =>
      t.id === home.id ? { ...t, rackets: [...t.rackets, racket] } : t,
    ),
  };
}

function maybeRecruit(state: GameState): GameState {
  const family = state.playerFamily;
  if (!family) return state;
  const active = state.crew.filter((c) => c.family === family && c.status === "active").length;
  if (active >= 8) return state;
  let best = -1;
  let price = Infinity;
  state.recruitmentPool.forEach((member, index) => {
    const cost = recruitPrice(member, family);
    if (cost < price && state.money >= cost) {
      best = index;
      price = cost;
    }
  });
  if (best < 0) return state;
  const recruit = state.recruitmentPool[best]!;
  const scattered = isFreeAgent(recruit);
  const hired: CrewMember = {
    ...recruit,
    family,
    id: scattered ? recruit.id : `crew_sim_${state.seed}_${state.crew.length}_${state.turn}`,
    freeUntilTurn: undefined,
    assignment: { type: "idle" },
  };
  return {
    ...state,
    money: state.money - price,
    crew: [...state.crew, hired],
    recruitmentPool: state.recruitmentPool.filter((_, i) => i !== best),
  };
}

function maybeLookout(state: GameState, rng: Rng): GameState {
  const family = state.playerFamily;
  if (!family || state.turn % 4 !== 0) return state;
  const mine = new Set(state.territories.filter((t) => t.owner === family).map((t) => t.id));
  const targets = state.territories.filter(
    (t) => t.owner && t.owner !== family && t.adjacentTerritories.some((id) => mine.has(id)),
  );
  if (targets.length === 0) return state;
  const lookout = state.crew.find(
    (c) => c.family === family && c.status === "active" && c.assignment.type === "idle" && c.role !== "boss",
  );
  if (!lookout) return state;
  const territory = targets[rng.int(0, targets.length - 1)]!;
  const opId = `op_sim_surv_${state.turn}_${territory.id}`;
  return {
    ...state,
    operations: [
      ...state.operations,
      {
        id: opId,
        family,
        kind: "surveillance",
        targetTerritoryId: territory.id,
        targetFamily: territory.owner!,
        shooterIds: [],
        lookoutId: lookout.id,
        surveilled: false,
        tippedOff: false,
        pendingTurns: 1,
        resolved: false,
      },
    ],
    crew: assignCrew(state.crew, lookout.id, {
      type: "surveillance",
      operationId: opId,
      territoryId: territory.id,
    }),
  };
}

function maybeCapture(state: GameState, rng: Rng): GameState {
  const family = state.playerFamily;
  if (!family || dinnerActive(state)) return state;
  const mine = new Set(state.territories.filter((t) => t.owner === family).map((t) => t.id));
  const neighbours = state.territories
    .filter((t) => t.owner && t.owner !== family && t.adjacentTerritories.some((id) => mine.has(id)))
    .filter((t) => captureAllowance(state, family, t).ok)
    .sort((a, b) => a.rackets.length - b.rackets.length);
  const target = neighbours[0];
  if (!target) return state;
  const crew = eligibleCaptureCrew(state, target.id).slice(0, 3).map((c) => c.id);
  if (crew.length === 0) return state;
  return resolveCapture(state, target.id, crew, rng).state;
}

function maybeHit(state: GameState, rng: Rng): GameState {
  const family = state.playerFamily;
  if (!family || handsDown(state) || dinnerActive(state) || state.turn % 6 !== 0) return state;
  const report = Object.values(state.intel?.reports ?? {}).find((r) => r && r.territoryId);
  if (!report) return state;
  const block = state.territories.find((t) => t.id === report.territoryId);
  if (!block?.owner || block.owner === family) return state;
  if (inTruce(state, family, block.owner)) return state;
  const knownId = Object.entries(state.intel?.known ?? {}).find(
    ([, entry]) => entry?.territoryId === block.id,
  )?.[0];
  const shooter = state.crew.find(
    (c) => c.family === family && c.status === "active" && c.assignment.type === "idle" && c.role !== "boss",
  );
  if (!shooter || !knownId) return state;
  const origin = state.territories.find((t) => t.owner === family)?.id;
  const op = planHit(
    state,
    {
      family,
      targetTerritoryId: block.id,
      targetFamily: block.owner,
      targetCrewId: knownId,
      approach: "ambush",
      shooterIds: [shooter.id],
      originTerritoryId: origin,
      blind: !knownId,
    },
    rng,
  );
  return {
    ...state,
    operations: [...state.operations, op],
    crew: assignCrew(state.crew, shooter.id, { type: "operation", operationId: op.id }),
  };
}

/** While the chair is empty, put the best capo (or a made soldier) in as underboss. */
function maybeNameHeir(state: GameState): GameState {
  const family = state.playerFamily;
  if (!family || !playerLeaderless(state)) return state;
  const hasUb = state.crew.some(
    (c) => c.family === family && c.role === "underboss" && c.status === "active" && c.loyalty >= 30,
  );
  if (hasUb) return state;
  const capos = state.crew
    .filter(
      (c) =>
        c.family === family &&
        c.role === "capo" &&
        (c.status === "active" || c.status === "wounded"),
    )
    .sort((a, b) => b.level - a.level || b.loyalty - a.loyalty);
  const soldiers = state.crew
    .filter((c) => c.family === family && c.role === "soldier" && c.status === "active" && !isUnmade(c) && c.level >= 4)
    .sort((a, b) => b.level - a.level || b.loyalty - a.loyalty);
  const pick = capos[0] ?? soldiers[0];
  if (!pick) return state;
  const check = canPromote(pick, "underboss", state.crew, state.money, {
    leaderless: true,
    dirty: state.dirtyMoney,
  });
  if (!check.ok) return state;
  const fromDirty = Math.min(Math.max(0, state.dirtyMoney), check.cost);
  return {
    ...state,
    money: state.money - (check.cost - fromDirty),
    dirtyMoney: state.dirtyMoney - fromDirty,
    crew: promoteCrew(state.crew, pick.id, "underboss", state.turn),
  };
}

/** One week of the stand-in boss. Pure: no toasts, no store. */
export function autoPlayer(state: GameState, rng: Rng): GameState {
  if (!state.playerFamily || state.victory.won || state.victory.lost) return state;
  let next = maybeNameHeir(state);
  next = assignManagers(next);
  next = maybeBuild(next, rng);
  next = maybeRecruit(next);
  next = maybeLookout(next, rng);
  next = maybeCapture(next, rng);
  next = maybeHit(next, rng);
  return next;
}
