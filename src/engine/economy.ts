import type {
  CrewMember,
  DeliveryRoute,
  FamilyName,
  GameState,
  LiquorLedger,
  Racket,
  RacketType,
  Territory,
  TurnLogEntry,
} from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { CRATE_STREET_VALUE } from "./passage";
import { assessPath } from "./supplyRoutes";
import type { Rng } from "./rng";
import { createRng, hashString } from "./rng";
import { aggregateTraitEffects, isUnmade, roleUpkeep } from "./crew";
import { crewIncomeMult } from "./crews";
import { BOSS_PRESENCE, bossPresenceDistrict } from "./bossPresence";
import { DINNER_INCOME_MULT, dinnerActive } from "./dinner";
import {
  applyWarehouseShrinkage,
  depositCrates,
  dumpWarning,
  emptyLiquorLedger,
  hasManagedWarehouse,
  idleStorageCost,
  makeManagerLookup,
  mergeLedger,
  produceAndStore,
  productionOutput,
  sellSpeakeasies,
  stashHeat,
  stockCap,
  supplySpeakeasies,
  totalCrates,
  withdrawCrates,
} from "./liquor";
import { isUnguarded } from "./territoryValue";

export const MAX_RACKETS_PER_DISTRICT = 3;

export const LEGIT_TYPES = [
  "laundromat",
  "deli",
  "barber",
  "restaurant",
  "trucking",
] as const;

export type LegitType = (typeof LEGIT_TYPES)[number];

export function isLegitBusiness(type: RacketType): type is LegitType {
  return (LEGIT_TYPES as readonly string[]).includes(type);
}

/** Migrate legacy "front" saves to laundromat. */
export function normalizeRacketType(raw: string): RacketType {
  if (raw === "front") return "laundromat";
  return raw as RacketType;
}

export const RACKET_BUILD_COST: Record<RacketType, number> = {
  still: 800,
  brewery: 1500,
  warehouse: 1200,
  speakeasy: 2000,
  gambling: 2500,
  brothel: 2200,
  loan_shark: 1800,
  laundromat: 1500,
  deli: 1200,
  barber: 900,
  restaurant: 2500,
  trucking: 3200,
  safehouse: 1000,
};

export const RACKET_BASE_INCOME: Record<RacketType, number> = {
  still: 120,
  brewery: 200,
  warehouse: 60,
  speakeasy: 280,
  gambling: 350,
  brothel: 300,
  loan_shark: 250,
  laundromat: 60,
  deli: 70,
  barber: 40,
  restaurant: 120,
  trucking: 150,
  safehouse: 0,
};

/**
 * Per-turn heat from the whole racket book = Σ heatGen × this scale.
 * Base decay is 2/turn (up to ~8 with every bribe running), so 0.25 lets a
 * starting book (~22 raw) sit near the Raids line and forces a growing empire
 * to buy protection. At 1.0 a passive player pegged 100 heat by turn 6.
 */
export const RACKET_HEAT_SCALE = 0.25;

export const RACKET_HEAT: Record<RacketType, number> = {
  still: 3,
  brewery: 4,
  warehouse: 2,
  speakeasy: 5,
  gambling: 4,
  brothel: 6,
  loan_shark: 3,
  laundromat: 1,
  deli: 1,
  barber: 1,
  restaurant: 1,
  trucking: 2,
  safehouse: 0,
};

/** Legacy flat caps — prefer stockCap() from liquor.ts (level-scaled). */
export const RACKET_STOCK_CAP: Record<RacketType, number> = {
  still: 30,
  brewery: 50,
  warehouse: 100,
  speakeasy: 40,
  gambling: 0,
  brothel: 0,
  loan_shark: 0,
  laundromat: 0,
  deli: 0,
  barber: 0,
  restaurant: 0,
  trucking: 0,
  safehouse: 0,
};

export const LAUNDER_RULES: Record<LegitType, { capPerLevel: number; cut: number }> = {
  laundromat: { capPerLevel: 500, cut: 0.1 },
  deli: { capPerLevel: 300, cut: 0.1 },
  barber: { capPerLevel: 200, cut: 0.08 },
  restaurant: { capPerLevel: 600, cut: 0.15 },
  trucking: { capPerLevel: 900, cut: 0.18 },
};

export function earlyGameCapMult(turn: number): number {
  return turn <= 5 ? 1.5 : 1;
}

export function launderManagerMods(manager?: CrewMember | null): {
  capMult: number;
  auditMult: number;
} {
  if (!manager || manager.status !== "active") {
    return { capMult: 1, auditMult: 1 };
  }
  const bookkeeper = manager.traits.includes("bookkeeper");
  const smarts = manager.skills.smarts;
  const capMult = Math.min(1.6, 1 + (bookkeeper ? 0.25 : 0) + smarts / 200);
  const auditMult = Math.max(
    0.6,
    bookkeeper ? 0.75 : 1 - smarts / 400,
  );
  return { capMult, auditMult };
}

export function launderCap(
  racket: Racket,
  manager?: CrewMember | null,
  turn = 0,
  /** The boss holds court on this block: the books stretch further. */
  bossHere = false,
): number {
  if (!isLegitBusiness(racket.type)) return 0;
  const rules = LAUNDER_RULES[racket.type];
  const { capMult } = launderManagerMods(manager);
  return Math.floor(
    rules.capPerLevel *
      racket.level *
      capMult *
      earlyGameCapMult(turn) *
      (bossHere ? BOSS_PRESENCE.launderCapMult : 1),
  );
}

export function launderCut(type: RacketType): number {
  if (!isLegitBusiness(type)) return 0;
  return LAUNDER_RULES[type].cut;
}

/** House counsel picks up only once clean cash is this far below zero. */
export const LAWYER_DEFICIT = 3000;
/** He keeps half and writes a check for the rest. */
export const LAWYER_HEAT = 8;
/** Weeks before he will take another retainer. */
export const LAWYER_COOLDOWN_TURNS = 4;

export interface LawyerQuote {
  /** Clean cash is below −$3,000. */
  inTheRed: boolean;
  /** A full under-cap wash this week still leaves clean below zero. */
  washFallsShort: boolean;
  cooling: boolean;
  readyTurn: number;
  deficit: number;
  washReturn: number;
  cleanReturn: number;
  dirtySpent: number;
  available: boolean;
}

