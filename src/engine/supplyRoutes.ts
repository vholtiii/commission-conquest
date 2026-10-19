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
  CrewMember,
  CrewRequest,
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
import { assignCrew, bumpLoyalty, grantXpToCrew } from "./crew";
import { crewPresentIn } from "./crewLocation";
import { hasActiveIntel } from "./intel";
import {
  depositTracked,
  emptyLiquorLedger,
  hasManagedWarehouse,
  makeManagerLookup,
  mergeLedger,
  withdrawWarehouse,
} from "./liquor";
import { addEvidence, makeEvidence, openIncidentFromHijack } from "./incidents";
import { seizureCover } from "./safehouse";
import { dockHaul } from "./districtFeatures";
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
import { noteDrivingArrival } from "./practice";

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

/** Left where he parked it. The route does not roll and nobody covers. */
export const TRUCK_HELD = -1;
/** He is home. The next supply pass buys the truck, or rolls it if a trucking company is waiting. */
export const TRUCK_ARM = 0;

/** Highest-level trucking company on a block this family holds. */
export function truckingLevel(state: { territories: Territory[] }, family: FamilyName): number {
  let best = 0;
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    for (const r of t.rackets) {
      if (r.type === "trucking" && r.level > best) best = r.level;
    }
  }
  return best;
}

/** Share taken off hijack, stop, and seizure odds. Level 1 is 20%, plus 10% a level, capped at 40%. */
export function roadCut(level: number): number {
  if (level <= 0) return 0;
  return Math.min(0.4, 0.2 + 0.1 * (level - 1));
}

/** Extra crates a standing route loads, one per level, up to 3. */
export function extraHaul(level: number): number {
  return Math.min(3, Math.max(0, level));
}

/**
 * A driver walked off the truck. The week's load is lifted off the back,
 * and the route sits until he is done and a truck exists again.
 */
export function leaveTheTruck(state: GameState, man: CrewMember): GameState {
  const back = man.returnTo;
  if (back?.type !== "delivery" || !back.routeId) return state;
  const route = state.supplyRoutes.find((r) => r.id === back.routeId);
  if (!route) return state;
  const truckHere =
    route.truckReadyTurn == null || (route.truckReadyTurn > 0 && state.turn >= route.truckReadyTurn);
  const src = state.territories.find((t) => t.id === route.sourceTerritoryId);
  let territories = state.territories;
  let taken = 0;
  if (truckHere && src) {
    const lookup = makeManagerLookup(state.crew, route.family);
    const wd = withdrawWarehouse(src, route.cratesPerTurn, state.turn, lookup);
    taken = wd.moved;
    territories = territories.map((t) => (t.id === src.id ? wd.territory : t));
  }
  const place = src?.name ?? "the street";
  const text = !truckHere
    ? `${man.name} is off the route. The new truck is not here yet.`
    : taken > 0
      ? `${man.name} left the truck in ${place}. ${taken} crate${taken === 1 ? "" : "s"} were lifted off the back.`
      : `${man.name} left the truck in ${place}. The back was empty.`;
  const log =
    man.family === state.playerFamily
      ? [
          ...state.turnLog,
          {
            id: `log_left_truck_${route.id}_${state.turn}`,
            turn: state.turn,
            category: "delivery" as const,
            text,
            family: man.family,
          },
        ]
      : state.turnLog;
  return {
    ...state,
    territories,
    turnLog: log,
    supplyRoutes: state.supplyRoutes.map((r) =>
      r.id === route.id ? { ...r, truckReadyTurn: TRUCK_HELD } : r,
    ),
  };
}

