/**
 * Crews: a capo runs a handful of soldiers. Men in a crew learn what the capo
 * is good at and pick up the management habits that make a future capo; men
 * outside a crew stay sharp on the street and grow into casing specialists.
 *
 * The brass run crews too, each with its own school: the boss's crew is where
 * the family's shooters are made (muscle, stealth, wheel time), and the
 * consigliere's crew learns to think and move quiet (smarts, stealth).
 *
 * Pure functions over crew arrays and GameState; the store and turn pipeline
 * wire them in.
 */
import type {
  CrewMember,
  CrewRequest,
  CrewSkills,
  FamilyName,
  GameState,
  Territory,
  TurnLogEntry,
} from "@/types/game";
import {
  CREW_SETTLING_TURNS,
  CREW_SLOTS_BASE,
  CREW_SLOTS_VETERAN,
  CREW_VETERAN_LEVEL,
} from "@/types/game";
import type { Rng } from "./rng";
import { createRng, hashString } from "./rng";
import { walkToRival } from "./defection";
import { resolveCrewTerritoryId, type LocationState } from "./crewLocation";
import { BOSS_PRESENCE, bossPresenceDistrict } from "./bossPresence";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Base per-skill chance a mentored soldier gains +1 this turn. */
const MENTOR_BASE_CHANCE = 0.15;
/** Extra chance per point the capo leads the soldier by. */
const MENTOR_GAP_DIVISOR = 250;
/** XP a soldier earns each turn just for running with a crew. */
const CREW_XP_PER_TURN = 1;
/** Every N turns in a crew, +1 in the leader's drip skill (capos: smarts / charm alternating). */
const MANAGEMENT_DRIP_EVERY = 4;
/**
 * The boss and consigliere don't teach with their own hands: the boss puts
 * his crew with the family's best shooters, the consigliere runs a school.
 * Their curriculum is taught at least this well regardless of their own stats.
 */
const SCHOOL_TEACHER_FLOOR = 60;
/** Freelance soldiers read as this much sharper when casing. */
export const FREELANCE_STEALTH_EDGE = 8;
export const FREELANCE_SMARTS_EDGE = 5;
/** Racket income: each crew soldier adds this much, before the capo's cut. */
const CREW_INCOME_PER_MAN = 0.04;
const CREW_INCOME_SKILL_DIVISOR = 2000;
/** Capo loyalty lost when the boss turns him down twice running. */
const REJECTION_LOYALTY_HIT = 3;

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

export type CrewLeaderRole = "capo" | "boss" | "consigliere";

export function isCrewLeaderRole(role: CrewMember["role"]): role is CrewLeaderRole {
  return role === "capo" || role === "boss" || role === "consigliere";
}

/** Capos, the boss and the consigliere each run a crew. */
export function canLeadCrew(c: CrewMember): boolean {
  return isCrewLeaderRole(c.role) && c.status !== "dead";
}

/** Short label for what kind of crew this is, for the UI. */
export function crewSchoolLabel(leader: CrewMember): string {
  if (leader.role === "boss") return "Boss's crew — shooters";
  if (leader.role === "consigliere") return "Consigliere's crew — thinkers";
  return "Capo's crew";
}

export function crewSlots(capo: CrewMember): number {
  return capo.level >= CREW_VETERAN_LEVEL ? CREW_SLOTS_VETERAN : CREW_SLOTS_BASE;
}

/** Everyone tagged to this capo, whatever their status. */
export function crewOf(crew: CrewMember[], capoId: string): CrewMember[] {
  return crew.filter((c) => c.capoId === capoId && c.status !== "dead");
}

/** Jobs that keep a soldier where he is. Only idle and garrisoned men are free to be pulled. */
const HELD_ASSIGNMENTS: CrewMember["assignment"]["type"][] = [
  "operation",
  "surveillance",
  "delivery",
  "safehouse",
  "racket",
];

/** Already out: a hit, a casing, a route, lying low, running a racket, or not on his feet. */
export function isHeldOff(c: CrewMember): boolean {
  return c.status !== "active" || HELD_ASSIGNMENTS.includes(c.assignment.type);
}