/** Clean a full under-cap wash of every ready front would return this week. */
export function weeklyWashCeiling(state: GameState): number {
  if (!state.playerFamily) return 0;
  const bossBlock = bossPresenceDistrict(state, state.playerFamily);
  let clean = 0;
  for (const t of state.territories) {
    if (t.owner !== state.playerFamily) continue;
    const bossHere = t.id === bossBlock;
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type) || isRacketFrozen(r, state.turn)) continue;
      if (!isLaunderSiteActive(r, state.turn)) continue;
      const manager = r.managerId
        ? state.crew.find((c) => c.id === r.managerId && c.status === "active") ?? null
        : null;
      const cap = launderCap(r, manager, state.turn, bossHere);
      clean += Math.floor(cap * (1 - launderCut(r.type)));
    }
  }
  return clean;
}

export function lawyerOffer(state: GameState): LawyerQuote {
  const deficit = Math.max(0, -Math.floor(state.money));
  const washReturn = weeklyWashCeiling(state);
  const inTheRed = state.money < -LAWYER_DEFICIT;
  const washFallsShort = washReturn < deficit;
  const readyTurn = state.lawyerReadyTurn ?? 0;
  const cooling = state.turn < readyTurn;
  const cleanReturn = Math.min(deficit, Math.floor(Math.max(0, state.dirtyMoney) / 2));
  const dirtySpent = cleanReturn * 2;
  return {
    inTheRed,
    washFallsShort,
    cooling,
    readyTurn,
    deficit,
    washReturn,
    cleanReturn,
    dirtySpent,
    available: inTheRed && washFallsShort && !cooling && cleanReturn > 0,
  };
}

/** Why the button is quiet while clean is already deep enough in the red. */
export function lawyerBlockReason(offer: LawyerQuote): string | null {
  if (!offer.inTheRed || offer.available) return null;
  if (offer.cooling) return `He won't take another call until week ${offer.readyTurn}.`;
  if (!offer.washFallsShort) return "The fronts can cover this hole. Wash it.";
  return "Nothing dirty to hand him.";
}

/** Dirty cash, up front, for four weeks on the street lawyer's books. */
export const STREET_LAWYER_COST = 2400;
/** Weeks he stays hired. `streetLawyerUntil = turn + this`. */
export const STREET_LAWYER_WEEKS = 4;
/** Heat the week he walks a man out. */
export const STREET_LAWYER_BAIL_HEAT = 3;
/** Extra heat decay each week the retainer is live. */
export const STREET_LAWYER_HEAT_DECAY = 1;

export interface StreetLawyerQuote {
  /** Retainer is live this turn. */
  onTheBooks: boolean;
  /** First turn he drops off. 0 when he has never been hired. */
  until: number;
  /** One bail is still open on this retainer. */
  bailOpen: boolean;
  /** Dirty cash covers a new hire and he is not already retained. */
  canHire: boolean;
  /** He is off the books and dirty cash is short of the retainer. */
  shortCash: boolean;
}

export function streetLawyerQuote(
  state: Pick<GameState, "turn" | "dirtyMoney" | "streetLawyerUntil" | "streetLawyerBailUsed">,
): StreetLawyerQuote {
  const until = state.streetLawyerUntil ?? 0;
  const onTheBooks = state.turn < until;
  const shortCash = state.dirtyMoney < STREET_LAWYER_COST;
  return {
    onTheBooks,
    until,
    bailOpen: onTheBooks && !state.streetLawyerBailUsed,
    canHire: !onTheBooks && !shortCash,
    shortCash: !onTheBooks && shortCash,
  };
}

export function isRacketFrozen(racket: Racket, turn: number): boolean {
  return (racket.frozenUntil ?? 0) > turn;
}

/**
 * Wanted shed per week while managing an unfrozen legit front.
 * Slower than a safehouse: Lv1–2 → 1, Lv3–4 → 2, Lv5 → 3.
 */
export function legitCoverWantedDrop(level: number): number {
  return 1 + Math.floor(Math.max(1, level) / 2);
}

/**
 * End-of-week pass: managers of live legit businesses shed a little wanted.
 * Does not stack with lying low — skip anyone already in a safehouse.
 */
export function tickLegitCover(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  const turn = state.turn;
  const dropById = new Map<string, number>();

  for (const t of state.territories) {
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type) || isRacketFrozen(r, turn) || !r.managerId) continue;
      const drop = legitCoverWantedDrop(r.level);
      const prev = dropById.get(r.managerId) ?? 0;
      if (drop > prev) dropById.set(r.managerId, drop);
    }
  }
  if (dropById.size === 0) return { state, logs };

  const cooled: string[] = [];
  const clean: string[] = [];
  const crew = state.crew.map((m) => {
    const drop = dropById.get(m.id);
    if (!drop || drop <= 0) return m;
    if (m.assignment.type === "safehouse") return m;
    if (m.status !== "active" && m.status !== "wounded") return m;
    if (m.wanted <= 0) return m;
    const wanted = Math.max(0, m.wanted - drop);
    if (m.family === player) {
      if (wanted < m.wanted) cooled.push(m.name);
      if (wanted === 0 && m.wanted > 0) clean.push(m.name);
    }
    return { ...m, wanted };
  });

  if (player && cooled.length > 0) {
    logs.push({
      id: `log_legit_cover_${turn}`,
      turn,
      category: "system",
      text: `${cooled.join(", ")} kept a low profile behind the counter — wanted dropped.`,
      family: player,
    });
  }
  if (player && clean.length > 0) {
    logs.push({
      id: `log_legit_cover_clean_${turn}`,
      turn,
      category: "system",
      text: `${clean.join(", ")} ${clean.length === 1 ? "is" : "are"} off the blotter — the front did its job.`,
      family: player,
    });
  }

  return { state: { ...state, crew }, logs };
}

function liveSafehouses(t: Pick<Territory, "rackets">, turn: number): Racket[] {
  return t.rackets.filter((r) => r.type === "safehouse" && !isRacketFrozen(r, turn));
}

/** Unfrozen safehouse in the district. */
export function hasSafehouse(t: Pick<Territory, "rackets">, turn: number): boolean {
  return liveSafehouses(t, turn).length > 0;
}

/** Highest unfrozen safehouse level, or 0. */
export function safehouseLevel(t: Pick<Territory, "rackets">, turn: number): number {
  return liveSafehouses(t, turn).reduce((n, r) => Math.max(n, r.level), 0);
}

export type LaunderSiteStatus = "off" | "setting_up" | "ready";

/** Status of a legit business as a laundering site for the given turn. */
export function launderSiteStatus(racket: Racket, turn: number): LaunderSiteStatus {
  if (!isLegitBusiness(racket.type)) return "off";
  if (racket.launderReadyTurn == null) return "off";
  if (turn < racket.launderReadyTurn) return "setting_up";
  return "ready";
}

