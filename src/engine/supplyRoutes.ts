/**
 * Supply routes: standing liquor orders between the player's districts.
 *
 * A route picks a path across the map. Every district it crosses is a hop
 * with a hijack chance that depends on who owns it, how many men are on the
 * block (known only with intel), and how hot the street is. Crossing another
 * family's turf needs a passage deal from a sit-down; without one the run is
 * "hot" — their men tax the truck, hijack odds climb, and the offence is
 * remembered.
 *
 * Every turn each active route withdraws crates at the source, rolls the
 * road, and lands what's left in the destination's warehouse or speakeasy.
 */
import type {
  DeliveryRoute,
  FamilyName,
  GameState,
  LiquorLedger,
  RouteHop,
  RouteHopKind,
  RouteOption,
  RouteRiskLabel,
  RouteStrategy,
  SupplyRoute,
  Territory,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { assignCrew } from "./crew";
import { crewPresentIn } from "./crewLocation";
import { hasActiveIntel } from "./intel";
import {
  depositCrates,
  emptyLiquorLedger,
  makeManagerLookup,
  mergeLedger,
  withdrawCrates,
} from "./liquor";
import { addEvidence, makeEvidence, openIncidentFromHijack } from "./incidents";
import { getRelation, setRelationDelta, statusFromScore } from "./relations";
import {
  CRATE_STREET_VALUE,
  activeDeal,
  addPassageGrudge,
  breachDeal,
  familiesOnPath,
  hasLeverage,
} from "./passage";
import { proposePassageSitdown } from "./sitdowns";

/* ------------------------------------------------------------------ */
/* Per-hop risk                                                        */
/* ------------------------------------------------------------------ */

const HOP_BASE: Record<RouteHopKind, number> = {
  own: 0.01,
  unclaimed: 0.04,
  deal: 0.03,
  rival: 0.1,
  hostile: 0.16,
};
/** Each rival man on the block adds this much. */
const GARRISON_HOP = 0.02;
/** How many men we assume on an uncased rival block. */
const UNKNOWN_GARRISON = 2;
const UNKNOWN_GARRISON_MAX = 4;

type RiskState = Pick<
  GameState,
  "territories" | "crew" | "routes" | "operations" | "playerFamily" | "turn" | "intel" | "relations" | "passageDeals" | "supplyRoutes" | "passageLeverage"
> & Partial<Pick<GameState, "incidents">>;

function hopKind(state: RiskState, t: Territory, family: FamilyName): RouteHopKind {
  if (!t.owner) return "unclaimed";
  if (t.owner === family) return "own";
  if (activeDeal(state as GameState, t.owner)) return "deal";
  const status = statusFromScore(getRelation(state.relations, family, t.owner));
  return status === "war" || status === "hostile" ? "hostile" : "rival";
}

export function assessHop(state: RiskState, territoryId: string, family: FamilyName): RouteHop {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t) {
    return { territoryId, owner: null, kind: "unclaimed", risk: 0.04, riskMin: 0.04, riskMax: 0.04, known: true };
  }
  const kind = hopKind(state, t, family);
  const heat = (t.heatLevel ?? 0) * 0.003;
  let risk = HOP_BASE[kind] + heat;
  let riskMin = risk;
  let riskMax = risk;
  let known = true;

  if (kind === "rival" || kind === "hostile" || kind === "deal") {
    risk += t.defenseBonus * 0.5;
    riskMin = risk;
    riskMax = risk;
    const owner = t.owner!;
    const seen = family === state.playerFamily ? hasActiveIntel(state as GameState, territoryId) : true;
    if (seen) {
      const men = crewPresentIn(state as GameState, territoryId).filter((c) => c.family === owner).length;
      const add = kind === "deal" ? men * GARRISON_HOP * 0.25 : men * GARRISON_HOP;
      risk += add;
      riskMin = risk;
      riskMax = risk;
    } else {
      known = false;
      const scale = kind === "deal" ? 0.25 : 1;
      riskMin = risk;
      riskMax = risk + UNKNOWN_GARRISON_MAX * GARRISON_HOP * scale;
      risk += UNKNOWN_GARRISON * GARRISON_HOP * scale;
    }
  }
  const clamp = (n: number) => Math.max(0, Math.min(0.5, n));
  return { territoryId, owner: t.owner, kind, risk: clamp(risk), riskMin: clamp(riskMin), riskMax: clamp(riskMax), known };
}

