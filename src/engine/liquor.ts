import type {
  CrewMember,
  FamilyName,
  GameState,
  LiquorLedger,
  PendingShipment,
  Racket,
  RacketType,
  Territory,
  TurnLogEntry,
} from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import type { Rng } from "./rng";
import { createRng, hashString } from "./rng";
import { isUnguarded } from "./territoryValue";
import { findDeliveryPath, hasSafehouse } from "./economy";
import { BOSS_PRESENCE } from "./bossPresence";
import { placementBonus } from "./districtFeatures";
import { penalizeRacketFreeze } from "./practice";

const SPEAKEASY_BASE_INCOME = 280;
/** A crate that sat a week in a managed warehouse sells for this much more. */
export const PROOF_PREMIUM = 5;
/** Empty warehouse slots under this, per barn, pay no rent. */
export const WAREHOUSE_FREE_EMPTY = 40;

function frozen(r: Racket, turn: number): boolean {
  return (r.frozenUntil ?? 0) > turn;
}

/** Crates of capacity per racket level. */
export const STOCK_CAP_PER_LEVEL: Record<RacketType, number> = {
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

const STORAGE_TYPES: RacketType[] = ["still", "brewery", "warehouse", "speakeasy"];
const PRODUCER_TYPES: RacketType[] = ["still", "brewery"];

export type ManagerLookup = (racket: Racket) => CrewMember | null | undefined;

export function makeManagerLookup(
  crew: CrewMember[],
  family: FamilyName | null,
): ManagerLookup {
  return (racket) => {
    if (!racket.managerId || !family) return null;
    const m = crew.find((c) => c.id === racket.managerId);
    if (!m || m.family !== family || m.status !== "active") return null;
    return m;
  };
}

export function warehouseManagerMods(manager?: CrewMember | null): {
  managed: boolean;
  score: number;
  capMult: number;
  shrinkRate: number;
  raidMult: number;
} {
  if (!manager || manager.status !== "active") {
    return {
      managed: false,
      score: 0,
      capMult: 1,
      shrinkRate: 0.12,
      raidMult: 1,
    };
  }
  const bookkeeper = manager.traits.includes("bookkeeper");
  const score = Math.max(
    0,
    Math.min(100, manager.skills.smarts + (bookkeeper ? 20 : 0)),
  );
  if (score < 50) {
    return {
      managed: true,
      score,
      capMult: 1,
      shrinkRate: ((50 - score) / 50) * 0.1,
      raidMult: 1,
    };
  }
  const t = (score - 50) / 50;
  return {
    managed: true,
    score,
    capMult: 1 + t * 0.3,
    shrinkRate: 0,
    raidMult: 1 - t * 0.25,
  };
}

/** Human-readable manager effect for UI. */
export function warehouseManagerEffectText(
  manager: CrewMember | null | undefined,
  stock = 0,
): string {
  const mods = warehouseManagerMods(manager);
  if (!mods.managed) {
    return "Unmanaged: −12%/turn";
  }
  if (mods.shrinkRate > 0) {
    const loss = Math.max(1, Math.ceil(stock * mods.shrinkRate));
    return `−${loss} crates/turn pilferage (smarts ${mods.score})`;
  }
  const capPct = Math.round((mods.capMult - 1) * 100);
  const raidPct = Math.round((1 - mods.raidMult) * 100);
  const parts: string[] = [];
  if (capPct > 0) parts.push(`+${capPct}% cap`);
  if (raidPct > 0) parts.push(`−${raidPct}% raid`);
  if (parts.length === 0) return `Managed (smarts ${mods.score})`;
  return parts.join(", ");
}

export function emptyLiquorLedger(): LiquorLedger {
  return {
    produced: 0,
    bought: 0,
    sold: 0,
    delivered: 0,
    dumped: 0,
    stolen: 0,
    seized: 0,
    shrunk: 0,
    cashIn: 0,
    cashOut: 0,
    heat: 0,
  };
}

export function isStorageType(type: RacketType): boolean {
  return STORAGE_TYPES.includes(type);
}

export function isProducerType(type: RacketType): boolean {
  return PRODUCER_TYPES.includes(type);
}

export function stockCap(racket: Racket, manager?: CrewMember | null): number {
  const base = STOCK_CAP_PER_LEVEL[racket.type] * racket.level;
  if (racket.type !== "warehouse") return base;
  return Math.floor(base * warehouseManagerMods(manager).capMult);
}

function capOf(r: Racket, lookup?: ManagerLookup, feature?: Territory["feature"]): number {
  const docks = feature === "docks" && r.type === "warehouse" ? 1.25 : 1;
  return Math.floor(stockCap(r, lookup?.(r)) * docks);
}

function proofCount(r: Racket): number {
  return Math.max(0, Math.min(r.stock, r.proofed ?? 0));
}

/** Take crates, proofed ones first. Mutates the racket. */
export function pullFrom(r: Racket, n: number): { take: number; proofed: number } {
  const take = Math.min(r.stock, Math.max(0, n));
  const before = proofCount(r);
  const proofed = Math.min(before, take);
  r.stock -= take;
  r.proofed = before - proofed;
  return { take, proofed };
}

export function districtStorage(
  t: Territory,
  turn = 0,
  lookup?: ManagerLookup,
): { stored: number; cap: number; free: number } {
  let stored = 0;
  let cap = 0;
  for (const r of t.rackets) {
    if (!isStorageType(r.type)) continue;
    if (r.type === "warehouse" && frozen(r, turn)) continue;
    const c = capOf(r, lookup, t.feature);
    cap += c;
    stored += Math.min(r.stock, c);
  }
  return { stored, cap, free: Math.max(0, cap - stored) };
}

export function totalCrates(state: GameState, family: FamilyName | null): number {
  if (!family) return 0;
  const lookup = makeManagerLookup(state.crew, family);
  let n = 0;
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    n += districtStorage(t, state.turn, lookup).stored;
  }
  return n;
}

