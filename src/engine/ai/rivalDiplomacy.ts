import type {
  AiPersonality,
  FamilyName,
  GameState,
  RivalPact,
  RivalPactEvent,
  RivalPactKind,
  TurnLogEntry,
} from "@/types/game";
import { getFamilyDef } from "@/data/families";
import type { Rng } from "../rng";
import { isDefunct } from "../defection";
import { grievance, remember, trustIn, witnessBreak } from "./aiMemory";
import { cityLeader } from "./aiPlanner";
import { mindOf, rivalFamilies } from "./minds";
import { activeRivalPacts, rivalPactBetween } from "./rivalPacts";

/** Weekly chance a family tears up a pact, before grudges and trust. */
export const PACT_BREAK: Record<AiPersonality, number> = {
  volatile: 0.04,
  expansionist: 0.025,
  covert: 0.02,
  smuggler: 0.015,
  economic: 0.01,
};
/** Leader pressure at which the others start lining up against it. */
export const COALITION_PRESSURE = 0.4;
export const COALITION_WEEKS = 8;
export const COALITION_SIGN_CHANCE = 0.5;
export const TRUCE_ACCEPT_CHANCE = 0.6;
/** Grievance a family will swallow to sign a truce. A hothead swallows less. */
const TRUCE_SWALLOW: Record<AiPersonality, number> = {
  volatile: 1.5,
  expansionist: 2.5,
  covert: 3,
  smuggler: 3.5,
  economic: 4,
};
const PACT_LOG_CAP = 50;

function personality(f: FamilyName): AiPersonality {
  return getFamilyDef(f).personality;
}

function sharedBorder(state: GameState, a: FamilyName, b: FamilyName): string | undefined {
  for (const t of state.territories) {
    if (t.owner !== a) continue;
    for (const id of t.adjacentTerritories) {
      if (state.territories.find((x) => x.id === id)?.owner === b) return t.id;
    }
  }
  return undefined;
}

function withPacts(state: GameState, pacts: RivalPact[], events: RivalPactEvent[]): GameState {
  return {
    ...state,
    diplomacy: {
      ...state.diplomacy,
      rivalPacts: pacts,
      rivalPactLog: [...(state.diplomacy.rivalPactLog ?? []), ...events].slice(-PACT_LOG_CAP),
    },
  };
}

function pactLog(state: GameState, pact: Pick<RivalPact, "a" | "b">, id: string, text: string): TurnLogEntry {
  return {
    id,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: pact.a,
    territoryId: sharedBorder(state, pact.a, pact.b),
    tone: "intel",
  };
}

function sign(
  state: GameState,
  a: FamilyName,
  b: FamilyName,
  kind: RivalPactKind,
  weeks: number,
  target?: FamilyName,
): { state: GameState; log: TurnLogEntry } {
  const pact: RivalPact = { a, b, kind, target, since: state.turn, until: state.turn + weeks };
  const next = withPacts(state, [...activeRivalPacts(state), pact], [{ turn: state.turn, a, b, kind, event: "signed", cause: target ? `against ${target}` : undefined }]);
  const text =
    kind === "coalition"
      ? `${a} and ${b} close ranks against ${target}. Word is neither will raise a hand to the other while ${target} stands.`
      : `${a} and ${b} shook hands. No hands raised between them for ${weeks} weeks.`;
  return { state: next, log: pactLog(next, pact, `log_rpact_${kind}_${a}_${b}_${state.turn}`, text) };
}

/**
 * Rival families talk to each other. Pacts lapse or fall apart, families
 * that fear the same leader close ranks, and a family seeking peace with a
 * rival gets an answer. Breaking a pact is remembered by everyone.
 */
