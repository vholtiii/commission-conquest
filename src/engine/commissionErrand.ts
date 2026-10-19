/**
 * A manhunt from the Commission. Standing is the pay. It is not for sale,
 * and a hit on another family's man does not sour that family.
 */
import type { CrewMember, FamilyName, GameState, Operation, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { districtsThatTouch } from "./cityLayout";
import { isDefunct } from "./defection";
import { jailInCrew } from "./jail";
import { resolveCrewTerritoryId } from "./crewLocation";
import { hitCrewIds } from "@/data/hitApproaches";
import { onUnresolvedHit } from "./jobReturn";
import { WARRANT } from "./heat";
import type { Rng } from "./rng";
import { cadence } from "./tempo";

export const ERRAND_WEEKS = 7;
export const ERRAND_GAP = 8;
export const ERRAND_STANDING = 8;
export const ERRAND_RESPECT = 2;
/** The week it is posted, and the week after. It leaves at the start of the third. */
export const ERRAND_OFFER_TURNS = 2;
/** Once the table is allowed to ask, this is the chance each quiet week. */
export const ERRAND_OFFER_CHANCE = 0.25;
/** A new game hears nothing before this turn. */
export const ERRAND_FIRST_TURN = 8;

function errandGap(state: Pick<GameState, "seed">): number {
  return cadence(state.seed, "errand");
}

/** Heat each approach puts on the family, before a botch adds more. */
export const ERRAND_APPROACH_HEAT = { ambush: 8, drive_by: 12, car_bomb: 20 } as const;

const FACES = [
  "A scar through the left eyebrow.",
  "He favors the right leg.",
  "A gold tooth, and he smiles with his mouth closed.",
  "A grey overcoat he does not take off indoors.",
];
const BARS = [
  "a lunch counter that stays open past midnight",
  "an upstairs card game",
  "a back room that pours after the door is locked",
];
const FIRST = ["Marco", "Sal", "Nicky", "Paulie", "Carlo", "Vito", "Rocco", "Gino"];
const LAST = ["Ricci", "Morelli", "Costa", "Bianchi", "Greco", "Leone", "Ferrante", "Pucci"];

const HIGH_RANK: CrewMember["role"][] = ["boss", "underboss", "consigliere", "capo"];

function districtName(state: GameState, id: string | undefined): string {
  if (!id) return "a block";
  return state.territories.find((t) => t.id === id)?.name ?? "a block";
}

function livingFamilies(state: GameState): FamilyName[] {
  return ALL_FAMILY_NAMES.filter((f) => !isDefunct(state, f));
}

/** Anyone not jailed, wounded, dead, or held, even if he is already working. */
export function canWorkErrand(member: CrewMember, operations: Operation[]): boolean {
  if (member.status !== "active") return false;
  if (onUnresolvedHit(member.id, operations)) return false;
  if (operations.some((o) => !o.resolved && o.errandId && hitCrewIds(o).includes(member.id))) return false;
  return true;
}

export function errandWeeksLeft(turn: number, untilTurn: number | undefined): number {
  if (untilTurn == null) return 0;
  return Math.max(0, untilTurn - turn);
}

/** Boss, underboss, consigliere, and capos already wanted past the warrant line. */
export function hotHighRanks(crew: CrewMember[], family: FamilyName): CrewMember[] {
  return crew.filter(
    (c) =>
      c.family === family &&
      c.status === "active" &&
      HIGH_RANK.includes(c.role) &&
      c.wanted > WARRANT.wantedFloor,
  );
}

/** What the offer tells you before you accept: the heat, and who it can jail. */
export function errandOfferWarning(state: GameState): string {
  const heat = state.heat.level;
  const crosses = (Object.entries(ERRAND_APPROACH_HEAT) as [string, number][]).filter(
    ([, added]) => heat + added >= WARRANT.heatFloor,
  );
  const base = "Ambush adds 8 heat. A drive-by adds 12. A car bomb adds 20.";
  if (crosses.length === 0 || !state.playerFamily) return base;
  const names = hotHighRanks(state.crew, state.playerFamily).map((c) => c.name);
  if (names.length === 0) {
    return `${base} Warrants go out at ${WARRANT.heatFloor} heat. Nobody high up is wanted past ${WARRANT.wantedFloor}.`;
  }
  const list = names.join(", ");
  return `${base} ${list} ${names.length === 1 ? "is" : "are"} already wanted past ${WARRANT.wantedFloor}. Heat at ${WARRANT.heatFloor} or higher can pick them up.`;
}

function hops(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.25) return 0;
  if (roll < 0.75) return 1;
  return 2;
}