export function totalCapacity(state: GameState, family: FamilyName | null): number {
  if (!family) return 0;
  const lookup = makeManagerLookup(state.crew, family);
  let n = 0;
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    n += districtStorage(t, state.turn, lookup).cap;
  }
  return n;
}

export function hasManagedWarehouse(
  t: Territory,
  lookup: ManagerLookup,
  turn = 0,
): boolean {
  return t.rackets.some((r) => {
    if (r.type !== "warehouse") return false;
    if (frozen(r, turn)) return false;
    return warehouseManagerMods(lookup(r)).managed;
  });
}

export function hasWarehouse(t: Territory, turn = 0): boolean {
  return t.rackets.some((r) => r.type === "warehouse" && !frozen(r, turn));
}

export type FeedPlan =
  | { ok: true; sourceId: string; driverId: string; cargo: number; path: string[] }
  | { ok: false; reason: string };

function localSupplyStock(t: Territory, turn: number): number {
  let n = 0;
  for (const r of t.rackets) {
    if (r.type !== "warehouse" && r.type !== "still" && r.type !== "brewery") continue;
    if (r.type === "warehouse" && frozen(r, turn)) continue;
    n += r.stock;
  }
  return n;
}

/**
 * Pick arguments for an existing delivery that restocks a dry speakeasy.
 * Does not move crates — callers pass the result to startDelivery.
 */
export function planFeedSpeakeasy(
  state: Pick<GameState, "territories" | "crew" | "playerFamily" | "turn">,
  territoryId: string,
): FeedPlan {
  const family = state.playerFamily;
  const dest = state.territories.find((t) => t.id === territoryId);
  if (!family || !dest || dest.owner !== family) {
    return { ok: false, reason: "Not your district" };
  }

  const dry = dest.rackets.filter(
    (r) => r.type === "speakeasy" && r.stock === 0 && !frozen(r, state.turn),
  );
  if (dry.length === 0) {
    return { ok: false, reason: "No dry speakeasy here" };
  }

  if (localSupplyStock(dest, state.turn) > 0) {
    return { ok: false, reason: "Local stock will refill it next turn" };
  }
  if (!hasWarehouse(dest, state.turn)) {
    return { ok: false, reason: "Build a warehouse here to receive crates" };
  }

  const lookup = makeManagerLookup(state.crew, family);
  if (!hasManagedWarehouse(dest, lookup, state.turn)) {
    return { ok: false, reason: "Assign a manager to the warehouse here" };
  }

  const destFree = districtStorage(dest, state.turn, lookup).free;
  if (destFree <= 0) {
    return { ok: false, reason: "Warehouse here is full" };
  }

  const candidates = state.territories.filter((t) => {
    if (t.id === dest.id || t.owner !== family) return false;
    if (!hasManagedWarehouse(t, lookup, state.turn)) return false;
    return withdrawWarehouse(t, 1_000_000, state.turn, lookup).moved > 0;
  });
  if (candidates.length === 0) {
    return { ok: false, reason: "No other district has a stocked, managed warehouse" };
  }

  let best: { id: string; path: string[]; stock: number } | null = null;
  let reachable = false;
  for (const source of candidates) {
    const path = findDeliveryPath(state.territories, source.id, dest.id, family, true);
    if (!path || path.length < 2) continue;
    reachable = true;
    const stock = withdrawWarehouse(source, 1_000_000, state.turn, lookup).moved;
    if (
      !best ||
      path.length < best.path.length ||
      (path.length === best.path.length && stock > best.stock)
    ) {
      best = { id: source.id, path, stock };
    }
  }
  if (!best || !reachable) {
    return { ok: false, reason: "No route to a stocked warehouse" };
  }

  const drivers = state.crew.filter(
    (c) => c.family === family && c.status === "active" && c.assignment.type === "idle",
  );
  if (drivers.length === 0) {
    return { ok: false, reason: "No idle crew to drive" };
  }
  const driver = [...drivers].sort((a, b) => {
    const wheel = Number(b.traits.includes("wheelman")) - Number(a.traits.includes("wheelman"));
    if (wheel !== 0) return wheel;
    return b.skills.driving - a.skills.driving;
  })[0]!;

  const need = dry.reduce((sum, r) => sum + stockCap(r), 0);
  const cargo = Math.max(1, Math.min(need, best.stock, destFree));
  return {
    ok: true,
    sourceId: best.id,
    driverId: driver.id,
    cargo,
    path: best.path,
  };
}

