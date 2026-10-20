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
import type { CrewMember, FamilyName, GameState, HitApproach, RacketType } from "@/types/game";

export type SimStrategy = "balanced" | "racketeer" | "warmonger" | "expansionist" | "turtle";

interface Style {
  build: boolean;
  /** Stop hiring once the family has this many active men. */
  recruitCap: number;
  /** Case a neighbouring block every this many weeks. 0 never cases. */
  lookoutEvery: number;
  /** `soft` only takes a block with no garrison or no rackets. */
  capture: "weekly" | "soft" | "never";
  captureMen: number;
  /** Order a hit every this many weeks. 0 never hits. */
  hitEvery: number;
  /** Cycle ambush, drive-by and car bomb. Otherwise always an ambush. */
  rotateApproach: boolean;
}

const STYLES: Record<SimStrategy, Style> = {
  balanced: { build: true, recruitCap: 8, lookoutEvery: 4, capture: "weekly", captureMen: 3, hitEvery: 6, rotateApproach: false },
  racketeer: { build: true, recruitCap: 8, lookoutEvery: 0, capture: "soft", captureMen: 3, hitEvery: 0, rotateApproach: false },
  warmonger: { build: true, recruitCap: 8, lookoutEvery: 2, capture: "weekly", captureMen: 3, hitEvery: 3, rotateApproach: true },
  expansionist: { build: true, recruitCap: 12, lookoutEvery: 0, capture: "weekly", captureMen: 4, hitEvery: 0, rotateApproach: false },
  turtle: { build: false, recruitCap: 8, lookoutEvery: 0, capture: "never", captureMen: 0, hitEvery: 0, rotateApproach: false },
};

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

function maybeRecruit(state: GameState, cap: number): GameState {
  const family = state.playerFamily;
  if (!family) return state;
  const active = state.crew.filter((c) => c.family === family && c.status === "active").length;
  if (active >= cap) return state;
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

function maybeLookout(state: GameState, rng: Rng, every: number): GameState {
  const family = state.playerFamily;
  if (!family || every <= 0 || state.turn % every !== 0) return state;
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

function maybeCapture(state: GameState, rng: Rng, mode: "weekly" | "soft", men: number): GameState {
  const family = state.playerFamily;
  if (!family || dinnerActive(state) || men <= 0) return state;
  const mine = new Set(state.territories.filter((t) => t.owner === family).map((t) => t.id));
  const neighbours = state.territories
    .filter((t) => t.owner && t.owner !== family && t.adjacentTerritories.some((id) => mine.has(id)))
    .filter((t) => mode === "weekly" || t.garrisonIds.length === 0 || t.rackets.length === 0)
    .filter((t) => captureAllowance(state, family, t).ok)
    .sort((a, b) => a.rackets.length - b.rackets.length);
  const target = neighbours[0];
  if (!target) return state;
  const crew = eligibleCaptureCrew(state, target.id).slice(0, men).map((c) => c.id);
  if (crew.length === 0) return state;
  return resolveCapture(state, target.id, crew, rng).state;
}

const APPROACHES: HitApproach[] = ["ambush", "drive_by", "car_bomb"];

function idleHands(state: GameState, family: FamilyName): CrewMember[] {
  return state.crew.filter(
    (c) => c.family === family && c.status === "active" && c.assignment.type === "idle" && c.role !== "boss",
  );
}

function maybeHit(state: GameState, rng: Rng, every: number, rotate: boolean): GameState {
  const family = state.playerFamily;
  if (!family || handsDown(state) || dinnerActive(state) || every <= 0 || state.turn % every !== 0) return state;
  const report = Object.values(state.intel?.reports ?? {}).find((r) => r && r.territoryId);
  if (!report) return state;
  const block = state.territories.find((t) => t.id === report.territoryId);
  if (!block?.owner || block.owner === family) return state;
  if (inTruce(state, family, block.owner)) return state;
  const knownId = Object.entries(state.intel?.known ?? {}).find(
    ([, entry]) => entry?.territoryId === block.id,
  )?.[0];
  const hands = idleHands(state, family);
  const shooter = hands[0];
  const second = hands[1];
  if (!shooter || !knownId) return state;
  let approach: HitApproach = rotate ? APPROACHES[Math.floor(state.turn / every) % APPROACHES.length]! : "ambush";
  if (approach !== "ambush" && !second) approach = "ambush";
  const origin = state.territories.find((t) => t.owner === family)?.id;
  const op = planHit(
    state,
    {
      family,
      targetTerritoryId: block.id,
      targetFamily: block.owner,
      targetCrewId: knownId,
      approach,
      shooterIds: approach === "car_bomb" ? [] : [shooter.id],
      wheelmanId: approach === "drive_by" ? second!.id : undefined,
      bombMakerId: approach === "car_bomb" ? shooter.id : undefined,
      planterId: approach === "car_bomb" ? second!.id : undefined,
      originTerritoryId: origin,
      blind: false,
    },
    rng,
  );
  const seated = approach === "ambush" ? [shooter.id] : [shooter.id, second!.id];
  return {
    ...state,
    operations: [...state.operations, op],
    crew: seated.reduce(
      (crew, id) => assignCrew(crew, id, { type: "operation", operationId: op.id }),
      state.crew,
    ),
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
export function autoPlayer(state: GameState, rng: Rng, strategy: SimStrategy = "balanced"): GameState {
  if (!state.playerFamily || state.victory.won || state.victory.lost) return state;
  const style = STYLES[strategy];
  let next = maybeNameHeir(state);
  next = assignManagers(next);
  if (style.build) next = maybeBuild(next, rng);
  next = maybeRecruit(next, style.recruitCap);
  if (style.lookoutEvery > 0) next = maybeLookout(next, rng, style.lookoutEvery);
  if (style.capture !== "never") next = maybeCapture(next, rng, style.capture, style.captureMen);
  if (style.hitEvery > 0) next = maybeHit(next, rng, style.hitEvery, style.rotateApproach);
  return next;
}