/** True when the site can wash cash on the given turn (ready, not merely set up). */
export function isLaunderSiteActive(racket: Racket, turn: number): boolean {
  return launderSiteStatus(racket, turn) === "ready";
}

/** True when the player has marked the site for laundering (setting up or ready). */
export function isLaunderSiteSetUp(racket: Racket): boolean {
  return isLegitBusiness(racket.type) && racket.launderReadyTurn != null;
}

export interface AuditChanceCtx {
  heatLevel: number;
  mayorActive: boolean;
  chiefsActive: boolean;
  manager?: CrewMember | null;
  scrutinyPrev?: number;
  bossHere?: boolean;
}

export function auditChance(
  racket: Racket,
  amount: number,
  ctx: AuditChanceCtx,
  turn = 0,
): number {
  const cap = launderCap(racket, ctx.manager, turn, ctx.bossHere ?? false);
  if (cap <= 0 || amount <= cap) return 0;
  const over = amount / cap - 1;
  const scrutinyPrev = ctx.scrutinyPrev ?? racket.scrutiny ?? 0;
  const heatMult = 1 + Math.max(0, ctx.heatLevel - 40) / 100;
  const bribeMult = ctx.mayorActive ? 0.5 : ctx.chiefsActive ? 0.7 : 1;
  const { auditMult } = launderManagerMods(ctx.manager);
  const p =
    (0.35 * over + 0.15 * scrutinyPrev) * heatMult * bribeMult * auditMult;
  return Math.max(0, Math.min(0.65, p));
}

export function auditModifiersLabel(ctx: AuditChanceCtx, turn: number): string {
  const parts: string[] = [];
  if (turn <= 5) parts.push("Early-game grace: caps ×1.5 until turn 5");
  const heatMult = 1 + Math.max(0, ctx.heatLevel - 40) / 100;
  if (heatMult > 1) parts.push(`Heat ×${heatMult.toFixed(1)} audit odds`);
  if (ctx.mayorActive) parts.push("Mayor bribe ×0.5");
  else if (ctx.chiefsActive) parts.push("Chiefs bribe ×0.7");
  return parts.join(" · ");
}

export function racketUpgradeCost(type: RacketType, level: number): number {
  return Math.floor(RACKET_BUILD_COST[type] * (1 + level * 0.6));
}

export function createRacket(
  id: string,
  territoryId: string,
  type: RacketType,
  level = 1,
  turn = 0,
  siteIndex?: number,
): Racket {
  return {
    id,
    territoryId,
    type,
    level,
    managerId: null,
    stock:
      type === "still" ||
      type === "brewery" ||
      type === "warehouse" ||
      type === "speakeasy"
        ? 10
        : 0,
    heatGen: RACKET_HEAT[type] * level,
    upgradeCost: racketUpgradeCost(type, level),
    builtTurn: turn,
    ...(typeof siteIndex === "number" ? { siteIndex } : {}),
  };
}

export function upgradeRacket(racket: Racket, turn = 0): Racket {
  if (racket.level >= 5) return racket;
  const level = racket.level + 1;
  return {
    ...racket,
    level,
    heatGen: RACKET_HEAT[racket.type] * level,
    upgradeCost: racketUpgradeCost(racket.type, level),
    upgradedTurn: turn,
  };
}

/** Whether a racket was built or upgraded on the current turn. */
export function racketFreshness(
  racket: Racket,
  turn: number,
): "new" | "upgraded" | null {
  if (racket.upgradedTurn === turn) return "upgraded";
  if (racket.builtTurn === turn) return "new";
  return null;
}

/** A safehouse is a door and some beds; nobody has to run it. */
export function needsManager(type: RacketType): boolean {
  return type !== "safehouse";
}

/**
 * Idle or garrisoned family men can run a racket. The boss cannot.
 * An associate can run a clean front only: pass that racket's type.
 * Omit the type and he does not qualify.
 */
export function canManageRacket(
  member: CrewMember,
  playerFamily: FamilyName | null,
  type?: RacketType,
): boolean {
  if (!playerFamily || member.family !== playerFamily) return false;
  if (member.status !== "active") return false;
  if (member.role === "boss") return false;
  if (member.role === "associate" && !(type && isLegitBusiness(type))) return false;
  return member.assignment.type === "idle" || member.assignment.type === "garrison";
}

/**
 * Unmanaged rackets run at 70%; managers restore full + trait/skill bonus.
 * A capo managing with his crew behind him earns more per man (pass `crew`).
 * With the boss on the block nothing runs short-handed and everything runs
 * harder (`BOSS_PRESENCE.incomeMult`).
 */
export function racketIncome(
  racket: Racket,
  incomeBonus = 0,
  manager?: CrewMember | null,
  crew?: CrewMember[],
  bossHere = false,
): number {
  const base = RACKET_BASE_INCOME[racket.type] * racket.level;
  let managerMult = bossHere ? BOSS_PRESENCE.unmanagedFloor : 0.7;
  if (manager && manager.status === "active") {
    const traits = aggregateTraitEffects(manager.traits);
    managerMult =
      (1 + traits.incomeMod + (manager.skills.smarts + manager.skills.charm) / 1000) *
      crewIncomeMult(manager, crew);
    if (isUnmade(manager)) managerMult *= 0.85;
  }
  if (bossHere) managerMult *= BOSS_PRESENCE.incomeMult;
  return Math.floor(base * (1 + incomeBonus) * managerMult);
}

/** The crew's share of a managed racket's income, for the breakdown line. */
export function racketCrewBonusPct(manager: CrewMember | null | undefined, crew: CrewMember[]): number {
  return Math.round((crewIncomeMult(manager, crew) - 1) * 100);
}

export function incomeFlavor(type: RacketType): "clean" | "dirty" | "mixed" {
  if (isLegitBusiness(type)) return "clean";
  if (["gambling", "brothel", "loan_shark"].includes(type)) return "dirty";
  return "mixed";
}

export type RacketFunding = "clean" | "dirty" | "either";

export function racketFunding(type: RacketType): RacketFunding {
  const flavor = incomeFlavor(type);
  if (flavor === "clean") return "clean";
  if (flavor === "dirty") return "dirty";
  return "either";
}

export function fundingLabel(funding: RacketFunding): string {
  if (funding === "clean") return "Clean cash";
  if (funding === "dirty") return "Dirty cash";
  return "Dirty or clean";
}

/** Dirty-only rackets are closed to an associate. Mixed and clean types he may build. */
export function associateCanBuild(type: RacketType): boolean {
  return racketFunding(type) !== "dirty";
}

/** A front or a safehouse. Liquor houses pay more. */
export const ASSOCIATE_FRONT_XP = 20;
/** A still, brewery, warehouse, or speakeasy. */
export const ASSOCIATE_LIQUOR_XP = 30;