function combine(hops: RouteHop[], pick: (h: RouteHop) => number): number {
  let safe = 1;
  for (const h of hops) safe *= 1 - pick(h);
  return 1 - safe;
}

/** Driver and escort take the edge off. */
function crewMult(state: Pick<GameState, "crew">, driverId?: string, escortId?: string): number {
  let mult = 1;
  const driver = driverId ? state.crew.find((c) => c.id === driverId) : undefined;
  if (driver) {
    mult *= 1 - Math.min(0.35, driver.skills.driving / 250);
    if (driver.traits.includes("wheelman")) mult *= 0.85;
  }
  if (escortId) mult *= 0.75;
  return mult;
}

export function labelFor(hops: RouteHop[], needsDeal: FamilyName[]): RouteRiskLabel {
  if (needsDeal.length > 0) return "hot";
  if (hops.some((h) => h.kind === "deal")) return "toll";
  return "safe";
}

/** Everything the UI needs about one path. */
export function assessPath(
  state: RiskState,
  path: string[],
  family: FamilyName,
  driverId?: string,
  escortId?: string,
  strategies: RouteStrategy[] = [],
  dodges?: FamilyName,
): RouteOption {
  // The source block is ours and the truck is loading, not on the road.
  const road = path.slice(1);
  const hops = road.map((tid) => assessHop(state, tid, family));
  const mult = crewMult(state, driverId, escortId);
  const clamp = (n: number) => Math.max(0.02, Math.min(0.75, n));
  const families = familiesOnPath(state, path, family);
  const needsDeal = families.filter((f) => !activeDeal(state as GameState, f));
  return {
    id: path.join(">"),
    path,
    hops,
    strategies,
    dodges,
    risk: clamp(combine(hops, (h) => h.risk) * mult),
    riskMin: clamp(combine(hops, (h) => h.riskMin) * mult),
    riskMax: clamp(combine(hops, (h) => h.riskMax) * mult),
    families,
    needsDeal,
    label: labelFor(hops, needsDeal),
  };
}

/* ------------------------------------------------------------------ */
/* Path search                                                         */
/* ------------------------------------------------------------------ */

/**
 * Cheapest road from A to B under a per-hop cost. `Infinity` bars a block.
 * The destination is always enterable; the cost applies to the block being
 * entered. Plain Dijkstra — the map is a few dozen districts.
 */
function cheapestRoad(
  territories: Territory[],
  sourceId: string,
  destId: string,
  cost: (t: Territory) => number,
): string[] | null {
  const byId = new Map(territories.map((t) => [t.id, t]));
  if (!byId.has(sourceId) || !byId.has(destId)) return null;
  if (sourceId === destId) return [sourceId];
  const dist = new Map<string, number>([[sourceId, 0]]);
  const parent = new Map<string, string>();
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur === null) return null;
    if (cur === destId) break;
    done.add(cur);
    for (const adj of byId.get(cur)!.adjacentTerritories) {
      const t = byId.get(adj);
      if (!t || done.has(adj)) continue;
      const step = adj === destId ? 1 : cost(t);
      if (!Number.isFinite(step)) continue;
      const nd = best + step;
      if (nd < (dist.get(adj) ?? Infinity)) {
        dist.set(adj, nd);
        parent.set(adj, cur);
      }
    }
  }
  const path = [destId];
  let p = destId;
  while (parent.has(p)) {
    p = parent.get(p)!;
    path.unshift(p);
  }
  return path;
}

export const STRATEGY_LABEL: Record<RouteStrategy, string> = {
  direct: "Direct",
  home_turf: "Home turf",
  toll_road: "Toll road",
  cold_road: "Cold road",
  dodge: "Dodge",
  detour: "Detour",
};

/** Fixed order for the strategy picker, so the chips never shuffle. */
export const STRATEGY_ORDER: RouteStrategy[] = ["direct", "home_turf", "toll_road", "cold_road", "dodge", "detour"];

