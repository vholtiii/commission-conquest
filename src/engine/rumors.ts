/**
 * Word on the street: turn-start rumors.
 *
 * Two kinds:
 *  - pending_hit: a rival hit on the player is pending; the street may whisper
 *    about it at some fidelity (vague → where → who → how → from whom).
 *    Not every hit leaks (capped at 80%), and some rumors are false.
 *  - past_incident: gossip about an open case that nudges the suspect board.
 *    Usually right, sometimes wrong; false nudges fade after two turns.
 *
 * Pure except for `generateRumors`, which returns a new state.
 */
import type {
  FamilyName,
  GameState,
  HitApproach,
  Incident,
  Operation,
  Rumor,
  RumorFidelity,
  TurnLogEntry,
} from "@/types/game";
import type { Rng } from "./rng";
import { getFamilyDef, ALL_FAMILY_NAMES } from "@/data/families";
import { crewPresentIn } from "./crewLocation";
import { addEvidence, makeEvidence, openIncidents } from "./incidents";
import { lastName } from "./casing";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

export const RUMOR_CHANCE_BASE = 0.3;
export const RUMOR_CHANCE_MIN = 0.1;
/** Some hits always come out of nowhere. */
export const RUMOR_CHANCE_MAX = 0.8;

/** Chance per turn of a rumor with nothing behind it (heat > 30 or in a vendetta). */
export const FALSE_RUMOR_CHANCE = 0.08;
/** Chance per open case per turn that the street offers a name. */
export const PAST_INCIDENT_RUMOR_CHANCE = 0.2;
/** How often that name is the right one. */
export const PAST_INCIDENT_RUMOR_ACCURACY = 0.65;
/** Suspect nudge from a rumor naming a family. */
export const RUMOR_EVIDENCE_SHIFT = 0.1;
/** False rumor evidence fades after this many turns. */
export const FALSE_RUMOR_DECAY_TURNS = 2;

const FIDELITY_ORDER: RumorFidelity[] = ["vague", "where", "who", "how", "from_whom"];

function fidelityRank(f: RumorFidelity): number {
  return FIDELITY_ORDER.indexOf(f);
}

/* ------------------------------------------------------------------ */
/* Pending-hit rumors                                                  */
/* ------------------------------------------------------------------ */

function districtRevealed(state: GameState, territoryId: string): boolean {
  return (state.intel?.districtReveal?.[territoryId] ?? 0) > state.turn;
}

function familyRevealed(state: GameState, family: FamilyName): boolean {
  return (state.intel?.familyReveal?.[family] ?? 0) > state.turn;
}

/** Sharp men on the block hear things. */
function sharpGarrisonPresent(state: GameState, territoryId: string): boolean {
  if (!state.playerFamily) return false;
  return crewPresentIn(state, territoryId).some(
    (c) => c.family === state.playerFamily && c.skills.smarts >= 50,
  );
}

/** Chance the street whispers about a pending rival hit on the player. */
export function rumorChance(state: GameState, op: Operation): number {
  let chance = RUMOR_CHANCE_BASE;
  if (districtRevealed(state, op.targetTerritoryId)) chance += 0.25;
  if (familyRevealed(state, op.family)) chance += 0.4;
  if (sharpGarrisonPresent(state, op.targetTerritoryId)) chance += 0.1;
  if (op.tippedOff) chance += 0.1;
  chance += (state.reputation.streetInfluence ?? 0) / 500;
  if (getFamilyDef(op.family).personality === "covert") chance -= 0.15;
  const lookout = op.lookoutId ? state.crew.find((c) => c.id === op.lookoutId) : undefined;
  if (lookout) chance -= lookout.skills.stealth / 600;
  return Math.max(RUMOR_CHANCE_MIN, Math.min(RUMOR_CHANCE_MAX, chance));
}

/** How much the rumor gives away. Naming the family needs the chief bribe. */
export function rollFidelity(state: GameState, op: Operation, rng: Rng): RumorFidelity {
  let score = rng.next();
  if (districtRevealed(state, op.targetTerritoryId)) score += 0.2;
  if (op.tippedOff) score += 0.1;
  if (sharpGarrisonPresent(state, op.targetTerritoryId)) score += 0.1;
  if (getFamilyDef(op.family).personality === "covert") score -= 0.2;

  if (familyRevealed(state, op.family)) return "from_whom";

  let fidelity: RumorFidelity;
  if (score < 0.35) fidelity = "vague";
  else if (score < 0.6) fidelity = "where";
  else if (score < 0.8) fidelity = "who";
  else fidelity = "how";

  // Blind hits have no named mark: "who" collapses to "where".
  if (fidelity === "who" && !op.targetCrewId) fidelity = "where";
  return fidelity;
}

