/**
 * Open cases: hits and hijacks against the player awaiting attribution.
 *
 * The truth (`actualFamily`, `actualMotive`, `hiredBy`) lives on the incident
 * but is never rendered. The player sees a suspect board (0..1 confidence per
 * family) that evidence pushes around. Casing, bribes, sit-downs, intel and
 * rumors all write evidence through `addEvidence`.
 */
import type {
  DeliveryRoute,
  Evidence,
  EvidenceSource,
  FamilyName,
  GameState,
  HitApproach,
  HitOutcome,
  HitResult,
  Incident,
  Motive,
  Operation,
  TurnLogEntry,
} from "@/types/game";
import {
  CASE_SOLVED_THRESHOLD,
  CASE_THIN_THRESHOLD,
  MOTIVE_LABELS,
} from "@/types/game";
import type { Rng } from "./rng";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { getRelation, setRelationDelta } from "./relations";
import { breakPact, hasPact } from "./diplomacy";
import { GRUDGE_TURNS, lastName } from "./casing";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Turns before an unanswered case goes cold. */
export const CASE_COLD_TURNS = 6;
/** Respect lost when a case goes cold unanswered. */
export const COLD_CASE_RESPECT = 3;

/** Justified answer: respect gained, relations penalty softened by this much. */
export const JUSTIFIED_RESPECT = 5;
export const JUSTIFIED_RELATION_REBATE = 10;

/** Wrong target: full penalties. */
export const WRONG_TARGET_RESPECT = 15;
/** Wrong target on solid-looking evidence (≥ solved threshold): halved. */
export const WRONG_TARGET_GOOD_FAITH_RESPECT = 8;
export const WRONG_TARGET_EXTRA_RELATION = -5;
export const WRONG_TARGET_COMMISSION_RELATION = -10;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function rivalsOf(player: FamilyName): FamilyName[] {
  return ALL_FAMILY_NAMES.filter((f) => f !== player);
}

let evidenceCounter = 0;
function evidenceId(source: EvidenceSource, turn: number, rng?: Rng): string {
  const salt = rng ? rng.int(1000, 9999) : ++evidenceCounter;
  return `ev_${source}_${turn}_${salt}`;
}

export function makeEvidence(
  source: EvidenceSource,
  turn: number,
  text: string,
  shifts: Partial<Record<FamilyName, number>>,
  extra?: Partial<Evidence>,
  rng?: Rng,
): Evidence {
  return { id: evidenceId(source, turn, rng), turn, source, text, shifts, ...extra };
}

export function applyShifts(
  suspects: Partial<Record<FamilyName, number>>,
  shifts: Partial<Record<FamilyName, number>>,
): Partial<Record<FamilyName, number>> {
  const next = { ...suspects };
  for (const [fam, d] of Object.entries(shifts)) {
    if (d === undefined) continue;
    const key = fam as FamilyName;
    next[key] = clamp01((next[key] ?? 0) + d);
  }
  return next;
}

export function topSuspect(
  incident: Pick<Incident, "suspects">,
): { family: FamilyName; confidence: number } | undefined {
  let best: { family: FamilyName; confidence: number } | undefined;
  for (const [fam, c] of Object.entries(incident.suspects)) {
    if (c === undefined) continue;
    if (!best || c > best.confidence) best = { family: fam as FamilyName, confidence: c };
  }
  return best;
}

export function isSolved(incident: Pick<Incident, "suspects">): boolean {
  return (topSuspect(incident)?.confidence ?? 0) >= CASE_SOLVED_THRESHOLD;
}

/** Families who actually bear responsibility (shooters + whoever paid). */
export function culpritFamilies(incident: Pick<Incident, "actualFamily" | "hiredBy">): FamilyName[] {
  return incident.hiredBy ? [incident.actualFamily, incident.hiredBy] : [incident.actualFamily];
}

export function isOpen(incident: Incident, turn: number): boolean {
  return incident.answeredTurn === undefined && incident.coldTurn > turn;
}

export function openIncidents(state: Pick<GameState, "incidents" | "turn">): Incident[] {
  return (state.incidents ?? []).filter((i) => isOpen(i, state.turn));
}

export function findIncident(
  state: Pick<GameState, "incidents">,
  id: string,
): Incident | undefined {
  return (state.incidents ?? []).find((i) => i.id === id);
}