type Prefer = "warehouse" | "speakeasy" | "producer" | "any";

function depositOrder(prefer: Prefer): RacketType[] {
  if (prefer === "warehouse") return ["warehouse", "speakeasy", "still", "brewery"];
  if (prefer === "speakeasy") return ["speakeasy", "warehouse", "still", "brewery"];
  if (prefer === "producer") return ["still", "brewery", "warehouse", "speakeasy"];
  return ["warehouse", "speakeasy", "still", "brewery"];
}

function withdrawOrder(): RacketType[] {
  return ["warehouse", "still", "brewery", "speakeasy"];
}

/** Deposit crates into a district. Frozen warehouses cannot receive. */
export function depositCrates(
  t: Territory,
  n: number,
  prefer: Prefer = "any",
  turn = 0,
  lookup?: ManagerLookup,
): { territory: Territory; moved: number; overflow: number } {
  if (n <= 0) return { territory: t, moved: 0, overflow: 0 };
  let remaining = n;
  const order = depositOrder(prefer);
  const rackets = t.rackets.map((r) => ({ ...r }));

  for (const type of order) {
    if (remaining <= 0) break;
    for (const r of rackets) {
      if (r.type !== type) continue;
      if (type === "warehouse" && frozen(r, turn)) continue;
      const free = Math.max(0, capOf(r, lookup, t.feature) - r.stock);
      if (free <= 0) continue;
      const add = Math.min(free, remaining);
      r.stock += add;
      remaining -= add;
    }
  }

  return {
    territory: { ...t, rackets },
    moved: n - remaining,
    overflow: remaining,
  };
}

/** Withdraw crates from a district (warehouses first). Frozen warehouses cannot send. */
export function withdrawCrates(
  t: Territory,
  n: number,
  turn = 0,
): { territory: Territory; moved: number } {
  if (n <= 0) return { territory: t, moved: 0 };
  let remaining = n;
  const rackets = t.rackets.map((r) => ({ ...r }));

  for (const type of withdrawOrder()) {
    if (remaining <= 0) break;
    for (const r of rackets) {
      if (r.type !== type) continue;
      if (type === "warehouse" && frozen(r, turn)) continue;
      if (r.stock <= 0) continue;
      const got = pullFrom(r, remaining);
      remaining -= got.take;
    }
  }

  return {
    territory: { ...t, rackets },
    moved: n - remaining,
  };
}

type DepositPrefer = Prefer | "warehouseOnly";

function trackedOrder(prefer: DepositPrefer): RacketType[] {
  if (prefer === "warehouseOnly") return ["warehouse"];
  return depositOrder(prefer);
}

/**
 * Deposit crates, carrying a proofed count onto the racks that receive them.
 * Proofed crates land first so overflow sold on the street is the green stuff.
 */
export function depositTracked(
  t: Territory,
  n: number,
  proofed: number,
  prefer: DepositPrefer = "any",
  turn = 0,
  lookup?: ManagerLookup,
): { territory: Territory; moved: number; overflow: number; proofedLanded: number } {
  if (n <= 0) return { territory: t, moved: 0, overflow: 0, proofedLanded: 0 };
  let remaining = n;
  let proofLeft = Math.max(0, Math.min(proofed, n));
  const order = trackedOrder(prefer);
  const rackets = t.rackets.map((r) => ({ ...r }));

  const place = (wantProof: boolean) => {
    for (const type of order) {
      if (remaining <= 0) break;
      if (wantProof && proofLeft <= 0) break;
      for (const r of rackets) {
        if (r.type !== type) continue;
        if (type === "warehouse" && frozen(r, turn)) continue;
        const free = Math.max(0, capOf(r, lookup, t.feature) - r.stock);
        if (free <= 0) continue;
        const budget = wantProof ? proofLeft : remaining - proofLeft;
        if (budget <= 0) continue;
        const add = Math.min(free, budget);
        r.stock += add;
        if (wantProof) {
          r.proofed = proofCount(r) + add;
          proofLeft -= add;
        }
        remaining -= add;
      }
    }
  };
  place(true);
  place(false);

  return {
    territory: { ...t, rackets },
    moved: n - remaining,
    overflow: remaining,
    proofedLanded: Math.min(proofed, n) - proofLeft,
  };
}

/**
 * Draw crates from unfrozen warehouses only. With a lookup, only a managed
 * barn loads. Proofed crates leave first.
 */