/** Chip label; `dodge` names the family it goes around. */
export function strategyChipLabel(strategy: RouteStrategy, dodges?: FamilyName): string {
  return strategy === "dodge" && dodges ? `Dodge ${dodges}` : STRATEGY_LABEL[strategy];
}

/**
 * Why a strategy isn't on offer between these two districts, for the greyed
 * chip. `undefined` when some road carries it.
 */
export function strategyUnavailableReason(
  strategy: RouteStrategy,
  options: Pick<RouteOption, "strategies" | "path">[],
  state: RiskState,
  family: FamilyName,
): string | undefined {
  if (options.some((o) => o.strategies.includes(strategy))) return undefined;
  if (options.length === 0) return "No road connects these districts";
  switch (strategy) {
    case "direct":
    case "cold_road":
      return "No road here";
    case "home_turf":
      return "No road stays on your turf";
    case "toll_road":
      return "No road crosses only families you've paid";
    case "dodge":
      return threatFamily(state, family)
        ? `Every road runs through ${threatFamily(state, family)}`
        : "Nobody to dodge right now";
    case "detour":
      return options.length === 1
        ? "Only one road between these districts"
        : "Every other road shares blocks with Direct";
  }
}

/** One line on why you'd take this road. `dodge` fills in the family. */
export function strategyBlurb(strategy: RouteStrategy, dodges?: FamilyName): string {
  switch (strategy) {
    case "direct":
      return "Fewest hops, whatever the turf. Fast, and exposed.";
    case "home_turf":
      return "Never leaves your blocks. No tolls, no grudges, your garrisons cover it.";
    case "toll_road":
      return "Passage you've paid for. Predictable cost; their men wave you through.";
    case "cold_road":
      return "Stays off hot streets. Less police on the kerb.";
    case "dodge":
      return `Goes around ${dodges ?? "the family"} — the ones most likely to hit the truck.`;
    case "detour":
      return "A different road from Direct. Somewhere to send the truck when the usual way is watched.";
  }
}

/** Card title: every strategy that agreed on this road. */
export function strategyTitle(option: Pick<RouteOption, "strategies" | "dodges">): string {
  return option.strategies
    .map((s) => (s === "dodge" && option.dodges ? `Dodge ${option.dodges}` : STRATEGY_LABEL[s]))
    .join(" · ");
}

/** How far back a hijack case still colours which road to take. */
const THREAT_MEMORY_TURNS = 8;
const THREAT_SUSPECT_MIN = 0.4;

/**
 * The family most likely to hit a truck: the one you're at war with (or
 * hostile), else the top suspect on a recent hijack case. Uses only what the
 * player can see.
 */
export function threatFamily(state: RiskState, family: FamilyName): FamilyName | undefined {
  const owners = new Set(state.territories.map((t) => t.owner).filter((o): o is FamilyName => !!o && o !== family));
  let worst: { f: FamilyName; rel: number } | undefined;
  for (const f of owners) {
    const rel = getRelation(state.relations, family, f);
    const status = statusFromScore(rel);
    if (status !== "war" && status !== "hostile") continue;
    if (!worst || rel < worst.rel) worst = { f, rel };
  }
  if (worst) return worst.f;

  const recent = (state.incidents ?? [])
    .filter((i) => i.kind === "hijack" && i.turn >= state.turn - THREAT_MEMORY_TURNS && !i.answeredTurn)
    .sort((a, b) => b.turn - a.turn);
  for (const inc of recent) {
    const top = (Object.entries(inc.suspects) as [FamilyName, number][])
      .filter(([f, p]) => f !== family && p >= THREAT_SUSPECT_MIN && owners.has(f))
      .sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
  }
  return undefined;
}

/**
 * The roads from A to B, each with the strategies that produced it.
 * Every strategy picks the cheapest road under its own idea of cost; roads
 * that several strategies agree on carry all their labels, so a single road
 * still tells you what it is ("Direct · Home turf").
 */