/* ------------------------------------------------------------------ */
/* Scene priors                                                        */
/* ------------------------------------------------------------------ */

interface SceneInput {
  kind: Incident["kind"];
  territoryId: string;
  approach?: HitApproach;
  outcome?: HitOutcome;
  routePath?: string[];
  actualFamily: FamilyName;
  /** Attacker crew identified at the scene (arrested / killed / shot in a firefight). */
  capturedCrewIds?: string[];
}

/** What the street knows for free the morning after. */
export function scenePriors(
  state: GameState,
  input: SceneInput,
  rng: Rng,
): { suspects: Partial<Record<FamilyName, number>>; evidence: Evidence[] } {
  const player = state.playerFamily!;
  const turn = state.turn;
  const rivals = rivalsOf(player);
  const evidence: Evidence[] = [];
  let suspects: Partial<Record<FamilyName, number>> = {};

  // Everyone starts as a possibility; pact partners a little less.
  for (const f of rivals) {
    suspects[f] = hasPact(state, player, f) ? 0.05 : 0.1;
  }

  const territory = state.territories.find((t) => t.id === input.territoryId);
  const districtName = territory?.name ?? "the district";

  // Relations & vendettas.
  const hostile: Partial<Record<FamilyName, number>> = {};
  for (const f of rivals) {
    const rel = getRelation(state.relations, player, f);
    let d = 0;
    if (rel < -60) d += 0.25;
    else if (rel < -30) d += 0.15;
    if (state.vendettas.includes(f)) d += 0.15;
    if (d > 0) hostile[f] = d;
  }
  if (Object.keys(hostile).length > 0) {
    const names = Object.keys(hostile).join(", ");
    evidence.push(
      makeEvidence("scene", turn, `Bad blood: ${names} had reason.`, hostile, undefined, rng),
    );
    suspects = applyShifts(suspects, hostile);
  }

  // Geography.
  const geo: Partial<Record<FamilyName, number>> = {};
  if (input.kind === "hijack" && input.routePath) {
    for (const tid of input.routePath) {
      const t = state.territories.find((x) => x.id === tid);
      if (t?.owner && t.owner !== player) geo[t.owner] = Math.max(geo[t.owner] ?? 0, 0.25);
    }
    if (Object.keys(geo).length > 0) {
      evidence.push(
        makeEvidence(
          "scene",
          turn,
          `The truck went through ${Object.keys(geo).join(" and ")} turf.`,
          geo,
          undefined,
          rng,
        ),
      );
    }
  } else if (territory) {
    for (const adjId of territory.adjacentTerritories) {
      const t = state.territories.find((x) => x.id === adjId);
      if (t?.owner && t.owner !== player) geo[t.owner] = Math.max(geo[t.owner] ?? 0, 0.15);
    }
    if (Object.keys(geo).length > 0) {
      evidence.push(
        makeEvidence(
          "scene",
          turn,
          `${Object.keys(geo).join(" and ")} hold the blocks next to ${districtName}.`,
          geo,
          undefined,
          rng,
        ),
      );
    }
  }
  suspects = applyShifts(suspects, geo);

  // Approach signature.
  if (input.approach) {
    const sig: Partial<Record<FamilyName, number>> = {};
    for (const f of rivals) {
      const p = getFamilyDef(f).personality;
      if (input.approach === "sitdown_betrayal" && p === "covert") sig[f] = 0.15;
      if (input.approach === "drive_by" && p === "volatile") sig[f] = 0.15;
      if (input.approach === "car_bomb" && (p === "economic" || p === "smuggler")) sig[f] = 0.1;
      if (input.approach === "ambush" && p === "expansionist") sig[f] = 0.1;
    }
    if (Object.keys(sig).length > 0) {
      const how: Record<HitApproach, string> = {
        sitdown_betrayal: "A sit-down that ended in gunfire — that's how the quiet outfits work.",
        drive_by: "Drive-by, loud and sloppy. Somebody with a temper.",
        car_bomb: "A car bomb takes money and patience.",
        ambush: "Planned ambush, professional. An outfit that's used to taking ground.",
      };
      evidence.push(makeEvidence("scene", turn, how[input.approach], sig, undefined, rng));
      suspects = applyShifts(suspects, sig);
    }
  }

  // What they left behind.
  if (input.capturedCrewIds && input.capturedCrewIds.length > 0) {
    const id = input.capturedCrewIds[0]!;
    const c = state.crew.find((m) => m.id === id);
    const shifts: Partial<Record<FamilyName, number>> = { [input.actualFamily]: 0.6 };
    evidence.push(
      makeEvidence(
        "capture",
        turn,
        c
          ? `${c.name} — a ${input.actualFamily} ${c.role} — was left ${c.status === "dead" ? "dead on the pavement" : c.status === "jailed" ? "in a cell" : "bleeding in an alley"}.`
          : `One of the shooters didn't make it out. He's ${input.actualFamily}.`,
        shifts,
        undefined,
        rng,
      ),
    );
    suspects = applyShifts(suspects, shifts);
  } else if (input.outcome === "messy_kill" || input.outcome === "botched_wounded") {
    const shifts: Partial<Record<FamilyName, number>> = { [input.actualFamily]: 0.15 };
    evidence.push(
      makeEvidence(
        "scene",
        turn,
        rng.pick([
          "A witness saw the car. Dark sedan, plates from across the river.",
          "They left in a hurry. A hat, a shell casing, a half-smoked cigar.",
          "Loud work. Half the block saw something; nobody agrees on what.",
        ]),
        shifts,
        undefined,
        rng,
      ),
    );
    suspects = applyShifts(suspects, shifts);
  } else if (input.outcome === "clean_kill") {
    evidence.push(
      makeEvidence("scene", turn, "Clean. No witnesses, no casings. Professionals.", {}, undefined, rng),
    );
  }

  return { suspects, evidence };
}