const APPROACH_HINT: Record<HitApproach, string[]> = {
  car_bomb: [
    "they've been asking about his car",
    "somebody wanted to know where he parks",
  ],
  drive_by: [
    "a sedan's been circling the block, slow",
    "somebody clocked two men in a car who don't belong",
  ],
  ambush: [
    "a couple of new faces have been hanging around",
    "somebody's been timing when he leaves",
  ],
  sitdown_betrayal: [
    "somebody wants a sit-down with him, real friendly",
    "there's an invitation coming he shouldn't take",
  ],
  summons: ["he's been told to come by the house", "the boss wants a word with him, alone"],
};

const OPENERS = [
  "Word is",
  "People are saying",
  "A guy who knows a guy says",
  "The barber heard",
  "Somebody's cousin at the precinct says",
];

export function pendingHitRumorText(
  state: GameState,
  fidelity: RumorFidelity,
  parts: {
    territoryId?: string;
    targetCrewId?: string;
    approach?: HitApproach;
    family?: FamilyName;
    message?: boolean;
  },
  rng: Rng,
): string {
  const opener = rng.pick(OPENERS);
  if (parts.message) {
    const text = pendingHitRumorText(state, fidelity, { ...parts, message: false }, rng);
    return `${text} ${rng.pick([
      "It's not the boss they want — somebody who matters. They mean to make a point about the trucks.",
      "Word is it's over the routes. They want one of your good men found in the street.",
      "Not a war, they say. A message. Somebody skilled, somewhere public.",
    ])}`;
  }
  const district = parts.territoryId
    ? state.territories.find((t) => t.id === parts.territoryId)?.name
    : undefined;
  const mark = parts.targetCrewId
    ? state.crew.find((c) => c.id === parts.targetCrewId)
    : undefined;

  const pieces: string[] = [`${opener} somebody's got paper out on one of yours.`];
  if (fidelityRank(fidelity) >= fidelityRank("where") && district) {
    pieces.push(`They've been watching ${district}.`);
  }
  if (fidelityRank(fidelity) >= fidelityRank("who") && mark) {
    pieces.push(`${lastName(mark)}'s name came up.`);
  }
  if (fidelityRank(fidelity) >= fidelityRank("how") && parts.approach) {
    const hint = rng.pick(APPROACH_HINT[parts.approach]);
    pieces.push(`${hint.charAt(0).toUpperCase()}${hint.slice(1)}.`);
  }
  if (fidelity === "from_whom" && parts.family) {
    pieces.push(`It's the ${parts.family}s.`);
  }
  return pieces.join(" ");
}

/* ------------------------------------------------------------------ */
/* Past-incident rumors                                                */
/* ------------------------------------------------------------------ */