export function withdrawWarehouse(
  t: Territory,
  n: number,
  turn = 0,
  lookup?: ManagerLookup,
): { territory: Territory; moved: number; proofed: number } {
  if (n <= 0) return { territory: t, moved: 0, proofed: 0 };
  let remaining = n;
  let proofed = 0;
  const rackets = t.rackets.map((r) => ({ ...r }));
  for (const r of rackets) {
    if (remaining <= 0) break;
    if (r.type !== "warehouse" || frozen(r, turn) || r.stock <= 0) continue;
    if (lookup && !warehouseManagerMods(lookup(r)).managed) continue;
    const got = pullFrom(r, remaining);
    remaining -= got.take;
    proofed += got.proofed;
  }
  return { territory: { ...t, rackets }, moved: n - remaining, proofed };
}

/** Pull a standing sale or a split load across every managed barn, fullest first. */
export function withdrawFamilyWarehouses(
  territories: Territory[],
  owner: FamilyName,
  n: number,
  turn: number,
  lookup: ManagerLookup,
): { territories: Territory[]; moved: number; proofed: number } {
  const ranked = territories
    .filter((t) => t.owner === owner)
    .map((t) => ({
      id: t.id,
      stock: t.rackets.reduce((sum, r) => {
        if (r.type !== "warehouse" || frozen(r, turn)) return sum;
        if (!warehouseManagerMods(lookup(r)).managed) return sum;
        return sum + r.stock;
      }, 0),
    }))
    .filter((x) => x.stock > 0)
    .sort((a, b) => b.stock - a.stock);

  let next = territories;
  let moved = 0;
  let proofed = 0;
  let need = n;
  for (const src of ranked) {
    if (need <= 0) break;
    const current = next.find((t) => t.id === src.id);
    if (!current) continue;
    const wd = withdrawWarehouse(current, need, turn, lookup);
    next = next.map((t) => (t.id === src.id ? wd.territory : t));
    moved += wd.moved;
    proofed += wd.proofed;
    need -= wd.moved;
  }
  return { territories: next, moved, proofed };
}

/** Leftover stock in a managed, unfrozen warehouse has sat the week. It is proofed. */
export function markWarehouseProof(
  t: Territory,
  turn: number,
  lookup: ManagerLookup,
): Territory {
  return {
    ...t,
    rackets: t.rackets.map((r) => {
      if (r.type !== "warehouse") return r;
      const held = proofCount(r);
      if (frozen(r, turn) || !warehouseManagerMods(lookup(r)).managed) {
        return { ...r, proofed: held };
      }
      return { ...r, proofed: r.stock };
    }),
  };
}

/**
 * Pilferage from unmanaged / weak-manager warehouses.
 * Loss = ceil(stock * shrinkRate), min 1 when rate > 0 and stock > 0.
 */
export function applyWarehouseShrinkage(
  t: Territory,
  lookup: ManagerLookup,
  turn = 0,
): {
  territory: Territory;
  shrunk: number;
  byRacket: { racketId: string; lost: number; cause: string }[];
} {
  let shrunk = 0;
  const byRacket: { racketId: string; lost: number; cause: string }[] = [];
  const straightToBar = t.rackets.some((r) => r.type === "speakeasy");
  const rackets = t.rackets.map((r) => {
    if (straightToBar && r.type === "warehouse") return r;
    if (r.type !== "warehouse" || frozen(r, turn) || r.stock <= 0) return r;
    const mgr = lookup(r);
    const mods = warehouseManagerMods(mgr);
    if (mods.shrinkRate <= 0) return r;
    const next = { ...r };
    const lost = Math.max(1, Math.ceil(next.stock * mods.shrinkRate));
    const got = pullFrom(next, lost);
    shrunk += got.take;
    byRacket.push({
      racketId: r.id,
      lost: got.take,
      cause: mods.managed
        ? `weak manager: ${mgr?.name ?? "unknown"}`
        : "no manager",
    });
    return next;
  });
  return { territory: { ...t, rackets }, shrunk, byRacket };
}

/** Crates a still or brewery turns out a week; more with the boss on the block. */
export function productionOutput(racket: Racket, bossHere = false): number {
  const extra = bossHere ? BOSS_PRESENCE.productionPerLevel * racket.level : 0;
  if (racket.type === "still") return 5 + racket.level * 3 + extra;
  if (racket.type === "brewery") return 8 + racket.level * 4 + extra;
  return 0;
}

/**
 * Produce into stills and breweries. A managed warehouse on the block takes
 * the cook first, as green crates. What does not fit stays in the cooker,
 * and anything past that cap spills to a warehouse or is dumped.
 */