/* ------------------------------------------------------------------ */
/* Opening cases                                                       */
/* ------------------------------------------------------------------ */

export function inferMotive(
  state: GameState,
  attacker: FamilyName,
  victim: FamilyName,
  opts: { kind: Incident["kind"]; territoryId?: string; routePassesThrough?: boolean },
): Motive {
  if (state.vendettas.includes(attacker) && state.vendettas.includes(victim)) return "vendetta";
  const grudge = (state.grudges ?? []).find(
    (g) => g.family === attacker && g.against === victim && g.expiresTurn > state.turn,
  );
  if (grudge?.reason === "casing") return "retaliation_casing";
  if (opts.kind === "hijack") return opts.routePassesThrough ? "route_dispute" : "opportunist";
  const rel = getRelation(state.relations, attacker, victim);
  if (opts.territoryId) {
    const t = state.territories.find((x) => x.id === opts.territoryId);
    const borders = t?.adjacentTerritories.some(
      (id) => state.territories.find((x) => x.id === id)?.owner === attacker,
    );
    if (borders && rel < -20) return "territory";
  }
  if (rel < -40) return "power_grab";
  return "opportunist";
}

function pushIncident(state: GameState, incident: Incident): GameState {
  return { ...state, incidents: [...(state.incidents ?? []), incident] };
}

/** A rival hit landed on the player. Open a case. */
export function openIncidentFromHit(
  state: GameState,
  op: Operation,
  result: HitResult,
  rng: Rng,
): { state: GameState; incident: Incident } {
  const turn = state.turn;
  const attackerIds = new Set([
    ...op.shooterIds,
    op.wheelmanId,
    op.lookoutId,
    op.bombMakerId,
    op.planterId,
    op.negotiatorId,
  ].filter((x): x is string => !!x));
  const captured = result.casualtyDetail
    .filter((d) => attackerIds.has(d.crewId))
    .map((d) => d.crewId);

  const { suspects, evidence } = scenePriors(
    state,
    {
      kind: "hit",
      territoryId: op.targetTerritoryId,
      approach: op.approach,
      outcome: result.outcome,
      actualFamily: op.family,
      capturedCrewIds: captured,
    },
    rng,
  );

  const incident: Incident = {
    id: `case_hit_${op.id}_${turn}`,
    turn,
    kind: "hit",
    territoryId: op.targetTerritoryId,
    victimCrewId: op.targetCrewId,
    approach: op.approach,
    outcome: result.outcome,
    actualFamily: op.family,
    actualMotive:
      op.motive ??
      inferMotive(state, op.family, op.targetFamily, {
        kind: "hit",
        territoryId: op.targetTerritoryId,
      }),
    hiredBy: op.contractFor,
    suspects,
    motiveKnown: false,
    evidence,
    solved: false,
    coldTurn: turn + CASE_COLD_TURNS,
  };
  incident.solved = isSolved(incident);

  let next = pushIncident(state, incident);
  next = applyPatternMatch(next, incident.id, rng);
  return { state: next, incident: findIncident(next, incident.id)! };
}