const ASSOCIATE_LIQUOR_BUILD = new Set<RacketType>(["still", "brewery", "warehouse", "speakeasy"]);

/** XP for opening a shop. Dirty rackets pay nothing because he cannot build them. */
export function associateBuildXp(type: RacketType): number {
  if (!associateCanBuild(type)) return 0;
  return ASSOCIATE_LIQUOR_BUILD.has(type) ? ASSOCIATE_LIQUOR_XP : ASSOCIATE_FRONT_XP;
}

/**
 * An associate pays the whole build from clean cash. Dirty is never touched,
 * including on a still, brewery, warehouse, or speakeasy.
 */
export function associateBuildPayment(
  type: RacketType,
  cost: number,
  money: number,
): { clean: number; dirty: number } | null {
  if (!associateCanBuild(type) || money < cost) return null;
  return { clean: cost, dirty: 0 };
}

/** How much clean/dirty to debit for a racket cost, or null if unaffordable. Mixed types pay dirty first. */
export function racketPayment(
  type: RacketType,
  cost: number,
  money: number,
  dirtyMoney: number,
): { clean: number; dirty: number } | null {
  const funding = racketFunding(type);
  if (funding === "clean") {
    return money >= cost ? { clean: cost, dirty: 0 } : null;
  }
  if (funding === "dirty") {
    return dirtyMoney >= cost ? { clean: 0, dirty: cost } : null;
  }
  if (money + dirtyMoney < cost) return null;
  const dirty = Math.min(cost, Math.max(0, dirtyMoney));
  return { clean: cost - dirty, dirty };
}

export function paymentShortfall(
  type: RacketType,
  cost: number,
  money: number,
  dirtyMoney: number,
): { amount: number; pool: "clean" | "dirty" | "either" } | null {
  if (racketPayment(type, cost, money, dirtyMoney)) return null;
  const funding = racketFunding(type);
  if (funding === "clean") return { amount: cost - money, pool: "clean" };
  if (funding === "dirty") return { amount: cost - dirtyMoney, pool: "dirty" };
  return { amount: cost - money - dirtyMoney, pool: "either" };
}

export function formatPaymentParts(pay: { clean: number; dirty: number }): string {
  const parts: string[] = [];
  if (pay.dirty > 0) parts.push(`$${pay.dirty} dirty`);
  if (pay.clean > 0) parts.push(`$${pay.clean} clean`);
  return parts.length > 0 ? `paid ${parts.join(" / ")}` : "";
}

/** Still/brewery only — fills own stock up to level-scaled cap (no spill). Prefer produceAndStore. */
export function produceLiquor(racket: Racket): Racket {
  if (racket.type !== "still" && racket.type !== "brewery") return racket;
  const out = productionOutput(racket);
  const cap = stockCap(racket);
  return {
    ...racket,
    stock: Math.min(cap, racket.stock + out),
  };
}

/** Speakeasy sales only. Prefer sellSpeakeasies. */
export function sellLiquor(
  territory: Territory,
  family: FamilyName,
  incomeBonus = 0,
): { territory: Territory; revenue: number; dirtyRevenue: number } {
  const result = sellSpeakeasies(territory, family, incomeBonus);
  return {
    territory: result.territory,
    revenue: result.revenue,
    dirtyRevenue: result.dirtyRevenue,
  };
}

export function findDeliveryPath(
  territories: Territory[],
  sourceId: string,
  destId: string,
  family: FamilyName,
  allowEnemyTransit = false,
): string[] | null {
  const byId = new Map(territories.map((t) => [t.id, t]));
  const start = byId.get(sourceId);
  const end = byId.get(destId);
  if (!start || !end) return null;
  if (sourceId === destId) return [sourceId];

  const canTraverse = (t: Territory): boolean => {
    if (!t.owner || t.owner === family) return true;
    return allowEnemyTransit;
  };

  const queue: string[] = [sourceId];
  const visited = new Set<string>([sourceId]);
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = byId.get(current)!;
    for (const adjId of node.adjacentTerritories) {
      if (visited.has(adjId)) continue;
      const adj = byId.get(adjId);
      if (!adj || !canTraverse(adj)) continue;
      visited.add(adjId);
      parent.set(adjId, current);
      if (adjId === destId) {
        const path: string[] = [destId];
        let p = destId;
        while (parent.has(p)) {
          p = parent.get(p)!;
          path.unshift(p);
        }
        return path;
      }
      queue.push(adjId);
    }
  }
  return null;
}

export function createDeliveryRoute(
  rng: Rng,
  state: GameState,
  family: FamilyName,
  driverId: string,
  sourceTerritoryId: string,
  destTerritoryId: string,
  cargo: number,
): DeliveryRoute | null {
  const path = findDeliveryPath(
    state.territories,
    sourceTerritoryId,
    destTerritoryId,
    family,
  );
  if (!path || path.length < 2) return null;

  return {
    id: `route_${rng.int(10000, 99999)}`,
    family,
    driverId,
    sourceTerritoryId,
    destTerritoryId,
    path,
    cargo,
    status: "active",
  };
}

/** One-off runs read the road the same way standing routes do. */
export function hijackRisk(state: GameState, route: DeliveryRoute): number {
  return assessPath(state, route.path, route.family, route.driverId).risk;
}

export interface DeliveryProcessResult {
  routes: DeliveryRoute[];
  moneyDelta: number;
  dirtyDelta: number;
  logs: TurnLogEntry[];
  heatDelta: number;
  crewUpdates: { id: string; status: "active" | "wounded" | "dead" }[];
  territories: Territory[];
  ledger: Partial<LiquorLedger>;
  /** Player trucks taken this turn; the pipeline opens a case for each. */
  hijacks: { route: DeliveryRoute; hijacker: FamilyName }[];
  /** Crates fenced by the hijackers, credited to their pools. */
  rivalTreasury: Partial<Record<FamilyName, number>>;
}