export function produceAndStore(
  t: Territory,
  turn = 0,
  lookup?: ManagerLookup,
  bossHere = false,
): {
  territory: Territory;
  produced: number;
  dumped: number;
  dumpCash: number;
  dumpHeat: number;
  backedUp: boolean;
} {
  let produced = 0;
  let territory: Territory = { ...t, rackets: t.rackets.map((r) => ({ ...r })) };
  const intoBarn = !!lookup && hasManagedWarehouse(t, lookup, turn);
  let spill = 0;

  for (const r of territory.rackets) {
    if (!isProducerType(r.type)) continue;
    const cook = t.feature === "industrial" ? 1.25 : 1;
    const out = Math.floor(productionOutput(r, bossHere) * cook);
    produced += out;
    let left = out;
    if (intoBarn && left > 0) {
      const dep = depositTracked(territory, left, 0, "warehouseOnly", turn, lookup);
      territory = dep.territory;
      left -= dep.moved;
    }
    const cooker = territory.rackets.find((x) => x.id === r.id);
    if (!cooker) continue;
    const room = Math.max(0, stockCap(cooker) - cooker.stock);
    const kept = Math.min(left, room);
    cooker.stock += kept;
    spill += left - kept;
  }

  let dumped = 0;
  if (spill > 0) {
    const dep = depositTracked(territory, spill, 0, "warehouseOnly", turn, lookup);
    territory = dep.territory;
    dumped = dep.overflow;
  }

  if (t.feature === "docks") {
    let extra = 0;
    for (const r of territory.rackets) {
      if (r.type === "warehouse") extra += 2 * r.level;
    }
    if (extra > 0) {
      const landed = depositTracked(territory, extra, 0, "warehouseOnly", turn, lookup);
      territory = landed.territory;
      produced += landed.moved;
    }
  }

  const dumpCash = dumped * 4;
  const dumpHeat = Math.floor(dumped / 10);
  return {
    territory,
    produced,
    dumped,
    dumpCash,
    dumpHeat,
    backedUp: dumped > 0,
  };
}

/** Pull crates from warehouses then producers into speakeasies up to cap. */
export function supplySpeakeasies(
  t: Territory,
  turn = 0,
  lookup?: ManagerLookup,
): Territory {
  const speaks = t.rackets.filter((r) => r.type === "speakeasy");
  if (speaks.length === 0) return t;

  let territory = t;
  for (const speak of speaks) {
    const need = Math.max(0, stockCap(speak) - speak.stock);
    if (need <= 0) continue;
    const rackets = territory.rackets.map((r) => ({ ...r }));
    let remaining = need;
    let proofed = 0;
    for (const type of ["warehouse", "still", "brewery"] as RacketType[]) {
      if (remaining <= 0) break;
      for (const r of rackets) {
        if (r.type !== type) continue;
        if (type === "warehouse" && frozen(r, turn)) continue;
        if (r.stock <= 0) continue;
        const got = pullFrom(r, remaining);
        remaining -= got.take;
        proofed += got.proofed;
      }
    }
    const got = need - remaining;
    for (const r of rackets) {
      if (r.id !== speak.id) continue;
      r.stock += got;
      r.proofed = proofCount(r) + proofed;
    }
    territory = { ...territory, rackets };
  }
  void lookup;
  return territory;
}

/**
 * Speakeasies sell crates. Dry speakeasies (no stock) earn 25% of base income as dirty.
 * Fed speakeasies earn full base income + crate sales.
 */
export function sellSpeakeasies(
  territory: Territory,
  family: FamilyName,
  incomeBonus = 0,
  /** A managed warehouse on the same block keeps the bar poured: +1 crate/level sold. */
  localWarehouse = false,
  /** The boss drinks here: the room is full every night, +1 crate/level poured. */
  bossHere = false,
): {
  territory: Territory;
  revenue: number;
  dirtyRevenue: number;
  sold: number;
  dryCount: number;
  /** Each bar's own take, before any dinner thinning. Sums to revenue / dirtyRevenue. */
  byRacket: { id: string; clean: number; dirty: number }[];
} {
  let revenue = 0;
  let dirtyRevenue = 0;
  let sold = 0;
  let dryCount = 0;
  const byRacket: { id: string; clean: number; dirty: number }[] = [];

  const rackets = territory.rackets.map((r) => {
    if (r.type !== "speakeasy") return r;
    const place = placementBonus(territory, r, territory.rackets);
    const base = Math.floor(SPEAKEASY_BASE_INCOME * r.level * (1 + incomeBonus) * place.mult);
    if (r.stock <= 0) {
      dryCount += 1;
      const dirty = Math.floor(base * 0.25);
      dirtyRevenue += dirty;
      byRacket.push({ id: r.id, clean: 0, dirty });
      return r;
    }
    const amount = Math.min(r.stock, speakeasyPull(r.level, localWarehouse, bossHere));
    const proofedSold = Math.min(amount, proofCount(r));
    const greenSold = amount - proofedSold;
    const price = 15 + r.level * 5;
    const crateDirty = greenSold * price + proofedSold * (price + PROOF_PREMIUM);
    const crateClean =
      Math.floor(greenSold * price * 0.3) + Math.floor(proofedSold * (price + PROOF_PREMIUM) * 0.3);
    const baseDirty = Math.floor(base * 0.7);
    const baseClean = Math.floor(base * 0.3);
    dirtyRevenue += crateDirty + baseDirty;
    revenue += crateClean + baseClean;
    byRacket.push({ id: r.id, clean: crateClean + baseClean, dirty: crateDirty + baseDirty });
    sold += amount;
    return { ...r, stock: r.stock - amount, proofed: proofCount(r) - proofedSold };
  });

  return {
    territory: { ...territory, rackets },
    revenue,
    dirtyRevenue,
    sold,
    dryCount,
    byRacket,
  };
}

