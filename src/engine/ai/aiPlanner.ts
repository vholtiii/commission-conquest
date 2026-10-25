import type {
  AiGoal,
  AiGoalKind,
  AiOptionTrace,
  AiPersonality,
  FamilyMind,
  FamilyName,
  GameState,
  Territory,
} from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { Rng } from "../rng";
import { getRelation } from "../relations";
import { atPeace } from "../deals";
import { captureAllowance } from "../capture";
import { isDefunct } from "../defection";
import { handsDown } from "../mourning";
import { familiesPressingSuddenDeath } from "../victory";
import { maxRacketsFor, valueScore, allowedRacketTypes } from "../territoryValue";
import { safehouseCaptureDefence } from "../safehouse";
import { mattressDistrict, MATTRESS_DEFENCE } from "../mattresses";
import { RACKET_BUILD_COST } from "../economy";
import { grievance, topGrievance, trustIn } from "./aiMemory";
import {
  believedCrewSite,
  believedGarrison,
  believedStrength,
  believedWealth,
  garrisonConfidence,
  liveGarrison,
  SCOUT_COST,
} from "./aiBeliefs";
import { coalitionTarget } from "./rivalPacts";
import { mindOf, withMind } from "./minds";

export type AiActionKind =
  | "expand"
  | "scout"
  | "shift"
  | "hit"
  | "shakedown"
  | "build"
  | "hijack"
  | "delivery"
  | "seek_peace";

export interface AiAction {
  kind: AiActionKind;
  targetFamily?: FamilyName;
  territoryId?: string;
  score: number;
  /** How well this serves the current goal; 1 is neutral. */
  fit: number;
  reasons: string[];
}

interface Style {
  /** How readily the family reaches for each kind of move. */
  act: Record<Exclude<AiActionKind, "scout" | "shift" | "seek_peace">, number>;
  /** How much each goal appeals. */
  goal: Record<AiGoalKind, number>;
  /** A challenger must beat the current goal by this share to replace it. */
  patience: number;
  /** Weight on the chance of success against the cost of failure. */
  risk: number;
}

export const STYLES: Record<AiPersonality, Style> = {
  economic: {
    act: { build: 1, expand: 0.45, shakedown: 0.45, hit: 0.45, hijack: 0.35, delivery: 0.35 },
    goal: { expand: 0.8, consolidate: 1, enrich: 1.3, retaliate: 0.7, contain_leader: 1.1, recover: 1.2, seek_peace: 1.2 },
    patience: 0.35,
    risk: 0.8,
  },
  expansionist: {
    act: { build: 0.4, expand: 0.7, shakedown: 0.45, hit: 0.7, hijack: 0.3, delivery: 0.25 },
    goal: { expand: 1.4, consolidate: 0.8, enrich: 0.7, retaliate: 0.9, contain_leader: 1, recover: 1, seek_peace: 0.6 },
    patience: 0.25,
    risk: 1.1,
  },
  covert: {
    act: { build: 0.65, expand: 0.3, shakedown: 0.4, hit: 1, hijack: 0.9, delivery: 0.3 },
    goal: { expand: 0.7, consolidate: 1, enrich: 1, retaliate: 1.1, contain_leader: 1.2, recover: 1, seek_peace: 0.9 },
    patience: 0.5,
    risk: 0.9,
  },
  smuggler: {
    act: { build: 0.65, expand: 0.3, shakedown: 0.4, hit: 0.45, hijack: 0.9, delivery: 1.1 },
    goal: { expand: 0.7, consolidate: 0.9, enrich: 1.3, retaliate: 0.9, contain_leader: 0.9, recover: 1, seek_peace: 1 },
    patience: 0.3,
    risk: 0.9,
  },
  volatile: {
    act: { build: 0.35, expand: 0.26, shakedown: 0.45, hit: 1.4, hijack: 0.3, delivery: 0.2 },
    goal: { expand: 0.5, consolidate: 0.7, enrich: 0.6, retaliate: 1.25, contain_leader: 0.9, recover: 0.9, seek_peace: 0.4 },
    patience: 0.1,
    risk: 1.15,
  },
};