export function routeOptions(
  state: RiskState,
  sourceId: string,
  destId: string,
  family: FamilyName,
  driverId?: string,
  escortId?: string,
): RouteOption[] {
  const ts = state.territories;
  const own = (t: Territory) => !t.owner || t.owner === family;
  const hasDeal = (t: Territory) => !!t.owner && !!activeDeal(state as GameState, t.owner);
  const threat = threatFamily(state, family);

  const direct = cheapestRoad(ts, sourceId, destId, () => 1);
  const directMiddle = new Set(direct ? direct.slice(1, -1) : []);

  const plans: Array<{ strategy: RouteStrategy; cost: (t: Territory) => number; skip?: boolean }> = [
    { strategy: "direct", cost: () => 1 },
    { strategy: "home_turf", cost: (t) => (!t.owner ? 2 : t.owner === family ? 1 : Infinity) },
    {
      strategy: "toll_road",
      cost: (t) => (!t.owner ? 2 : t.owner === family ? 1 : hasDeal(t) ? 1.5 : Infinity),
    },
    { strategy: "cold_road", cost: (t) => 1 + (t.heatLevel ?? 0) / 5 },
    { strategy: "dodge", cost: (t) => (t.owner === threat ? Infinity : 1), skip: !threat },
    {
      strategy: "detour",
      cost: (t) => (directMiddle.has(t.id) ? Infinity : 1),
      skip: !direct || directMiddle.size === 0,
    },
  ];

  const byKey = new Map<string, { path: string[]; strategies: RouteStrategy[] }>();
  for (const plan of plans) {
    if (plan.skip) continue;
    const path = cheapestRoad(ts, sourceId, destId, plan.cost);
    if (!path || path.length < 2) continue;
    // Detour only counts when it really is a different road.
    if (plan.strategy === "detour" && direct && path.join(">") === direct.join(">")) continue;
    const key = path.join(">");
    const hit = byKey.get(key);
    if (hit) hit.strategies.push(plan.strategy);
    else byKey.set(key, { path, strategies: [plan.strategy] });
  }

  const out = [...byKey.values()].map((o) =>
    assessPath(
      state,
      o.path,
      family,
      driverId,
      escortId,
      o.strategies,
      o.strategies.includes("dodge") ? threat : undefined,
    ),
  );
  // Every strategy that found a road keeps it, so the picker's chips are
  // honest: six strategies, at most six roads.
  out.sort((a, b) => a.risk - b.risk || a.path.length - b.path.length);
  return out;
}

/* ------------------------------------------------------------------ */
/* Establish / manage                                                  */
/* ------------------------------------------------------------------ */

export interface EstablishResult {
  state: GameState;
  route?: SupplyRoute;
  logs: TurnLogEntry[];
  error?: string;
}

/**
 * Open a standing order. Families on the path without a deal get a passage
 * sit-down in two weeks; the route waits on them unless `runHot`.
 */
