import type { GameState, LookoutReport, TurnLogEntry, VictoryState } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { createRng, type Rng } from "./rng";
import { resolvePendingOperations } from "./hitOps";
import { runAllAiTurns } from "./rivalAI";
import { processDeliveries, processAllEconomy, isLegitBusiness, pruneLaunderPlan, safehouseLevel } from "./economy";
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
import { getBoss, pruneManagers, tickAssignmentXp, grantXpToCrew } from "./crew";
import { emptyIntel, pruneIntel } from "./intel";

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

export function checkVictory(state: GameState): VictoryState {
  const victory = { ...state.victory };

  if (victory.won || victory.lost) return victory;
  if (!state.playerFamily || !state.started) return victory;

  const playerBoss = getBoss(state.crew, state.playerFamily);
  if (!playerBoss || playerBoss.status === "dead") {
    return { ...victory, lost: true, reason: "Your boss was eliminated." };
  }
  if (playerBoss.status === "jailed") {
    return { ...victory, lost: true, reason: "Your boss was locked up for good." };
  }

  if (state.money < 0 && state.dirtyMoney < 0) {
    return {
      ...victory,
      lost: true,
      reason: "Bankrupt — legitimate and dirty coffers are empty.",
    };
  }

  const total = state.territories.length;
  const owned = state.territories.filter(
    (t) => t.owner === state.playerFamily,
  ).length;
  const controlPct = owned / total;

  if (controlPct >= 0.6) {
    return {
      ...victory,
      won: true,
      reason: `Territorial dominance — ${Math.floor(controlPct * 100)}% of districts under control.`,
    };
  }

  const rivalBossesAlive = ALL_FAMILY_NAMES.filter(
    (f) => f !== state.playerFamily && getBoss(state.crew, f),
  ).length;

  if (rivalBossesAlive === 0) {
    return {
      ...victory,
      won: true,
      reason: "Every rival boss is dead — the city is yours.",
    };
  }

  let chairTurns = victory.commissionChairTurns;
  const respect = state.reputation.respect;
  const fear = state.reputation.fear;
  if (respect >= 70 && fear >= 50 && owned >= Math.ceil(total * 0.35)) {
    chairTurns += 1;
  } else {
    chairTurns = Math.max(0, chairTurns - 1);
  }

  if (chairTurns >= 10) {
    return {
      ...victory,
      won: true,
      commissionChairTurns: chairTurns,
      reason: "Commission chair for ten turns — all families bend the knee.",
    };
  }

  return { ...victory, commissionChairTurns: chairTurns };
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

  const ops = resolvePendingOperations(current, random);
  current = applyLookoutReports(ops.state, ops.reports);
  for (const hit of ops.results) {
    logs.push({
      id: `log_hit_${hit.operationId}`,
      turn: current.turn,
      category: "hit",
      text: hit.headline,
    });
  }

  const ai = runAllAiTurns(current, random);
  current = ai.state;
  logs.push(...ai.logs);

  const aiOps = resolvePendingOperations(current, random);
  current = applyLookoutReports(aiOps.state, aiOps.reports);
  for (const hit of aiOps.results) {
    logs.push({
      id: `log_ai_hit_${hit.operationId}`,
      turn: current.turn,
      category: "hit",
      text: hit.headline,
    });
  }

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
  };
  current = applyHeatToState(current, deliveries.heatDelta, "deliveries");
  logs.push(...deliveries.logs);

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
  current = {
    ...current,
    territories: economy.territories,
    money: current.money + economy.moneyDelta,
    dirtyMoney: current.dirtyMoney + economy.dirtyDelta,
    lastNetIncome: economy.lastNetIncome,
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

  // Influence tick: respect + fear + street drive growth
  const infDelta =
    current.reputation.respect * 0.04 +
    current.reputation.fear * 0.03 +
    current.reputation.streetInfluence * 0.02 -
    2;
  current.influence = Math.max(0, Math.min(300, current.influence + infDelta));

  current.territories = pruneManagers(current);
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
      category: "crew",
      text: `${lvl.name} reached level ${lvl.level}.`,
      family: current.playerFamily ?? undefined,
    });
  }

  current = pruneIntel(current);
  current.victory = checkVictory(current);
  current = appendLogs(current, logs);

  return current;
}