/** A goal older than this is re-weighed from scratch. */
export const GOAL_MAX_WEEKS = 10;
/** Two failed steps and the plan is dropped. */
export const GOAL_MAX_FAILURES = 2;
/** Turf share at which the rest of the table starts to worry. */
export const LEADER_SHARE = 0.25;
/** Player hits in 8 weeks that make a family either fold or dig in. */
export const INTIMIDATION_HITS = 3;
const DEFIANCE_PULL = 0.6;
/** Extra appeal of building when the player's books dwarf everyone's. */
const DOMINANCE_PULL = 0.4;
/** Blocks one man can keep an eye on before claiming empty ground overextends the family. */
const BLOCKS_PER_MAN = 0.45;
const MIN_REACH = 0.2;
/** Weeks a family spends settling a new block before it reaches for the next. */
export const DIGEST_WEEKS = 4;
const DIGEST_DAMPING = 0.4;
/** Appetite for the player's blocks when the player isn't the family's target. */
const PLAYER_WARINESS = 0.5;
/** A family won't sue for peace with a runaway leader; it looks to contain it instead. */
const APPEASE_LEADER = 0.35;
/** Share of the predicted blowback a family accepts when it has set out to contain the leader. */
const CONTAIN_BLOWBACK = 0.4;
/** How hard a leader's lead weighs against a family's own plans. */
const CONTAIN_URGENCY = 1;
/** Sampling temperature: low keeps families sensible, above zero keeps them readable but not scripted. */
const TEMPERATURE = 0.45;

interface Ctx {
  state: GameState;
  family: FamilyName;
  personality: AiPersonality;
  style: Style;
  mind: FamilyMind;
  treasury: number;
  heat: number;
  men: number;
  owned: Territory[];
  alive: FamilyName[];
}

function context(state: GameState, family: FamilyName): Ctx {
  const personality = getFamilyDef(family).personality;
  return {
    state,
    family,
    personality,
    style: STYLES[personality],
    mind: mindOf(state, family),
    treasury: state.rivalTreasury?.[family] ?? 0,
    heat: state.rivalHeat?.[family] ?? 0,
    men: state.crew.filter((c) => c.family === family && c.status === "active").length,
    owned: state.territories.filter((t) => t.owner === family),
    alive: ALL_FAMILY_NAMES.filter((f) => f !== family && !isDefunct(state, f)),
  };
}

function territory(state: GameState, id: string | undefined): Territory | undefined {
  return id ? state.territories.find((t) => t.id === id) : undefined;
}

/** 1 while the family has the men to hold what it has; less as each man covers more blocks. */
function spreadFactor(ctx: Ctx): number {
  const perMan = ctx.owned.length / Math.max(1, ctx.men);
  return Math.max(MIN_REACH, Math.min(1, BLOCKS_PER_MAN / Math.max(perMan, 0.01)));
}

function borderTargets(ctx: Ctx): Territory[] {
  const ids = new Set<string>();
  for (const t of ctx.owned) for (const a of t.adjacentTerritories) ids.add(a);
  return ctx.state.territories.filter(
    (t) =>
      ids.has(t.id) &&
      t.owner !== ctx.family &&
      (!t.owner || !atPeace(ctx.state, ctx.family, t.owner)) &&
      captureAllowance(ctx.state, ctx.family, t).ok,
  );
}

function fortification(state: GameState, t: Territory): number {
  return t.owner
    ? safehouseCaptureDefence(t, state.turn) - 1 + (mattressDistrict(state, t.id) ? MATTRESS_DEFENCE : 0)
    : 0;
}

/** Chance a grab works, as the family reads the block. Mirrors the roll in `tryExpand`. */
export function believedCaptureChance(ctx: Ctx, t: Territory): number {
  if (!t.owner) return 1;
  const g = believedGarrison(ctx.state, ctx.family, t);
  const threshold = Math.max(
    0.05,
    0.35 + t.defenseBonus + fortification(ctx.state, t) + g * 0.05 - 0.05 * Math.min(2, maxRacketsFor(t) - 3),
  );
  return Math.max(0, Math.min(1, 1 - threshold));
}