function trail(state: GameState, hideoutId: string, rng: Rng): string[] {
  const adj = districtsThatTouch(state.territories);
  const away = hops(rng);
  const walked = [hideoutId];
  const seen = new Set([hideoutId]);
  let current = hideoutId;
  for (let i = 0; i < away; i++) {
    const nexts = (adj.get(current) ?? []).filter((id) => !seen.has(id));
    if (nexts.length === 0) break;
    current = rng.pick(nexts);
    seen.add(current);
    walked.push(current);
  }
  return walked.reverse();
}

function detailLine(kind: "family" | "stranger", markFamily: FamilyName | undefined, rng: Rng): string {
  const roll = rng.int(0, 2);
  if (roll === 0) return rng.pick(FACES);
  if (roll === 1) return `He drinks at ${rng.pick(BARS)}.`;
  if (kind === "family" && markFamily) return `He still runs errands for the ${markFamily}.`;
  return "Out of town. Nobody here claims him.";
}

function strangerName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

function pickHideout(state: GameState, avoidId: string | undefined, rng: Rng): string | null {
  const pool = state.territories.filter((t) => t.id !== avoidId);
  if (pool.length === 0) return state.territories[0]?.id ?? null;
  return rng.pick(pool).id;
}

function buildFamilyErrand(state: GameState, rng: Rng) {
  const player = state.playerFamily;
  const marks = state.crew.filter(
    (c) =>
      c.family !== player &&
      c.role !== "boss" &&
      c.status === "active" &&
      !isDefunct(state, c.family),
  );
  if (marks.length === 0) return null;
  const mark = rng.pick(marks);
  const home = resolveCrewTerritoryId(state, mark.id) ?? undefined;
  const hideout = pickHideout(state, home, rng);
  if (!hideout) return null;
  return {
    kind: "family" as const,
    targetCrewId: mark.id,
    targetName: mark.name,
    markFamily: mark.family,
    path: trail(state, hideout, rng),
    detail: detailLine("family", mark.family, rng),
  };
}

function buildStrangerErrand(state: GameState, rng: Rng) {
  const hideout = pickHideout(state, undefined, rng);
  if (!hideout) return null;
  return {
    kind: "stranger" as const,
    targetName: strangerName(rng),
    path: trail(state, hideout, rng),
    detail: detailLine("stranger", undefined, rng),
  };
}

function takeChance(family: FamilyName): number {
  switch (getFamilyDef(family).personality) {
    case "volatile":
      return 0.75;
    case "expansionist":
      return 0.65;
    case "smuggler":
      return 0.45;
    case "economic":
      return 0.35;
    default:
      return 0.25;
  }
}

function successChance(family: FamilyName): number {
  switch (getFamilyDef(family).personality) {
    case "volatile":
    case "expansionist":
      return 0.65;
    case "covert":
      return 0.4;
    default:
      return 0.55;
  }
}

function pushLog(state: GameState, log: TurnLogEntry): GameState {
  return { ...state, turnLog: [...state.turnLog, log].slice(-200) };
}

function closeErrand(state: GameState, readyTurn: number): GameState {
  return { ...state, commissionErrand: null, commissionErrandReady: readyTurn };
}

