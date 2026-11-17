import type { CrewMember, FamilyName, GameState, Operation } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { getActiveCrew } from "./crew";
import { findClue } from "./casing";
import { resolveCrewTerritoryId } from "./crewLocation";
import { clueHolds } from "./casing";
import { getRelation, statusFromScore } from "./relations";
import { tableBurned } from "./diplomacy";

export const BETRAYAL_REFUSE_HEAT = 5;
export const BETRAYAL_REFUSE_RELATION = -8;
export const BETRAYAL_KILL_RESPECT = -3;
export const BETRAYAL_ESCAPE_INFLUENCE = 10;

export function markOnBetrayalVenue(state: GameState, op: Operation): boolean {
  if (!op.targetCrewId) return false;
  return resolveCrewTerritoryId(state, op.targetCrewId) === op.targetTerritoryId;
}

function liveConsigliere(state: GameState, family: FamilyName): CrewMember | undefined {
  return state.crew.find((c) => c.family === family && c.role === "consigliere" && c.status === "active");
}

/** Chance the named mark agrees to sit. Blind jobs skip this. */
export function sitdownInviteChance(state: GameState, op: Operation): number {
  const mark = op.targetCrewId ? state.crew.find((c) => c.id === op.targetCrewId) : undefined;
  if (!mark || mark.status !== "active") return 0;
  const nego = op.negotiatorId ? state.crew.find((c) => c.id === op.negotiatorId) : undefined;
  const rel = getRelation(state.relations, op.family, op.targetFamily);
  const status = statusFromScore(rel);
  const onBlock = markOnBetrayalVenue(state, op);
  let rate = 0.42;
  if (nego) rate += nego.skills.charm / 220;
  if (nego?.role === "consigliere") rate += 0.08;
  rate += (state.reputation.respect - 50) / 400;
  rate += Math.min(0.08, state.reputation.fear / 700);
  if (mark.traits.includes("hothead")) rate += 0.08;
  const weak = findClue(state, op.targetTerritoryId, "weak_link", mark.id);
  if (clueHolds(weak, true)) rate += 0.1;
  const meeting = (state.sitdowns ?? []).some(
    (s) =>
      (s.status === "scheduled" || s.status === "at_table") &&
      s.heldTurn === state.turn &&
      (s.proposer === op.targetFamily || s.other === op.targetFamily),
  );
  if (meeting) rate += 0.08;
  if (status === "war") rate -= 0.22;
  else if (status === "hostile") rate -= 0.12;
  else if (status === "cold") rate -= 0.05;
  rate -= mark.skills.smarts / 350;
  if (mark.traits.includes("ghost")) rate -= 0.1;
  const extraGuns = Math.max(0, (op.shooterIds?.length ?? 0) - 2);
  rate -= extraGuns * 0.05;
  if (onBlock) rate += 0.14;
  else rate -= 0.22;
  if (tableBurned(state, op.targetFamily)) rate = 0.05;
  return Math.max(0.1, Math.min(0.9, rate));
}

export interface BetrayalEscort {
  muscleIds: string[];
  consigliereId?: string;
  /** Likely gun count for the planner (not a roll). */
  likelyMuscle: number;
  likelyConsigliere: boolean;
}

function musclePool(state: GameState, family: FamilyName): CrewMember[] {
  return getActiveCrew(state.crew, family)
    .filter((c) => c.role !== "boss" && c.role !== "consigliere" && c.role !== "associate")
    .sort((a, b) => b.skills.muscle - a.skills.muscle);
}

function likelyMuscleCount(state: GameState, op: Operation): number {
  const rel = getRelation(state.relations, op.family, op.targetFamily);
  const status = statusFromScore(rel);
  const volatile = getFamilyDef(op.targetFamily).personality === "volatile";
  const onBlock = markOnBetrayalVenue(state, op);
  if (status === "war") return volatile ? 3 : 2;
  if (status === "hostile") return onBlock ? 2 : 1;
  if (onBlock) return 1;
  return 0;
}

export function likelyBetrayalEscort(state: GameState, op: Operation): BetrayalEscort {
  const n = likelyMuscleCount(state, op);
  const pool = musclePool(state, op.targetFamily);
  const consigliere = liveConsigliere(state, op.targetFamily);
  return {
    muscleIds: pool.slice(0, n).map((c) => c.id),
    consigliereId: consigliere?.id,
    likelyMuscle: Math.min(n, pool.length),
    likelyConsigliere: !!consigliere,
  };
}

export function rollBetrayalEscort(state: GameState, op: Operation, rng: Rng): BetrayalEscort {
  const likely = likelyBetrayalEscort(state, op);
  const pool = musclePool(state, op.targetFamily);
  const rel = getRelation(state.relations, op.family, op.targetFamily);
  const status = statusFromScore(rel);
  let n = likely.likelyMuscle;
  if (status !== "war" && n > 0 && rng.chance(0.25)) n = Math.max(0, n - 1);
  const muscleIds = pool.slice(0, n).map((c) => c.id);
  const consig = liveConsigliere(state, op.targetFamily);
  const bringConsig = !!consig && (status === "war" || status === "hostile" || rng.chance(0.55));
  return {
    muscleIds,
    consigliereId: bringConsig ? consig!.id : undefined,
    likelyMuscle: n,
    likelyConsigliere: bringConsig,
  };
}

export function backupBeatsEscort(state: GameState, op: Operation, escort: BetrayalEscort): boolean {
  if (escort.muscleIds.length === 0) return true;
  const bestSmarts = Math.max(
    0,
    ...op.shooterIds.map((id) => state.crew.find((c) => c.id === id)?.skills.smarts ?? 0),
  );
  const bestMuscle = Math.max(
    0,
    ...escort.muscleIds.map((id) => state.crew.find((c) => c.id === id)?.skills.muscle ?? 0),
  );
  if (op.shooterIds.length === 0) return false;
  return bestSmarts > bestMuscle;
}

export function betrayalKillMod(state: GameState, op: Operation, escort: BetrayalEscort): number {
  const guns = escort.muscleIds.length;
  if (guns === 0) return 0;
  return backupBeatsEscort(state, op, escort) ? -guns * 0.03 : -guns * 0.12;
}

export function betrayalEscortGuns(state: GameState, op: Operation, escort: BetrayalEscort): number {
  const n = escort.muscleIds.length;
  if (n === 0) return 0;
  return backupBeatsEscort(state, op, escort) ? n * 0.35 : n * 1.25;
}

export function escortLine(escort: Pick<BetrayalEscort, "likelyMuscle" | "likelyConsigliere">): string {
  if (escort.likelyMuscle <= 0 && !escort.likelyConsigliere) return "they likely come alone";
  if (escort.likelyMuscle <= 0) return "they likely bring a consigliere";
  const guns = escort.likelyMuscle === 1 ? "1 gun" : `${escort.likelyMuscle} guns`;
  if (escort.likelyConsigliere) return `they likely bring ${guns} and a consigliere`;
  return `they likely bring ${guns}`;
}