export function processDeliveries(
  state: GameState,
  rng: Rng,
): DeliveryProcessResult {
  const logs: TurnLogEntry[] = [];
  const moneyDelta = 0;
  let dirtyDelta = 0;
  let heatDelta = 0;
  const crewUpdates: DeliveryProcessResult["crewUpdates"] = [];
  const routes: DeliveryRoute[] = [];
  const hijacks: DeliveryProcessResult["hijacks"] = [];
  const rivalTreasury: DeliveryProcessResult["rivalTreasury"] = { ...(state.rivalTreasury ?? {}) };
  let territories = state.territories;
  const ledger: Partial<LiquorLedger> = {
    delivered: 0,
    seized: 0,
    stolen: 0,
    cashIn: 0,
    heat: 0,
  };
  const lookup = makeManagerLookup(state.crew, state.playerFamily);

  for (const route of state.routes) {
    if (route.status !== "active") {
      routes.push(route);
      continue;
    }

    const isPlayer = route.family === state.playerFamily;
    const risk = hijackRisk(state, route);

    if (rng.chance(risk)) {
      routes.push({ ...route, status: "hijacked" });
      heatDelta += isPlayer ? 2 : 0;
      if (isPlayer) {
        ledger.stolen = (ledger.stolen ?? 0) + route.cargo;
        ledger.heat = (ledger.heat ?? 0) + 2;
      }
      const onPath = state.territories
        .filter((t) => route.path.includes(t.id) && t.owner && t.owner !== route.family)
        .map((t) => t.owner as FamilyName);
      const hijacker: FamilyName | undefined = onPath.length
        ? rng.pick(onPath)
        : isPlayer
          ? rng.pick(ALL_FAMILY_NAMES.filter((f) => f !== route.family))
          : undefined;
      if (hijacker) {
        rivalTreasury[hijacker] = (rivalTreasury[hijacker] ?? 0) + route.cargo * CRATE_STREET_VALUE;
      }
      // The player never gets told who; that's what the case is for.
      logs.push({
        id: `log_del_${route.id}`,
        turn: state.turn,
        category: "delivery",
        text: isPlayer
          ? `Your shipment was hijacked on the road. Lost ${route.cargo} crates.`
          : `${route.family} shipment hijacked${hijacker ? ` by ${hijacker}` : ""}! Lost ${route.cargo} crates.`,
        family: route.family,
      });
      if (isPlayer && hijacker) hijacks.push({ route, hijacker });
      if (isPlayer && rng.chance(0.25)) {
        crewUpdates.push({ id: route.driverId, status: "wounded" });
      }
      continue;
    }

    if (rng.chance(state.heat.level > 50 ? 0.15 : 0.05)) {
      routes.push({ ...route, status: "seized" });
      if (isPlayer) {
        heatDelta += 4;
        ledger.seized = (ledger.seized ?? 0) + route.cargo;
        ledger.heat = (ledger.heat ?? 0) + 4;
      }
      logs.push({
        id: `log_del_seize_${route.id}`,
        turn: state.turn,
        category: "delivery",
        text: `Police seized a ${route.family} liquor run (${route.cargo} crates).`,
        family: route.family,
      });
      continue;
    }

    // Success: deposit into destination (player only mutates stock/cash)
    if (isPlayer) {
      const dest = territories.find((t) => t.id === route.destTerritoryId);
      if (dest) {
        const dep = depositCrates(dest, route.cargo, "any", state.turn, lookup);
        territories = territories.map((t) =>
          t.id === dest.id ? dep.territory : t,
        );
        ledger.delivered = (ledger.delivered ?? 0) + dep.moved;
        if (dep.overflow > 0) {
          const payout = dep.overflow * (12 + rng.int(0, 8));
          dirtyDelta += payout;
          ledger.cashIn = (ledger.cashIn ?? 0) + payout;
          logs.push({
            id: `log_del_ok_${route.id}`,
            turn: state.turn,
            category: "delivery",
            text: `Delivered ${dep.moved} crates to ${dest.name}; ${dep.overflow} street-sold for $${payout}.`,
            family: route.family,
          });
        } else {
          logs.push({
            id: `log_del_ok_${route.id}`,
            turn: state.turn,
            category: "delivery",
            text: `Delivered ${route.cargo} crates to ${dest.name}.`,
            family: route.family,
          });
        }
      } else {
        logs.push({
          id: `log_del_ok_${route.id}`,
          turn: state.turn,
          category: "delivery",
          text: `${route.family} delivery arrived but destination was gone — ${route.cargo} crates lost.`,
          family: route.family,
        });
      }
    } else {
      logs.push({
        id: `log_del_ok_${route.id}`,
        turn: state.turn,
        category: "delivery",
        text: `${route.family} delivered ${route.cargo} crates.`,
        family: route.family,
      });
    }

    routes.push({ ...route, status: "complete" });
  }

  return {
    routes,
    moneyDelta,
    dirtyDelta,
    logs,
    heatDelta,
    crewUpdates,
    territories,
    ledger,
    hijacks,
    rivalTreasury,
  };
}

export function calculateUpkeep(state: GameState, family: FamilyName): number {
  const crewCost = state.crew
    .filter((c) => c.family === family && c.status !== "dead")
    .reduce((sum, c) => sum + roleUpkeep(c.role), 0);

  const racketCost = state.territories
    .filter((t) => t.owner === family)
    .flatMap((t) => t.rackets)
    .reduce((sum, r) => sum + r.level * 30, 0);

  return crewCost + racketCost;
}

export interface EconomyTurnResult {
  moneyDelta: number;
  dirtyDelta: number;
  netIncome: number;
  logs: TurnLogEntry[];
  territories: Territory[];
  heatDelta: number;
  liquorStock: number;
  audits: LaunderAudit[];
  racketUpdates: Racket[];
  ledger: LiquorLedger;
}

export interface LaunderAudit {
  racketId: string;
  territoryId: string;
  label: string;
  districtName: string;
  freezeTurns: number;
  seized: number;
  heat: number;
}

export interface LaunderSitePlan {
  racket: Racket;
  territoryId: string;
  districtName: string;
  manager: CrewMember | null;
  /** The boss holds court on this block. */
  bossHere?: boolean;
  plan: number;
  cap: number;
  ratio: number;
}

/** Sort sites: under-cap first (ascending plan/cap), then over-cap (ascending), greediest last. */
export function sortLaunderFillOrder(sites: LaunderSitePlan[]): LaunderSitePlan[] {
  return [...sites].sort((a, b) => {
    const aOver = a.ratio > 1 ? 1 : 0;
    const bOver = b.ratio > 1 ? 1 : 0;
    if (aOver !== bOver) return aOver - bOver;
    return a.ratio - b.ratio;
  });
}