export function tickRivalDiplomacy(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  let next = state;
  const all = next.diplomacy.rivalPacts ?? [];
  const events: RivalPactEvent[] = [];
  const kept: RivalPact[] = [];

  for (const p of all) {
    if (isDefunct(next, p.a) || isDefunct(next, p.b)) continue;
    if (p.until <= next.turn) {
      events.push({ turn: next.turn, a: p.a, b: p.b, kind: p.kind, event: "expired" });
      continue;
    }
    if (p.kind === "coalition" && p.target) {
      const lead = cityLeader(next, p.a);
      if (!lead || lead.leader !== p.target || lead.pressure < COALITION_PRESSURE / 2 || isDefunct(next, p.target)) {
        events.push({ turn: next.turn, a: p.a, b: p.b, kind: p.kind, event: "dissolved", cause: `${p.target} no longer the threat` });
        logs.push(pactLog(next, p, `log_rpact_end_${p.a}_${p.b}_${next.turn}`, `${p.a} and ${p.b} go their own ways now that ${p.target} is no longer the threat.`));
        continue;
      }
    }
    let broken: { by: FamilyName; victim: FamilyName; cause: string } | undefined;
    for (const [s, o] of [[p.a, p.b], [p.b, p.a]] as [FamilyName, FamilyName][]) {
      const mind = mindOf(next, s);
      const g = grievance(mind, o, next.turn, personality(s));
      const wants = mind.goal && mind.goal.target === o && (mind.goal.kind === "retaliate" || mind.goal.kind === "expand") ? 2 : 1;
      const chance = PACT_BREAK[personality(s)] * (1 + Math.max(0, g) / 4) * (1 - trustIn(mind, o) / 150) * wants;
      if (rng.chance(chance)) {
        broken = { by: s, victim: o, cause: g > 2 ? "an old score" : wants > 1 ? "wanted what the other had" : "temper" };
        break;
      }
    }
    if (broken) {
      events.push({ turn: next.turn, a: p.a, b: p.b, kind: p.kind, event: "broken", by: broken.by, cause: broken.cause });
      next = remember(next, broken.victim, "broke_truce", broken.by);
      next = witnessBreak(next, broken.by, broken.victim);
      logs.push({
        ...pactLog(next, p, `log_rpact_break_${broken.by}_${broken.victim}_${next.turn}`, `${broken.by} tore up its word to ${broken.victim}. Every table in the city heard about it.`),
        tone: "warning",
      });
      continue;
    }
    kept.push(p);
  }
  next = withPacts(next, kept, events);

  const rivals = rivalFamilies(next).filter((f) => !isDefunct(next, f));

  // Coalitions against a runaway leader.
  for (let i = 0; i < rivals.length; i++) {
    for (let j = i + 1; j < rivals.length; j++) {
      const a = rivals[i]!;
      const b = rivals[j]!;
      if (rivalPactBetween(next, a, b)) continue;
      const la = cityLeader(next, a);
      const lb = cityLeader(next, b);
      if (!la || !lb || la.leader !== lb.leader) continue;
      const leader = la.leader;
      if (leader === a || leader === b) continue;
      if (Math.min(la.pressure, lb.pressure) < COALITION_PRESSURE) continue;
      const inCoalition = (f: FamilyName) => activeRivalPacts(next).some((p) => p.kind === "coalition" && (p.a === f || p.b === f));
      if (inCoalition(a) || inCoalition(b)) continue;
      const ma = mindOf(next, a);
      const mb = mindOf(next, b);
      if (trustIn(ma, b) < -40 || trustIn(mb, a) < -40) continue;
      // Fear of the leader outweighs small grudges between the two.
      const swallow = 4 + Math.min(la.pressure, lb.pressure) * 2;
      if (grievance(ma, b, next.turn, personality(a)) > swallow || grievance(mb, a, next.turn, personality(b)) > swallow) continue;
      if (!rng.chance(COALITION_SIGN_CHANCE)) continue;
      const signed = sign(next, a, b, "coalition", COALITION_WEEKS, leader);
      next = signed.state;
      logs.push(signed.log);
    }
  }

  // Truces: a family seeking peace with a rival gets an answer.
  for (const f of rivals) {
    const goal = mindOf(next, f).goal;
    if (goal?.kind !== "seek_peace" || !goal.target || goal.target === next.playerFamily) continue;
    const o = goal.target;
    if (isDefunct(next, o) || rivalPactBetween(next, f, o)) continue;
    const mo = mindOf(next, o);
    const busy = mo.goal?.kind === "contain_leader" || (mo.goal?.kind === "seek_peace" && mo.goal.target === f);
    const lead = cityLeader(next, o);
    const elsewhere = lead && lead.leader !== f && lead.pressure >= COALITION_PRESSURE ? 1.5 : 0;
    const swallow = TRUCE_SWALLOW[personality(o)] + (busy ? 1.5 : 0) + elsewhere;
    if (trustIn(mo, f) < -30 || grievance(mo, f, next.turn, personality(o)) > swallow) continue;
    if (!rng.chance(Math.max(0.1, Math.min(0.9, TRUCE_ACCEPT_CHANCE + trustIn(mo, f) / 200)))) continue;
    const signed = sign(next, f, o, "truce", rng.int(6, 10));
    next = signed.state;
    logs.push(signed.log);
  }

  return { state: next, logs };
}

/** Rival pact events, for the sim and the debug panel. */
export function pactHistory(state: GameState): RivalPactEvent[] {
  return state.diplomacy.rivalPactLog ?? [];
}