/** Who is running away with the city, as anyone at the table can see it. */
export function cityLeader(state: GameState, family: FamilyName): { leader: FamilyName; pressure: number; why: string } | undefined {
  const total = state.territories.length || 1;
  const pressing = familiesPressingSuddenDeath(state);
  let best: { leader: FamilyName; pressure: number; why: string } | undefined;
  const wealth = ALL_FAMILY_NAMES.filter((f) => !isDefunct(state, f)).map((f) => ({ f, w: believedWealth(state, f) }));
  const sorted = [...wealth].sort((a, b) => b.w - a.w);
  for (const f of ALL_FAMILY_NAMES) {
    if (f === family || isDefunct(state, f)) continue;
    const share = state.territories.filter((t) => t.owner === f).length / total;
    let pressure = Math.max(0, share - LEADER_SHARE) * 6;
    let why = `${Math.round(share * 100)}% of the city`;
    if (pressing.includes(f)) {
      pressure += 1.5;
      why = `pressing the Commission, ${why}`;
    }
    if (sorted[0]?.f === f && sorted[1] && sorted[0].w > sorted[1].w * 1.8) {
      pressure += 0.8;
      why = `the richest books by far, ${why}`;
    }
    if (pressure > 0 && (!best || pressure > best.pressure)) best = { leader: f, pressure, why };
  }
  return best;
}

interface GoalOption {
  goal: Omit<AiGoal, "since" | "step" | "failures">;
  reason: string;
}

function recent(turns: number[], now: number, weeks: number): number {
  return turns.filter((t) => now - t < weeks).length;
}

function goalOptions(ctx: Ctx): GoalOption[] {
  const { state, family, style, mind, personality } = ctx;
  const out: GoalOption[] = [];
  const turn = state.turn;

  // Expand: the best block next door, as the family reads its defence.
  const border = borderTargets(ctx)
    .map((t) => ({ t, v: (valueScore(t) / 1000) * (0.4 + believedCaptureChance(ctx, t)) }))
    .sort((a, b) => b.v - a.v);
  if (border[0]) {
    const cash = ctx.treasury >= 500 ? 1 : 0.6;
    out.push({
      goal: {
        kind: "expand",
        territoryId: border[0].t.id,
        target: border[0].t.owner ?? undefined,
        score: style.goal.expand * Math.min(2, border[0].v) * cash * (border[0].t.owner ? 1 : spreadFactor(ctx)),
      },
      reason: `${border[0].t.name} looks ${border[0].t.owner ? "lightly held" : "open"} next door`,
    });
  }

  // Enrich: room to build and money to build with, more so when the player's books dwarf ours.
  const lead = cityLeader(state, family);
  const outEarned = !!lead && lead.leader === state.playerFamily && lead.why.startsWith("the richest");
  const slots = ctx.owned.reduce((n, t) => n + Math.max(0, maxRacketsFor(t) - t.rackets.length), 0);
  if (slots > 0 && ctx.treasury >= 1500) {
    out.push({
      goal: { kind: "enrich", score: style.goal.enrich * (0.8 + Math.min(0.6, slots * 0.1) + (outEarned ? DOMINANCE_PULL : 0)) },
      reason: `${slots} open lots and cash to build${outEarned ? ", and the player is out-earning everyone" : ""}`,
    });
  }

  // Retaliate: the biggest open score. A family the player keeps hitting
  // answers if it is strong or hot-headed; a weak one looks for peace below.
  const score = topGrievance(mind, turn, personality, (f) => ctx.alive.includes(f));
  if (score && !atPeace(state, family, score.actor)) {
    const pushed = score.actor === state.playerFamily ? recent(mind.adapt.playerHits, turn, 8) : 0;
    const ratio = believedStrength(state, family, score.actor) / Math.max(1, ctx.men);
    const defiant = pushed >= INTIMIDATION_HITS && (ratio <= 1 || personality === "volatile") ? DEFIANCE_PULL : 0;
    out.push({
      goal: { kind: "retaliate", target: score.actor, score: style.goal.retaliate * (Math.min(2.5, score.score / 3) + defiant) },
      reason: `a score to settle with ${score.actor} (${score.score.toFixed(1)})${defiant ? ", and we won't be pushed around" : ""}`,
    });
  }

  // Contain the leader, harder if the family has signed on to a coalition.
  const pact = coalitionTarget(state, family);
  if (lead && !atPeace(state, family, lead.leader)) {
    const bonus = pact === lead.leader ? 0.8 : 0;
    out.push({
      goal: { kind: "contain_leader", target: lead.leader, score: style.goal.contain_leader * (lead.pressure * CONTAIN_URGENCY + bonus) },
      reason: `${lead.leader} is pulling ahead: ${lead.why}${bonus ? ", and we have a coalition" : ""}`,
    });
  }

  // Recover: broke, hot, or thin on men.
  let recover = 0;
  const why: string[] = [];
  if (ctx.treasury < 600) {
    recover += 1.6;
    why.push("the treasury is nearly empty");
  }
  if (ctx.heat >= 60) {
    recover += (ctx.heat - 60) / 30;
    why.push(`police heat at ${Math.round(ctx.heat)}`);
  }
  if (ctx.men < 4) {
    recover += 0.6;
    why.push("too few men");
  }
  if (recover > 0) out.push({ goal: { kind: "recover", score: style.goal.recover * recover }, reason: why.join(", ") });

  // Consolidate: thin borders, a block just lost, or a lesson learned about weak blocks.
  const thin = thinBorderBlocks(ctx);
  const lost = mind.memories.some((m) => m.kind === "took_turf" && turn - m.turn < 4);
  const cons = Math.min(1.5, thin.length * 0.5) + (lost ? 0.8 : 0) + (mind.adapt.minBorder > 0 && thin.length > 0 ? 0.4 : 0);
  if (cons > 0) {
    out.push({
      goal: { kind: "consolidate", territoryId: thin[0]?.id, score: style.goal.consolidate * cons },
      reason: [thin.length ? `${thin.length} border blocks thinly held` : "", lost ? "we just lost a block" : ""].filter(Boolean).join(", "),
    });
  }

  // Seek peace: someone stronger keeps hitting us.
  let worst: { f: FamilyName; v: number; why: string } | undefined;
  for (const f of ctx.alive) {
    if (atPeace(state, family, f)) continue;
    const hits = mind.memories.filter((m) => m.actor === f && (m.kind === "hit_us" || m.kind === "took_turf" || m.kind === "killed_boss") && turn - m.turn < 8).length;
    if (hits === 0) continue;
    const ratio = believedStrength(state, family, f) / Math.max(1, ctx.men);
    const intimidated = f === state.playerFamily ? recent(mind.adapt.playerHits, turn, 8) : 0;
    const cowed = intimidated >= INTIMIDATION_HITS && ratio > 1 && personality !== "volatile";
    const v = Math.max(0, ratio - 1) * 1.5 + hits * 0.25 + (cowed ? 0.8 : 0);
    if (v > 0 && (!worst || v > worst.v)) worst = { f, v, why: `${f} keeps hitting us and looks ${ratio.toFixed(1)}x our size` };
  }
  if (worst) {
    const appeasing = lead && lead.leader === worst.f && lead.pressure >= 0.6 ? APPEASE_LEADER : 1;
    out.push({ goal: { kind: "seek_peace", target: worst.f, score: style.goal.seek_peace * worst.v * appeasing }, reason: worst.why });
  }

  return out;
}