export function collectLaunderSites(
  state: GameState,
  territories: Territory[],
): LaunderSitePlan[] {
  const plan = state.launderPlan ?? {};
  // Economy runs after advanceDate, so readiness is checked for the turn being closed.
  const closedTurn = Math.max(0, state.turn - 1);
  const sites: LaunderSitePlan[] = [];
  const bossBlock = state.playerFamily ? bossPresenceDistrict(state, state.playerFamily) : null;
  for (const t of territories) {
    if (t.owner !== state.playerFamily) continue;
    const bossHere = t.id === bossBlock;
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type)) continue;
      if (isRacketFrozen(r, state.turn)) continue;
      if (!isLaunderSiteActive(r, closedTurn)) continue;
      const amount = Math.max(0, Math.floor(plan[r.id] ?? 0));
      if (amount <= 0) continue;
      const manager = r.managerId
        ? state.crew.find(
            (c) => c.id === r.managerId && c.status === "active",
          ) ?? null
        : null;
      const cap = Math.max(1, launderCap(r, manager, state.turn, bossHere));
      sites.push({
        racket: r,
        territoryId: t.id,
        districtName: t.name,
        manager,
        bossHere,
        plan: amount,
        cap,
        ratio: amount / cap,
      });
    }
  }
  return sortLaunderFillOrder(sites);
}

export function processLaundering(
  state: GameState,
  territories: Territory[],
): {
  moneyDelta: number;
  dirtyDelta: number;
  heatDelta: number;
  logs: TurnLogEntry[];
  audits: LaunderAudit[];
  racketUpdates: Map<string, Partial<Racket>>;
} {
  let moneyDelta = 0;
  let dirtyDelta = 0;
  let heatDelta = 0;
  const logs: TurnLogEntry[] = [];
  const audits: LaunderAudit[] = [];
  const racketUpdates = new Map<string, Partial<Racket>>();

  if (!state.playerFamily) {
    return { moneyDelta, dirtyDelta, heatDelta, logs, audits, racketUpdates };
  }

  let dirtyRemaining = Math.max(0, state.dirtyMoney);

  const sites = collectLaunderSites(state, territories);
  let totalIn = 0;
  let totalOut = 0;
  let siteCount = 0;
  let cutSum = 0;

  const mayorActive = state.bribes.mayor.isActive;
  const chiefsActive = state.bribes.chiefs.isActive;
  const heatLevel = state.heat.level;

  for (const site of sites) {
    const amount = Math.min(site.plan, dirtyRemaining);
    if (amount <= 0) continue;

    const cut = launderCut(site.racket.type);
    const over = Math.max(0, amount / site.cap - 1);
    const scrutinyPrev = site.racket.scrutiny ?? 0;
    const p = auditChance(
      site.racket,
      amount,
      {
        heatLevel,
        mayorActive,
        chiefsActive,
        manager: site.manager,
        scrutinyPrev,
        bossHere: site.bossHere,
      },
      state.turn,
    );

    const rng = createRng(
      hashString(`${state.seed}:${state.turn}:${site.racket.id}`),
    );
    const audited = over > 0 && rng.chance(p);

    dirtyRemaining -= amount;
    dirtyDelta -= amount;
    siteCount += 1;
    cutSum += cut;
    totalIn += amount;

    if (audited) {
      const freezeTurns = over < 0.5 ? 1 : over < 1.5 ? 2 : 3;
      const seized = over < 0.5 ? Math.floor(amount * 0.5) : amount;
      const returned = amount - seized;
      const heatAdd = 4 * freezeTurns;
      heatDelta += heatAdd;
      if (returned > 0) {
        const cleaned = Math.floor(returned * (1 - cut));
        moneyDelta += cleaned;
        totalOut += cleaned;
      }
      racketUpdates.set(site.racket.id, {
        frozenUntil: state.turn + freezeTurns,
        scrutiny: 0,
      });
      const label = RACKET_LABELS[site.racket.type];
      audits.push({
        racketId: site.racket.id,
        territoryId: site.territoryId,
        label,
        districtName: site.districtName,
        freezeTurns,
        seized,
        heat: heatAdd,
      });
      logs.push({
        id: `log_audit_${state.turn}_${site.racket.id}`,
        turn: state.turn,
        category: "economy",
        text: `Treasury audit: ${label} in ${site.districtName} frozen ${freezeTurns} turn(s); $${seized} seized.`,
        family: state.playerFamily,
      });
    } else {
      const cleaned = Math.floor(amount * (1 - cut));
      moneyDelta += cleaned;
      totalOut += cleaned;
      const scrutiny = Math.round((scrutinyPrev * 0.5 + over) * 100) / 100;
      racketUpdates.set(site.racket.id, { scrutiny });
    }
  }

  const closedTurn = Math.max(0, state.turn - 1);

  // Log frozen / setting-up skips once
  for (const t of territories) {
    if (t.owner !== state.playerFamily) continue;
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type)) continue;
      const planned = (state.launderPlan ?? {})[r.id] ?? 0;
      if (planned <= 0) continue;
      if (isRacketFrozen(r, state.turn)) {
        logs.push({
          id: `log_frozen_${state.turn}_${r.id}`,
          turn: state.turn,
          category: "economy",
          text: `${RACKET_LABELS[r.type]} in ${t.name} is frozen — wash skipped.`,
          family: state.playerFamily,
        });
        continue;
      }
      if (
        isLaunderSiteSetUp(r) &&
        !isLaunderSiteActive(r, closedTurn)
      ) {
        logs.push({
          id: `log_setup_${state.turn}_${r.id}`,
          turn: state.turn,
          category: "economy",
          text: `${RACKET_LABELS[r.type]} in ${t.name}: books still being set up — wash starts next turn.`,
          family: state.playerFamily,
        });
      }
    }
  }

  if (siteCount > 0 && totalIn > 0) {
    const avgCut = Math.round((cutSum / siteCount) * 100);
    logs.push({
      id: `log_launder_${state.turn}`,
      turn: state.turn,
      category: "economy",
      text: `Laundered $${totalIn} → $${totalOut} clean across ${siteCount} businesses (avg cut ${avgCut}%).`,
      family: state.playerFamily,
    });
  }

  return { moneyDelta, dirtyDelta, heatDelta, logs, audits, racketUpdates };
}

