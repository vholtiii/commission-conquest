/**
 * Deals: what a sit-down leaves behind.
 *
 * A truce, a job owed, a favor — anything struck at the table that has to be
 * kept afterwards lives here. Deals are between the player and one rival.
 * Breaking one is public: the breaker loses standing with the Commission,
 * the victim remembers, and every other family trusts him a little less.
 *
 * Pure except for the state-returning functions.
 */
import type {
  AgendaTerms,
  Deal,
  DealKind,
  DealSettlement,
  FamilyName,
  GameState,
  HitResult,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { setRelationDelta } from "./relations";
import { hasPact } from "./diplomacy";
import { withdrawCrates } from "./liquor";
import { racketIncome } from "./economy";
import { HONOR_RESPECT } from "./standing";

/** Standing the breaker loses with the Commission. */
export const BREAK_STANDING = 20;
/** Relation lost with the family that was wronged. */
export const BREAK_RELATION_VICTIM = -25;
/** Relation lost with every other family — word gets around. */
export const BREAK_RELATION_OTHERS = -10;
/** Relation gained when a job owed is delivered. */
export const HONOR_RELATION = 10;

/** Per-turn chance a rival tears up a truce, by temperament. */
const AI_BREAK_CHANCE: Record<string, number> = {
  volatile: 0.05,
  covert: 0.03,
  expansionist: 0.02,
  smuggler: 0.015,
  economic: 0.01,
};

type DealState = Pick<GameState, "deals" | "turn" | "playerFamily">;

function blockName(state: Pick<GameState, "territories">, deal: Deal): string {
  return state.territories.find((t) => t.id === deal.terms.territoryId)?.name ?? "the block";
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

function isLive(deal: Deal, turn: number): boolean {
  return deal.status === "active" && (deal.untilTurn === null || deal.untilTurn > turn);
}

function binds(deal: Deal, a: FamilyName, b: FamilyName): boolean {
  return (deal.a === a && deal.b === b) || (deal.a === b && deal.b === a);
}

export function activeDeals(state: DealState): Deal[] {
  return (state.deals ?? []).filter((d) => isLive(d, state.turn));
}

export function dealsWith(state: DealState, family: FamilyName, kind?: DealKind): Deal[] {
  const player = state.playerFamily;
  if (!player) return [];
  return activeDeals(state).filter((d) => binds(d, player, family) && (!kind || d.kind === kind));
}

/** An active truce between two families. */
export function truceBetween(state: DealState, a: FamilyName, b: FamilyName): Deal | undefined {
  return activeDeals(state).find((d) => d.kind === "truce" && binds(d, a, b));
}

export function inTruce(state: DealState, a: FamilyName, b: FamilyName): boolean {
  return !!truceBetween(state, a, b);
}

/** Pact or truce: neither side is supposed to raise a hand. */
export function atPeace(state: GameState, a: FamilyName, b: FamilyName): boolean {
  return hasPact(state, a, b) || inTruce(state, a, b);
}

/** The other family on a deal, from the player's side. */
export function dealPartner(state: Pick<GameState, "playerFamily">, deal: Deal): FamilyName {
  return deal.a === state.playerFamily ? deal.b : deal.a;
}

export function dealKindLabel(kind: DealKind): string {
  switch (kind) {
    case "truce":
      return "Truce";
    case "alliance":
      return "Contract";
    case "liquor":
      return "Liquor order";
    case "favor":
      return "Favor owed";
    case "cut":
      return "Cut of the take";
  }
}

/** Weekly cut a `cut` deal moves, at today's take. */
export function weeklyCut(state: Pick<GameState, "territories">, deal: Deal): number {
  const t = state.territories.find((x) => x.id === deal.terms.territoryId);
  if (!t) return 0;
  const take = t.baseIncome + t.rackets.reduce((n, r) => n + racketIncome(r), 0);
  return Math.round(take * (deal.terms.share ?? 0));
}

/* ------------------------------------------------------------------ */
/* Making and keeping                                                  */
/* ------------------------------------------------------------------ */

export function makeDeal(
  state: GameState,
  kind: DealKind,
  other: FamilyName,
  terms: AgendaTerms,
  opts: { obligor?: FamilyName; weeks?: number | null; rng?: Rng } = {},
): { state: GameState; deal: Deal } {
  const player = state.playerFamily!;
  const weeks = opts.weeks === undefined ? terms.weeks ?? null : opts.weeks;
  const deal: Deal = {
    id: `deal_${kind}_${other}_${state.turn}_${opts.rng ? opts.rng.int(100, 999) : (state.deals ?? []).length}`,
    kind,
    a: player,
    b: other,
    terms,
    sinceTurn: state.turn,
    untilTurn: weeks === null ? null : state.turn + weeks,
    status: "active",
    obligor: opts.obligor,
  };
  // One live truce per pair: a new one replaces the old.
  const rest = (state.deals ?? []).map((d) =>
    kind === "truce" && d.kind === "truce" && isLive(d, state.turn) && binds(d, player, other)
      ? { ...d, status: "expired" as const, untilTurn: state.turn }
      : d,
  );
  return { state: { ...state, deals: [...rest, deal] }, deal };
}

/** Relations and standing after `breaker` tears up a deal with `victim`. */
function breakFallout(state: GameState, breaker: FamilyName, victim: FamilyName): GameState {
  const player = state.playerFamily;
  let relations = setRelationDelta(state.relations, breaker, victim, BREAK_RELATION_VICTIM);
  for (const f of ALL_FAMILY_NAMES) {
    if (f === breaker || f === victim) continue;
    relations = setRelationDelta(relations, breaker, f, BREAK_RELATION_OTHERS);
  }
  const next: GameState = { ...state, relations };
  if (breaker === player) {
    return { ...next, influence: Math.max(0, next.influence - BREAK_STANDING) };
  }
  return {
    ...next,
    rivalInfluence: {
      ...next.rivalInfluence,
      [breaker]: Math.max(0, (next.rivalInfluence?.[breaker] ?? 0) - BREAK_STANDING),
    },
  };
}

/** A closed deal waits for its card. */
export function queueSettlement(
  state: GameState,
  deal: Deal,
  settlement: Omit<DealSettlement, "dealId" | "kind" | "other" | "terms" | "turn">,
): GameState {
  const other = dealPartner(state, deal);
  return {
    ...state,
    pendingDealSettlements: [
      ...(state.pendingDealSettlements ?? []),
      { dealId: deal.id, kind: deal.kind, other, terms: deal.terms, turn: state.turn, ...settlement },
    ],
  };
}

/**
 * `by` walks away from a deal. Everyone hears about it. `text` replaces the
 * generic line when the caller knows what exactly went wrong.
 */
export function breakDeal(
  state: GameState,
  dealId: string,
  by: FamilyName,
  text?: string,
): { state: GameState; log?: TurnLogEntry } {
  const deal = (state.deals ?? []).find((d) => d.id === dealId);
  if (!deal || !isLive(deal, state.turn) || !state.playerFamily) return { state };
  const victim = deal.a === by ? deal.b : deal.a;
  const mine = by === state.playerFamily;
  const line =
    text ??
    (mine
      ? `You broke your ${dealKindLabel(deal.kind).toLowerCase()} with ${victim}. The Commission took note.`
      : `${by} broke the ${dealKindLabel(deal.kind).toLowerCase()} with you. The other families noticed.`);
  let next = breakFallout(
    {
      ...state,
      deals: state.deals.map((d) =>
        d.id === dealId ? { ...d, status: "breached" as const, breachedBy: by, untilTurn: state.turn } : d,
      ),
    },
    by,
    victim,
  );
  next = queueSettlement(next, deal, {
    outcome: "breached",
    cash: 0,
    relation: BREAK_RELATION_VICTIM,
    standing: mine ? -BREAK_STANDING : 0,
    breachedBy: by,
    text: line,
  });
  return {
    state: next,
    log: {
      id: `log_deal_break_${dealId}_${state.turn}`,
      turn: state.turn,
      category: "diplomacy",
      text: line,
      family: mine ? state.playerFamily : by,
    },
  };
}

/** Cash moves between the player and a rival. Positive = the player pays, dirty money first. */
function settleCash(state: GameState, other: FamilyName, cash: number): GameState {
  if (cash === 0) return state;
  if (cash > 0) {
    const dirty = Math.min(state.dirtyMoney, cash);
    return {
      ...state,
      dirtyMoney: state.dirtyMoney - dirty,
      money: state.money - (cash - dirty),
      rivalTreasury: { ...state.rivalTreasury, [other]: (state.rivalTreasury?.[other] ?? 0) + cash },
    };
  }
  return {
    ...state,
    money: state.money - cash,
    rivalTreasury: { ...state.rivalTreasury, [other]: (state.rivalTreasury?.[other] ?? 0) + cash },
  };
}

/**
 * A job owed is done: whoever owed it gets paid and the deal closes.
 * When the player owed the job, negative cash comes to him; when the rival
 * owed it, the player pays the positive cash he promised.
 */
export function honorDeal(state: GameState, dealId: string): { state: GameState; log?: TurnLogEntry } {
  const deal = (state.deals ?? []).find((d) => d.id === dealId);
  const player = state.playerFamily;
  if (!deal || !isLive(deal, state.turn) || !player) return { state };
  const other = dealPartner(state, deal);
  const theyOwed = !!deal.obligor && deal.obligor !== player;
  const cash = deal.terms.calledIn ? 0 : theyOwed ? Math.max(0, deal.terms.cash) : Math.min(0, deal.terms.cash);
  const next = settleCash(state, other, cash);
  const amount = Math.abs(cash);
  let text: string;
  if (deal.terms.calledIn) {
    text = `The favor is paid. ${other} calls it square.`;
  } else if (theyOwed) {
    text = `${other} did the job on ${deal.terms.targetFamily}. You pay the $${amount} you promised.`;
  } else if (deal.kind === "liquor") {
    text = `The crates reached ${other}'s speakeasy. $${amount} for your trouble.`;
  } else {
    text = `${other} pays $${amount}: the job they asked for is done.`;
  }
  return {
    state: queueSettlement(
      {
        ...next,
        relations: setRelationDelta(next.relations, player, other, HONOR_RELATION),
        reputation: {
          ...next.reputation,
          respect: Math.min(100, next.reputation.respect + HONOR_RESPECT),
        },
        deals: next.deals.map((d) =>
          d.id === dealId ? { ...d, status: "honored" as const, untilTurn: state.turn } : d,
        ),
      },
      deal,
      { outcome: "honored", cash, relation: HONOR_RELATION, standing: 0, respect: HONOR_RESPECT, text },
    ),
    log: {
      id: `log_deal_honor_${dealId}_${state.turn}`,
      turn: state.turn,
      category: "diplomacy",
      text,
      family: player,
    },
  };
}

/**
 * The player sends the crates a liquor order calls for, out of any of his
 * warehouses with the stock. Returns the reason if he can't.
 */
export function fulfilLiquorDeal(
  state: GameState,
  dealId: string,
): { state: GameState; log?: TurnLogEntry; error?: string } {
  const deal = (state.deals ?? []).find((d) => d.id === dealId);
  const player = state.playerFamily;
  if (!deal || deal.kind !== "liquor" || !isLive(deal, state.turn) || !player) {
    return { state, error: "That order is closed." };
  }
  const crates = deal.terms.crates ?? 0;
  const source = state.territories
    .filter((t) => t.owner === player && t.rackets.some((r) => r.type === "warehouse"))
    .map((t) => ({ t, stock: t.rackets.reduce((n, r) => n + (r.type === "warehouse" ? r.stock : 0), 0) }))
    .filter((x) => x.stock >= crates)
    .sort((a, b) => b.stock - a.stock)[0];
  if (!source) return { state, error: `No warehouse holds ${crates} crates.` };
  const wd = withdrawCrates(source.t, crates, state.turn);
  if (wd.moved < crates) return { state, error: `Only ${wd.moved} crates on hand in ${source.t.name}.` };
  const other = dealPartner(state, deal);
  const territories = state.territories.map((t) => {
    if (t.id === source.t.id) return wd.territory;
    if (t.id === deal.terms.destTerritoryId && t.owner === other) {
      // The crates land in their speakeasy.
      let placed = false;
      return {
        ...t,
        rackets: t.rackets.map((r) => {
          if (placed || r.type !== "speakeasy") return r;
          placed = true;
          return { ...r, stock: r.stock + crates };
        }),
      };
    }
    return t;
  });
  return honorDeal(
    { ...state, territories, liquorStock: Math.max(0, state.liquorStock - crates) },
    dealId,
  );
}

/* ------------------------------------------------------------------ */
/* Each week                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hits that landed this turn: a contract fulfilled, or a truce broken by
 * whoever pulled the trigger (a job planned before the handshake still counts).
 */
export function settleDealsAfterHits(
  state: GameState,
  results: HitResult[],
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  if (!player || results.length === 0) return { state, logs };
  let next = state;
  for (const hit of results) {
    const op = next.operations.find((o) => o.id === hit.operationId);
    if (!op || op.kind !== "hit") continue;
    const truce = truceBetween(next, op.family, op.targetFamily);
    if (truce && !hit.markAbsent) {
      const broke = breakDeal(next, truce.id, op.family);
      next = broke.state;
      if (broke.log) logs.push(broke.log);
    }
    if (hit.targetDead) {
      // Whoever owed the job — the player or a rival under contract to him.
      const contract = activeDeals(next).find(
        (d) => d.kind === "alliance" && d.obligor === op.family && d.terms.targetFamily === op.targetFamily,
      );
      if (contract) {
        const done = honorDeal(next, contract.id);
        next = done.state;
        if (done.log) logs.push(done.log);
      }
    }
  }
  return { state: next, logs };
}

/** Families under contract to `family`: who they've been paid to move on. */
export function contractedTargets(state: DealState, family: FamilyName): FamilyName[] {
  return activeDeals(state)
    .filter((d) => d.kind === "alliance" && d.obligor === family && d.terms.targetFamily)
    .map((d) => d.terms.targetFamily!);
}

/**
 * Truces run out, deadlines pass, and once in a while a hot-headed family
 * decides the paper isn't worth keeping.
 */
export function tickDeals(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  if (!player) return { state, logs };
  let next = state;

  for (const deal of state.deals ?? []) {
    if (deal.status !== "active") continue;
    const other = dealPartner(next, deal);
    const due = deal.untilTurn !== null && deal.untilTurn <= next.turn;

    if (due) {
      if (deal.obligor && (deal.kind === "liquor" || deal.kind === "alliance")) {
        // A job owed and not done is a breach by whoever owed it.
        const text =
          deal.obligor === player
            ? deal.terms.calledIn
              ? `You never paid back the favor ${other} called in. Now it's a grudge, and the other families heard.`
              : deal.kind === "liquor"
                ? `The crates never reached ${other}. They call it what it is.`
                : `${other}'s contract ran out with ${deal.terms.targetFamily} still standing. They want their word back.`
            : deal.kind === "alliance"
              ? `${other} never moved on ${deal.terms.targetFamily}. The contract is dead; you owe them nothing.`
              : `${other} let their side of the deal lapse.`;
        const broke = breakDeal(
          { ...next, deals: next.deals.map((d) => (d.id === deal.id ? { ...d, untilTurn: next.turn + 1 } : d)) },
          deal.id,
          deal.obligor,
          text,
        );
        next = broke.state;
        logs.push({
          id: `log_deal_missed_${deal.id}`,
          turn: next.turn,
          category: "diplomacy",
          text,
          family: deal.obligor === player ? player : other,
        });
      } else {
        next = {
          ...next,
          deals: next.deals.map((d) => (d.id === deal.id ? { ...d, status: "expired" as const } : d)),
        };
        if (deal.kind === "truce" || deal.kind === "cut") {
          const text =
            deal.kind === "truce"
              ? `Your truce with ${other} has run its course.`
              : `The cut of ${blockName(next, deal)}'s take with ${other} has run out.`;
          next = queueSettlement(next, deal, { outcome: "expired", cash: 0, relation: 0, standing: 0, text });
          logs.push({
            id: `log_deal_expired_${deal.id}`,
            turn: next.turn,
            category: "diplomacy",
            text,
            family: player,
          });
        }
      }
      continue;
    }

    if (deal.kind === "cut") {
      const block = next.territories.find((t) => t.id === deal.terms.territoryId);
      if (!block || block.owner !== deal.obligor) {
        // The block changed hands; there's no take left to split.
        const text = `${blockName(next, deal)} changed hands. The cut of its take is off.`;
        next = {
          ...next,
          deals: next.deals.map((d) => (d.id === deal.id ? { ...d, status: "expired" as const, untilTurn: next.turn } : d)),
        };
        next = queueSettlement(next, deal, { outcome: "expired", cash: 0, relation: 0, standing: 0, text });
        logs.push({
          id: `log_deal_cut_gone_${deal.id}`,
          turn: next.turn,
          category: "diplomacy",
          text,
          family: player,
        });
        continue;
      }
      const amount = weeklyCut(next, deal);
      if (amount <= 0) continue;
      if (deal.obligor === player) {
        if (next.money + next.dirtyMoney < amount) {
          // He can't cover the cut. That's a breach.
          const text = `You couldn't cover ${other}'s cut of ${block.name}. They call it a broken deal.`;
          const broke = breakDeal(next, deal.id, player, text);
          next = broke.state;
          logs.push({
            id: `log_deal_cut_short_${deal.id}_${next.turn}`,
            turn: next.turn,
            category: "diplomacy",
            text,
            family: player,
          });
          continue;
        }
        next = settleCash(next, other, amount);
      } else {
        const paid = Math.min(amount, Math.max(0, next.rivalTreasury?.[other] ?? 0));
        next = settleCash(next, other, -paid);
      }
      continue;
    }

    if (deal.kind === "truce") {
      const chance = AI_BREAK_CHANCE[getFamilyDef(other).personality] ?? 0.02;
      // A family in a vendetta against the player is looking for the excuse.
      const eager = next.vendettas.includes(other) ? 2 : 1;
      if (rng.chance(chance * eager)) {
        const broke = breakDeal(next, deal.id, other);
        next = broke.state;
        if (broke.log) logs.push(broke.log);
      }
    }
  }

  // History: keep the last dozen turns of dead deals.
  const trimmed = (next.deals ?? []).filter(
    (d) => d.status === "active" || (d.untilTurn ?? next.turn) > next.turn - 12,
  );
  return { state: { ...next, deals: trimmed }, logs };
}