/** Crates a speakeasy moves in a week. */
export function speakeasyPull(level: number, localWarehouse = false, bossHere = false): number {
  return 5 + level * 2 + (localWarehouse ? level : 0) + (bossHere ? BOSS_PRESENCE.speakeasyPullPerLevel * level : 0);
}

/**
 * Passive heat from oversized stashes. Allowance 50 crates. Doubled if
 * unguarded. Speakeasy stock in a district with a managed warehouse doesn't
 * count — the crates live in the back, not behind the bar.
 */
export function stashHeat(
  t: Territory,
  unguarded: boolean,
  turn = 0,
  lookup?: ManagerLookup,
): number {
  let { stored } = districtStorage(t, turn, lookup);
  if (lookup && hasManagedWarehouse(t, lookup, turn)) {
    for (const r of t.rackets) {
      if (r.type === "speakeasy") stored -= Math.min(r.stock, capOf(r, lookup, t.feature));
    }
  }
  const base = Math.floor(Math.max(0, stored - 50) / 100);
  return unguarded ? base * 2 : base;
}

/** Cost of empty warehouse slots ($0.10 per free crate of warehouse capacity). */
export function idleStorageCost(
  t: Territory,
  turn = 0,
  lookup?: ManagerLookup,
): number {
  let free = 0;
  for (const r of t.rackets) {
    if (r.type !== "warehouse") continue;
    if (frozen(r, turn)) continue;
    const empty = Math.max(0, capOf(r, lookup, t.feature) - r.stock);
    free += Math.max(0, empty - WAREHOUSE_FREE_EMPTY);
  }
  return Math.floor(free * 0.1);
}

export function supplierPrice(seed: number, turn: number, heatLevel: number): number {
  const rng = createRng(hashString(`${seed}:supplier:${turn}`));
  const drift = rng.int(-3, 4);
  let price = 10 + drift;
  if (heatLevel >= 60) price = Math.ceil(price * 1.5);
  return Math.max(4, price);
}

export function shipmentSeizureChance(
  heatLevel: number,
  bribes: { mayor: { isActive: boolean }; chiefs: { isActive: boolean } },
): number {
  let p = 0.06;
  if (heatLevel > 50) p += 0.1;
  if (bribes.mayor.isActive) p *= 0.4;
  else if (bribes.chiefs.isActive) p *= 0.6;
  return Math.min(0.5, p);
}

export function stashRaidChance(
  crates: number,
  heatLevel: number,
  unguarded: boolean,
  bribes: { mayor: { isActive: boolean }; chiefs: { isActive: boolean } },
  raidMult = 1,
): number {
  let p = 0.01 + crates / 2000 + Math.max(0, heatLevel - 40) / 400;
  if (unguarded) p *= 1.5;
  if (bribes.mayor.isActive) p *= 0.4;
  else if (bribes.chiefs.isActive) p *= 0.6;
  p *= raidMult;
  return Math.min(0.35, p);
}

/** Best (lowest) raidMult among warehouses in a district. */
export function districtRaidMult(t: Territory, lookup: ManagerLookup): number {
  let best = 1;
  for (const r of t.rackets) {
    if (r.type !== "warehouse") continue;
    const m = warehouseManagerMods(lookup(r)).raidMult;
    if (m < best) best = m;
  }
  return best;
}

export interface ShipmentProcessResult {
  pendingShipments: PendingShipment[];
  territories: Territory[];
  dirtyDelta: number;
  heatDelta: number;
  logs: TurnLogEntry[];
  ledger: Partial<LiquorLedger>;
}