export function processEconomyTurn(
  state: GameState,
  family: FamilyName,
): EconomyTurnResult {
  const def = getFamilyDef(family);
  const incomeBonus = def.bonuses.incomeBonus;
  const logs: TurnLogEntry[] = [];
  let moneyDelta = 0;
  let dirtyDelta = 0;
  let heatDelta = 0;
  let racketHeat = 0;
  const audits: LaunderAudit[] = [];
  let ledger = emptyLiquorLedger();
  const isPlayer = family === state.playerFamily;
  const activeIds = new Set(
    state.crew.filter((c) => c.status === "active").map((c) => c.id),
  );
  const lookup = isPlayer ? makeManagerLookup(state.crew, family) : undefined;
  // The boss's block: rackets there run harder all week.
  const bossBlock = bossPresenceDistrict(state, family);

  // Rival shortcut: pool all crates and auto-feed speakeasies across districts
  let territories = state.territories;
  if (!isPlayer) {
    let pool = 0;
    territories = territories.map((t) => {
      if (t.owner !== family) return t;
      const { territory: produced } = produceAndStore(t, state.turn, undefined, t.id === bossBlock);
      let sum = 0;
      const cleared = produced.rackets.map((r) => {
        if (!["still", "brewery", "warehouse", "speakeasy"].includes(r.type)) {
          return r;
        }
        sum += r.stock;
        return { ...r, stock: 0 };
      });
      pool += sum;
      return { ...produced, rackets: cleared };
    });
    // Distribute pool into speakeasies then warehouses
    territories = territories.map((t) => {
      if (t.owner !== family) return t;
      let remaining = pool;
      const rackets = t.rackets.map((r) => {
        if (r.type !== "speakeasy" || remaining <= 0) return r;
        const room = Math.max(0, stockCap(r) - r.stock);
        const add = Math.min(room, remaining);
        remaining -= add;
        return { ...r, stock: r.stock + add };
      });
      pool = remaining;
      return { ...t, rackets };
    });
    for (const t of territories) {
      if (t.owner !== family) continue;
      if (pool <= 0) break;
      const dep = depositCrates(t, pool, "warehouse", state.turn);
      pool = dep.overflow;
      territories = territories.map((x) => (x.id === t.id ? dep.territory : x));
    }
  }

  territories = territories.map((t) => {
    if (t.owner !== family) return t;

    let updated = t;
    const bossHere = t.id === bossBlock;

    if (isPlayer) {
      const prod = produceAndStore(updated, state.turn, lookup, bossHere);
      updated = prod.territory;
      ledger = mergeLedger(ledger, {
        produced: prod.produced,
        dumped: prod.dumped,
        cashIn: prod.dumpCash,
        heat: prod.dumpHeat,
      });
      dirtyDelta += prod.dumpCash;
      heatDelta += prod.dumpHeat;
      if (prod.backedUp) {
        logs.push({
          id: `log_dump_${state.turn}_${t.id}`,
          turn: state.turn,
          category: "economy",
          text: dumpWarning(t.name, prod.dumped),
          family,
        });
      }

      // Nothing walks out the back with the boss on the block.
      if (lookup && !bossHere) {
        const shrink = applyWarehouseShrinkage(updated, lookup, state.turn);
        updated = shrink.territory;
        if (shrink.shrunk > 0) {
          ledger = mergeLedger(ledger, { shrunk: shrink.shrunk });
          const cause = shrink.byRacket[0]?.cause ?? "no manager";
          logs.push({
            id: `log_shrink_${state.turn}_${t.id}`,
            turn: state.turn,
            category: "economy",
            text: `${t.name}: ${shrink.shrunk} crates walked out the back (${cause}).`,
            family,
          });
        }
      }

      updated = supplySpeakeasies(updated, state.turn, lookup);
    }

    // Base racket income (speakeasy handled in sellSpeakeasies)
    updated = {
      ...updated,
      rackets: updated.rackets.map((racket) => {
        if (isRacketFrozen(racket, state.turn)) {
          racketHeat += racket.heatGen * 0.5;
          return racket;
        }
        if (racket.type === "speakeasy") {
          racketHeat += racket.heatGen;
          return racket;
        }
        const manager = racket.managerId
          ? state.crew.find(
              (c) =>
                c.id === racket.managerId &&
                c.family === family &&
                c.status === "active",
            )
          : null;
        let inc = racketIncome(racket, incomeBonus, manager, state.crew, bossHere);
        if (isPlayer && dinnerActive(state)) inc = Math.floor(inc * DINNER_INCOME_MULT);
        if (isLegitBusiness(racket.type)) {
          moneyDelta += inc;
        } else if (["gambling", "brothel", "loan_shark"].includes(racket.type)) {
          dirtyDelta += inc;
        } else {
          dirtyDelta += Math.floor(inc * 0.7);
          moneyDelta += Math.floor(inc * 0.3);
        }
        racketHeat += racket.heatGen;
        return racket;
      }),
    };

    const sell = sellSpeakeasies(
      updated,
      family,
      incomeBonus,
      // The boss's block counts as managed: his people mind the back room.
      bossHere || (!!lookup && hasManagedWarehouse(updated, lookup, state.turn)),
      bossHere,
    );
    updated = sell.territory;
    const thin = isPlayer && dinnerActive(state) ? DINNER_INCOME_MULT : 1;
    moneyDelta += Math.floor(sell.revenue * thin);
    dirtyDelta += Math.floor(sell.dirtyRevenue * thin);
    if (isPlayer) {
      ledger = mergeLedger(ledger, {
        sold: sell.sold,
        cashIn: sell.dirtyRevenue + sell.revenue,
      });
    }

    // Every held district kicks back a tenth of its base income in clean cash.
    // General territory money, not liquor: it stays out of the crate ledger.
    moneyDelta += Math.floor(t.baseIncome * (1 + incomeBonus) * 0.1);

    if (t.strategicBonus?.type === "income") {
      moneyDelta += Math.floor(t.strategicBonus.value * (1 + incomeBonus));
    }

    moneyDelta += Math.floor(t.baseIncome * (1 + incomeBonus) * 0.15);

    if (isPlayer) {
      const unguarded = isUnguarded(updated, activeIds);
      const sh = stashHeat(updated, unguarded, state.turn, lookup);
      heatDelta += sh;
      ledger = mergeLedger(ledger, { heat: sh });
      const idle = idleStorageCost(updated, state.turn, lookup);
      moneyDelta -= idle;
      if (idle > 0) ledger = mergeLedger(ledger, { cashOut: idle });
    }

    return updated;
  });

  let finalTerritories = territories;
  const racketUpdates: Racket[] = [];
  if (isPlayer) {
    const wash = processLaundering(
      {
        ...state,
        dirtyMoney: state.dirtyMoney + dirtyDelta,
        territories,
      },
      territories,
    );
    moneyDelta += wash.moneyDelta;
    dirtyDelta += wash.dirtyDelta;
    heatDelta += wash.heatDelta;
    logs.push(...wash.logs);
    audits.push(...wash.audits);

    if (wash.racketUpdates.size > 0) {
      finalTerritories = territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) => {
          const patch = wash.racketUpdates.get(r.id);
          if (!patch) return r;
          const updated = { ...r, ...patch };
          racketUpdates.push(updated);
          return updated;
        }),
      }));
    }
  }

  const upkeep = calculateUpkeep(
    { ...state, territories: finalTerritories },
    family,
  );
  moneyDelta -= upkeep;

  const netIncome = moneyDelta + dirtyDelta;
  const liquorStock = isPlayer
    ? totalCrates({ ...state, territories: finalTerritories }, family)
    : state.liquorStock;

  if (isPlayer) {
    logs.push({
      id: `log_econ_${state.turn}_${family}`,
      turn: state.turn,
      category: "economy",
      text: `Net income: $${netIncome >= 0 ? "+" : ""}${netIncome} (upkeep $${upkeep}).`,
      family,
    });
  }

  heatDelta += Math.round(racketHeat * RACKET_HEAT_SCALE);

  return {
    moneyDelta,
    dirtyDelta,
    netIncome,
    logs,
    territories: finalTerritories,
    heatDelta,
    liquorStock,
    audits,
    racketUpdates,
    ledger,
  };
}