/**
 * Men a boss, capo, or consigliere pulls with him. Soldiers on a job stay put.
 * Loose soldiers, the hitman, and anyone with no crew are never in this list.
 */
export function freeCrewOf(crew: CrewMember[], leaderId: string): CrewMember[] {
  return crewOf(crew, leaderId).filter((c) => !isHeldOff(c));
}

/** Leaders already on a job whose free men still have no seat. */
export function unseatedCrew(
  crew: CrewMember[],
  seatedIds: string[],
): { leader: CrewMember; men: CrewMember[] }[] {
  const seated = new Set(seatedIds);
  const out: { leader: CrewMember; men: CrewMember[] }[] = [];
  for (const id of seatedIds) {
    const leader = crew.find((c) => c.id === id);
    if (!leader || leader.status !== "active" || !canLeadCrew(leader)) continue;
    const men = freeCrewOf(crew, leader.id).filter((m) => !seated.has(m.id));
    if (men.length > 0) out.push({ leader, men });
  }
  return out;
}

/** The attackers, plus the free crew of any boss, capo, or consigliere among them. */
export function captureParty(crew: CrewMember[], attackerIds: string[]): string[] {
  const ids = [...attackerIds];
  const have = new Set(ids);
  for (const id of attackerIds) {
    const leader = crew.find((c) => c.id === id);
    if (!leader || leader.status !== "active" || !canLeadCrew(leader)) continue;
    for (const man of freeCrewOf(crew, leader.id)) {
      if (have.has(man.id)) continue;
      have.add(man.id);
      ids.push(man.id);
    }
  }
  return ids;
}

/**
 * Garrison a leader's free crew on the block he just took. Men running a racket
 * stay on it. The leader himself is left to the caller.
 */
export function placeCrewAt<T extends { crew: CrewMember[]; territories: Territory[] }>(
  state: T,
  leaderId: string,
  territoryId: string,
): T {
  const men = freeCrewOf(state.crew, leaderId);
  if (men.length === 0) return state;
  const ids = new Set(men.map((m) => m.id));
  const crew = state.crew.map((c) =>
    ids.has(c.id) ? { ...c, assignment: { type: "garrison" as const, territoryId } } : c,
  );
  const territories = state.territories.map((t) => {
    const garrisonIds = t.garrisonIds.filter((id) => !ids.has(id));
    return {
      ...t,
      garrisonIds: t.id === territoryId ? [...garrisonIds, ...men.map((m) => m.id)] : garrisonIds,
      rackets: t.rackets.map((r) =>
        r.managerId && ids.has(r.managerId) ? { ...r, managerId: null } : r,
      ),
    };
  });
  return { ...state, crew, territories };
}

/** Crew members who are on the block and not out on a job. */
export function workingCrewOf(crew: CrewMember[], capoId: string): CrewMember[] {
  return crewOf(crew, capoId).filter(
    (c) =>
      c.status === "active" &&
      c.assignment.type !== "operation" &&
      c.assignment.type !== "surveillance",
  );
}

export function openSlots(crew: CrewMember[], capo: CrewMember): number {
  return Math.max(0, crewSlots(capo) - crewOf(crew, capo.id).length);
}

export function isFreelanceSoldier(c: CrewMember): boolean {
  return c.role === "soldier" && !c.capoId;
}

export function isInCrew(c: CrewMember): boolean {
  return !!c.capoId;
}

export function capoFor(crew: CrewMember[], member: CrewMember): CrewMember | undefined {
  if (!member.capoId) return undefined;
  return crew.find((c) => c.id === member.capoId);
}

export interface JoinCheck {
  ok: boolean;
  reason?: string;
}

