/**
 * Job practice. A thin layer beside XP: the work itself moves one skill,
 * slowly, and a bad week can take it back. Every family uses the same rates.
 * Only the player's men get a log line.
 */
import type {
  CrewMember,
  CrewSkills,
  FamilyName,
  HitOutcome,
  Territory,
  TurnLogEntry,
} from "@/types/game";

export const GARRISON_WEEKS = 8;
export const RACKET_WEEKS = 4;
export const BOOKKEEPER_WEEKS = 3;
export const DRIVING_ARRIVALS = 4;
export const FREEZE_SMARTS = 2;
export const HIT_SKILL = 2;
export const HITMAN_ESCAPE = 1;
export const SOUR_LOYALTY = 5;

export type PracticeKind = "garrison" | "racket" | "driving";

export interface HitSeats {
  shooterIds: string[];
  wheelmanId?: string;
  lookoutId?: string;
  bombMakerId?: string;
  planterId?: string;
  negotiatorId?: string;
}

function clampSkill(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Still on the roster: not dead, not put away, not sent out of town. */
export function onRoster(member: CrewMember): boolean {
  return member.status !== "dead" && !member.putAway && !member.leftCity;
}

function shiftSkill(
  member: CrewMember,
  skill: keyof CrewSkills,
  delta: number,
): { member: CrewMember; changed: boolean } {
  const before = member.skills[skill];
  const after = clampSkill(before + delta);
  if (after === before) return { member, changed: false };
  return {
    member: { ...member, skills: { ...member.skills, [skill]: after } },
    changed: true,
  };
}

function clearWork(member: CrewMember): CrewMember {
  if (!member.needsWork) return member;
  const next = { ...member };
  delete next.needsWork;
  return next;
}

function skillLine(name: string, skill: keyof CrewSkills, delta: number): string {
  const n = Math.abs(delta);
  const points = n === 1 ? "a point" : `${n} points`;
  const verb = delta > 0 ? "picks up" : "loses";
  return `${name} ${verb} ${points} of ${skill}.`;
}

function practiceLog(turn: number, member: CrewMember, text: string, tag: string): TurnLogEntry {
  return {
    id: `log_xp_practice_${member.id}_${turn}_${tag}`,
    turn,
    category: "system",
    text,
    family: member.family,
  };
}

function playerLog(
  logs: TurnLogEntry[],
  member: CrewMember,
  playerFamily: FamilyName | null,
  turn: number,
  text: string,
  tag: string,
) {
  if (!playerFamily || member.family !== playerFamily) return;
  logs.push(practiceLog(turn, member, text, tag));
}

function racketIsFrozen(territories: Territory[], racketId: string | undefined, turn: number): boolean {
  if (!racketId) return false;
  for (const t of territories) {
    const racket = t.rackets.find((r) => r.id === racketId);
    if (racket) return (racket.frozenUntil ?? 0) > turn;
  }
  return false;
}

/**
 * One week of garrison or racket practice for every active man.
 * A truck's driving bank is counted when the truck arrives, not here.
 * Switching off a standing job clears that bank. Driving waits out an idle week
 * so a one-off run can finish what the last delivery started.
 */
export function tickJobPractice(
  crew: CrewMember[],
  territories: Territory[],
  turn: number,
  playerFamily: FamilyName | null,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const next = crew.map((member) => {
    if (member.status !== "active") return member;
    let kind: PracticeKind | null = null;
    let pay = 0;
    let skill: keyof CrewSkills | null = null;
    if (member.assignment.type === "garrison") {
      kind = "garrison";
      pay = GARRISON_WEEKS;
      skill = "muscle";
    } else if (member.assignment.type === "racket") {
      if (racketIsFrozen(territories, member.assignment.racketId, turn)) return member;
      kind = "racket";
      pay = member.traits.includes("bookkeeper") ? BOOKKEEPER_WEEKS : RACKET_WEEKS;
      skill = "smarts";
    }
    if (!kind || !skill) {
      if (member.practice && member.practice.kind !== "driving") {
        return { ...member, practice: undefined };
      }
      return member;
    }
    const progress = (member.practice?.kind === kind ? member.practice.progress : 0) + 1;
    if (progress < pay) return { ...member, practice: { kind, progress } };
    const moved = shiftSkill(member, skill, 1);
    if (moved.changed) playerLog(logs, member, playerFamily, turn, skillLine(member.name, skill, 1), kind);
    return { ...moved.member, practice: { kind, progress: 0 } };
  });
  return { crew: next, logs };
}

export function seatSkill(seats: HitSeats, id: string): keyof CrewSkills {
  if (seats.shooterIds.includes(id)) return "muscle";
  if (seats.wheelmanId === id) return "driving";
  if (seats.lookoutId === id) return "stealth";
  if (seats.bombMakerId === id || seats.planterId === id) return "smarts";
  if (seats.negotiatorId === id) return "charm";
  return "muscle";
}

function riders(seats: HitSeats): string[] {
  const ids = new Set<string>(seats.shooterIds);
  for (const id of [seats.wheelmanId, seats.lookoutId, seats.bombMakerId, seats.planterId, seats.negotiatorId]) {
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * A resolved hit. A kill is +2 in the seat's skill, a botch is −2, an escape
 * is nothing. A hitman who rode still gains muscle: +2 on a kill (already
 * covered when he was a shooter), +1 when the mark gets away, −2 on a botch.
 * Riding clears the sulk. It does not jump him past the man who caught him.
 */
export function applyHitPractice(
  crew: CrewMember[],
  seats: HitSeats,
  outcome: HitOutcome,
  turn: number,
  playerFamily: FamilyName | null,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  const kill = outcome === "clean_kill" || outcome === "messy_kill";
  const botch =
    outcome === "botched_wounded" || outcome === "botched_arrested" || outcome === "botched_killed";
  const escape = outcome === "target_escaped";
  const logs: TurnLogEntry[] = [];
  let next = crew;
  for (const id of riders(seats)) {
    const member = next.find((c) => c.id === id);
    if (!member || member.status === "dead") continue;
    const skill = seatSkill(seats, id);
    const delta = kill ? HIT_SKILL : botch ? -HIT_SKILL : 0;
    let updated = member;
    if (delta !== 0) {
      const moved = shiftSkill(updated, skill, delta);
      updated = moved.member;
      if (moved.changed) {
        playerLog(logs, member, playerFamily, turn, skillLine(member.name, skill, delta), skill);
      }
    }
    if (member.role === "hitman") {
      updated = clearWork(updated);
      let extra = 0;
      if (skill === "muscle") {
        if (escape) extra = HITMAN_ESCAPE;
      } else if (kill) extra = HIT_SKILL;
      else if (botch) extra = -HIT_SKILL;
      else if (escape) extra = HITMAN_ESCAPE;
      if (extra !== 0) {
        const moved = shiftSkill(updated, "muscle", extra);
        updated = moved.member;
        if (moved.changed) {
          playerLog(logs, member, playerFamily, turn, skillLine(member.name, "muscle", extra), "ride");
        }
      }
    }
    next = next.map((c) => (c.id === id ? updated : c));
  }
  return { crew: next, logs };
}

/** A clean casing. Spotted work does not call this. Pays once, made or not. */
export function practiceCleanCasing(crew: CrewMember[], lookoutId: string | undefined): CrewMember[] {
  if (!lookoutId) return crew;
  const lookout = crew.find((c) => c.id === lookoutId);
  if (!lookout || lookout.status === "dead" || lookout.skills.stealth >= 100) return crew;
  return crew.map((c) =>
    c.id === lookoutId ? { ...c, skills: { ...c.skills, stealth: c.skills.stealth + 1 } } : c,
  );
}

/** A truck that arrived. Seized and hijacked runs do not call this. */
export function noteDrivingArrival(
  crew: CrewMember[],
  driverId: string | undefined,
  turn: number,
  playerFamily: FamilyName | null,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  if (!driverId) return { crew, logs: [] };
  const member = crew.find((c) => c.id === driverId);
  if (!member || member.status === "dead") return { crew, logs: [] };
  const progress = (member.practice?.kind === "driving" ? member.practice.progress : 0) + 1;
  const logs: TurnLogEntry[] = [];
  let updated: CrewMember = { ...member, practice: { kind: "driving", progress } };
  if (progress >= DRIVING_ARRIVALS) {
    const moved = shiftSkill(updated, "driving", 1);
    updated = { ...moved.member, practice: { kind: "driving", progress: 0 } };
    if (moved.changed) {
      playerLog(logs, member, playerFamily, turn, skillLine(member.name, "driving", 1), "drive");
    }
  }
  return { crew: crew.map((c) => (c.id === driverId ? updated : c)), logs };
}

/** The week a racket freezes. −2 smarts, and that manager's racket bank clears. */
export function penalizeRacketFreeze(
  crew: CrewMember[],
  managerId: string | null | undefined,
  turn: number,
  playerFamily: FamilyName | null,
  nonce = "",
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  if (!managerId) return { crew, logs: [] };
  const member = crew.find((c) => c.id === managerId);
  if (!member || member.status === "dead") return { crew, logs: [] };
  const moved = shiftSkill(member, "smarts", -FREEZE_SMARTS);
  const practice = member.practice?.kind === "racket" ? undefined : member.practice;
  const updated: CrewMember = { ...moved.member, practice };
  const logs: TurnLogEntry[] = [];
  if (moved.changed) {
    playerLog(
      logs,
      member,
      playerFamily,
      turn,
      `The freeze costs ${member.name} ${FREEZE_SMARTS} points of smarts.`,
      `freeze_${nonce}`,
    );
  }
  return { crew: crew.map((c) => (c.id === managerId ? updated : c)), logs };
}

/**
 * A living man has matched or passed the hitman. Once: the flag, loyalty −5,
 * and a line. It does not tick again while he stays behind.
 */
export function noteHitmanPride(
  crew: CrewMember[],
  turn: number,
  playerFamily: FamilyName | null,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const next = crew.map((member) => {
    if (member.role !== "hitman" || !onRoster(member) || member.needsWork) return member;
    const matched = crew.some(
      (other) =>
        other.id !== member.id &&
        other.family === member.family &&
        onRoster(other) &&
        other.skills.muscle >= member.skills.muscle,
    );
    if (!matched) return member;
    const loyalty = Math.max(0, member.loyalty - SOUR_LOYALTY);
    playerLog(logs, member, playerFamily, turn, `${member.name} needs work.`, "sour");
    return { ...member, needsWork: true, loyalty };
  });
  return { crew: next, logs };
}

/**
 * A dinner the hitman actually sits. He is set one point above the best other
 * arm in the family, and not past 100. At 100 he ties, and the log says so.
 * Men left on the street because the house was full are not in `seated`.
 */
export function liftSeatedHitmen(
  crew: CrewMember[],
  seated: ReadonlySet<string>,
  playerFamily: FamilyName | null,
  turn: number,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  if (!playerFamily) return { crew, logs: [] };
  const logs: TurnLogEntry[] = [];
  const next = crew.map((member) => {
    if (!seated.has(member.id) || member.role !== "hitman" || member.family !== playerFamily) return member;
    if (!onRoster(member)) return member;
    let best = -1;
    for (const other of crew) {
      if (other.id === member.id || other.family !== member.family || !onRoster(other)) continue;
      if (other.skills.muscle > best) best = other.skills.muscle;
    }
    let updated = clearWork(member);
    if (best < 0) return updated;
    if (best >= 100) {
      if (updated.skills.muscle < 100) updated = shiftSkill(updated, "muscle", 100 - updated.skills.muscle).member;
      playerLog(
        logs,
        member,
        playerFamily,
        turn,
        `Dinner puts ${member.name} level with the best arm in the family.`,
        "dinner",
      );
      return updated;
    }
    const target = best + 1;
    if (updated.skills.muscle < target) {
      updated = shiftSkill(updated, "muscle", target - updated.skills.muscle).member;
      playerLog(
        logs,
        member,
        playerFamily,
        turn,
        `Dinner puts ${member.name} one point above the next man.`,
        "dinner",
      );
    }
    return updated;
  });
  return { crew: next, logs };
}