/** Post one offer when the table is quiet and the family is not under sanction. */
export function tickCommissionErrand(
  state: GameState,
  rng: Rng,
): { state: GameState; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const errand = state.commissionErrand;
  if (errand?.phase === "rival" && errand.carrier && (errand.untilTurn ?? 0) <= state.turn) {
    return resolveRivalErrand(state, rng);
  }
  if (errand?.phase === "hunting" && state.turn > (errand.untilTurn ?? state.turn)) {
    const respect = Math.max(0, state.reputation.respect - ERRAND_RESPECT);
    const log: TurnLogEntry = {
      id: `log_commission_errand_lapse_${errand.id}`,
      turn: state.turn,
      category: "diplomacy",
      text: `The seven weeks ran out on ${errand.targetName}. The table noticed. Respect −${ERRAND_RESPECT}.`,
      family: state.playerFamily ?? undefined,
    };
    logs.push(log);
    return {
      state: closeErrand(
        { ...state, reputation: { ...state.reputation, respect } },
        state.turn + errandGap(state),
      ),
      logs,
    };
  }
  if (errand?.phase === "offered" && state.turn >= errand.openedTurn + ERRAND_OFFER_TURNS) {
    const handed = handOffErrand(state, rng, { lapsed: true });
    return { state: handed.state, logs: [handed.log] };
  }
  if (errand) return { state, logs };
  if (!state.playerFamily || !state.started) return { state, logs };
  if (state.turn < (state.commissionErrandReady ?? 0)) return { state, logs };
  if ((state.diplomacy?.sanctionUntil ?? 0) > state.turn) return { state, logs };
  if (!rng.chance(ERRAND_OFFER_CHANCE)) return { state, logs };

  const built = rng.chance(0.5) ? buildFamilyErrand(state, rng) ?? buildStrangerErrand(state, rng) : buildStrangerErrand(state, rng);
  if (!built) return { state, logs };
  const id = `errand_${state.turn}_${rng.int(1000, 9999)}`;
  const who = built.kind === "family" && built.markFamily ? `a ${built.markFamily} man` : "a man from out of town";
  logs.push({
    id: `log_commission_errand_offer_${id}`,
    turn: state.turn,
    category: "diplomacy",
    text: `The table has work. They want ${who} found. Two weeks to take it.`,
    family: state.playerFamily,
  });
  return {
    state: {
      ...state,
      commissionErrand: {
        id,
        phase: "offered",
        kind: built.kind,
        targetCrewId: built.kind === "family" ? built.targetCrewId : undefined,
        targetName: built.targetName,
        markFamily: built.kind === "family" ? built.markFamily : undefined,
        path: built.path,
        leadIndex: 0,
        detail: built.detail,
        found: false,
        openedTurn: state.turn,
      },
    },
    logs,
  };
}

export function acceptCommissionErrand(state: GameState): { state: GameState; error?: string } {
  const errand = state.commissionErrand;
  if (!errand || errand.phase !== "offered" || !state.playerFamily) {
    return { state, error: "Nothing is on offer." };
  }
  return {
    state: {
      ...state,
      commissionErrand: {
        ...errand,
        phase: "hunting",
        carrier: state.playerFamily,
        untilTurn: state.turn + ERRAND_WEEKS,
      },
    },
  };
}

/**
 * The offer leaves the table and one other family is asked.
 * Silence costs nothing. An explicit decline pays the respect before calling this.
 */
function handOffErrand(
  state: GameState,
  rng: Rng,
  opts?: { lapsed?: boolean },
): { state: GameState; log: TurnLogEntry } {
  const errand = state.commissionErrand!;
  const player = state.playerFamily!;
  const candidates = livingFamilies(state).filter((f) => f !== player && f !== errand.markFamily);
  const asked = candidates.length > 0 ? rng.pick(candidates) : null;
  const lead = opts?.lapsed ? "The two weeks passed. " : "";
  const took = !!asked && rng.chance(takeChance(asked));
  const text = !asked
    ? `${lead}The table looked for someone else to find ${errand.targetName}. Nobody took it.`
    : took
      ? `${lead}The table asked the ${asked} to find ${errand.targetName}. They took the work.`
      : `${lead}The table asked the ${asked} to find ${errand.targetName}. They refused.`;
  const log: TurnLogEntry = {
    id: `log_commission_errand_ask_${errand.id}`,
    turn: state.turn,
    category: "diplomacy",
    text,
    family: player,
  };
  if (!took || !asked) {
    return { state: closeErrand(state, state.turn + errandGap(state)), log };
  }
  return {
    state: {
      ...state,
      commissionErrand: {
        ...errand,
        phase: "rival",
        carrier: asked,
        untilTurn: state.turn + ERRAND_WEEKS,
      },
    },
    log,
  };
}

export function declineCommissionErrand(
  state: GameState,
  rng: Rng,
): { state: GameState; error?: string; log?: TurnLogEntry } {
  const errand = state.commissionErrand;
  const player = state.playerFamily;
  if (!errand || errand.phase !== "offered" || !player) return { state, error: "Nothing is on offer." };
  const respect = Math.max(0, state.reputation.respect - ERRAND_RESPECT);
  const handed = handOffErrand(
    { ...state, reputation: { ...state.reputation, respect } },
    rng,
  );
  return { state: pushLog(handed.state, handed.log), log: handed.log };
}