/** Weak blocks taken in this many weeks before the family learns to man its border. */
export const WEAK_HIT_LESSON = 2;
/** How far back the family remembers losing weak blocks, and being hit by the player. */
export const ADAPT_WINDOW = 10;
const ADAPT_KEEP = 20;

/** Learn from the last few weeks: weak blocks lost twice means two men on every border. */
export function refreshAdapt(state: GameState, family: FamilyName): GameState {
  const mind = mindOf(state, family);
  const turn = state.turn;
  const keep = (xs: number[]) => xs.filter((t) => turn - t < ADAPT_KEEP);
  const weakHits = keep(mind.adapt.weakHits);
  const playerHits = keep(mind.adapt.playerHits);
  const minBorder = recent(weakHits, turn, ADAPT_WINDOW) >= WEAK_HIT_LESSON ? 2 : 0;
  if (
    minBorder === mind.adapt.minBorder &&
    weakHits.length === mind.adapt.weakHits.length &&
    playerHits.length === mind.adapt.playerHits.length
  ) {
    return state;
  }
  return withMind(state, family, { ...mind, adapt: { ...mind.adapt, weakHits, playerHits, minBorder } });
}

/** Owned blocks bordering another family with fewer men than the family now insists on. */
export function thinBorderBlocks(ctx: Pick<Ctx, "state" | "family" | "owned" | "mind">): Territory[] {
  const floor = Math.max(1, ctx.mind.adapt.minBorder);
  return ctx.owned.filter((t) => {
    const exposed = t.adjacentTerritories.some((id) => {
      const o = territory(ctx.state, id)?.owner;
      return !!o && o !== ctx.family;
    });
    return exposed && liveGarrison(ctx.state, t) < floor && t.rackets.length > 0;
  });
}

function sameGoal(a: Pick<AiGoal, "kind" | "target" | "territoryId">, b: Pick<AiGoal, "kind" | "target" | "territoryId">): boolean {
  return a.kind === b.kind && a.target === b.target && (a.kind !== "expand" || a.territoryId === b.territoryId);
}