export function establishSupplyRoute(
  state: GameState,
  args: {
    sourceTerritoryId: string;
    destTerritoryId: string;
    path: string[];
    cratesPerTurn: number;
    driverId: string;
    escortId?: string;
    runHot: boolean;
  },
  rng: Rng,
): EstablishResult {
  const player = state.playerFamily;
  const fail = (error: string): EstablishResult => ({ state, logs: [], error });
  if (!player) return fail("No family.");
  const src = state.territories.find((t) => t.id === args.sourceTerritoryId);
  const dest = state.territories.find((t) => t.id === args.destTerritoryId);
  if (!src || src.owner !== player) return fail("Source must be your district.");
  if (!dest || dest.owner !== player) return fail("Destination must be your district.");
  if (src.id === dest.id) return fail("Pick two different districts.");
  if (!dest.rackets.some((r) => r.type === "warehouse" || r.type === "speakeasy")) {
    return fail("Destination needs a warehouse or a speakeasy to take crates.");
  }
  if (args.cratesPerTurn < 1) return fail("Need at least one crate a week.");
  if (args.path[0] !== src.id || args.path[args.path.length - 1] !== dest.id) {
    return fail("That road doesn't run between those districts.");
  }
  const driver = state.crew.find((c) => c.id === args.driverId);
  if (!driver || driver.family !== player || driver.status !== "active") return fail("Pick a driver.");
  if (driver.assignment.type !== "idle" && driver.assignment.type !== "garrison") {
    return fail(`${driver.name} is busy.`);
  }
  if (args.escortId) {
    const escort = state.crew.find((c) => c.id === args.escortId);
    if (!escort || escort.family !== player || escort.status !== "active") return fail("Pick an escort.");
    if (escort.id === driver.id) return fail("The driver can't ride shotgun on himself.");
    if (escort.assignment.type !== "idle" && escort.assignment.type !== "garrison") {
      return fail(`${escort.name} is busy.`);
    }
  }

  const needsDeal = familiesOnPath(state, args.path, player).filter((f) => !activeDeal(state, f));
  const route: SupplyRoute = {
    id: `supply_${state.turn}_${rng.int(1000, 9999)}`,
    family: player,
    sourceTerritoryId: src.id,
    destTerritoryId: dest.id,
    path: args.path,
    cratesPerTurn: Math.floor(args.cratesPerTurn),
    driverId: driver.id,
    escortId: args.escortId,
    status: needsDeal.length > 0 && !args.runHot ? "negotiating" : "active",
    sinceTurn: state.turn,
    awaitingFamilies: needsDeal,
    runHot: args.runHot,
  };

  let crew = assignCrew(state.crew, driver.id, {
    type: "delivery",
    routeId: route.id,
    territoryId: src.id,
  });
  if (args.escortId) {
    crew = assignCrew(crew, args.escortId, {
      type: "delivery",
      routeId: route.id,
      territoryId: src.id,
    });
  }
  let next: GameState = { ...state, crew, supplyRoutes: [...(state.supplyRoutes ?? []), route] };
  const logs: TurnLogEntry[] = [
    {
      id: `log_supply_open_${route.id}`,
      turn: state.turn,
      category: "delivery",
      text: `Supply route opened: ${route.cratesPerTurn} crates a week, ${src.name} → ${dest.name}${
        needsDeal.length ? ` (crosses ${needsDeal.join(", ")})` : ""
      }.`,
      family: player,
    },
  ];
  for (const f of needsDeal) {
    const ask = proposePassageSitdown(next, f, route.id, rng);
    next = ask.state;
    if (ask.log) logs.push(ask.log);
  }
  return { state: next, route, logs };
}

function freeRouteCrew(state: GameState, route: SupplyRoute): GameState {
  const ids = [route.driverId, route.escortId].filter((x): x is string => !!x);
  const crew = state.crew.map((c) =>
    ids.includes(c.id) && c.assignment.type === "delivery" && c.assignment.routeId === route.id
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );
  return { ...state, crew };
}

export function cancelSupplyRoute(state: GameState, id: string): GameState {
  const route = (state.supplyRoutes ?? []).find((r) => r.id === id);
  if (!route) return state;
  const freed = freeRouteCrew(state, route);
  return { ...freed, supplyRoutes: freed.supplyRoutes.filter((r) => r.id !== id) };
}

export function toggleSupplyRoute(state: GameState, id: string): GameState {
  return {
    ...state,
    supplyRoutes: (state.supplyRoutes ?? []).map((r) => {
      if (r.id !== id) return r;
      if (r.status === "suspended") {
        return {
          ...r,
          status: r.awaitingFamilies.length > 0 && !r.runHot ? "negotiating" : "active",
          suspendedReason: undefined,
        };
      }
      return { ...r, status: "suspended", suspendedReason: "Held by you" };
    }),
  };
}

/** Let a waiting route roll without the deal (or stop it rolling hot). */
export function setRouteRunHot(state: GameState, id: string, runHot: boolean): GameState {
  return {
    ...state,
    supplyRoutes: (state.supplyRoutes ?? []).map((r) => {
      if (r.id !== id) return r;
      const status =
        r.status === "suspended"
          ? r.status
          : runHot || r.awaitingFamilies.length === 0
            ? "active"
            : "negotiating";
      return { ...r, runHot, status };
    }),
  };
}