/** Soldiers and associates can join; associates are made soldiers on the way in. */
export function canJoinCrew(
  crew: CrewMember[],
  memberId: string,
  capoId: string,
): JoinCheck {
  const member = crew.find((c) => c.id === memberId);
  const capo = crew.find((c) => c.id === capoId);
  if (!member || !capo) return { ok: false, reason: "No such man." };
  if (member.family !== capo.family) return { ok: false, reason: "Different families." };
  if (!canLeadCrew(capo)) return { ok: false, reason: `${capo.name} doesn't run a crew.` };
  if (capo.status !== "active") return { ok: false, reason: `${capo.name} is out of action.` };
  if (member.role !== "soldier" && member.role !== "associate") {
    return { ok: false, reason: "Only soldiers and associates run in a crew." };
  }
  if (member.status !== "active") return { ok: false, reason: `${member.name} is out of action.` };
  // A man already running with someone else is spoken for; cut him loose first.
  if (member.capoId && member.capoId !== capoId) {
    const other = crew.find((c) => c.id === member.capoId);
    return {
      ok: false,
      reason: `${member.name} already runs with ${other?.name ?? "another capo"}. Cut him loose first.`,
    };
  }
  if (member.capoId === capoId) return { ok: false, reason: "Already in this crew." };
  if (openSlots(crew, capo) <= 0) return { ok: false, reason: `${capo.name}'s crew is full.` };
  return { ok: true };
}

/** Put a man in a capo's crew. Associates are promoted to soldier. */
export function joinCrew(
  crew: CrewMember[],
  memberId: string,
  capoId: string,
  turn: number,
): CrewMember[] {
  if (!canJoinCrew(crew, memberId, capoId).ok) return crew;
  return crew.map((c) => {
    if (c.id !== memberId) return c;
    const promoted = c.role === "associate";
    return {
      ...c,
      role: "soldier" as const,
      level: promoted ? c.level + 1 : c.level,
      roleSinceTurn: promoted ? turn : c.roleSinceTurn,
      capoId,
      crewSinceTurn: turn,
    };
  });
}

export function leaveCrew(crew: CrewMember[], memberId: string): CrewMember[] {
  return crew.map((c) =>
    c.id === memberId ? { ...c, capoId: undefined, crewSinceTurn: undefined } : c,
  );
}

/**
 * Cut loose anyone whose capo is gone: dead, no longer a capo (moved up to the
 * brass), or no longer in the family. Soldiers promoted out of the rank leave too.
 */
export function orphanCrews(crew: CrewMember[]): CrewMember[] {
  let changed = false;
  const next = crew.map((c) => {
    if (!c.capoId) return c;
    const capo = crew.find((m) => m.id === c.capoId);
    const capoGone = !capo || !canLeadCrew(capo) || capo.family !== c.family;
    const outgrew = c.role !== "soldier";
    if (!capoGone && !outgrew) return c;
    changed = true;
    return { ...c, capoId: undefined, crewSinceTurn: undefined };
  });
  return changed ? next : crew;
}

/* ------------------------------------------------------------------ */
/* Mentoring                                                           */
/* ------------------------------------------------------------------ */

const SKILL_KEYS: (keyof CrewSkills)[] = ["muscle", "stealth", "smarts", "charm", "driving"];

/** The two things this capo is best at, by value. */
export function capoTopSkills(capo: CrewMember): (keyof CrewSkills)[] {
  return [...SKILL_KEYS].sort((a, b) => capo.skills[b] - capo.skills[a]).slice(0, 2);
}

/**
 * What a crew learns each week. A capo teaches whatever he is personally best
 * at; the boss's crew is the hitman school (muscle + stealth); the
 * consigliere's crew learns to think and move quiet (smarts + stealth).
 */
export function crewCurriculum(leader: CrewMember): (keyof CrewSkills)[] {
  if (leader.role === "boss") return ["muscle", "stealth"];
  if (leader.role === "consigliere") return ["smarts", "stealth"];
  return capoTopSkills(leader);
}

/** The skill that drips in slowly from just being around the crew. */
function dripSkill(leader: CrewMember, tenure: number): keyof CrewSkills {
  // Shooters get wheel time; the consigliere's men learn to talk; a capo's men
  // pick up collections (smarts) and how the capo talks (charm), alternating.
  if (leader.role === "boss") return "driving";
  if (leader.role === "consigliere") return "charm";
  return (tenure / MANAGEMENT_DRIP_EVERY) % 2 === 1 ? "smarts" : "charm";
}

/** How well the leader teaches a skill: a capo by his own hand, the brass through their school. */
function teacherSkill(leader: CrewMember, skill: keyof CrewSkills): number {
  const own = leader.skills[skill];
  return leader.role === "capo" ? own : Math.max(own, SCHOOL_TEACHER_FLOOR);
}