export function processShipments(
  state: GameState,
  rng: Rng,
): ShipmentProcessResult {
  const logs: TurnLogEntry[] = [];
  let dirtyDelta = 0;
  let heatDelta = 0;
  let territories = state.territories;
  const remaining: PendingShipment[] = [];
  const ledger: Partial<LiquorLedger> = {
    bought: 0,
    seized: 0,
    cashIn: 0,
    heat: 0,
  };
  const lookup = makeManagerLookup(state.crew, state.playerFamily);

  const bribes = {
    mayor: state.bribes.mayor,
    chiefs: state.bribes.chiefs,
  };
  const seizeP = shipmentSeizureChance(state.heat.level, bribes);

  for (const ship of state.pendingShipments ?? []) {
    if (ship.arriveTurn > state.turn) {
      remaining.push(ship);
      continue;
    }

    const dest = territories.find((t) => t.id === ship.destTerritoryId);
    if (!dest || dest.owner !== state.playerFamily) {
      logs.push({
        id: `log_ship_lost_${ship.id}`,
        turn: state.turn,
        category: "delivery",
        text: `Shipment of ${ship.crates} crates had nowhere to land — lost.`,
        family: state.playerFamily ?? undefined,
      });
      ledger.seized = (ledger.seized ?? 0) + ship.crates;
      continue;
    }

    if (rng.chance(seizeP)) {
      heatDelta += 4;
      ledger.seized = (ledger.seized ?? 0) + ship.crates;
      ledger.heat = (ledger.heat ?? 0) + 4;
      logs.push({
        id: `log_ship_seize_${ship.id}`,
        turn: state.turn,
        category: "delivery",
        text: `Police seized a ${ship.crates}-crate whisky shipment bound for ${dest.name}.`,
        family: state.playerFamily ?? undefined,
      });
      continue;
    }

    const dep = depositCrates(dest, ship.crates, "warehouse", state.turn, lookup);
    territories = territories.map((t) =>
      t.id === dest.id ? dep.territory : t,
    );
    ledger.bought = (ledger.bought ?? 0) + dep.moved;
    if (dep.overflow > 0) {
      const street = dep.overflow * (12 + rng.int(0, 8));
      dirtyDelta += street;
      ledger.cashIn = (ledger.cashIn ?? 0) + street;
      logs.push({
        id: `log_ship_overflow_${ship.id}`,
        turn: state.turn,
        category: "delivery",
        text: `${ship.crates} crates arrived in ${dest.name}; ${dep.overflow} sold on the street for $${street}.`,
        family: state.playerFamily ?? undefined,
      });
    } else {
      logs.push({
        id: `log_ship_ok_${ship.id}`,
        turn: state.turn,
        category: "delivery",
        text: `${ship.crates} crates of whisky landed in ${dest.name}.`,
        family: state.playerFamily ?? undefined,
      });
    }
  }

  return { pendingShipments: remaining, territories, dirtyDelta, heatDelta, logs, ledger };
}

export interface StashRaidResult {
  territories: Territory[];
  heatDelta: number;
  logs: TurnLogEntry[];
  ledger: Partial<LiquorLedger>;
  crew: CrewMember[];
}

export function processStashRaids(
  state: GameState,
  rng: Rng,
): StashRaidResult {
  const logs: TurnLogEntry[] = [];
  let heatDelta = 0;
  let territories = state.territories;
  const ledger: Partial<LiquorLedger> = { seized: 0, heat: 0 };

  if (!state.playerFamily) {
    return { territories, heatDelta, logs, ledger, crew: state.crew };
  }

  const lookup = makeManagerLookup(state.crew, state.playerFamily);
  const activeIds = new Set(
    state.crew.filter((c) => c.status === "active").map((c) => c.id),
  );
  const bribes = {
    mayor: state.bribes.mayor,
    chiefs: state.bribes.chiefs,
  };

  type Candidate = { t: Territory; crates: number; unguarded: boolean; p: number };
  const candidates: Candidate[] = [];
  for (const t of territories) {
    if (t.owner !== state.playerFamily) continue;
    const { stored } = districtStorage(t, state.turn, lookup);
    if (stored <= 0) continue;
    const unguarded = isUnguarded(t, activeIds);
    const raidMult = districtRaidMult(t, lookup);
    const hide = hasSafehouse(t, state.turn) ? 0.6 : 1;
    const p =
      stashRaidChance(
        stored,
        state.heat.level,
        unguarded,
        bribes,
        raidMult,
      ) * hide;
    candidates.push({ t, crates: stored, unguarded, p });
  }
  if (candidates.length === 0) {
    return { territories, heatDelta, logs, ledger, crew: state.crew };
  }

  const totalW = candidates.reduce((s, c) => s + c.crates, 0);
  let roll = rng.int(1, Math.max(1, totalW));
  let pick = candidates[0]!;
  for (const c of candidates) {
    roll -= c.crates;
    if (roll <= 0) {
      pick = c;
      break;
    }
  }

  if (!rng.chance(pick.p)) {
    return { territories, heatDelta, logs, ledger, crew: state.crew };
  }

  const seize = Math.ceil(pick.crates * 0.5);
  const wd = withdrawCrates(pick.t, seize, state.turn);
  heatDelta += 6;
  ledger.seized = seize;
  ledger.heat = 6;

  territories = territories.map((t) => {
    if (t.id !== pick.t.id) return t;
    return {
      ...wd.territory,
      rackets: wd.territory.rackets.map((r) =>
        r.type === "warehouse"
          ? { ...r, frozenUntil: state.turn + 1 }
          : r,
      ),
    };
  });

  logs.push({
    id: `log_raid_${state.turn}_${pick.t.id}`,
    turn: state.turn,
    category: "heat",
    text: `Treasury raid on ${pick.t.name}: ${wd.moved} crates seized; warehouses frozen 1 turn.`,
    family: state.playerFamily,
  });

  let crew = state.crew;
  const frozenManagers = new Set<string>();
  for (const r of pick.t.rackets) {
    if (r.type === "warehouse" && r.managerId && (r.frozenUntil ?? 0) <= state.turn) {
      frozenManagers.add(r.managerId);
    }
  }
  for (const id of frozenManagers) {
    const hit = penalizeRacketFreeze(crew, id, state.turn, state.playerFamily, id);
    crew = hit.crew;
    logs.push(...hit.logs);
  }

  return { territories, heatDelta, logs, ledger, crew };
}