/** Ask the family to the table again for a route that's waiting. */
export function reopenPassageTalks(
  state: GameState,
  routeId: string,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const route = (state.supplyRoutes ?? []).find((r) => r.id === routeId);
  if (!route) return { state, logs: [] };
  let next = state;
  const logs: TurnLogEntry[] = [];
  const need = familiesOnPath(state, route.path, route.family).filter((f) => !activeDeal(state, f));
  next = {
    ...next,
    supplyRoutes: next.supplyRoutes.map((r) =>
      r.id === routeId
        ? {
            ...r,
            awaitingFamilies: need,
            status: r.status === "suspended" ? (need.length && !r.runHot ? "negotiating" : "active") : r.status,
            suspendedReason: undefined,
          }
        : r,
    ),
  };
  for (const f of need) {
    const ask = proposePassageSitdown(next, f, routeId, rng);
    next = ask.state;
    if (ask.log) logs.push(ask.log);
  }
  return { state: next, logs };
}

/* ------------------------------------------------------------------ */
/* The weekly run                                                      */
/* ------------------------------------------------------------------ */

export interface SupplyRunResult {
  state: GameState;
  logs: TurnLogEntry[];
  ledger: LiquorLedger;
  heatDelta: number;
}

function payDirtyFirst(state: GameState, amount: number): { state: GameState; paid: boolean } {
  if (amount <= 0) return { state, paid: true };
  const dirty = Math.min(Math.max(0, state.dirtyMoney), amount);
  const clean = amount - dirty;
  if (clean > Math.max(0, state.money)) return { state, paid: false };
  return { state: { ...state, dirtyMoney: state.dirtyMoney - dirty, money: state.money - clean }, paid: true };
}

function credit(state: GameState, family: FamilyName, amount: number): GameState {
  if (amount <= 0) return state;
  return {
    ...state,
    rivalTreasury: { ...state.rivalTreasury, [family]: (state.rivalTreasury?.[family] ?? 0) + amount },
  };
}

function markLast(
  state: GameState,
  routeId: string,
  last: SupplyRoute["last"],
  patch?: Partial<SupplyRoute>,
): GameState {
  return {
    ...state,
    supplyRoutes: state.supplyRoutes.map((r) => (r.id === routeId ? { ...r, ...patch, last } : r)),
  };
}

/**
 * Which family pulls the trigger. Hostile turf first, then rivals; a family
 * that sold you passage has little reason to break it, so on a toll road the
 * shooters are usually outsiders working the route.
 */
function pickHijacker(state: GameState, option: RouteOption, rng: Rng): FamilyName | undefined {
  const weights = new Map<FamilyName, number>();
  for (const h of option.hops) {
    if (!h.owner || h.owner === state.playerFamily) continue;
    const w = h.kind === "hostile" ? 3 : h.kind === "rival" ? 2 : 0.4;
    weights.set(h.owner, (weights.get(h.owner) ?? 0) + w);
  }
  const outsiders = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily && !weights.has(f));
  for (const f of outsiders) weights.set(f, 1 / Math.max(1, outsiders.length));
  if (weights.size === 0) return undefined;
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  for (const [f, w] of weights) {
    roll -= w;
    if (roll <= 0) return f;
  }
  return [...weights.keys()][0];
}

/**
 * Run every active player route for the week. Deals collect their tolls; hot
 * hops get the truck stopped; the road rolls for hijack and seizure; what's
 * left lands in the destination.
 */