export function isSettling(member: CrewMember, turn: number): boolean {
  return (member.crewSinceTurn ?? -Infinity) + CREW_SETTLING_TURNS > turn;
}

/**
 * Per-skill chance of +1 this turn. Uncapped: a student can pass his teacher.
 * `schoolHot`: the boss's shooter is garrisoned on the boss's own block — the
 * school runs every day, and the newcomer's settling-in penalty is waived.
 */
export function mentoringChance(
  leader: CrewMember,
  soldier: CrewMember,
  skill: keyof CrewSkills,
  turn: number,
  schoolHot = false,
): number {
  const gap = Math.max(0, teacherSkill(leader, skill) - soldier.skills[skill]);
  let chance = MENTOR_BASE_CHANCE + gap / MENTOR_GAP_DIVISOR;
  if (schoolHot) chance *= BOSS_PRESENCE.mentorMult;
  else if (isSettling(soldier, turn)) chance *= 0.5;
  return Math.min(schoolHot ? 0.9 : 0.6, chance);
}

/** The boss's man, standing on the boss's block. */
export function isSchoolHot(state: LocationState, leader: CrewMember, soldier: CrewMember): boolean {
  if (leader.role !== "boss") return false;
  const block = bossPresenceDistrict(state, leader.family);
  return !!block && resolveCrewTerritoryId(state, soldier.id) === block;
}

export interface MentoringLog {
  crewId: string;
  name: string;
  skill: keyof CrewSkills;
  value: number;
}

/**
 * Per-turn crew tick: mentoring, the management drip, and loyalty drift.
 * Runs for every family so rivals' crews grow the same way.
 */
export function tickCrewMentoring(
  crew: CrewMember[],
  turn: number,
  rng: Rng,
  playerFamily: FamilyName | null,
  /** Map state, so the boss's school can run hot on his own block. */
  where?: Omit<LocationState, "crew">,
): { crew: CrewMember[]; logs: MentoringLog[] } {
  const logs: MentoringLog[] = [];
  const base = orphanCrews(crew);
  const loc: LocationState | undefined = where ? { ...where, crew: base, turn } : undefined;
  const next = base.map((m) => {
    if (!m.capoId || m.status !== "active") return m;
    const capo = base.find((c) => c.id === m.capoId);
    if (!capo || capo.status !== "active") return m;

    const skills = { ...m.skills };
    let gained = false;
    const hot = !!loc && isSchoolHot(loc, capo, m);

    for (const skill of crewCurriculum(capo)) {
      if (skills[skill] >= 100) continue;
      if (rng.chance(mentoringChance(capo, m, skill, turn, hot))) {
        skills[skill] += 1;
        gained = true;
        if (m.family === playerFamily) {
          logs.push({ crewId: m.id, name: m.name, skill, value: skills[skill] });
        }
      }
    }

    // Slow drip from just being around: collections and capo-talk for a capo's
    // men, wheel time for the boss's shooters, talk for the consigliere's men.
    const tenure = turn - (m.crewSinceTurn ?? turn);
    if (tenure > 0 && tenure % MANAGEMENT_DRIP_EVERY === 0) {
      const key = dripSkill(capo, tenure);
      if (skills[key] < 100) {
        skills[key] += 1;
        gained = true;
      }
    }

    // Loyalty drifts toward the capo's. A rotten capo rots his crew.
    let loyalty = m.loyalty;
    if (loyalty < capo.loyalty) loyalty += 1;
    else if (loyalty > capo.loyalty) loyalty -= 1;

    return {
      ...m,
      skills: gained ? skills : m.skills,
      xp: m.xp + CREW_XP_PER_TURN,
      loyalty,
    };
  });
  return { crew: next, logs };
}

/* ------------------------------------------------------------------ */
/* Freelance edge                                                      */
/* ------------------------------------------------------------------ */

/** Skills as they read on a casing job: loose soldiers are sharper on the street. */
export function casingSkills(lookout: CrewMember): CrewSkills {
  if (!isFreelanceSoldier(lookout)) return lookout.skills;
  return {
    ...lookout.skills,
    stealth: Math.min(100, lookout.skills.stealth + FREELANCE_STEALTH_EDGE),
    smarts: Math.min(100, lookout.skills.smarts + FREELANCE_SMARTS_EDGE),
  };
}