function goalDone(state: GameState, family: FamilyName, goal: AiGoal): boolean {
  switch (goal.kind) {
    case "expand":
      return territory(state, goal.territoryId)?.owner === family;
    case "retaliate":
      return goal.step >= 2;
    case "recover":
      return (state.rivalTreasury?.[family] ?? 0) >= 1500 && (state.rivalHeat?.[family] ?? 0) < 50;
    case "seek_peace":
      return !!goal.target && atPeace(state, family, goal.target);
    default:
      return goal.step >= 3;
  }
}

/**
 * Keep the current goal unless it is finished, has failed twice, has run
 * too long, or a new one beats it by more than the family's patience.
 */
export function chooseGoal(state: GameState, family: FamilyName): { state: GameState; goal: AiGoal | null; reason: string } {
  const ctx = context(state, family);
  const mind = ctx.mind;
  const options = goalOptions(ctx).sort((a, b) => b.goal.score - a.goal.score);
  const best = options[0];
  let stats = mind.stats;
  let current = mind.goal;
  let reason = "";

  if (current && goalDone(state, family, current)) {
    stats = { ...stats, plansDone: stats.plansDone + 1 };
    current = null;
  }
  if (current) {
    const still = options.find((o) => sameGoal(o.goal, current!));
    const stale =
      !still ||
      current.failures >= GOAL_MAX_FAILURES ||
      state.turn - current.since >= GOAL_MAX_WEEKS ||
      (best && !sameGoal(best.goal, current) && best.goal.score > still.goal.score * (1 + ctx.style.patience));
    if (!stale) {
      return {
        state: withMind(state, family, { ...mind, stats, goal: { ...current, score: still!.goal.score } }),
        goal: { ...current, score: still!.goal.score },
        reason: `sticking with it: ${still!.reason}`,
      };
    }
    stats = {
      ...stats,
      goalSwitches: stats.goalSwitches + 1,
      plansAbandoned: stats.plansAbandoned + (current.step > 0 ? 1 : 0),
    };
    reason = current.failures >= GOAL_MAX_FAILURES ? "the last plan failed twice; " : "";
  }
  if (!best || best.goal.score < 0.15) {
    return { state: withMind(state, family, { ...mind, stats, goal: null }), goal: null, reason: `${reason}nothing pressing` };
  }
  const goal: AiGoal = { ...best.goal, since: state.turn, step: 0, failures: 0 };
  return {
    state: withMind(state, family, { ...mind, stats, goal }),
    goal,
    reason: `${reason}${best.reason}`,
  };
}

/**
 * Predicted cost of provoking `other`: its size against ours, and its temper.
 * Shared with a coalition, or accepted because it is the leader we set out to contain.
 */
function blowback(ctx: Ctx, other: FamilyName): number {
  const ratio = believedStrength(ctx.state, ctx.family, other) / Math.max(1, ctx.men);
  const temper = getFamilyDef(other).personality === "volatile" ? 1.3 : 1;
  const shared = coalitionTarget(ctx.state, ctx.family) === other ? 0.5 : 1;
  const goal = ctx.mind.goal;
  const accepted = goal?.kind === "contain_leader" && goal.target === other ? CONTAIN_BLOWBACK : 1;
  return Math.max(0, ratio - 0.6) * 0.35 * temper * shared * accepted;
}

function knowsMenOf(ctx: Ctx, other: FamilyName): boolean {
  return ctx.state.crew.some(
    (c) => c.family === other && c.status === "active" && !!believedCrewSite(ctx.state, ctx.family, c.id),
  );
}