/**
 * Apply event crate delta.
 * Positive: prefer managed warehouse districts (largest free capacity).
 * Negative: withdraw across districts (warehouses first).
 */
export function applyCrateEffect(
  state: GameState,
  delta: number,
  rng: Rng,
): { territories: Territory[]; dirtyDelta: number; log?: TurnLogEntry; moved: number } {
  if (!state.playerFamily || delta === 0) {
    return { territories: state.territories, dirtyDelta: 0, moved: 0 };
  }

  const lookup = makeManagerLookup(state.crew, state.playerFamily);
  let territories = state.territories;
  let dirtyDelta = 0;

  if (delta > 0) {
    const owned = territories.filter((t) => t.owner === state.playerFamily);
    const best = [...owned].sort((a, b) => {
      const aManaged = hasManagedWarehouse(a, lookup, state.turn) ? 1 : 0;
      const bManaged = hasManagedWarehouse(b, lookup, state.turn) ? 1 : 0;
      if (bManaged !== aManaged) return bManaged - aManaged;
      const aw = districtStorage(a, state.turn, lookup).free;
      const bw = districtStorage(b, state.turn, lookup).free;
      return bw - aw;
    })[0];
    if (!best) return { territories, dirtyDelta: 0, moved: 0 };
    const dep = depositCrates(best, delta, "warehouse", state.turn, lookup);
    territories = territories.map((t) => (t.id === best.id ? dep.territory : t));
    if (dep.overflow > 0) {
      dirtyDelta += dep.overflow * (12 + rng.int(0, 8));
    }
    return {
      territories,
      dirtyDelta,
      moved: dep.moved,
      log: {
        id: `log_evt_crates_${state.turn}`,
        turn: state.turn,
        category: "event",
        text: `Event: +${dep.moved} crates into ${best.name}${dep.overflow ? `; ${dep.overflow} street-sold` : ""}.`,
        family: state.playerFamily,
      },
    };
  }

  let remaining = -delta;
  for (const t of territories) {
    if (remaining <= 0) break;
    if (t.owner !== state.playerFamily) continue;
    const wd = withdrawCrates(t, remaining, state.turn);
    remaining -= wd.moved;
    territories = territories.map((x) => (x.id === t.id ? wd.territory : x));
  }
  const burned = -delta - remaining;
  return {
    territories,
    dirtyDelta: 0,
    moved: burned,
    log: {
      id: `log_evt_burn_${state.turn}`,
      turn: state.turn,
      category: "event",
      text: `Event: burned ${burned} crates of liquor stock.`,
      family: state.playerFamily,
    },
  };
}

export function mergeLedger(
  base: LiquorLedger,
  patch: Partial<LiquorLedger>,
): LiquorLedger {
  return {
    produced: base.produced + (patch.produced ?? 0),
    bought: base.bought + (patch.bought ?? 0),
    sold: base.sold + (patch.sold ?? 0),
    delivered: base.delivered + (patch.delivered ?? 0),
    dumped: base.dumped + (patch.dumped ?? 0),
    stolen: base.stolen + (patch.stolen ?? 0),
    seized: base.seized + (patch.seized ?? 0),
    shrunk: (base.shrunk ?? 0) + (patch.shrunk ?? 0),
    cashIn: base.cashIn + (patch.cashIn ?? 0),
    cashOut: base.cashOut + (patch.cashOut ?? 0),
    heat: base.heat + (patch.heat ?? 0),
  };
}

export function liquorLedgerLog(
  ledger: LiquorLedger,
  turn: number,
  family: FamilyName,
): TurnLogEntry {
  const net = ledger.cashIn - ledger.cashOut;
  const losses =
    ledger.dumped + ledger.stolen + ledger.seized + (ledger.shrunk ?? 0);
  const pilfer =
    (ledger.shrunk ?? 0) > 0
      ? `; ${ledger.shrunk} crates walked out the back`
      : "";
  return {
    id: `log_liquor_${turn}`,
    turn,
    category: "economy",
    text: `Liquor: ${net >= 0 ? "+" : ""}$${net} from ${ledger.sold} crates sold${losses > 0 ? `, −${losses} crates lost` : ""}${pilfer}${ledger.heat > 0 ? `, +${ledger.heat} heat` : ""}.`,
    family,
  };
}

/** Label helper for dump warnings. */
export function dumpWarning(districtName: string, dumped: number): string {
  return `Still in ${districtName} backed up — dumped ${dumped} crates. Build or upgrade a warehouse.`;
}

export function storageLabel(type: RacketType): string {
  return RACKET_LABELS[type] ?? type;
}