/** A clean casing teaches a freelance soldier something. */
export function learnFromCleanCasing(crew: CrewMember[], lookoutId: string | undefined): CrewMember[] {
  if (!lookoutId) return crew;
  return crew.map((c) => {
    if (c.id !== lookoutId || !isFreelanceSoldier(c) || c.skills.stealth >= 100) return c;
    return { ...c, skills: { ...c.skills, stealth: c.skills.stealth + 1 } };
  });
}

/* ------------------------------------------------------------------ */
/* Racket income                                                       */
/* ------------------------------------------------------------------ */

/**
 * Multiplier on a racket the capo personally manages. Each working crew soldier
 * adds 4–14% depending on how good the capo is at making money. Only a capo's
 * crew works the rackets; the boss's and consigliere's men are not collectors.
 */
export function crewIncomeMult(manager: CrewMember | null | undefined, crew: CrewMember[] | undefined): number {
  if (!manager || !crew || manager.role !== "capo" || !canLeadCrew(manager)) return 1;
  const men = workingCrewOf(crew, manager.id).length;
  if (men === 0) return 1;
  const perMan =
    CREW_INCOME_PER_MAN + (manager.skills.smarts + manager.skills.charm) / CREW_INCOME_SKILL_DIVISOR;
  return 1 + men * perMan;
}

/* ------------------------------------------------------------------ */
/* Requests: the capo asks                                             */
/* ------------------------------------------------------------------ */

export function pendingCrewRequests(state: Pick<GameState, "crewRequests">): CrewRequest[] {
  return (state.crewRequests ?? []).filter((r) => r.status === "pending");
}

/** A candidate's strongest skill. */
function topSkill(c: CrewMember): keyof CrewSkills {
  return capoTopSkills(c)[0]!;
}

/** What a leader is looking for in a recruit: the first thing his crew learns. */
function wantedSkill(leader: CrewMember): keyof CrewSkills {
  return crewCurriculum(leader)[0]!;
}

function lastName(c: CrewMember): string {
  const parts = c.name.replace(/"[^"]*"\s*/g, "").trim().split(/\s+/);
  const skip = new Set(["II", "III", "IV", "Jr.", "Jr", "Sr.", "Sr"]);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!skip.has(parts[i]!)) return parts[i]!;
  }
  return parts[parts.length - 1] ?? c.name;
}

const SKILL_PRAISE: Record<keyof CrewSkills, string[]> = {
  muscle: ["he's got hands like mine", "kid can hit", "nobody pushes him off a corner"],
  stealth: ["he moves quiet", "you never hear him coming", "he knows how to disappear"],
  smarts: ["he counts fast and keeps his mouth shut", "he sees the angle before I say it"],
  charm: ["people like him, and that's worth money", "he can talk a cop into buying him lunch"],
  driving: ["he can drive", "he knows every alley in the borough"],
};

function pitchFor(
  capo: CrewMember,
  candidate: CrewMember,
  sameBlock: boolean,
  rng: Rng,
): string {
  const skill = wantedSkill(capo);
  const shared = topSkill(candidate) === skill;
  const bits: string[] = [];
  if (shared) bits.push(rng.pick(SKILL_PRAISE[skill]));
  else bits.push(rng.pick(["he's raw but he listens", "he shows up on time, which is rarer than you'd think", "he needs someone to teach him"]));
  if (sameBlock) bits.push("he's been on my corner for a month");
  if (candidate.role === "associate") bits.push("I'll make him a soldier myself");
  const who = candidate.role === "associate" ? "the kid" : lastName(candidate);
  if (capo.role === "consigliere") {
    return `Boss, let me take ${who} under my wing — ${bits.join(", ")}. I'll teach him to think before he talks.`;
  }
  return `Boss, I want ${who} in my crew — ${bits.join(", ")}. Say the word.`;
}

/**
 * Turn-start pass: each player capo (and the consigliere) with an open slot
 * may ask for a man. The boss is the player — he fills his own crew from the
 * Crew panel. Expires deferred asks that have waited a turn. Only the player's
 * men ask; rival crews fill quietly in the AI pass.
 */
