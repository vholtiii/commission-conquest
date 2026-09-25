import type {
  GameState,
  HitCinematic,
  HitPerspective,
  HitResult,
  LookoutReport,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { createRng, type Rng } from "./rng";
import {
  buildHitCinematic,
  resolvePendingOperations,
  settleReadyHit,
  tipOffChance,
} from "./hitOps";
import { runAllAiTurns } from "./rivalAI";
import { findDeliveryPath, processDeliveries, processAllEconomy, isLegitBusiness, pruneLaunderPlan, safehouseLevel } from "./economy";
import {
  emptyLiquorLedger,
  liquorLedgerLog,
  mergeLedger,
  processShipments,
  processStashRaids,
  totalCrates,
} from "./liquor";
import {
  applyHeat as applyHeatDelta,
  aggregateBribeEffects,
  processHeatTurn,
  tickBribes,
  applyWarrantConsequences,
} from "./heat";
import { drawEvent } from "./events";
import { decayRelations } from "./relations";
import { activePactKeys, expirePacts } from "./diplomacy";
import { pruneManagers, tickAssignmentXp, grantXpToCrew } from "./crew";
import { emptyIntel, pruneIntel } from "./intel";
import { pruneGrudges, releaseHeldCrew } from "./casing";
import { generateCrewRequests, tickCrewMentoring } from "./crews";
import { tickBossPresence } from "./bossPresence";
import { familyHeadless, tickJails } from "./jail";
import { checkVictory, influenceTick, rivalStandingDrivers } from "./victory";
import { generateRumors } from "./rumors";
import { tickIncidents } from "./incidents";
import { holdSitdowns, proposePassageSitdown, stageSitdowns } from "./sitdowns";
import { resolveCrewTerritoryId } from "./crewLocation";
import { openIncidentFromHijack } from "./incidents";
import { processSupplyRoutes } from "./supplyRoutes";
import { tickPassageDeals } from "./passage";
import { settleDealsAfterHits, tickDeals } from "./deals";
import { callInFavors } from "./favors";
import { walkIns } from "./recruiting";
import { applyWeeklyStreet } from "./standing";

export interface PlayerHit {
  op: Operation;
  result: HitResult;
  /** Origin → strike block, for the drive-in. */
  path: string[];
}

/**
 * The player's jobs that go this week: anything at one week or less when he
 * presses Next Turn (a fresh hit is planned at 1; surveil-first reaches 1 once
 * the casing is done). They resolve here, before the rest of the week, so the
 * store can play the reel; `endTurn` leaves the player's hits alone.
 *
 * Each gets its final tip-off roll first, the same one `endTurn` gives rival
 * hits. A boss car bomb that hasn't gone off yet stays armed and is retried
 * next week.
 */
export function resolvePlayerHits(
  state: GameState,
  rng: Rng,
): { state: GameState; hits: PlayerHit[]; logs: TurnLogEntry[] } {
  const player = state.playerFamily;
  const hits: PlayerHit[] = [];
  const logs: TurnLogEntry[] = [];
  if (!player) return { state, hits, logs };
  let current = state;

  const ready = current.operations.filter(
    (o) => !o.resolved && o.kind === "hit" && o.family === player && o.pendingTurns <= 1,
  );
  for (const planned of ready) {
    let op = planned;
    if (op.pendingTurns > 0 && !op.tippedOff && rng.chance(tipOffChance(current, op))) {
      op = { ...op, tippedOff: true };
    }
    op = { ...op, pendingTurns: 0 };
    current = {
      ...current,
      operations: current.operations.map((o) => (o.id === op.id ? op : o)),
    };

    const settled = settleReadyHit(current, op, rng);
    current = settled.state;
    if (settled.log) logs.push(settled.log);
    if (!settled.result) continue;

    const result = settled.result;
    logs.push({
      id: `log_hit_${op.id}`,
      turn: current.turn,
      category: "hit",
      text: result.headline,
    });
    const origin =
      op.originTerritoryId ||
      current.territories.find((t) => t.owner === player)?.id ||
      op.targetTerritoryId;
    const strike = result.strikeTerritoryId ?? op.targetTerritoryId;
    const path =
      findDeliveryPath(current.territories, origin, strike, player, true) || [origin, strike];
    hits.push({ op, result, path });
  }

  if (hits.length > 0) {
    const settled = settleDealsAfterHits(
      current,
      hits.map((h) => h.result),
    );
    current = settled.state;
    logs.push(...settled.logs);
  }
  if (logs.length > 0) current = { ...current, turnLog: [...current.turnLog, ...logs] };
  return { state: current, hits, logs };
}

/**
 * Rival hits worth a reel: ones on our people ("incoming"), and rival-on-rival
 * jobs in a district we've discovered ("witnessed" — shooters and mark only).
 * A job with nobody to see (the mark never showed, the plant was called off)
 * stays a log line.
 */
function incomingHits(state: GameState, hits: HitResult[]): HitCinematic[] {
  const player = state.playerFamily;
  if (!player) return [];
  const out: HitCinematic[] = [];
  for (const hit of hits) {
    const op = state.operations.find((o) => o.id === hit.operationId);
    if (!op || op.family === player) continue;
    const strike = hit.strikeTerritoryId ?? op.targetTerritoryId;
    let perspective: HitPerspective;
    if (op.targetFamily === player) {
      perspective = "incoming";
    } else {
      const here = state.territories.find((t) => t.id === strike);
      if (!here?.discovered) continue;
      if (hit.markAbsent || hit.complication === "cop_on_fender") continue;
      perspective = "witnessed";
    }
    const origin =
      op.originTerritoryId ||
      state.territories.find((t) => t.owner === op.family)?.id ||
      strike;
    const path =
      findDeliveryPath(state.territories, origin, strike, op.family, true) || [origin, strike];
    out.push(buildHitCinematic(state, op, hit, perspective, path));
  }
  return out;
}

function applyLookoutReports(state: GameState, reports: LookoutReport[]): GameState {
  if (reports.length === 0) return state;
  const intel = state.intel ?? emptyIntel();
  const nextReports = { ...(intel.reports ?? {}) };
  for (const r of reports) {
    nextReports[r.territoryId] = r;
  }
  return {
    ...state,
    intel: { ...intel, reports: nextReports },
    pendingReports: [...(state.pendingReports ?? []), ...reports],
  };
}

function advanceDate(state: GameState): GameState {
  let { year, month, day } = state.date;
  day += 7;
  if (day > 28) {
    day = 1;
    month += 1;
  }
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return { ...state, turn: state.turn + 1, date: { year, month, day } };
}

function appendLogs(state: GameState, entries: TurnLogEntry[]): GameState {
  return {
    ...state,
    turnLog: [...state.turnLog, ...entries].slice(-200),
  };
}

function applyHeatToState(state: GameState, amount: number, source: string): GameState {
  const bribeFx = aggregateBribeEffects(state.bribes);
  return {
    ...state,
    heat: applyHeatDelta(
      state.heat,
      amount,
      source,
      bribeFx.heatGenerationReduction,
    ),
  };
}

export function endTurn(state: GameState, rng?: Rng): GameState {
  const random = rng ?? createRng(state.seed + state.turn * 7919);
  let current = advanceDate(state);
  const logs: TurnLogEntry[] = [];

  logs.push({
    id: `log_turn_${current.turn}`,
    turn: current.turn,
    category: "system",
    text: `— Turn ${current.turn}: ${current.date.month}/${current.date.day}/${current.date.year} —`,
  });

  // Anyone whose hold ran out walks home before the week's business starts.
  const released = releaseHeldCrew(current);
  current = { ...current, crew: released.crew };
  logs.push(...released.logs);

  // Trips that ended last week are over; this week's sit-downs start now,
  // before any hit resolves — a boss on the road is a boss a car bomb can reach.
  current = {
    ...current,
    crew: current.crew.map((c) =>
      c.awayAt && c.awayAt.untilTurn <= current.turn ? { ...c, awayAt: undefined } : c,
    ),
  };
  current = stageSitdowns(current);

  // The player's own hits already went (resolvePlayerHits, with a reel);
  // only rival jobs resolve in here.
  const rivalsOnly = { skipFamily: current.playerFamily };
  const ops = resolvePendingOperations(current, random, rivalsOnly);
  current = applyLookoutReports(ops.state, ops.reports);
  const reel: HitCinematic[] = [];
  for (const hit of ops.results) {
    const op = current.operations.find((o) => o.id === hit.operationId);
    logs.push({
      id: `log_hit_${hit.operationId}`,
      turn: current.turn,
      category: "hit",
      text: hit.headline,
      family: op && op.family !== current.playerFamily ? op.family : undefined,
    });
  }
  reel.push(...incomingHits(current, ops.results));
  // A contract fulfilled, or a truce broken by whoever pulled the trigger.
  const settled = settleDealsAfterHits(current, ops.results);
  current = settled.state;
  logs.push(...settled.logs);

  const ai = runAllAiTurns(current, random);
  current = ai.state;
  logs.push(...ai.logs);

  const aiOps = resolvePendingOperations(current, random, rivalsOnly);
  current = applyLookoutReports(aiOps.state, aiOps.reports);
  for (const hit of aiOps.results) {
    const op = current.operations.find((o) => o.id === hit.operationId);
    logs.push({
      id: `log_ai_hit_${hit.operationId}`,
      turn: current.turn,
      category: "hit",
      text: hit.headline,
      family: op && op.family !== current.playerFamily ? op.family : undefined,
    });
  }
  reel.push(...incomingHits(current, aiOps.results));
  current = { ...current, incomingHitReel: reel };
  const aiSettled = settleDealsAfterHits(current, aiOps.results);
  current = aiSettled.state;
  logs.push(...aiSettled.logs);

  // The meetings, now that the week's violence is settled.
  const meetings = holdSitdowns(current, random);
  current = meetings.state;
  logs.push(...meetings.logs);

  // Word on the street about what's coming, and about what's unsolved.
  const rumorPass = generateRumors(current, random);
  current = rumorPass.state;
  logs.push(...rumorPass.logs);

  // Supplier shipments arrive before deliveries
  const shipments = processShipments(current, random);
  let turnLedger = mergeLedger(emptyLiquorLedger(), shipments.ledger);
  current = {
    ...current,
    pendingShipments: shipments.pendingShipments,
    territories: shipments.territories,
    dirtyMoney: current.dirtyMoney + shipments.dirtyDelta,
  };
  current = applyHeatToState(current, shipments.heatDelta, "shipments");
  logs.push(...shipments.logs);

  const deliveries = processDeliveries(current, random);
  turnLedger = mergeLedger(turnLedger, deliveries.ledger);
  current = {
    ...current,
    territories: deliveries.territories,
    routes: deliveries.routes.filter((r) => r.status === "active"),
    money: current.money + deliveries.moneyDelta,
    dirtyMoney: current.dirtyMoney + deliveries.dirtyDelta,
    rivalTreasury: deliveries.rivalTreasury,
  };
  current = applyHeatToState(current, deliveries.heatDelta, "deliveries");
  logs.push(...deliveries.logs);
  // Every player truck taken on the road is a case to work.
  for (const h of deliveries.hijacks) {
    current = openIncidentFromHijack(current, h.route, h.hijacker, random).state;
  }

  // Standing orders roll after the one-off runs: tolls, hot stops, the road, the landing.
  const supply = processSupplyRoutes(current, random);
  current = supply.state;
  turnLedger = mergeLedger(turnLedger, supply.ledger);
  current = applyHeatToState(current, supply.heatDelta, "supply routes");
  logs.push(...supply.logs);

  // Truces run out, jobs owed come due, and the odd hothead tears up paper.
  const tableDeals = tickDeals(current, random);
  current = tableDeals.state;
  logs.push(...tableDeals.logs);

  // Families holding a favor decide whether this is the week to collect.
  const favors = callInFavors(current, random);
  current = favors.state;
  logs.push(...favors.logs);

  // Deals that ran their course; routes crossing that turf go back to the table.
  const dealTick = tickPassageDeals(current);
  current = dealTick.state;
  for (const fam of dealTick.expired) {
    logs.push({
      id: `log_deal_expired_${fam}_${current.turn}`,
      turn: current.turn,
      category: "diplomacy",
      text: `Your passage deal with ${fam} has run out.`,
      family: current.playerFamily ?? undefined,
    });
    const waiting = (current.supplyRoutes ?? []).find(
      (r) => r.awaitingFamilies.includes(fam) && r.status !== "suspended",
    );
    if (waiting) {
      const talks = proposePassageSitdown(current, fam, waiting.id, random);
      current = talks.state;
      if (talks.log) logs.push(talks.log);
    }
  }

  if (deliveries.crewUpdates.length) {
    current.crew = current.crew.map((c) => {
      const upd = deliveries.crewUpdates.find((u) => u.id === c.id);
      return upd ? { ...c, status: upd.status } : c;
    });
  }

  // XP for completed deliveries
  for (const route of deliveries.routes) {
    if (route.status === "complete") {
      const xp = grantXpToCrew(current.crew, route.driverId, 5);
      current.crew = xp.crew;
      if (xp.leveled && xp.name && current.playerFamily) {
        const driver = current.crew.find((c) => c.id === route.driverId);
        if (driver?.family === current.playerFamily) {
          logs.push({
            id: `log_xp_${route.driverId}_${current.turn}`,
            turn: current.turn,
            category: "system",
            text: `${xp.name} reached level ${xp.level}.`,
            family: current.playerFamily,
          });
        }
      }
    }
  }

  const economy = processAllEconomy(current);
  turnLedger = mergeLedger(turnLedger, economy.ledger);
  const headless =
    !!current.playerFamily && familyHeadless(current, current.playerFamily);
  const scaleIncome = (n: number) => (headless && n > 0 ? n * 0.75 : n);
  if (headless) {
    logs.push({
      id: `log_headless_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: "No one is speaking for the family — the rackets run at three quarters.",
      family: current.playerFamily ?? undefined,
    });
  }
  current = {
    ...current,
    territories: economy.territories,
    money: current.money + scaleIncome(economy.moneyDelta),
    dirtyMoney: current.dirtyMoney + scaleIncome(economy.dirtyDelta),
    lastNetIncome: scaleIncome(economy.lastNetIncome),
    liquorStock: economy.liquorStock,
    rivalTreasury: economy.rivalTreasury,
    launderPlan: pruneLaunderPlan(
      current.launderPlan ?? {},
      economy.territories,
      current.playerFamily,
    ),
  };
  current = applyHeatToState(current, economy.heatDelta, "rackets");
  logs.push(...economy.logs);

  const laidLow: string[] = [];
  current.crew = current.crew.map((member) => {
    if (member.status !== "active" || member.wanted <= 0) return member;
    const home = current.territories.find(
      (t) => t.owner === member.family && t.garrisonIds.includes(member.id),
    );
    if (!home) return member;
    const cover = safehouseLevel(home, current.turn);
    if (cover <= 0) return member;
    const wanted = Math.max(0, member.wanted - cover);
    if (
      wanted < member.wanted &&
      current.playerFamily &&
      member.family === current.playerFamily
    ) {
      laidLow.push(member.name);
    }
    return { ...member, wanted };
  });
  if (laidLow.length > 0 && current.playerFamily) {
    logs.push({
      id: `log_safehouse_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: `${laidLow.join(", ")} laid low — wanted dropped at the safehouse.`,
      family: current.playerFamily,
    });
  }

  // Discoverability nudge: dirty cash with nothing routed
  if (
    current.playerFamily &&
    !current.launderNudgeShown &&
    current.dirtyMoney >= 1000
  ) {
    const planned = Object.values(current.launderPlan ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    if (planned <= 0) {
      const legitSites = current.territories.flatMap((t) =>
        t.owner === current.playerFamily
          ? t.rackets.filter((r) => isLegitBusiness(r.type))
          : [],
      );
      const hasLegit = legitSites.length > 0;
      const anySetUp = legitSites.some((r) => r.launderReadyTurn != null);
      logs.push({
        id: `log_launder_nudge_${current.turn}`,
        turn: current.turn,
        category: "economy",
        text: !hasLegit
          ? `Build a deli or laundromat to start washing cash.`
          : !anySetUp
            ? `Set up a deli or laundromat as a laundering site (District panel).`
            : `You are sitting on $${current.dirtyMoney} dirty with nothing routed. Open Launder to wash it.`,
        family: current.playerFamily,
      });
      current.launderNudgeShown = true;
    }
  }

  const heatTurn = processHeatTurn(current);
  current.heat = heatTurn.heat;
  logs.push(...heatTurn.logs);

  if (heatTurn.incomePenalty > 0 && current.playerFamily) {
    const penalty = Math.floor(current.lastNetIncome * heatTurn.incomePenalty);
    current.money -= Math.max(0, penalty);
  }

  const raids = processStashRaids(current, random);
  turnLedger = mergeLedger(turnLedger, raids.ledger);
  current = {
    ...current,
    territories: raids.territories,
  };
  current = applyHeatToState(current, raids.heatDelta, "raid");
  logs.push(...raids.logs);

  if (current.playerFamily) {
    current.liquorStock = totalCrates(current, current.playerFamily);
    current.liquorLedger = turnLedger;
    if (
      turnLedger.sold > 0 ||
      turnLedger.dumped > 0 ||
      turnLedger.stolen > 0 ||
      turnLedger.seized > 0 ||
      turnLedger.bought > 0 ||
      turnLedger.heat > 0
    ) {
      logs.push(liquorLedgerLog(turnLedger, current.turn, current.playerFamily));
    }
  } else {
    current.liquorLedger = turnLedger;
  }

  current.bribes = tickBribes(current.bribes);
  current = applyWarrantConsequences(current);

  const event = drawEvent(current, random);
  if (event) {
    current.activeEvent = event;
    current.events = [...current.events, event];
    logs.push({
      id: `log_event_${event.id}`,
      turn: current.turn,
      category: "event",
      text: `Event: ${event.title}`,
    });
  }

  current.relations = decayRelations(current.relations, 1, {
    fear: current.reputation.fear,
    playerFamily: current.playerFamily,
    frozenKeys: activePactKeys(current),
  });

  const lapsed = expirePacts(current);
  current = lapsed.state;
  logs.push(...lapsed.logs);

  // Storefronts and a boss off his HQ, before the drift so this week counts.
  const street = applyWeeklyStreet(current);
  current = street.state;
  if (street.log) logs.push(street.log);

  // Influence tick: respect + fear + street drive growth
  const infDelta = influenceTick(current.reputation);
  current.influence = Math.max(0, Math.min(300, current.influence + infDelta));
  const rivalInfluence = { ...(current.rivalInfluence ?? {}) };
  for (const family of ALL_FAMILY_NAMES) {
    if (family === current.playerFamily) continue;
    const grown =
      (rivalInfluence[family] ?? 120) + influenceTick(rivalStandingDrivers(current, family));
    rivalInfluence[family] = Math.max(0, Math.min(300, grown));
  }
  current.rivalInfluence = rivalInfluence;

  // Respect decides who comes looking for work this week.
  const arrivals = walkIns(current, random);
  current = arrivals.state;
  if (arrivals.log) logs.push(arrivals.log);

  const jailed = tickJails(current, random);
  current = jailed.state;
  logs.push(...jailed.logs);

  current.territories = pruneManagers(current);
  // The dead don't hold corners.
  {
    const dead = new Set(current.crew.filter((c) => c.status === "dead").map((c) => c.id));
    if (dead.size > 0) {
      current.territories = current.territories.map((t) =>
        t.garrisonIds.some((id) => dead.has(id))
          ? { ...t, garrisonIds: t.garrisonIds.filter((id) => !dead.has(id)) }
          : t,
      );
    }
  }
  const xpTick = tickAssignmentXp(
    current.crew,
    current.playerFamily,
    current.territories,
    current.turn,
  );
  current.crew = xpTick.crew;
  for (const lvl of xpTick.logs) {
    logs.push({
      id: `log_xp_tick_${lvl.name}_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: `${lvl.name} reached level ${lvl.level}.`,
      family: current.playerFamily ?? undefined,
    });
  }

  // Crews: mentoring, the management drip, loyalty drift; then capos ask for men.
  const mentoring = tickCrewMentoring(current.crew, current.turn, random, current.playerFamily, current);
  current.crew = mentoring.crew;
  const learned = new Map<string, string[]>();
  for (const m of mentoring.logs) {
    const list = learned.get(m.name) ?? [];
    list.push(`${m.skill} ${m.value}`);
    learned.set(m.name, list);
  }
  for (const [name, gains] of learned) {
    logs.push({
      id: `log_mentor_${name}_${current.turn}`,
      turn: current.turn,
      category: "system",
      text: `${name} is learning from his capo: ${gains.join(", ")}.`,
      family: current.playerFamily ?? undefined,
    });
  }
  const asks = generateCrewRequests(current, random);
  current.crewRequests = asks.requests;
  logs.push(...asks.logs);

  // The boss's block: the men there stand taller, the neighbours get read.
  const presence = tickBossPresence(current, random);
  current = presence.state;
  logs.push(...presence.logs);

  current = pruneIntel(current);
  current = pruneGrudges(current);

  // Cold cases and rumor evidence that didn't hold up.
  const cases = tickIncidents(current);
  current = cases.state;
  logs.push(...cases.logs);

  // Where everyone stood at the end of the week. Next week's car bombs compare.
  current = {
    ...current,
    crew: current.crew.map((c) =>
      c.status === "dead" ? c : { ...c, lastSiteId: resolveCrewTerritoryId(current, c.id) ?? undefined },
    ),
  };
  current.victory = checkVictory(current);
  current = appendLogs(current, logs);

  return current;
}