/** A casing of the current lead either places him or moves the trail one district. */
export function noteErrandCasing(state: GameState, op: Operation): { state: GameState; log?: TurnLogEntry } {
  const errand = state.commissionErrand;
  if (!errand || errand.phase !== "hunting" || op.errandId !== errand.id) return { state };
  if (state.turn > (errand.untilTurn ?? state.turn)) return { state };
  const lead = errand.path[errand.leadIndex];
  if (op.targetTerritoryId !== lead) return { state };
  const hideout = errand.path[errand.path.length - 1];
  const here = districtName(state, lead);
  if (lead === hideout || errand.leadIndex >= errand.path.length - 1) {
    const report = `${errand.targetName} is in ${here}. ${errand.detail}`;
    const log: TurnLogEntry = {
      id: `log_errand_found_${errand.id}_${state.turn}`,
      turn: state.turn,
      category: "hit",
      text: report,
      family: state.playerFamily ?? undefined,
    };
    return {
      state: { ...state, commissionErrand: { ...errand, found: true, report } },
      log,
    };
  }
  const nextIndex = errand.leadIndex + 1;
  const nextName = districtName(state, errand.path[nextIndex]);
  const report = `Not in ${here}. He was seen heading to ${nextName}.`;
  const log: TurnLogEntry = {
    id: `log_errand_trail_${errand.id}_${state.turn}`,
    turn: state.turn,
    category: "hit",
    text: report,
    family: state.playerFamily ?? undefined,
  };
  return {
    state: { ...state, commissionErrand: { ...errand, leadIndex: nextIndex, report } },
    log,
  };
}

/** Standing, once, when the mark dies inside the window. No relation and no vendetta are handled on the hit. */
export function payCommissionKill(state: GameState, op: Operation, targetDead: boolean): GameState {
  const errand = state.commissionErrand;
  if (!targetDead || op.intent !== "commission") return state;
  if (!errand || errand.phase !== "hunting" || op.errandId !== errand.id) return state;
  if (op.family !== state.playerFamily) return state;
  if (state.turn > (errand.untilTurn ?? state.turn)) return state;
  const log: TurnLogEntry = {
    id: `log_commission_errand_paid_${errand.id}`,
    turn: state.turn + 1,
    category: "diplomacy",
    text: `The table counted ${errand.targetName}. Standing +${ERRAND_STANDING}.`,
    family: state.playerFamily ?? undefined,
  };
  return pushLog(
    {
      ...closeErrand(state, state.turn + errandGap(state)),
      influence: Math.max(0, Math.min(300, state.influence + ERRAND_STANDING)),
    },
    log,
  );
}

function resolveRivalErrand(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const errand = state.commissionErrand;
  const carrier = errand?.carrier;
  if (!errand || !carrier) return { state, logs: [] };
  const killed = rng.chance(successChance(carrier));
  const heat = killed ? (rng.chance(0.5) ? 18 : 8) : rng.chance(0.6) ? 8 : 0;
  let crew = state.crew;
  let deathName: string | undefined;
  if (!killed && rng.chance(0.4)) {
    const pool = crew.filter((c) => c.family === carrier && c.status === "active" && c.role !== "boss");
    if (pool.length > 0) {
      const man = rng.pick(pool);
      deathName = man.name;
      crew = crew.map((c) => (c.id === man.id ? { ...c, status: "dead" as const } : c));
    }
  }
  if (killed && errand.targetCrewId) {
    crew = crew.map((c) =>
      c.id === errand.targetCrewId && c.status !== "dead" ? { ...c, status: "dead" as const } : c,
    );
  }
  let arrestedName: string | undefined;
  if (heat > 0) {
    for (const man of hotHighRanks(crew, carrier)) {
      if (!rng.chance(WARRANT.chance)) continue;
      crew = jailInCrew(crew, man.id, state.turn);
      arrestedName = man.name;
      break;
    }
  }
  const influence = { ...(state.rivalInfluence ?? {}) };
  if (killed) {
    influence[carrier] = Math.max(0, Math.min(300, (influence[carrier] ?? 0) + ERRAND_STANDING));
  }
  const parts = [
    killed
      ? `The ${carrier} found ${errand.targetName}. The table paid them ${ERRAND_STANDING} standing.`
      : `The ${carrier} missed ${errand.targetName}.`,
  ];
  if (deathName) parts.push(`${deathName} didn't come back.`);
  if (heat > 0) parts.push(`Heat on them is up ${heat}.`);
  if (arrestedName) parts.push(`${arrestedName} was picked up.`);
  const log: TurnLogEntry = {
    id: `log_hit_errand_${errand.id}`,
    turn: state.turn,
    category: "hit",
    text: parts.join(" "),
    family: carrier,
  };
  return {
    state: {
      ...closeErrand({ ...state, crew, rivalInfluence: influence }, state.turn + errandGap(state)),
    },
    logs: [log],
  };
}