export function generateCrewRequests(
  state: GameState,
  rng: Rng,
): { requests: CrewRequest[]; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const turn = state.turn;
  const prior = (state.crewRequests ?? []).map((r) => {
    if (r.status !== "pending") return r;
    // Answered nothing for a full turn after a deferral: he stops asking.
    if ((r.deferred ?? 0) >= 1 && r.turn + 1 < turn) return { ...r, status: "expired" as const };
    // The man he asked for has since joined another crew: the ask is moot.
    const candidate = state.crew.find((c) => c.id === r.candidateId);
    if (candidate?.capoId && candidate.capoId !== r.capoId) return { ...r, status: "expired" as const };
    return r;
  });
  if (!state.playerFamily) return { requests: prior, logs };

  const crew = state.crew;
  const me = state.playerFamily;
  const asking = new Set(prior.filter((r) => r.status === "pending").map((r) => r.capoId));
  const spokenFor = new Set(prior.filter((r) => r.status === "pending").map((r) => r.candidateId));

  const capos = crew.filter(
    (c) => c.family === me && canLeadCrew(c) && c.role !== "boss" && c.status === "active",
  );
  const fresh: CrewRequest[] = [];

  for (const capo of capos) {
    if (asking.has(capo.id)) continue;
    if (openSlots(crew, capo) <= 0) continue;
    const chance = 0.15 + capo.skills.charm / 400;
    if (!rng.chance(chance)) continue;

    const capoBlock = resolveCrewTerritoryId(state, capo.id);
    const pool = crew.filter(
      (c) =>
        c.family === me &&
        c.id !== capo.id &&
        c.status === "active" &&
        (c.role === "soldier" || c.role === "associate") &&
        !c.capoId &&
        !spokenFor.has(c.id) &&
        c.assignment.type !== "operation" &&
        c.assignment.type !== "surveillance",
    );
    if (pool.length === 0) continue;

    const skill = wantedSkill(capo);
    const scored = pool
      .map((c) => {
        const sameBlock = !!capoBlock && resolveCrewTerritoryId(state, c.id) === capoBlock;
        let score = 1;
        if (topSkill(c) === skill) score += 2;
        if (sameBlock) score += 1;
        if (c.role === "soldier") score += 0.5;
        return { c, sameBlock, score };
      })
      .sort((a, b) => b.score - a.score);
    // Mostly the best fit, sometimes a surprise.
    const pick = rng.chance(0.75) ? scored[0]! : rng.pick(scored);

    spokenFor.add(pick.c.id);
    fresh.push({
      id: `crewreq_${capo.id}_${turn}`,
      turn,
      capoId: capo.id,
      candidateId: pick.c.id,
      pitch: pitchFor(capo, pick.c, pick.sameBlock, rng),
      status: "pending",
    });
    logs.push({
      id: `log_crewreq_${capo.id}_${turn}`,
      turn,
      category: "system",
      text: `${capo.name} wants ${pick.c.name} in his crew.`,
      family: me,
    });
  }

  // Keep history short.
  const history = prior.filter((r) => r.status !== "pending").slice(-20);
  const pending = prior.filter((r) => r.status === "pending");
  return { requests: [...history, ...pending, ...fresh], logs };
}

export type CrewRequestAnswer = "approve" | "reject" | "later";

