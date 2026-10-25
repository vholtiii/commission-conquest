import type {
  AiMemory,
  AiMemoryKind,
  AiPersonality,
  FamilyMind,
  FamilyName,
  GameState,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { createRng, hashString } from "../rng";
import { getRelation } from "../relations";
import { clamp, ensureMinds, MEMORY_CAP, mindOf, rivalFamilies, withMind } from "./minds";

/** Weeks for a memory to fade to half. A hothead holds on longest. */
export const MEMORY_HALF_LIFE: Record<AiPersonality, number> = {
  volatile: 20,
  covert: 16,
  expansionist: 14,
  smuggler: 12,
  economic: 10,
};

export const MEMORY_WEIGHT: Record<AiMemoryKind, number> = {
  hit_us: 2,
  killed_boss: 8,
  took_turf: 4,
  broke_truce: 6,
  shook_us: 1.5,
  kept_deal: -2,
  hit_our_enemy: -1.5,
  spared_us: -1,
};

/** How trust moves on each kind of memory. */
const TRUST_SHIFT: Partial<Record<AiMemoryKind, number>> = {
  broke_truce: -45,
  killed_boss: -30,
  took_turf: -8,
  hit_us: -6,
  shook_us: -3,
  kept_deal: 10,
  hit_our_enemy: 4,
};
/** Witnesses to a broken word think less of the breaker too. */
export const WITNESS_TRUST = -15;
/** Below this salience a memory is forgotten. */
const FORGET_AT = 0.15;
/** Base chance a family works out who hit it, before signatures. */
export const BLAME_KNOWN = 0.65;

export function salience(mem: AiMemory, turn: number, personality: AiPersonality): number {
  const age = Math.max(0, turn - mem.turn);
  return mem.weight * Math.pow(0.5, age / MEMORY_HALF_LIFE[personality]);
}

/** Net score against `actor`: grievances minus goodwill. Positive means a score to settle. */
export function grievance(mind: FamilyMind, actor: FamilyName, turn: number, personality: AiPersonality): number {
  let total = 0;
  for (const m of mind.memories) {
    if (m.actor === actor) total += salience(m, turn, personality);
  }
  return total;
}

export function trustIn(mind: FamilyMind, other: FamilyName): number {
  return mind.trust[other] ?? 0;
}

/** The family's biggest open score, if any is worth acting on. */
export function topGrievance(
  mind: FamilyMind,
  turn: number,
  personality: AiPersonality,
  alive: (f: FamilyName) => boolean,
): { actor: FamilyName; score: number } | undefined {
  const by = new Map<FamilyName, number>();
  for (const m of mind.memories) {
    if (!alive(m.actor)) continue;
    by.set(m.actor, (by.get(m.actor) ?? 0) + salience(m, turn, personality));
  }
  let best: { actor: FamilyName; score: number } | undefined;
  for (const [actor, score] of by) {
    if (score > 0 && (!best || score > best.score)) best = { actor, score };
  }
  return best;
}

function prune(mind: FamilyMind, turn: number, personality: AiPersonality): AiMemory[] {
  const kept = mind.memories.filter((m) => Math.abs(salience(m, turn, personality)) >= FORGET_AT);
  if (kept.length <= MEMORY_CAP) return kept;
  return [...kept]
    .sort((a, b) => Math.abs(salience(b, turn, personality)) - Math.abs(salience(a, turn, personality)))
    .slice(0, MEMORY_CAP)
    .sort((a, b) => a.turn - b.turn);
}

/** Add one memory to a rival's mind, with its trust shift. */
export function remember(
  state: GameState,
  family: FamilyName,
  kind: AiMemoryKind,
  actor: FamilyName,
  extra?: { territoryId?: string; weight?: number },
): GameState {
  if (family === state.playerFamily || family === actor) return state;
  const personality = getFamilyDef(family).personality;
  const mind = mindOf(state, family);
  const mem: AiMemory = {
    turn: state.turn,
    kind,
    actor,
    weight: extra?.weight ?? MEMORY_WEIGHT[kind],
    territoryId: extra?.territoryId,
  };
  const trust = { ...mind.trust };
  const shift = TRUST_SHIFT[kind];
  if (shift) trust[actor] = clamp((trust[actor] ?? 0) + shift, -100, 100);
  const next: FamilyMind = { ...mind, memories: prune({ ...mind, memories: [...mind.memories, mem] }, state.turn, personality), trust };
  return withMind(state, family, next);
}

/** Every rival but the two involved hears that `breaker` broke its word. */
export function witnessBreak(state: GameState, breaker: FamilyName, victim: FamilyName): GameState {
  let next = state;
  for (const f of rivalFamilies(state)) {
    if (f === breaker || f === victim) continue;
    const mind = mindOf(next, f);
    next = withMind(next, f, {
      ...mind,
      trust: { ...mind.trust, [breaker]: clamp((mind.trust[breaker] ?? 0) + WITNESS_TRUST, -100, 100) },
    });
  }
  return next;
}

/**
 * Who the victim thinks ordered the hit. A message, a betrayal at the table,
 * or open war signs the work. Otherwise they work it out most of the time,
 * and when they don't they blame whoever they already hate.
 */
export function believedAttacker(state: GameState, op: Operation): FamilyName | undefined {
  const victim = op.targetFamily;
  const attacker = op.family;
  if (op.intent === "message" || op.approach === "sitdown_betrayal" || op.intent === "commission") return attacker;
  const rel = getRelation(state.relations, victim, attacker);
  const rng = createRng(hashString(`${state.seed}:${op.id}:blame`));
  const known = BLAME_KNOWN + (rel < -40 ? 0.2 : 0) + (op.tippedOff ? 0.1 : 0);
  if (rng.chance(known)) return attacker;
  if (victim === state.playerFamily) return undefined;
  const personality = getFamilyDef(victim).personality;
  const scapegoat = topGrievance(mindOf(state, victim), state.turn, personality, (f) => f !== victim && f !== attacker);
  return scapegoat && rng.chance(0.5) ? scapegoat.actor : undefined;
}

function blockOwner(state: GameState, id: string): FamilyName | null {
  return state.territories.find((t) => t.id === id)?.owner ?? null;
}

/**
 * The week's memories, read off what changed between the start and the end
 * of the turn: hits, blocks changing hands, broken and kept deals, shakedowns.
 */
export function recordMemories(before: GameState, after: GameState, logs: TurnLogEntry[]): GameState {
  let next = ensureMinds(after);
  const player = after.playerFamily;
  const turn = after.turn;
  const wasResolved = new Set(before.operations.filter((o) => o.resolved).map((o) => o.id));

  const newHits = after.operations.filter(
    (o) =>
      o.kind === "hit" &&
      o.resolved &&
      (!wasResolved.has(o.id) || (o.family === player && o.resolvedTurn === before.turn)),
  );
  for (const op of newHits) {
    const victim = op.targetFamily;
    const mark = op.targetCrewId ? after.crew.find((c) => c.id === op.targetCrewId) : undefined;
    const wasAlive = op.targetCrewId
      ? before.crew.find((c) => c.id === op.targetCrewId)?.status !== "dead"
      : true;
    const killed = !!mark && mark.status === "dead" && wasAlive;
    const blamed = believedAttacker(next, op);
    if (blamed && victim !== player) {
      const kind: AiMemoryKind = killed && mark?.role === "boss" ? "killed_boss" : "hit_us";
      next = remember(next, victim, kind, blamed, {
        territoryId: op.targetTerritoryId,
        weight: kind === "hit_us" ? MEMORY_WEIGHT.hit_us + (killed ? 2 : 0) : undefined,
      });
      if (blamed === player) {
        const mind = mindOf(next, victim);
        next = withMind(next, victim, {
          ...mind,
          adapt: { ...mind.adapt, playerHits: [...mind.adapt.playerHits, turn].slice(-12) },
        });
      }
    }
    // The enemy of my enemy: a family with a score against the victim warms to the shooter.
    if (blamed === op.family) {
      for (const f of rivalFamilies(next)) {
        if (f === victim || f === op.family) continue;
        const p = getFamilyDef(f).personality;
        if (grievance(mindOf(next, f), victim, turn, p) >= 3) next = remember(next, f, "hit_our_enemy", op.family);
      }
    }
  }

  // Blocks that changed hands.
  for (const t of after.territories) {
    const prev = before.territories.find((x) => x.id === t.id);
    if (!prev || !prev.owner || prev.owner === t.owner || !t.owner) continue;
    next = remember(next, prev.owner, "took_turf", t.owner, { territoryId: t.id });
    if (t.owner === player && prev.owner !== player && prev.garrisonIds.length <= 1) {
      const mind = mindOf(next, prev.owner);
      next = withMind(next, prev.owner, {
        ...mind,
        adapt: { ...mind.adapt, weakHits: [...mind.adapt.weakHits, turn].slice(-12) },
      });
    }
  }

  // Deals with the player that closed this week.
  const prevStatus = new Map(before.deals.map((d) => [d.id, d.status]));
  for (const d of after.deals) {
    if (prevStatus.get(d.id) === d.status) continue;
    const other = d.a === player ? d.b : d.a;
    if (other === player) continue;
    if (d.status === "breached" && d.breachedBy === player) {
      next = remember(next, other, "broke_truce", player);
      next = witnessBreak(next, player!, other);
    } else if (d.status === "honored" || d.status === "expired") {
      next = remember(next, other, "kept_deal", player!);
    }
  }

  // Shakedowns name their victim block in the log id.
  for (const log of logs) {
    const m = /^ai_shake_([A-Za-z]+)_\d+_(.+)$/.exec(log.id);
    if (!m) continue;
    const shaker = m[1] as FamilyName;
    const victim = blockOwner(before, m[2]!);
    if (victim && victim !== shaker) next = remember(next, victim, "shook_us", shaker, { territoryId: m[2] });
  }

  return decayTrust(next);
}

/** Bad blood fades a point a week; good faith fades half as fast. */
function decayTrust(state: GameState): GameState {
  const minds = { ...(state.aiMinds ?? {}) };
  for (const f of rivalFamilies(state)) {
    const mind = minds[f];
    if (!mind) continue;
    const trust: FamilyMind["trust"] = {};
    for (const [k, v] of Object.entries(mind.trust) as [FamilyName, number][]) {
      const moved = v < 0 ? Math.min(0, v + 1) : Math.max(0, v - 0.5);
      if (moved !== 0) trust[k] = moved;
    }
    minds[f] = { ...mind, trust };
  }
  return { ...state, aiMinds: minds };
}
