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

const SPEAKEASY_BASE_INCOME = 280;

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

function capOf(r: Racket, lookup?: ManagerLookup): number {
  return stockCap(r, lookup?.(r));
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
    const c = capOf(r, lookup);
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
    return withdrawCrates(t, 1_000_000, state.turn).moved > 0;
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
    const stock = withdrawCrates(source, 1_000_000, state.turn).moved;
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
      const free = Math.max(0, capOf(r, lookup) - r.stock);
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
      const take = Math.min(r.stock, remaining);
      r.stock -= take;
      remaining -= take;
    }
  }

  return {
    territory: { ...t, rackets },
    moved: n - remaining,
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
  const rackets = t.rackets.map((r) => {
    if (r.type !== "warehouse" || frozen(r, turn) || r.stock <= 0) return r;
    const mgr = lookup(r);
    const mods = warehouseManagerMods(mgr);
    if (mods.shrinkRate <= 0) return r;
    const lost = Math.max(1, Math.ceil(r.stock * mods.shrinkRate));
    const take = Math.min(r.stock, lost);
    shrunk += take;
    byRacket.push({
      racketId: r.id,
      lost: take,
      cause: mods.managed
        ? `weak manager: ${mgr?.name ?? "unknown"}`
        : "no manager",
    });
    return { ...r, stock: r.stock - take };
  });
  return { territory: { ...t, rackets }, shrunk, byRacket };
}

export function productionOutput(racket: Racket): number {
  if (racket.type === "still") return 5 + racket.level * 3;
  if (racket.type === "brewery") return 8 + racket.level * 4;
  return 0;
}

/**
 * Produce into stills/breweries; spill overflow into same-district warehouses.
 * Leftover is dumped ($4/crate + heat).
 */
export function produceAndStore(
  t: Territory,
  turn = 0,
  lookup?: ManagerLookup,
): {
  territory: Territory;
  produced: number;
  dumped: number;
  dumpCash: number;
  dumpHeat: number;
  backedUp: boolean;
} {
  let produced = 0;
  let spill = 0;
  let rackets = t.rackets.map((r) => {
    if (!isProducerType(r.type)) return r;
    const out = productionOutput(r);
    produced += out;
    const cap = stockCap(r);
    const room = Math.max(0, cap - r.stock);
    const kept = Math.min(out, room);
    spill += out - kept;
    return { ...r, stock: r.stock + kept };
  });

  let territory: Territory = { ...t, rackets };
  let dumped = 0;
  if (spill > 0) {
    const dep = depositCrates(territory, spill, "warehouse", turn, lookup);
    territory = dep.territory;
    dumped = dep.overflow;
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
    for (const type of ["warehouse", "still", "brewery"] as RacketType[]) {
      if (remaining <= 0) break;
      for (const r of rackets) {
        if (r.type !== type) continue;
        if (type === "warehouse" && frozen(r, turn)) continue;
        if (r.stock <= 0) continue;
        const take = Math.min(r.stock, remaining);
        r.stock -= take;
        remaining -= take;
      }
    }
    const got = need - remaining;
    for (const r of rackets) {
      if (r.id === speak.id) r.stock += got;
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
): {
  territory: Territory;
  revenue: number;
  dirtyRevenue: number;
  sold: number;
  dryCount: number;
} {
  let revenue = 0;
  let dirtyRevenue = 0;
  let sold = 0;
  let dryCount = 0;

  const rackets = territory.rackets.map((r) => {
    if (r.type !== "speakeasy") return r;
    const base = Math.floor(SPEAKEASY_BASE_INCOME * r.level * (1 + incomeBonus));
    if (r.stock <= 0) {
      dryCount += 1;
      dirtyRevenue += Math.floor(base * 0.25);
      return r;
    }
    const amount = Math.min(r.stock, 5 + r.level * 2);
    const price = 15 + r.level * 5;
    dirtyRevenue += amount * price;
    revenue += Math.floor(amount * price * 0.3);
    dirtyRevenue += Math.floor(base * 0.7);
    revenue += Math.floor(base * 0.3);
    sold += amount;
    return { ...r, stock: r.stock - amount };
  });

  if (territory.owner === family) {
    revenue += Math.floor(territory.baseIncome * (1 + incomeBonus) * 0.1);
  }

  return {
    territory: { ...territory, rackets },
    revenue,
    dirtyRevenue,
    sold,
    dryCount,
  };
}

/** Passive heat from oversized stashes. Allowance 50 crates. Doubled if unguarded. */
export function stashHeat(
  t: Territory,
  unguarded: boolean,
  turn = 0,
  lookup?: ManagerLookup,
): number {
  const { stored } = districtStorage(t, turn, lookup);
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
    free += Math.max(0, capOf(r, lookup) - r.stock);
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
    return { territories, heatDelta, logs, ledger };
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
    return { territories, heatDelta, logs, ledger };
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
    return { territories, heatDelta, logs, ledger };
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

  return { territories, heatDelta, logs, ledger };
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
