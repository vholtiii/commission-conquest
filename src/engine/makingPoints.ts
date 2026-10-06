/** Skill points for opening the books. No other engine imports, so crews can share it. */
import type { CrewSkills } from "@/types/game";
import type { Rng } from "./rng";

export const SKILL_KEYS = ["muscle", "stealth", "smarts", "charm", "driving"] as const;
export const MAKING_POINTS = 4;
export const MAKING_PER_SKILL = 2;

export function emptyAlloc(): CrewSkills {
  return { muscle: 0, stealth: 0, smarts: 0, charm: 0, driving: 0 };
}

/** How many of the 4 points can legally land, given the cap of 2 and 100. */
export function pointsThatFit(skills: CrewSkills): number {
  const room = SKILL_KEYS.reduce(
    (n, k) => n + Math.min(MAKING_PER_SKILL, Math.max(0, 100 - skills[k])),
    0,
  );
  return Math.min(MAKING_POINTS, room);
}

/** Every point that can fit is placed, none over 2, none past 100. */
export function allocationOk(skills: CrewSkills, alloc: CrewSkills): boolean {
  let sum = 0;
  for (const k of SKILL_KEYS) {
    const n = alloc[k] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > MAKING_PER_SKILL) return false;
    if (skills[k] + n > 100) return false;
    sum += n;
  }
  return sum === pointsThatFit(skills);
}

export function applySkillPoints(skills: CrewSkills, alloc: CrewSkills): CrewSkills {
  const next = { ...skills };
  for (const k of SKILL_KEYS) {
    next[k] = Math.max(0, Math.min(100, next[k] + (alloc[k] ?? 0)));
  }
  return next;
}

/** A legal split of whatever points fit. Rivals use the same rules. */
export function randomMakingPoints(skills: CrewSkills, rng: Rng): CrewSkills {
  const alloc = emptyAlloc();
  let left = pointsThatFit(skills);
  while (left > 0) {
    const open = SKILL_KEYS.filter((k) => alloc[k] < MAKING_PER_SKILL && skills[k] + alloc[k] < 100);
    if (open.length === 0) break;
    alloc[rng.pick(open)] += 1;
    left -= 1;
  }
  return alloc;
}