/** Apply the boss's answer. Returns the new state and a one-line result for the UI. */
export function answerCrewRequest(
  state: GameState,
  requestId: string,
  answer: CrewRequestAnswer,
): { state: GameState; message: string } {
  const req = (state.crewRequests ?? []).find((r) => r.id === requestId);
  if (!req || req.status !== "pending") return { state, message: "" };
  const capo = state.crew.find((c) => c.id === req.capoId);
  const candidate = state.crew.find((c) => c.id === req.candidateId);
  const capoName = capo?.name ?? "Your capo";
  const candName = candidate?.name ?? "the kid";

  const setStatus = (status: CrewRequest["status"], patch: Partial<CrewRequest> = {}) =>
    (state.crewRequests ?? []).map((r) => (r.id === requestId ? { ...r, status, ...patch } : r));

  if (answer === "later") {
    return {
      state: { ...state, crewRequests: setStatus("pending", { deferred: (req.deferred ?? 0) + 1 }) },
      message: `${capoName} will ask again next week.`,
    };
  }

  // A man asking to leave after one of his own was taken out.
  if (req.kind === "walk") {
    const walker = state.crew.find((c) => c.id === req.candidateId);
    if (!walker) return { state: { ...state, crewRequests: setStatus("expired") }, message: "" };
    if (answer === "reject") {
      const crew = state.crew.map((c) =>
        c.id === walker.id ? { ...c, loyalty: Math.max(0, c.loyalty - 15) } : c,
      );
      return {
        state: { ...state, crew, crewRequests: setStatus("rejected") },
        message: `${walker.name} stays. He won't forget you made him.`,
      };
    }
    const rng = createRng(hashString(`${state.seed}:walk:${walker.id}:${state.turn}`));
    const gone = walkToRival(state, walker.id, rng);
    const log: TurnLogEntry = {
      id: `log_walk_${walker.id}_${state.turn}`,
      turn: state.turn,
      category: "system",
      text: gone.to
        ? `${walker.name} walks. He turns up with the ${gone.to}.`
        : `${walker.name} walks. Nobody sees where.`,
      family: state.playerFamily ?? undefined,
    };
    return {
      state: { ...gone.state, crewRequests: setStatus("approved"), turnLog: [...gone.state.turnLog, log].slice(-200) },
      message: log.text,
    };
  }

  if (answer === "reject") {
    // Two straight refusals and the capo takes it personally.
    const previous = (state.crewRequests ?? [])
      .filter((r) => r.capoId === req.capoId && r.id !== requestId && r.status !== "pending")
      .sort((a, b) => b.turn - a.turn)[0];
    const sting = previous?.status === "rejected";
    const crew = sting && capo
      ? state.crew.map((c) =>
          c.id === capo.id ? { ...c, loyalty: Math.max(0, c.loyalty - REJECTION_LOYALTY_HIT) } : c,
        )
      : state.crew;
    return {
      state: { ...state, crew, crewRequests: setStatus("rejected") },
      message: sting
        ? `${capoName} nods and says nothing. That's twice.`
        : `${capoName} lets it go.`,
    };
  }

  // approve
  if (!capo || !candidate) {
    return { state: { ...state, crewRequests: setStatus("expired") }, message: "" };
  }
  const check = canJoinCrew(state.crew, candidate.id, capo.id);
  if (!check.ok) {
    return {
      state: { ...state, crewRequests: setStatus("expired") },
      message: check.reason ?? "It didn't work out.",
    };
  }
  const wasAssociate = candidate.role === "associate";
  const crew = joinCrew(state.crew, candidate.id, capo.id, state.turn);
  const log: TurnLogEntry = {
    id: `log_crewjoin_${candidate.id}_${state.turn}`,
    turn: state.turn,
    category: "system",
    text: wasAssociate
      ? `${capoName} made ${candName} a soldier and brought him into his crew.`
      : `${candName} joined ${capoName}'s crew.`,
    family: state.playerFamily ?? undefined,
  };
  return {
    state: {
      ...state,
      crew,
      crewRequests: setStatus("approved"),
      turnLog: [...state.turnLog, log].slice(-200),
    },
    message: wasAssociate
      ? `${candName} is a soldier now. ${capoName} has him.`
      : `${candName} runs with ${capoName} now.`,
  };
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rival leaders quietly fill open slots from their family's loose soldiers,
 * each taking the men best suited to what his crew teaches.
 */
export function aiFillCrews(crew: CrewMember[], family: FamilyName, turn: number): CrewMember[] {
  let next = crew;
  const capos = next.filter((c) => c.family === family && canLeadCrew(c) && c.status === "active");
  for (const capo of capos) {
    let slots = openSlots(next, capo);
    if (slots <= 0) continue;
    const want = wantedSkill(capo);
    const loose = next
      .filter((c) => c.family === family && isFreelanceSoldier(c) && c.status === "active")
      .sort((a, b) => b.skills[want] - a.skills[want]);
    for (const s of loose) {
      if (slots <= 0) break;
      const after = joinCrew(next, s.id, capo.id, turn);
      if (after !== next) {
        next = after;
        slots -= 1;
      }
    }
  }
  return next;
}