/** Run economy for all families; returns merged state deltas */
export function processAllEconomy(
  state: GameState,
): {
  territories: Territory[];
  moneyDelta: number;
  dirtyDelta: number;
  lastNetIncome: number;
  logs: TurnLogEntry[];
  heatDelta: number;
  liquorStock: number;
  rivalTreasury: Partial<Record<FamilyName, number>>;
  audits: LaunderAudit[];
  ledger: LiquorLedger;
} {
  let territories = state.territories;
  let moneyDelta = 0;
  let dirtyDelta = 0;
  let heatDelta = 0;
  let liquorStock = state.liquorStock;
  let ledger = emptyLiquorLedger();
  const logs: TurnLogEntry[] = [];
  const audits: LaunderAudit[] = [];
  let playerNet = 0;
  const rivalTreasury: Partial<Record<FamilyName, number>> = {
    ...(state.rivalTreasury ?? {}),
  };

  const families = [...new Set(territories.map((t) => t.owner).filter(Boolean))] as FamilyName[];

  for (const family of families) {
    const partial = processEconomyTurn({ ...state, territories }, family);
    territories = partial.territories;
    // Heat is the player's problem: only the player's own rackets, dumps and
    // washes draw the law. Rival operations don't put cops on your door.
    if (family === state.playerFamily) heatDelta += partial.heatDelta;
    liquorStock = partial.liquorStock;
    logs.push(...partial.logs);

    if (family === state.playerFamily) {
      moneyDelta += partial.moneyDelta;
      dirtyDelta += partial.dirtyDelta;
      playerNet = partial.netIncome;
      audits.push(...partial.audits);
      ledger = mergeLedger(ledger, partial.ledger);
    } else {
      const stipend = Math.max(partial.netIncome, 150);
      rivalTreasury[family] = Math.max(0, (rivalTreasury[family] ?? 0) + stipend);
    }
  }

  // Rival audit rumors
  for (const family of families) {
    if (family === state.playerFamily) continue;
    const legitSites: { t: Territory; r: Racket }[] = [];
    for (const t of territories) {
      if (t.owner !== family) continue;
      for (const r of t.rackets) {
        if (isLegitBusiness(r.type) && !isRacketFrozen(r, state.turn)) {
          legitSites.push({ t, r });
        }
      }
    }
    if (legitSites.length === 0) continue;
    const baseP = state.heat.level >= 60 ? 0.06 : 0.04;
    const rng = createRng(hashString(`${state.seed}:${state.turn}:audit:${family}`));
    if (!rng.chance(baseP)) continue;
    const pick = rng.pick(legitSites);
    const freezeUntil = state.turn + 2;
    const debit = launderCap(pick.r, null, state.turn) * 2;
    rivalTreasury[family] = Math.max(0, (rivalTreasury[family] ?? 0) - debit);
    territories = territories.map((t) =>
      t.id !== pick.t.id
        ? t
        : {
            ...t,
            rackets: t.rackets.map((r) =>
              r.id === pick.r.id ? { ...r, frozenUntil: freezeUntil } : r,
            ),
          },
    );
    logs.push({
      id: `log_rival_audit_${state.turn}_${family}`,
      turn: state.turn,
      category: "economy",
      text: `Word on the street: the Feds froze ${family}'s ${RACKET_LABELS[pick.r.type]} in ${pick.t.name}.`,
      family,
    });
  }

  return {
    territories,
    moneyDelta,
    dirtyDelta,
    lastNetIncome: playerNet,
    logs,
    heatDelta,
    liquorStock,
    rivalTreasury,
    audits,
    ledger,
  };
}

export function mapBusinessTypeToRacket(businessType: string | null): RacketType | null {
  if (!businessType) return null;
  const map: Record<string, RacketType> = {
    store_front: "deli",
    mixed: "warehouse",
    loan_sharking: "loan_shark",
    gambling: "gambling",
    brothel: "brothel",
    still: "still",
    brewery: "brewery",
    warehouse: "warehouse",
    speakeasy: "speakeasy",
    front: "laundromat",
    laundromat: "laundromat",
    deli: "deli",
    barber: "barber",
    restaurant: "restaurant",
    trucking: "trucking",
    loan_shark: "loan_shark",
  };
  return map[businessType] ?? "speakeasy";
}

/** Apply normalizeRacketType to every racket on every territory (save migration). */
export function normalizeTerritoryRackets(territories: Territory[]): Territory[] {
  return territories.map((t) => ({
    ...t,
    rackets: t.rackets.map((r) => ({
      ...r,
      type: normalizeRacketType(r.type as string),
    })),
  }));
}

/** Prune launderPlan entries for missing / non-player / non-legit / unset sites. */
export function pruneLaunderPlan(
  plan: Record<string, number>,
  territories: Territory[],
  playerFamily: FamilyName | null,
): Record<string, number> {
  if (!playerFamily) return {};
  const next: Record<string, number> = {};
  for (const t of territories) {
    if (t.owner !== playerFamily) continue;
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type)) continue;
      if (!isLaunderSiteSetUp(r)) continue;
      const amount = plan[r.id];
      if (amount != null && amount > 0) next[r.id] = amount;
    }
  }
  return next;
}

/**
 * Legacy save migration: player legit rackets with a plan > 0 become ready sites;
 * others stay not set up.
 */
export function migrateLaunderSites(
  territories: Territory[],
  plan: Record<string, number>,
  playerFamily: FamilyName | null,
): Territory[] {
  if (!playerFamily) return territories;
  return territories.map((t) => {
    if (t.owner !== playerFamily) return t;
    let changed = false;
    const rackets = t.rackets.map((r) => {
      if (!isLegitBusiness(r.type)) return r;
      if (r.launderReadyTurn != null) return r;
      const amount = plan[r.id] ?? 0;
      if (amount <= 0) return r;
      changed = true;
      return { ...r, launderReadyTurn: 0 };
    });
    return changed ? { ...t, rackets } : t;
  });
}