/** Every move on the table this week, scored against the goal. */
export function candidateActions(state: GameState, family: FamilyName, goal: AiGoal | null): AiAction[] {
  const ctx = context(state, family);
  const { style } = ctx;
  const out: AiAction[] = [];
  const g = goal?.kind;
  const target = goal?.target;
  const saving = g === "recover";

  // Grabs next door, slower while the last one is still being digested or the men are spread thin.
  const digesting = ctx.mind.adapt.lastCapture != null && state.turn - ctx.mind.adapt.lastCapture < DIGEST_WEEKS;
  const reach = spreadFactor(ctx);
  for (const t of borderTargets(ctx)) {
    const p = believedCaptureChance(ctx, t);
    const conf = garrisonConfidence(state, family, t);
    let fit = 1;
    const reasons: string[] = [];
    if (digesting) reasons.push("still settling the last block");
    if (g === "expand" && t.id === goal?.territoryId) {
      fit = 1.7;
      reasons.push("the block we set out to take");
    } else if ((g === "contain_leader" || g === "retaliate") && t.owner && t.owner === target) {
      fit = 1.8;
      reasons.push(`takes turf from ${target}`);
    } else if (saving || g === "consolidate") {
      fit = 0.4;
    }
    const thin = t.owner ? 1 : reach;
    let s = style.act.expand * fit * (valueScore(t) / 1000) * (p * style.risk + 0.1) * (digesting ? DIGEST_DAMPING : 1) * thin;
    if (thin < 1) reasons.push("our men are spread thin");
    reasons.push(`${Math.round(p * 100)}% by our read of ${t.name}`);
    if (t.owner && conf < 0.3) {
      s *= 0.6;
      reasons.push("no fresh eyes on it");
    }
    if (t.owner === state.playerFamily && target !== t.owner) {
      s *= PLAYER_WARINESS;
      reasons.push("the player answers for every block");
    }
    if (t.owner) {
      const b = blowback(ctx, t.owner);
      s -= b;
      if (b > 0.1) reasons.push(`${t.owner} may answer`);
    }
    out.push({ kind: "expand", territoryId: t.id, targetFamily: t.owner ?? undefined, score: s, fit, reasons });
  }

  // A look before committing: the goal's block, or the target's turf.
  if (ctx.treasury >= SCOUT_COST + 250) {
    const wanted: Territory[] = [];
    const goalBlock = territory(state, goal?.territoryId);
    if (goalBlock && goalBlock.owner && goalBlock.owner !== family) wanted.push(goalBlock);
    if (target && (g === "retaliate" || g === "contain_leader")) {
      wanted.push(...state.territories.filter((t) => t.owner === target).slice(0, 4));
    }
    for (const t of wanted) {
      const conf = garrisonConfidence(state, family, t);
      if (conf >= 0.6) continue;
      out.push({
        kind: "scout",
        territoryId: t.id,
        targetFamily: t.owner ?? undefined,
        score: 0.9 * 1.6 * (1 - conf),
        fit: 1.6,
        reasons: [`stale read on ${t.name}`, "look before we move"],
      });
    }
  }

  // Men to the border: a thin block, or the block next to the one we want.
  const thin = thinBorderBlocks(ctx);
  for (const t of thin.slice(0, 2)) {
    const fit = g === "consolidate" ? 1.8 : 1;
    out.push({ kind: "shift", territoryId: t.id, score: 0.7 * fit, fit, reasons: [`${t.name} is thinly held on the border`] });
  }

  // Hits.
  if (!handsDown(state) && state.interregnum?.family !== family) {
    for (const f of ctx.alive) {
      if (atPeace(state, family, f)) continue;
      const rel = getRelation(state.relations, family, f);
      const grudge = grievance(ctx.mind, f, state.turn, ctx.personality);
      let fit = 0.5;
      const reasons: string[] = [];
      if (f === target && (g === "retaliate" || g === "contain_leader")) {
        fit = 1.6;
        reasons.push(g === "retaliate" ? `payback on ${f}` : `cut ${f} down to size`);
      } else if (rel < -20 || grudge > 1.5) {
        fit = 1;
        reasons.push(grudge > 1.5 ? `old score with ${f}` : `bad blood with ${f}`);
      }
      if (saving || g === "seek_peace") fit *= 0.3;
      const eyes = knowsMenOf(ctx, f);
      if (!eyes) reasons.push("no eyes on their men");
      const b = blowback(ctx, f);
      const s = style.act.hit * fit * (eyes ? 1 : 0.45) * style.risk - b;
      if (b > 0.1) reasons.push(`${f} hits back hard`);
      out.push({ kind: "hit", targetFamily: f, score: s, fit, reasons });
    }
  }

  // Shakedowns on blocks next door the family believes nobody is guarding.
  const nextDoor = new Set(ctx.owned.flatMap((t) => t.adjacentTerritories));
  for (const t of state.territories) {
    if (!nextDoor.has(t.id) || !t.owner || t.owner === family || t.rackets.length === 0) continue;
    if (atPeace(state, family, t.owner)) continue;
    if (believedGarrison(state, family, t) >= 0.5) continue;
    const fit = t.owner === target ? 1.6 : saving ? 1.3 : 1;
    out.push({
      kind: "shakedown",
      territoryId: t.id,
      targetFamily: t.owner,
      score: style.act.shakedown * fit * (0.5 + valueScore(t) / 2000) - blowback(ctx, t.owner) * 0.5,
      fit,
      reasons: [`${t.name} looks unguarded`],
    });
  }

  // Building.
  const cheapest = Math.min(
    ...ctx.owned.flatMap((t) =>
      t.rackets.length < maxRacketsFor(t) ? allowedRacketTypes(t).map((type) => RACKET_BUILD_COST[type] ?? 99999) : [99999],
    ),
    99999,
  );
  if (cheapest <= ctx.treasury) {
    const fit = g === "enrich" ? 1.5 : saving ? 0.2 : 1;
    out.push({ kind: "build", score: style.act.build * fit, fit, reasons: ["open lot and cash to build"] });
  }

  // Hijacks.
  const routes = state.routes.filter((r) => r.status === "active" && r.family !== family && !atPeace(state, family, r.family));
  if (routes.length > 0) {
    const lead = cityLeader(state, family);
    const fams = [...new Set(routes.map((r) => r.family))];
    for (const f of fams) {
      let fit = f === target ? 1.6 : 1;
      const reasons = [`${f} trucks on the road`];
      if (lead?.leader === f && f === state.playerFamily) {
        fit *= 1.4;
        reasons.push("bleed the richest books");
      }
      out.push({ kind: "hijack", targetFamily: f, score: style.act.hijack * fit, fit, reasons });
    }
  }

  // Liquor runs between their own blocks.
  if (ctx.owned.length >= 2) {
    const fit = g === "enrich" ? 1.2 : 1;
    out.push({ kind: "delivery", score: style.act.delivery * fit, fit, reasons: ["move product between our blocks"] });
  }

  // Peace feelers.
  if (g === "seek_peace" && target && trustIn(ctx.mind, target) > -60) {
    out.push({ kind: "seek_peace", targetFamily: target, score: 1.5, fit: 2, reasons: [`send word to ${target}`] });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * Pick `budget` moves: mostly the best, with a seeded softmax so a family is
 * readable but not scripted. One of each kind a week.
 */
export function pickActions(options: AiAction[], budget: number, rng: Rng): AiAction[] {
  const pool = options.filter((o) => o.score > 0.05);
  const chosen: AiAction[] = [];
  const kinds = new Map<AiActionKind, number>();
  while (chosen.length < budget && pool.length > 0) {
    const top = Math.max(...pool.map((o) => o.score));
    const weights = pool.map((o) => Math.exp((o.score - top) / TEMPERATURE));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rng.next() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      roll -= weights[idx]!;
      if (roll <= 0) break;
    }
    const pick = pool.splice(idx, 1)[0]!;
    const n = kinds.get(pick.kind) ?? 0;
    if (n >= 1) continue;
    kinds.set(pick.kind, n + 1);
    chosen.push(pick);
  }
  return chosen;
}

export function actionLabel(a: Pick<AiAction, "kind" | "targetFamily" | "territoryId">, state: GameState): string {
  const block = territory(state, a.territoryId)?.name;
  switch (a.kind) {
    case "expand":
      return `take ${block}`;
    case "scout":
      return `watch ${block}`;
    case "shift":
      return `reinforce ${block}`;
    case "hit":
      return `hit ${a.targetFamily}`;
    case "shakedown":
      return `shake down ${block}`;
    case "hijack":
      return `hijack ${a.targetFamily} trucks`;
    case "seek_peace":
      return `make peace with ${a.targetFamily}`;
    default:
      return a.kind;
  }
}

export function traceOptions(options: AiAction[], state: GameState): AiOptionTrace[] {
  return options.slice(0, 6).map((o) => ({ action: actionLabel(o, state), score: Math.round(o.score * 100) / 100, reasons: o.reasons }));
}

/** Book a step on the goal: a move that served it, and whether it worked. */
export function noteStep(state: GameState, family: FamilyName, action: AiAction, worked: boolean): GameState {
  const mind = mindOf(state, family);
  const goal = mind.goal;
  if (!goal || action.fit < 1.4) return state;
  const next: AiGoal = worked ? { ...goal, step: goal.step + 1 } : { ...goal, failures: goal.failures + 1 };
  return withMind(state, family, { ...mind, goal: next });
}