export function processSupplyRoutes(state: GameState, rng: Rng): SupplyRunResult {
  const player = state.playerFamily;
  const logs: TurnLogEntry[] = [];
  let ledger: LiquorLedger = emptyLiquorLedger();
  let heatDelta = 0;
  if (!player || !(state.supplyRoutes ?? []).length) return { state, logs, ledger, heatDelta };

  let next = state;
  const lookup = makeManagerLookup(state.crew, player);
  const log = (id: string, text: string) =>
    logs.push({ id: `log_supply_${id}_${state.turn}`, turn: state.turn, category: "delivery", text, family: player });

  for (const route of [...(state.supplyRoutes ?? [])]) {
    if (route.family !== player) continue;
    const src = next.territories.find((t) => t.id === route.sourceTerritoryId);
    const dest = next.territories.find((t) => t.id === route.destTerritoryId);
    const srcName = src?.name ?? "the source";
    const destName = dest?.name ?? "the destination";

    if (!src || src.owner !== player || !dest || dest.owner !== player) {
      next = freeRouteCrew(next, route);
      next = markLast(
        next,
        route.id,
        { turn: state.turn, outcome: "waiting", text: "Lost an end of the road." },
        { status: "suspended", suspendedReason: "You no longer hold both districts" },
      );
      log(route.id, `Supply route ${srcName} → ${destName} suspended: you no longer hold both ends.`);
      continue;
    }

    if (route.status === "negotiating") {
      next = markLast(next, route.id, {
        turn: state.turn,
        outcome: "waiting",
        text: `Waiting on passage from ${route.awaitingFamilies.join(", ")}.`,
      });
      continue;
    }
    if (route.status !== "active") continue;

    const driver = next.crew.find((c) => c.id === route.driverId);
    if (!driver || driver.status !== "active") {
      next = markLast(next, route.id, {
        turn: state.turn,
        outcome: "no_driver",
        text: driver ? `${driver.name} can't drive this week.` : "No driver.",
      });
      continue;
    }
    const escort = route.escortId ? next.crew.find((c) => c.id === route.escortId) : undefined;
    const escortRides = !!escort && escort.status === "active";

    const wd = withdrawCrates(src, route.cratesPerTurn, state.turn);
    if (wd.moved <= 0) {
      next = markLast(next, route.id, {
        turn: state.turn,
        outcome: "no_stock",
        text: `${srcName} had nothing to load.`,
      });
      continue;
    }
    next = { ...next, territories: next.territories.map((t) => (t.id === src.id ? wd.territory : t)) };
    let cargo = wd.moved;

    // Tolls and taxes on the road.
    const option = assessPath(next, route.path, player, driver.id, escortRides ? escort!.id : undefined);
    let stoppedBy: FamilyName | undefined;
    const notes: string[] = [];
    for (const fam of option.families) {
      const deal = activeDeal(next, fam);
      if (deal) {
        const toll = Math.ceil(cargo * deal.terms.tollPerCrate);
        const cut = Math.floor(cargo * deal.terms.cratesCut);
        const paid = payDirtyFirst(next, toll);
        if (paid.paid) {
          next = credit(paid.state, fam, toll);
          ledger = mergeLedger(ledger, { cashOut: toll });
          next = {
            ...next,
            passageDeals: next.passageDeals.map((d) => (d.id === deal.id ? { ...d, missedTolls: 0 } : d)),
          };
          if (toll > 0) notes.push(`$${toll} toll to ${fam}`);
        } else {
          const missed = deal.missedTolls + 1;
          next = {
            ...next,
            passageDeals: next.passageDeals.map((d) => (d.id === deal.id ? { ...d, missedTolls: missed } : d)),
          };
          if (missed >= 2) {
            next = breachDeal(next, deal.id, "holder");
            log(`${route.id}_breach`, `You couldn't cover ${fam}'s toll twice running. The passage deal is dead and they know why.`);
          } else {
            next = { ...next, relations: setRelationDelta(next.relations, player, fam, -4) };
            notes.push(`${fam}'s toll went unpaid`);
          }
        }
        if (cut > 0) {
          cargo -= cut;
          next = credit(next, fam, cut * CRATE_STREET_VALUE);
          notes.push(`${cut} crate${cut === 1 ? "" : "s"} to ${fam}`);
        }
        continue;
      }

      // Hot: no deal with this family.
      const theirHops = option.hops.filter((h) => h.owner === fam).length;
      let stopChance = 0.3 + 0.1 * (theirHops - 1);
      if (hasLeverage(next, fam)) stopChance *= 0.5;
      const status = statusFromScore(getRelation(next.relations, player, fam));
      if (status === "war" || status === "hostile") stopChance *= 1.3;
      const scene = option.hops.find((h) => h.owner === fam)?.territoryId ?? route.path[1]!;
      if (rng.chance(Math.min(0.85, stopChance))) {
        const take = Math.max(1, Math.ceil(cargo * (0.15 + rng.next() * 0.15)));
        cargo = Math.max(0, cargo - take);
        stoppedBy = fam;
        next = credit(next, fam, take * CRATE_STREET_VALUE);
        next = { ...next, relations: setRelationDelta(next.relations, player, fam, -4) };
        next = addPassageGrudge(next, fam, scene);
        notes.push(`${fam} men stopped the truck in ${next.territories.find((t) => t.id === scene)?.name ?? "their turf"} and took ${take} crate${take === 1 ? "" : "s"} as "tax"`);
      } else {
        // They still noticed.
        if (rng.chance(0.5)) next = addPassageGrudge(next, fam, scene);
      }
    }

    // The road itself.
    if (cargo > 0 && rng.chance(option.risk)) {
      const hijacker = pickHijacker(next, option, rng);
      heatDelta += 2;
      ledger = mergeLedger(ledger, { stolen: cargo, heat: 2 });
      if (hijacker) next = credit(next, hijacker, cargo * CRATE_STREET_VALUE);
      const fakeRoute: DeliveryRoute = {
        id: `${route.id}_${state.turn}`,
        family: player,
        driverId: driver.id,
        sourceTerritoryId: route.sourceTerritoryId,
        destTerritoryId: route.destTerritoryId,
        path: route.path,
        cargo,
        status: "hijacked",
      };
      if (hijacker) {
        const opened = openIncidentFromHijack(next, fakeRoute, hijacker, rng, "route_dispute");
        next = opened.state;
        const deal = activeDeal(next, hijacker);
        if (deal) {
          next = breachDeal(next, deal.id, "granter");
          next = addEvidence(
            next,
            opened.incident.id,
            makeEvidence("scene", state.turn, `It happened on ${hijacker} turf you'd paid to cross. Somebody there broke his word.`, { [hijacker]: 0.3 }, undefined, rng),
          );
          log(`${route.id}_word`, `${hijacker} took a truck they'd promised safe passage. The deal is void.`);
        }
      }
      let crew = next.crew;
      const hurt: string[] = [];
      if (rng.chance(0.25)) {
        crew = crew.map((c) => (c.id === driver.id ? { ...c, status: "wounded" as const } : c));
        hurt.push(driver.name);
      }
      if (escortRides && rng.chance(0.35)) {
        crew = crew.map((c) => (c.id === escort!.id ? { ...c, status: "wounded" as const } : c));
        hurt.push(escort!.name);
      }
      next = { ...next, crew };
      const text = `Truck ${srcName} → ${destName} hijacked. Lost ${cargo} crates${hurt.length ? `; ${hurt.join(" and ")} wounded` : ""}.`;
      next = markLast(next, route.id, { turn: state.turn, outcome: "hijacked", text });
      log(route.id, text);
      continue;
    }

    if (cargo > 0 && rng.chance(next.heat.level > 50 ? 0.12 : 0.04)) {
      heatDelta += 4;
      ledger = mergeLedger(ledger, { seized: cargo, heat: 4 });
      const text = `Police seized the ${srcName} → ${destName} run (${cargo} crates).`;
      next = markLast(next, route.id, { turn: state.turn, outcome: "seized", text });
      log(route.id, text);
      continue;
    }

    // Landed.
    const destNow = next.territories.find((t) => t.id === dest.id)!;
    const dep = depositCrates(destNow, cargo, "any", state.turn, lookup);
    next = { ...next, territories: next.territories.map((t) => (t.id === dest.id ? dep.territory : t)) };
    ledger = mergeLedger(ledger, { delivered: dep.moved });
    let payout = 0;
    if (dep.overflow > 0) {
      payout = dep.overflow * (CRATE_STREET_VALUE + rng.int(0, 8));
      next = { ...next, dirtyMoney: next.dirtyMoney + payout };
      ledger = mergeLedger(ledger, { cashIn: payout });
    }
    const outcome = stoppedBy ? "stopped" : "delivered";
    const text =
      `${dep.moved} crates landed in ${destName}` +
      (dep.overflow > 0 ? `; ${dep.overflow} street-sold for $${payout}` : "") +
      (notes.length ? ` (${notes.join("; ")})` : "") +
      ".";
    next = markLast(next, route.id, { turn: state.turn, outcome, text, stoppedBy });
    log(route.id, `${srcName} → ${destName}: ${text}`);
  }

  return { state: next, logs, ledger, heatDelta };
}