/** Driver and escort take the edge off. */
function crewMult(state: Pick<GameState, "crew">, driverId?: string, escortId?: string): number {
  let mult = 1;
  const driver = driverId ? state.crew.find((c) => c.id === driverId) : undefined;
  if (driver) {
    mult *= 1 - Math.min(0.35, driver.skills.driving / 250);
    if (driver.traits.includes("wheelman")) mult *= 0.85;
    else if (driver.role === "associate") mult *= 1.15;
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
  const mult = crewMult(state, driverId, escortId) * (1 - roadCut(truckingLevel(state, family)));
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

function pathIsWalk(territories: Territory[], path: string[]): boolean {
  if (path.length === 0) return false;
  const byId = new Map(territories.map((t) => [t.id, t]));
  for (let i = 0; i < path.length - 1; i++) {
    const hop = byId.get(path[i]!);
    if (!hop?.adjacentTerritories.includes(path[i + 1]!)) return false;
  }
  return true;
}

/** A saved road drawn on the old neighbor list is redrawn as the direct road. */
export function repairRoutePaths<
  T extends { sourceTerritoryId: string; destTerritoryId: string; path: string[] },
>(territories: Territory[], routes: T[]): T[] {
  return routes.map((route) => {
    if (pathIsWalk(territories, route.path)) return route;
    const path = cheapestRoad(
      territories,
      route.sourceTerritoryId,
      route.destTerritoryId,
      () => 1,
    );
    if (!path) return route;
    return { ...route, path };
  });
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
  const lookup = makeManagerLookup(state.crew, player);
  if (!hasManagedWarehouse(src, lookup, state.turn)) {
    return fail("Source needs a managed warehouse. A still cannot ship on its own.");
  }
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
  const ids = [route.driverId, route.coverDriverId, route.escortId].filter((x): x is string => !!x);
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

/** Loyalty an associate gains for being trusted with a truck. */
const COVER_LOYALTY = 4;
/** Loyalty a loose soldier loses when the boss puts him on a route. */
const SOLDIER_RESENTMENT = 6;
/** XP an associate earns each week he drives in someone else's place. */
const COVER_XP = 5;
/** A loose soldier speaks up about one week in five. */
const SOLDIER_ASK_CHANCE = 0.2;
/** Turns to wait before asking again after a refusal. */
const COVER_ASK_GAP = 3;

function shortName(name: string): string {
  return name.replace(/"[^"]*"\s*/g, "").trim().split(/\s+/).pop() ?? name;
}

function byWheel(a: CrewMember, b: CrewMember): number {
  const wheel = Number(b.traits.includes("wheelman")) - Number(a.traits.includes("wheelman"));
  if (wheel !== 0) return wheel;
  return b.skills.driving - a.skills.driving;
}

/** A hit or a casing that already went off this morning. */
function outThisMorning(state: GameState, crewId: string): boolean {
  const morning = state.turn - 1;
  return (state.operations ?? []).some((op) => {
    if (!op.resolved || op.resolvedTurn !== morning) return false;
    return (
      op.shooterIds.includes(crewId) ||
      op.wheelmanId === crewId ||
      op.lookoutId === crewId ||
      op.bombMakerId === crewId ||
      op.planterId === crewId ||
      op.negotiatorId === crewId
    );
  });
}

function canTakeTheWheel(state: GameState, man: CrewMember | undefined, used: Set<string>): boolean {
  if (!man || used.has(man.id)) return false;
  if (man.status !== "active" || man.role === "boss") return false;
  if (man.assignment.type === "operation" || man.assignment.type === "surveillance") return false;
  if (outThisMorning(state, man.id)) return false;
  return true;
}

function whyDown(state: GameState, man: CrewMember | undefined): string {
  if (!man) return "No driver";
  const who = shortName(man.name);
  if (man.status === "dead") return `${who} is dead`;
  if (man.status === "wounded") return `${who} is wounded`;
  if (man.status === "jailed") return `${who} is in the Tombs`;
  if (man.status === "held") return `${who} is being held`;
  if (outThisMorning(state, man.id) || man.assignment.type === "operation") return `${who} is out on a job`;
  if (man.assignment.type === "surveillance") return `${who} is casing a block`;
  return `${who} can't drive`;
}

function postedAt(
  state: GameState,
  territoryId: string,
  family: FamilyName,
  used: Set<string>,
  skipId?: string,
): CrewMember[] {
  return state.crew
    .filter(
      (c) =>
        c.family === family &&
        c.id !== skipId &&
        c.assignment.type === "garrison" &&
        c.assignment.territoryId === territoryId &&
        canTakeTheWheel(state, c, used),
    )
    .sort(byWheel);
}

function idleOfRole(
  state: GameState,
  family: FamilyName,
  role: "associate" | "soldier",
  used: Set<string>,
  looseOnly: boolean,
): CrewMember[] {
  return state.crew
    .filter(
      (c) =>
        c.family === family &&
        c.role === role &&
        c.assignment.type === "idle" &&
        (!looseOnly || !c.capoId) &&
        canTakeTheWheel(state, c, used),
    )
    .sort(byWheel);
}

function releaseCover(state: GameState, route: SupplyRoute): { state: GameState; route: SupplyRoute } {
  if (!route.coverDriverId) return { state, route };
  const crew = state.crew.map((c) =>
    c.id === route.coverDriverId && c.assignment.type === "delivery" && c.assignment.routeId === route.id
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );
  const supplyRoutes = state.supplyRoutes.map((r) =>
    r.id === route.id ? { ...r, coverDriverId: undefined } : r,
  );
  return {
    state: { ...state, crew, supplyRoutes },
    route: supplyRoutes.find((r) => r.id === route.id) ?? route,
  };
}

function promoteDriver(
  state: GameState,
  route: SupplyRoute,
  man: CrewMember,
): { state: GameState; route: SupplyRoute } {
  let crew = assignCrew(state.crew, man.id, {
    type: "delivery",
    routeId: route.id,
    territoryId: route.sourceTerritoryId,
  });
  crew = crew.map((c) =>
    c.id === route.driverId && c.assignment.type === "delivery" && c.assignment.routeId === route.id
      ? { ...c, assignment: { type: "idle" as const } }
      : c,
  );
  const territories = state.territories.map((t) => ({
    ...t,
    garrisonIds: t.garrisonIds.filter((id) => id !== man.id),
  }));
  const supplyRoutes = state.supplyRoutes.map((r) =>
    r.id === route.id ? { ...r, driverId: man.id, coverDriverId: undefined } : r,
  );
  return {
    state: { ...state, crew, territories, supplyRoutes },
    route: supplyRoutes.find((r) => r.id === route.id) ?? { ...route, driverId: man.id, coverDriverId: undefined },
  };
}

function acceptedCover(state: GameState, route: SupplyRoute, used: Set<string>): CrewMember | undefined {
  const man = state.crew.find((c) => c.id === route.coverDriverId);
  if (!man || !canTakeTheWheel(state, man, used)) return undefined;
  if (man.assignment.type === "idle") return man;
  if (man.assignment.type === "delivery" && man.assignment.routeId === route.id) return man;
  return undefined;
}

function coverPending(state: GameState, routeId: string): boolean {
  return (state.crewRequests ?? []).some(
    (r) => r.kind === "cover" && r.routeId === routeId && r.status === "pending",
  );
}

function askCooled(route: SupplyRoute, turn: number): boolean {
  return route.coverAskedTurn == null || turn >= route.coverAskedTurn + COVER_ASK_GAP;
}

function queueAsk(
  state: GameState,
  route: SupplyRoute,
  req: CrewRequest,
): { state: GameState; route: SupplyRoute } {
  const supplyRoutes = state.supplyRoutes.map((r) =>
    r.id === route.id ? { ...r, coverAskedTurn: state.turn } : r,
  );
  return {
    state: {
      ...state,
      supplyRoutes,
      crewRequests: [...(state.crewRequests ?? []), req],
    },
    route: supplyRoutes.find((r) => r.id === route.id) ?? route,
  };
}

/** XP for an associate driving in someone else's place. A made man gets none of it. */
function paySubstitute(state: GameState, route: SupplyRoute, driver: CrewMember): GameState {
  if (driver.role !== "associate" || route.coverDriverId !== driver.id) return state;
  return { ...state, crew: grantXpToCrew(state.crew, driver.id, COVER_XP).crew };
}

interface Seat {
  state: GameState;
  route: SupplyRoute;
  driver: CrewMember | null;
  /** Prefixed onto the week's line when someone else took the truck. */
  lead: string;
  text: string;
}

/**
 * The named driver, or a man garrisoned at the warehouse, or a cover the boss
 * already accepted. With nobody posted, an associate always asks and a loose
 * soldier rarely does.
 */
function seatForRoute(state: GameState, route: SupplyRoute, rng: Rng, used: Set<string>): Seat {
  const family = route.family;
  let named = state.crew.find((c) => c.id === route.driverId);
  const down = whyDown(state, named);

  if (canTakeTheWheel(state, named, used)) {
    const released = releaseCover(state, route);
    let next = released.state;
    route = released.route;
    const man = next.crew.find((c) => c.id === named!.id)!;
    if (man.assignment.type !== "delivery") {
      next = {
        ...next,
        crew: assignCrew(next.crew, man.id, {
          type: "delivery",
          routeId: route.id,
          territoryId: route.sourceTerritoryId,
        }),
      };
    }
    return { state: next, route, driver: next.crew.find((c) => c.id === man.id) ?? man, lead: "", text: "" };
  }

  const cover = acceptedCover(state, route, used);
  const posted = postedAt(state, route.sourceTerritoryId, family, used, route.escortId);
  if (named?.status === "dead" && (cover || posted[0])) {
    const man = cover ?? posted[0]!;
    const promoted = promoteDriver(state, route, man);
    return {
      state: promoted.state,
      route: promoted.route,
      driver: promoted.state.crew.find((c) => c.id === man.id) ?? man,
      lead: `${shortName(man.name)} has the route. ${down}. `,
      text: "",
    };
  }

  if (cover) {
    return {
      state,
      route,
      driver: cover,
      lead: `${shortName(cover.name)} took the truck. ${down}. `,
      text: "",
    };
  }

  if (posted[0]) {
    const man = posted[0];
    return {
      state,
      route,
      driver: man,
      lead: `${shortName(man.name)} took the truck. ${down}. `,
      text: "",
    };
  }

  const waiting = coverPending(state, route.id);
  if (waiting) {
    return { state, route, driver: null, lead: "", text: `${down}. Waiting on you to name a cover.` };
  }

  const associates = idleOfRole(state, family, "associate", used, false).filter((c) => c.id !== route.escortId);
  const soldiers = idleOfRole(state, family, "soldier", used, true).filter((c) => c.id !== route.escortId);
  if (askCooled(route, state.turn) && associates[0]) {
    const man = associates[0];
    const asked = queueAsk(state, route, {
      id: `cover_${route.id}_${state.turn}`,
      turn: state.turn,
      capoId: man.id,
      candidateId: man.id,
      pitch: `Boss, ${shortName(named?.name ?? "the driver")} can't take the truck. I'll run it until he's up.`,
      status: "pending",
      kind: "cover",
      routeId: route.id,
      volunteer: true,
    });
    return {
      state: asked.state,
      route: asked.route,
      driver: null,
      lead: "",
      text: `${shortName(man.name)} asked to take the truck. ${down}.`,
    };
  }
  if (askCooled(route, state.turn) && soldiers[0] && rng.chance(SOLDIER_ASK_CHANCE)) {
    const man = soldiers[0];
    const driverAsks = named?.status === "wounded" && rng.chance(0.5);
    const asked = queueAsk(state, route, {
      id: `cover_${route.id}_${state.turn}`,
      turn: state.turn,
      capoId: driverAsks && named ? named.id : man.id,
      candidateId: man.id,
      pitch:
        driverAsks && named
          ? `Boss, I can't hold the wheel. Send ${shortName(man.name)}. He won't like it.`
          : `Boss, the truck's sitting. I'll drive it if you say so.`,
      status: "pending",
      kind: "cover",
      routeId: route.id,
      volunteer: !driverAsks,
    });
    const text =
      driverAsks && named
        ? `${shortName(named.name)} asked you to send ${shortName(man.name)}.`
        : `${shortName(man.name)} asked to take the truck. He won't like it.`;
    return { state: asked.state, route: asked.route, driver: null, lead: "", text };
  }

  return {
    state,
    route,
    driver: null,
    lead: "",
    text: `${down}. Nobody at the warehouse to take the truck.`,
  };
}

export type CoverAnswer = "approve" | "reject" | "later";

/** The boss's answer to a man covering a truck. A refusal does not sting. */
export function answerCoverRequest(
  state: GameState,
  requestId: string,
  answer: CoverAnswer,
): { state: GameState; message: string } {
  const req = (state.crewRequests ?? []).find((r) => r.id === requestId);
  if (!req || req.kind !== "cover" || req.status !== "pending") return { state, message: "" };
  const setStatus = (status: CrewRequest["status"], patch: Partial<CrewRequest> = {}) =>
    (state.crewRequests ?? []).map((r) => (r.id === requestId ? { ...r, status, ...patch } : r));
  const man = state.crew.find((c) => c.id === req.candidateId);
  const who = shortName(man?.name ?? "He");

  if (answer === "later") {
    return {
      state: { ...state, crewRequests: setStatus("pending", { deferred: (req.deferred ?? 0) + 1 }) },
      message: `${who} will ask again.`,
    };
  }

  const route = (state.supplyRoutes ?? []).find((r) => r.id === req.routeId);
  const free = !!man && man.status === "active" && man.assignment.type === "idle";
  if (answer === "reject" || !route || !man || !free) {
    return {
      state: { ...state, crewRequests: setStatus(answer === "reject" ? "rejected" : "expired") },
      message: answer === "reject" ? "The truck sits." : "He's not free anymore.",
    };
  }

  const named = state.crew.find((c) => c.id === route.driverId);
  let next = state;
  let live = route;
  if (named?.status === "dead") {
    const promoted = promoteDriver(state, route, man);
    next = promoted.state;
    live = promoted.route;
  } else {
    const crew = assignCrew(state.crew, man.id, {
      type: "delivery",
      routeId: route.id,
      territoryId: route.sourceTerritoryId,
    });
    const supplyRoutes = state.supplyRoutes.map((r) =>
      r.id === route.id ? { ...r, coverDriverId: man.id } : r,
    );
    next = { ...state, crew, supplyRoutes };
    live = supplyRoutes.find((r) => r.id === route.id) ?? route;
  }

  let crew = next.crew;
  let message: string;
  if (man.role === "associate") {
    crew = bumpLoyalty(crew, [man.id], COVER_LOYALTY).crew;
    message = `${who} has the truck until the driver is back. He won't forget it.`;
  } else {
    crew = crew.map((c) =>
      c.id === man.id ? { ...c, loyalty: Math.max(0, c.loyalty - SOLDIER_RESENTMENT) } : c,
    );
    message = `${who} has the truck. He'll hold it against you.`;
  }
  const text = man.role === "associate"
    ? `${man.name} took ${shortName(named?.name ?? "the route")}'s truck.`
    : `${man.name} took the truck, and he doesn't care for it.`;
  const log: TurnLogEntry = {
    id: `log_cover_${live.id}_${state.turn}`,
    turn: state.turn,
    category: "delivery",
    text,
    family: state.playerFamily ?? undefined,
  };
  return {
    state: {
      ...next,
      crew,
      crewRequests: setStatus("approved"),
      turnLog: [...next.turnLog, log].slice(-200),
    },
    message,
  };
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

  const usedDrivers = new Set<string>();
  for (const planned of [...(state.supplyRoutes ?? [])]) {
    let route = planned;
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

    if (route.truckReadyTurn === TRUCK_ARM) {
      const ready = truckingLevel(next, route.family) > 0 ? state.turn : state.turn + 2;
      route = { ...route, truckReadyTurn: ready };
      next = {
        ...next,
        supplyRoutes: next.supplyRoutes.map((r) => (r.id === route.id ? route : r)),
      };
    }
    const held = route.truckReadyTurn === TRUCK_HELD;
    const buying =
      route.truckReadyTurn != null && route.truckReadyTurn > 0 && state.turn < route.truckReadyTurn;
    if (held || buying) {
      const weeks = buying ? route.truckReadyTurn! - state.turn : 0;
      const text = held
        ? `The truck was left in ${srcName}. Nothing rolls.`
        : `Buying a truck for ${srcName} → ${destName}. Rolls in ${weeks} week${weeks === 1 ? "" : "s"}.`;
      next = markLast(next, route.id, { turn: state.turn, outcome: "waiting", text });
      log(route.id, text);
      continue;
    }
    if (route.truckReadyTurn != null && route.truckReadyTurn > 0) {
      route = { ...route, truckReadyTurn: undefined };
      next = {
        ...next,
        supplyRoutes: next.supplyRoutes.map((r) => (r.id === route.id ? route : r)),
      };
    }

    const seated = seatForRoute(next, route, rng, usedDrivers);
    next = seated.state;
    route = seated.route;
    if (!seated.driver) {
      next = markLast(next, route.id, {
        turn: state.turn,
        outcome: "no_driver",
        text: seated.text,
      });
      log(route.id, seated.text);
      continue;
    }
    usedDrivers.add(seated.driver.id);
    const driver = seated.driver;
    const lead = seated.lead;
    const escort = route.escortId ? next.crew.find((c) => c.id === route.escortId) : undefined;
    const escortRides = !!escort && escort.status === "active" && escort.id !== driver.id;

    if (!hasManagedWarehouse(src, lookup, state.turn)) {
      const text = `${lead}No managed warehouse in ${srcName}. The truck waits.`;
      next = markLast(next, route.id, { turn: state.turn, outcome: "no_stock", text });
      log(route.id, text);
      continue;
    }

    const wd = withdrawWarehouse(
      src,
      route.cratesPerTurn + extraHaul(truckingLevel(next, route.family)) + dockHaul(src),
      state.turn,
      lookup,
    );
    if (wd.moved <= 0) {
      const stockText = `${lead}${srcName} had nothing to load.`;
      next = markLast(next, route.id, {
        turn: state.turn,
        outcome: "no_stock",
        text: stockText,
      });
      log(route.id, stockText);
      continue;
    }
    next = { ...next, territories: next.territories.map((t) => (t.id === src.id ? wd.territory : t)) };
    let cargo = wd.moved;
    let proofedCargo = wd.proofed;

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
      if (driver.role === "associate" && !driver.traits.includes("wheelman")) stopChance *= 1.15;
      stopChance *= 1 - roadCut(truckingLevel(next, route.family));
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
      const rode = bumpLoyalty(next.crew, [driver.id, escortRides ? escort!.id : ""], 1);
      next = paySubstitute({ ...next, crew: rode.crew }, route, driver);
      const text = `${lead}Truck ${srcName} → ${destName} hijacked. Lost ${cargo} crates${hurt.length ? `; ${hurt.join(" and ")} wounded` : ""}.`;
      next = markLast(next, route.id, { turn: state.turn, outcome: "hijacked", text });
      log(route.id, text);
      continue;
    }

    // Police checkpoint. A safehouse along the road is a garage to duck into.
    if (cargo > 0) {
      const checkpoint = (next.heat.level > 50 ? 0.12 : 0.04) * (1 - roadCut(truckingLevel(next, route.family)));
      const garage = seizureCover(next, player, route.path);
      const roll = rng.next();
      if (roll < checkpoint) {
        if (garage && roll >= checkpoint * (1 - garage.evasion)) {
          notes.push(`ducked a checkpoint into the ${garage.territory.name} safehouse`);
        } else {
          heatDelta += 4;
          ledger = mergeLedger(ledger, { seized: cargo, heat: 4 });
          const text = `${lead}Police seized the ${srcName} → ${destName} run (${cargo} crates).`;
          next = paySubstitute(
            { ...next, crew: bumpLoyalty(next.crew, [driver.id, escortRides ? escort!.id : ""], 1).crew },
            route,
            driver,
          );
          next = markLast(next, route.id, { turn: state.turn, outcome: "seized", text });
          log(route.id, text);
          continue;
        }
      }
    }

    // Landed.
    const destNow = next.territories.find((t) => t.id === dest.id)!;
    proofedCargo = Math.min(proofedCargo, cargo);
    const dep = depositTracked(destNow, cargo, proofedCargo, "any", state.turn, lookup);
    next = { ...next, territories: next.territories.map((t) => (t.id === dest.id ? dep.territory : t)) };
    ledger = mergeLedger(ledger, { delivered: dep.moved });
    let payout = 0;
    if (dep.overflow > 0) {
      payout = dep.overflow * (CRATE_STREET_VALUE + rng.int(0, 8));
      next = { ...next, dirtyMoney: next.dirtyMoney + payout };
      ledger = mergeLedger(ledger, { cashIn: payout });
    }
    const outcome = stoppedBy ? "stopped" : "delivered";
    const rode = bumpLoyalty(next.crew, [driver.id, escortRides ? escort!.id : ""], 1);
    const drove = noteDrivingArrival(rode.crew, driver.id, state.turn, state.playerFamily);
    logs.push(...drove.logs);
    next = paySubstitute({ ...next, crew: drove.crew }, route, driver);
    const text =
      `${lead}${dep.moved} crates landed in ${destName}` +
      (dep.overflow > 0 ? `; ${dep.overflow} street-sold for $${payout}` : "") +
      (notes.length ? ` (${notes.join("; ")})` : "") +
      ".";
    next = markLast(next, route.id, { turn: state.turn, outcome, text, stoppedBy });
    log(route.id, `${srcName} → ${destName}: ${text}`);
  }

  return { state: next, logs, ledger, heatDelta };
}