/** A player shipment was hijacked. Open a case. */
export function openIncidentFromHijack(
  state: GameState,
  route: DeliveryRoute,
  hijacker: FamilyName,
  rng: Rng,
  motive?: Motive,
): { state: GameState; incident: Incident } {
  const turn = state.turn;
  const passesThrough = route.path.some(
    (tid) => state.territories.find((t) => t.id === tid)?.owner === hijacker,
  );
  const sceneTerritory =
    route.path.find((tid) => state.territories.find((t) => t.id === tid)?.owner === hijacker) ??
    route.path[Math.floor(route.path.length / 2)] ??
    route.destTerritoryId;

  const { suspects, evidence } = scenePriors(
    state,
    {
      kind: "hijack",
      territoryId: sceneTerritory,
      routePath: route.path,
      actualFamily: hijacker,
    },
    rng,
  );

  const incident: Incident = {
    id: `case_hijack_${route.id}_${turn}`,
    turn,
    kind: "hijack",
    territoryId: sceneTerritory,
    routeId: route.id,
    victimCrewId: route.driverId,
    actualFamily: hijacker,
    actualMotive:
      motive ??
      inferMotive(state, hijacker, route.family, { kind: "hijack", routePassesThrough: passesThrough }),
    suspects,
    motiveKnown: false,
    evidence,
    solved: false,
    coldTurn: turn + CASE_COLD_TURNS,
  };
  incident.solved = isSolved(incident);

  let next = pushIncident(state, incident);
  next = applyPatternMatch(next, incident.id, rng);
  return { state: next, incident: findIncident(next, incident.id)! };
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/** Append evidence to a case and re-evaluate. No-op if the case is closed. */
export function addEvidence(state: GameState, incidentId: string, evidence: Evidence): GameState {
  const incidents = (state.incidents ?? []).map((i) => {
    if (i.id !== incidentId || !isOpen(i, state.turn)) return i;
    const suspects = applyShifts(i.suspects, evidence.shifts);
    const next: Incident = {
      ...i,
      suspects,
      evidence: [...i.evidence, evidence],
    };
    next.solved = isSolved(next);
    return next;
  });
  return { ...state, incidents };
}

/** Reveal the motive on a case (sit-down admission, Tier 4 casing). */
export function revealMotive(state: GameState, incidentId: string, alsoHiredBy = false): GameState {
  const incidents = (state.incidents ?? []).map((i) => {
    if (i.id !== incidentId) return i;
    return {
      ...i,
      motiveKnown: true,
      knownMotive: i.actualMotive,
      knownHiredBy: alsoHiredBy ? i.hiredBy : i.knownHiredBy,
    };
  });
  return { ...state, incidents };
}

/**
 * Second incident with the same signature nudges toward whoever you already
 * suspected. Visible-only: uses prior suspect boards, never the truth.
 */
export function applyPatternMatch(state: GameState, incidentId: string, rng: Rng): GameState {
  const incident = findIncident(state, incidentId);
  if (!incident) return state;
  const priors = (state.incidents ?? []).filter(
    (i) =>
      i.id !== incidentId &&
      i.kind === incident.kind &&
      (incident.kind === "hijack" || i.approach === incident.approach) &&
      state.turn - i.turn <= 12,
  );
  if (priors.length === 0) return state;

  const shifts: Partial<Record<FamilyName, number>> = {};
  for (const p of priors) {
    for (const [fam, c] of Object.entries(p.suspects)) {
      if (c === undefined || c < CASE_THIN_THRESHOLD) continue;
      const key = fam as FamilyName;
      shifts[key] = Math.max(shifts[key] ?? 0, Math.round(c * 0.2 * 100) / 100);
    }
  }
  if (Object.keys(shifts).length === 0) return state;

  return addEvidence(
    state,
    incidentId,
    makeEvidence(
      "pattern",
      state.turn,
      incident.kind === "hijack"
        ? "Same stretch of road, same play as last time."
        : `Same method as ${priors.length === 1 ? "the last one" : "the others"}. Same hands, probably.`,
      shifts,
      undefined,
      rng,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Retaliation judgment                                                */
/* ------------------------------------------------------------------ */

export type RetaliationBand = "justified" | "thin" | "reckless" | "none";

/** What the planner shows before the trigger is pulled. */
export function confidenceBand(
  incident: Pick<Incident, "suspects">,
  family: FamilyName,
): RetaliationBand {
  const c = incident.suspects[family] ?? 0;
  if (c >= CASE_SOLVED_THRESHOLD) return "justified";
  if (c >= CASE_THIN_THRESHOLD) return "thin";
  return "reckless";
}

export const BAND_LABELS: Record<RetaliationBand, string> = {
  justified: "Justified",
  thin: "Thin evidence",
  reckless: "Reckless",
  none: "",
};

export interface RetaliationJudgment {
  band: RetaliationBand;
  /** They actually did it (or paid for it). */
  guilty: boolean;
  /** Evidence looked solid but pointed at the wrong family. */
  goodFaith: boolean;
  text: string;
}

export function judgeRetaliation(
  state: GameState,
  incidentId: string,
  family: FamilyName,
): RetaliationJudgment {
  const incident = findIncident(state, incidentId);
  if (!incident || !isOpen(incident, state.turn)) {
    return { band: "none", guilty: false, goodFaith: false, text: "" };
  }
  const band = confidenceBand(incident, family);
  const guilty = culpritFamilies(incident).includes(family);
  const goodFaith = !guilty && band === "justified";

  let text: string;
  if (guilty && band === "justified") {
    text = `The Commission accepts it. ${family} had it coming and everyone knew.`;
  } else if (guilty) {
    text = `You guessed right — ${family} was behind it. The street nods, but you proved nothing.`;
  } else if (goodFaith) {
    text = `You had it wrong. ${family} didn't do it, and the evidence that said so was bad.`;
  } else if (band === "thin") {
    text = `${family} wasn't behind it. Thin evidence, wrong answer.`;
  } else {
    text = `${family} had nothing to do with it. You hit an innocent outfit on a hunch.`;
  }
  return { band, guilty, goodFaith, text };
}

/**
 * Apply consequences of a player hit declared as an answer to a case.
 * Call from resolveHit for player ops with `answersIncidentId`.
 * Assumes the base −25 relation and vendetta bookkeeping already ran.
 */
export function applyRetaliationJudgment(
  state: GameState,
  op: Operation,
  rng: Rng,
): { state: GameState; judgment: RetaliationJudgment; logs: TurnLogEntry[] } {
  const player = state.playerFamily;
  const incidentId = op.answersIncidentId;
  const logs: TurnLogEntry[] = [];
  if (!player || !incidentId) {
    return { state, judgment: { band: "none", guilty: false, goodFaith: false, text: "" }, logs };
  }
  const judgment = judgeRetaliation(state, incidentId, op.targetFamily);
  if (judgment.band === "none") return { state, judgment, logs };

  const turn = state.turn;
  let next = state;
  let relations = next.relations;
  let respect = next.reputation.respect;
  let grudges = next.grudges ?? [];

  if (judgment.guilty) {
    if (judgment.band === "justified") {
      respect += JUSTIFIED_RESPECT;
      relations = setRelationDelta(relations, player, op.targetFamily, JUSTIFIED_RELATION_REBATE);
    }
  } else {
    const respectLoss = judgment.goodFaith ? WRONG_TARGET_GOOD_FAITH_RESPECT : WRONG_TARGET_RESPECT;
    respect -= respectLoss;
    relations = setRelationDelta(relations, player, op.targetFamily, WRONG_TARGET_EXTRA_RELATION);
    for (const f of rivalsOf(player)) {
      if (f === op.targetFamily) continue;
      relations = setRelationDelta(relations, player, f, WRONG_TARGET_COMMISSION_RELATION);
    }
    grudges = [
      ...grudges,
      {
        id: `grudge_wrong_${op.targetFamily}_${turn}_${rng.int(100, 999)}`,
        family: op.targetFamily,
        against: player,
        crewId: undefined,
        territoryId: op.originTerritoryId ?? op.targetTerritoryId,
        reason: "wrong_target",
        turn,
        expiresTurn: turn + GRUDGE_TURNS + 2,
      },
    ];
  }

  next = {
    ...next,
    relations,
    grudges,
    reputation: {
      ...next.reputation,
      respect: Math.max(0, Math.min(100, respect)),
    },
    incidents: (next.incidents ?? []).map((i) =>
      i.id === incidentId
        ? { ...i, answeredTurn: turn, answeredFamily: op.targetFamily, solved: judgment.guilty || i.solved }
        : i,
    ),
  };

  // Wrong target on a pact partner: word broken.
  if (!judgment.guilty && hasPact(next, player, op.targetFamily)) {
    next = breakPact(next, op.targetFamily);
  }

  logs.push({
    id: `log_case_answer_${incidentId}_${turn}`,
    turn,
    category: "hit",
    text: judgment.text,
    family: player,
  });

  return { state: next, judgment, logs };
}

/* ------------------------------------------------------------------ */
/* Per-turn tick                                                       */
/* ------------------------------------------------------------------ */

/** Cold cases, decaying rumor shifts. Call once per turn after the date advances. */
export function tickIncidents(state: GameState): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const player = state.playerFamily;
  if (!player) return { state, logs };
  const turn = state.turn;
  let respectLoss = 0;

  const incidents = (state.incidents ?? []).map((i) => {
    let next = i;

    // Fade evidence whose shifts were meant to decay (false rumors).
    const fading = next.evidence.filter((e) => e.decaysTurn !== undefined && e.decaysTurn <= turn);
    if (fading.length > 0) {
      let suspects = next.suspects;
      for (const e of fading) {
        const inverse: Partial<Record<FamilyName, number>> = {};
        for (const [fam, d] of Object.entries(e.shifts)) {
          if (d !== undefined) inverse[fam as FamilyName] = -d;
        }
        suspects = applyShifts(suspects, inverse);
      }
      next = {
        ...next,
        suspects,
        evidence: next.evidence.map((e) =>
          e.decaysTurn !== undefined && e.decaysTurn <= turn
            ? { ...e, decaysTurn: undefined, text: `${e.text} (went nowhere)` }
            : e,
        ),
      };
      next.solved = isSolved(next);
    }

    // Went cold this turn.
    if (next.answeredTurn === undefined && next.coldTurn === turn) {
      respectLoss += COLD_CASE_RESPECT;
      const where = state.territories.find((t) => t.id === next.territoryId)?.name ?? "the district";
      logs.push({
        id: `log_case_cold_${next.id}`,
        turn,
        category: "hit",
        text: `The trail on the ${next.kind === "hijack" ? "hijacking" : "hit"} in ${where} went cold. People noticed you let it go.`,
        family: player,
      });
    }
    return next;
  });

  // Keep the list bounded.
  const trimmed = incidents.filter(
    (i) => isOpen(i, turn) || turn - (i.answeredTurn ?? i.coldTurn) < 20,
  );

  return {
    state: {
      ...state,
      incidents: trimmed,
      reputation: {
        ...state.reputation,
        respect: Math.max(0, state.reputation.respect - respectLoss),
      },
    },
    logs,
  };
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

export function incidentTitle(state: Pick<GameState, "territories" | "crew">, incident: Incident): string {
  const where = state.territories.find((t) => t.id === incident.territoryId)?.name ?? "Unknown block";
  if (incident.kind === "hijack") return `Hijacking — ${where}`;
  const victim = incident.victimCrewId
    ? state.crew.find((c) => c.id === incident.victimCrewId)
    : undefined;
  const who = victim ? lastName(victim) : "one of yours";
  const what =
    incident.outcome === "clean_kill" || incident.outcome === "messy_kill"
      ? "killed"
      : incident.outcome === "botched_wounded"
        ? "shot"
        : "hit attempt";
  return `${who} ${what} — ${where}`;
}

export function motiveLabel(incident: Incident): string {
  return incident.motiveKnown && incident.knownMotive ? MOTIVE_LABELS[incident.knownMotive] : "Unknown";
}