function pastIncidentText(
  state: GameState,
  incident: Incident,
  family: FamilyName,
  rng: Rng,
): string {
  const where = state.territories.find((t) => t.id === incident.territoryId)?.name ?? "that block";
  const what = incident.kind === "hijack" ? "the truck" : "what happened";
  return rng.pick([
    `${rng.pick(OPENERS)} the ${family}s were behind ${what} in ${where}.`,
    `${rng.pick(OPENERS)} ${family} men were drinking on it the night after ${where}.`,
    `${rng.pick(OPENERS)} ${family} has been bragging about ${where}.`,
  ]);
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export interface RumorGenResult {
  state: GameState;
  rumors: Rumor[];
  logs: TurnLogEntry[];
}

/** Pending rival hits aimed at the player that haven't resolved yet. */
export function pendingHitsOnPlayer(state: GameState): Operation[] {
  if (!state.playerFamily) return [];
  return state.operations.filter(
    (o) =>
      !o.resolved &&
      o.kind === "hit" &&
      o.targetFamily === state.playerFamily &&
      o.family !== state.playerFamily,
  );
}

/**
 * Roll this turn's rumors. Call once per turn after rival AI has planned.
 * Rumors about the same op across turns never lose fidelity.
 */
export function generateRumors(state: GameState, rng: Rng): RumorGenResult {
  const player = state.playerFamily;
  const logs: TurnLogEntry[] = [];
  if (!player) return { state, rumors: [], logs };

  const turn = state.turn;
  const existing = state.rumors ?? [];
  const fresh: Rumor[] = [];
  let next = state;

  // 1. Pending hits.
  for (const op of pendingHitsOnPlayer(state)) {
    const alreadyThisTurn = existing.some((r) => r.operationId === op.id && r.turn === turn);
    if (alreadyThisTurn) continue;
    if (!rng.chance(rumorChance(state, op))) continue;

    let fidelity = rollFidelity(state, op, rng);
    const prior = existing
      .filter((r) => r.operationId === op.id)
      .sort((a, b) => fidelityRank(b.fidelity) - fidelityRank(a.fidelity))[0];
    if (prior && fidelityRank(prior.fidelity) > fidelityRank(fidelity)) fidelity = prior.fidelity;

    const rank = fidelityRank(fidelity);
    const rumor: Rumor = {
      id: `rumor_${op.id}_${turn}`,
      turn,
      kind: "pending_hit",
      fidelity,
      operationId: op.id,
      territoryId: rank >= fidelityRank("where") ? op.targetTerritoryId : undefined,
      targetCrewId: rank >= fidelityRank("who") ? op.targetCrewId : undefined,
      approach: rank >= fidelityRank("how") ? op.approach : undefined,
      family: fidelity === "from_whom" ? op.family : undefined,
      text: "",
      false: false,
    };
    rumor.text = pendingHitRumorText(
      state,
      fidelity,
      { ...rumor, message: op.intent === "message" },
      rng,
    );
    fresh.push(rumor);

    // A named family is active against you: nudge every open case they're on.
    if (rumor.family) {
      for (const inc of openIncidents(next)) {
        next = addEvidence(
          next,
          inc.id,
          makeEvidence(
            "rumor",
            turn,
            `Street says the ${rumor.family}s are moving on you right now.`,
            { [rumor.family]: RUMOR_EVIDENCE_SHIFT },
            undefined,
            rng,
          ),
        );
      }
    }
  }

  // 2. A false whisper when the city is tense.
  const tense = state.heat.level > 30 || state.vendettas.length > 0;
  if (tense && rng.chance(FALSE_RUMOR_CHANCE)) {
    const owned = state.territories.filter((t) => t.owner === player);
    const where = owned.length > 0 && rng.chance(0.6) ? rng.pick(owned) : undefined;
    const fidelity: RumorFidelity = where ? "where" : "vague";
    const rumor: Rumor = {
      id: `rumor_false_${turn}_${rng.int(100, 999)}`,
      turn,
      kind: "pending_hit",
      fidelity,
      territoryId: where?.id,
      text: "",
      false: true,
    };
    rumor.text = pendingHitRumorText(state, fidelity, rumor, rng);
    fresh.push(rumor);
  }

  // 3. Gossip about open cases.
  for (const inc of openIncidents(state)) {
    if (inc.answeredTurn !== undefined) continue;
    if (!rng.chance(PAST_INCIDENT_RUMOR_CHANCE)) continue;
    const accurate = rng.chance(PAST_INCIDENT_RUMOR_ACCURACY);
    const others = ALL_FAMILY_NAMES.filter((f) => f !== player && f !== inc.actualFamily);
    const named: FamilyName = accurate || others.length === 0 ? inc.actualFamily : rng.pick(others);

    const rumor: Rumor = {
      id: `rumor_case_${inc.id}_${turn}`,
      turn,
      kind: "past_incident",
      fidelity: "from_whom",
      incidentId: inc.id,
      territoryId: inc.territoryId,
      family: named,
      text: pastIncidentText(state, inc, named, rng),
      false: !accurate,
    };
    fresh.push(rumor);

    next = addEvidence(
      next,
      inc.id,
      makeEvidence(
        "rumor",
        turn,
        rumor.text,
        { [named]: RUMOR_EVIDENCE_SHIFT },
        accurate ? undefined : { decaysTurn: turn + FALSE_RUMOR_DECAY_TURNS },
        rng,
      ),
    );
  }

  for (const r of fresh) {
    logs.push({
      id: `log_${r.id}`,
      turn,
      category: "hit",
      text: r.text,
      family: player,
    });
  }

  // Keep a short history.
  const rumors = [...existing, ...fresh].filter((r) => turn - r.turn <= 8);

  return { state: { ...next, rumors }, rumors: fresh, logs };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Rumors to show on the turn-start card. */
export function currentRumors(state: Pick<GameState, "rumors" | "turn">): Rumor[] {
  return (state.rumors ?? []).filter((r) => r.turn === state.turn && !r.dismissed);
}

export function dismissRumor(state: GameState, id: string): GameState {
  return {
    ...state,
    rumors: (state.rumors ?? []).map((r) => (r.id === id ? { ...r, dismissed: true } : r)),
  };
}

export function dismissCurrentRumors(state: GameState): GameState {
  return {
    ...state,
    rumors: (state.rumors ?? []).map((r) =>
      r.turn === state.turn ? { ...r, dismissed: true } : r,
    ),
  };
}

/** Districts the street has flagged this turn (for the `?` map marker). */
export function rumoredDistrictIds(state: Pick<GameState, "rumors" | "turn">): string[] {
  const ids = new Set<string>();
  for (const r of (state.rumors ?? []).filter((r) => r.turn === state.turn && r.kind === "pending_hit")) {
    if (r.territoryId) ids.add(r.territoryId);
  }
  return [...ids];
}

/** Crew the street has named this turn (for the portrait ring). */
export function rumoredCrewIds(state: Pick<GameState, "rumors" | "turn">): string[] {
  const ids = new Set<string>();
  for (const r of (state.rumors ?? []).filter((r) => r.turn === state.turn && r.kind === "pending_hit")) {
    if (r.targetCrewId) ids.add(r.targetCrewId);
  }
  return [...ids];
}
