import type {
  AssignmentType,
  CrewAssignment,
  CrewMember,
  CrewRole,
  CrewSkills,
  CrewStatus,
  CrewTrait,
  FamilyName,
  Territory,
} from "@/types/game";
import type { Rng } from "./rng";
import { generateName } from "./names";

const ROLE_ORDER: CrewRole[] = [
  "associate",
  "soldier",
  "capo",
  "hitman",
  "underboss",
  "consigliere",
  "boss",
];

const ALL_TRAITS: CrewTrait[] = [
  "marksman",
  "wheelman",
  "hothead",
  "rat_risk",
  "bookkeeper",
  "made_man",
  "ghost",
  "enforcer",
  "smooth_talker",
];

const ROLE_SKILL_BIAS: Record<CrewRole, Partial<CrewSkills>> = {
  associate: { muscle: 1, stealth: 1 },
  soldier: { muscle: 2, stealth: 1 },
  capo: { muscle: 2, smarts: 2, charm: 1 },
  hitman: { muscle: 3, stealth: 3, driving: 1 },
  underboss: { muscle: 2, smarts: 2, charm: 2 },
  consigliere: { smarts: 3, charm: 2 },
  boss: { smarts: 2, charm: 2, muscle: 1 },
};

export interface TraitEffect {
  skillBonus: Partial<CrewSkills>;
  loyaltyMod: number;
  incomeMod: number;
  hitMod: number;
  stealthMod: number;
  heatMod: number;
}

export function traitEffects(trait: CrewTrait): TraitEffect {
  switch (trait) {
    case "marksman":
      return { skillBonus: { muscle: 3 }, loyaltyMod: 0, incomeMod: 0, hitMod: 0.12, stealthMod: 0, heatMod: 0 };
    case "wheelman":
      return { skillBonus: { driving: 4 }, loyaltyMod: 0, incomeMod: 0, hitMod: 0.05, stealthMod: 0.08, heatMod: 0 };
    case "hothead":
      return { skillBonus: { muscle: 2 }, loyaltyMod: -5, incomeMod: 0, hitMod: 0.08, stealthMod: -0.1, heatMod: 2 };
    case "rat_risk":
      return { skillBonus: { smarts: 1 }, loyaltyMod: -10, incomeMod: 0, hitMod: -0.05, stealthMod: 0, heatMod: 0 };
    case "bookkeeper":
      return { skillBonus: { smarts: 3 }, loyaltyMod: 2, incomeMod: 0.08, hitMod: 0, stealthMod: 0, heatMod: -1 };
    case "made_man":
      return { skillBonus: { muscle: 1, charm: 1 }, loyaltyMod: 10, incomeMod: 0, hitMod: 0.05, stealthMod: 0, heatMod: 0 };
    case "ghost":
      return { skillBonus: { stealth: 4 }, loyaltyMod: 0, incomeMod: 0, hitMod: 0.1, stealthMod: 0.15, heatMod: -2 };
    case "enforcer":
      return { skillBonus: { muscle: 3, charm: -1 }, loyaltyMod: 3, incomeMod: 0, hitMod: 0.06, stealthMod: -0.05, heatMod: 3 };
    case "smooth_talker":
      return { skillBonus: { charm: 4 }, loyaltyMod: 5, incomeMod: 0.05, hitMod: 0, stealthMod: 0.05, heatMod: 0 };
    default:
      return { skillBonus: {}, loyaltyMod: 0, incomeMod: 0, hitMod: 0, stealthMod: 0, heatMod: 0 };
  }
}

export function aggregateTraitEffects(traits: CrewTrait[]): TraitEffect {
  return traits.reduce(
    (acc, t) => {
      const e = traitEffects(t);
      for (const [k, v] of Object.entries(e.skillBonus)) {
        const key = k as keyof CrewSkills;
        acc.skillBonus[key] = (acc.skillBonus[key] ?? 0) + (v ?? 0);
      }
      acc.loyaltyMod += e.loyaltyMod;
      acc.incomeMod += e.incomeMod;
      acc.hitMod += e.hitMod;
      acc.stealthMod += e.stealthMod;
      acc.heatMod += e.heatMod;
      return acc;
    },
    {
      skillBonus: {} as Partial<CrewSkills>,
      loyaltyMod: 0,
      incomeMod: 0,
      hitMod: 0,
      stealthMod: 0,
      heatMod: 0,
    },
  );
}

function rollSkills(rng: Rng, role: CrewRole): CrewSkills {
  const bias = ROLE_SKILL_BIAS[role];
  const roll = () => rng.int(15, 55);
  return {
    muscle: roll() + (bias.muscle ?? 0) * 5,
    stealth: roll() + (bias.stealth ?? 0) * 5,
    smarts: roll() + (bias.smarts ?? 0) * 5,
    charm: roll() + (bias.charm ?? 0) * 5,
    driving: roll() + (bias.driving ?? 0) * 5,
  };
}

function rollTraits(rng: Rng, role: CrewRole): CrewTrait[] {
  const count = role === "boss" ? 2 : rng.int(0, 2);
  const pool = rng.shuffle([...ALL_TRAITS]);
  const traits = pool.slice(0, count);
  if (role === "boss" && !traits.includes("made_man")) {
    traits.push("made_man");
  }
  return traits;
}

export function createCrewMember(
  rng: Rng,
  family: FamilyName,
  role: CrewRole = "soldier",
  opts?: { name?: string; isPlayerBoss?: boolean; id?: string },
): CrewMember {
  const traits = rollTraits(rng, role);
  const traitAgg = aggregateTraitEffects(traits);
  const baseLoyalty = rng.int(55, 85) + traitAgg.loyaltyMod;

  return {
    id: opts?.id ?? `crew_${family}_${rng.int(10000, 99999)}`,
    name: opts?.name ?? generateName(rng),
    family,
    role,
    skills: rollSkills(rng, role),
    traits,
    loyalty: Math.min(100, Math.max(20, baseLoyalty)),
    wanted: rng.int(0, role === "boss" ? 15 : 5),
    xp: role === "boss" ? 500 : rng.int(0, 100),
    level: role === "boss" ? 5 : role === "capo" ? 3 : 1,
    status: "active",
    portraitSeed: rng.int(1, 99999),
    assignment: { type: "idle" },
    hits: role === "hitman" ? rng.int(2, 8) : 0,
    isPlayerBoss: opts?.isPlayerBoss,
    roleSinceTurn: 0,
  };
}

export function generateRecruitmentPool(
  rng: Rng,
  family: FamilyName,
  count = 4,
): CrewMember[] {
  return Array.from({ length: count }, () =>
    createCrewMember(rng, family, "associate"),
  );
}

export interface PromotionPath {
  from: CrewRole;
  to: CrewRole;
  cost: number;
  /** Human-readable requirement checks. */
  check: (
    member: CrewMember,
    crew: CrewMember[],
  ) => { ok: boolean; reasons: { label: string; met: boolean }[] };
}

export const PROMOTION_PATHS: PromotionPath[] = [
  {
    from: "associate",
    to: "soldier",
    cost: 300,
    check: (m) => {
      const reasons = [
        { label: "Level ≥ 2", met: m.level >= 2 },
        { label: "Loyalty ≥ 40", met: m.loyalty >= 40 },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
  {
    from: "soldier",
    to: "capo",
    cost: 1200,
    check: (m) => {
      const reasons = [
        { label: "Level ≥ 3", met: m.level >= 3 },
        { label: "Loyalty ≥ 55", met: m.loyalty >= 55 },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
  {
    from: "soldier",
    to: "hitman",
    cost: 1000,
    check: (m) => {
      const reasons = [
        { label: "Hits ≥ 3", met: m.hits >= 3 },
        { label: "Muscle ≥ 45", met: m.skills.muscle >= 45 },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
  {
    from: "hitman",
    to: "capo",
    cost: 1500,
    check: (m) => {
      const reasons = [
        { label: "Level ≥ 4", met: m.level >= 4 },
        { label: "Hits ≥ 6", met: m.hits >= 6 },
        { label: "Loyalty ≥ 55", met: m.loyalty >= 55 },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
  {
    from: "capo",
    to: "underboss",
    cost: 2500,
    check: (m, crew) => {
      const hasUb = crew.some(
        (c) =>
          c.family === m.family &&
          c.role === "underboss" &&
          (c.status === "active" || c.status === "wounded"),
      );
      const reasons = [
        { label: "Level ≥ 5", met: m.level >= 5 },
        { label: "Loyalty ≥ 65", met: m.loyalty >= 65 },
        { label: "Hits ≥ 2", met: m.hits >= 2 },
        { label: "No active underboss", met: !hasUb },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
  {
    from: "capo",
    to: "consigliere",
    cost: 2500,
    check: (m, crew) => {
      const hasCons = crew.some(
        (c) =>
          c.family === m.family &&
          c.role === "consigliere" &&
          (c.status === "active" || c.status === "wounded"),
      );
      const reasons = [
        { label: "Level ≥ 4", met: m.level >= 4 },
        { label: "Smarts ≥ 50", met: m.skills.smarts >= 50 },
        { label: "Loyalty ≥ 65", met: m.loyalty >= 65 },
        { label: "No active consigliere", met: !hasCons },
      ];
      return { ok: reasons.every((r) => r.met), reasons };
    },
  },
];

export function pathsFromRole(role: CrewRole): PromotionPath[] {
  return PROMOTION_PATHS.filter((p) => p.from === role);
}

export function canPromote(
  member: CrewMember,
  toRole: CrewRole,
  crew: CrewMember[],
  money: number,
): { ok: boolean; cost: number; reasons: { label: string; met: boolean }[] } {
  const path = PROMOTION_PATHS.find((p) => p.from === member.role && p.to === toRole);
  if (!path) {
    return { ok: false, cost: 0, reasons: [{ label: "No promotion path", met: false }] };
  }
  const checked = path.check(member, crew);
  const reasons = [
    ...checked.reasons,
    { label: `Cash $${path.cost}`, met: money >= path.cost },
    { label: "Active", met: member.status === "active" },
  ];
  return { ok: reasons.every((r) => r.met), cost: path.cost, reasons };
}

export function promoteCrew(
  crew: CrewMember[],
  memberId: string,
  toRole: CrewRole,
  turn: number,
): CrewMember[] {
  return crew.map((m) => {
    if (m.id !== memberId || m.status !== "active") return m;
    const path = PROMOTION_PATHS.find((p) => p.from === m.role && p.to === toRole);
    if (!path) return m;
    return {
      ...m,
      role: toRole,
      level: m.level + 1,
      loyalty: Math.min(100, m.loyalty + 5),
      roleSinceTurn: turn,
    };
  });
}

/** XP needed to reach a given level (level 1 = 0). */
export function xpForLevel(level: number): number {
  return Math.max(0, (level - 1) * 120);
}

function topBiasedSkills(role: CrewRole): (keyof CrewSkills)[] {
  const bias = ROLE_SKILL_BIAS[role];
  return (Object.entries(bias) as [keyof CrewSkills, number][])
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 2)
    .map(([k]) => k);
}

export function gainXp(
  member: CrewMember,
  amount: number,
): { member: CrewMember; leveled: boolean; levelsGained: number } {
  if (amount <= 0 || member.status === "dead") {
    return { member, leveled: false, levelsGained: 0 };
  }
  let xp = member.xp + amount;
  let level = member.level;
  let skills = { ...member.skills };
  let levelsGained = 0;
  while (level < 10 && xp >= xpForLevel(level + 1)) {
    level += 1;
    levelsGained += 1;
    for (const key of topBiasedSkills(member.role)) {
      skills[key] = Math.min(100, skills[key] + 2);
    }
  }
  return {
    member: { ...member, xp, level, skills },
    leveled: levelsGained > 0,
    levelsGained,
  };
}

export function grantXpToCrew(
  crew: CrewMember[],
  memberId: string,
  amount: number,
): { crew: CrewMember[]; leveled: boolean; name?: string; level?: number } {
  let leveled = false;
  let name: string | undefined;
  let level: number | undefined;
  const next = crew.map((m) => {
    if (m.id !== memberId) return m;
    const result = gainXp(m, amount);
    if (result.leveled) {
      leveled = true;
      name = result.member.name;
      level = result.member.level;
    }
    return result.member;
  });
  return { crew: next, leveled, name, level };
}

export function assignCrew(
  crew: CrewMember[],
  memberId: string,
  assignment: CrewAssignment,
): CrewMember[] {
  return crew.map((m) => {
    if (m.id !== memberId) return m;
    if (m.status !== "active" && m.status !== "wounded") return m;
    return { ...m, assignment };
  });
}

export function clearAssignmentType(
  crew: CrewMember[],
  type: AssignmentType,
  exceptId?: string,
): CrewMember[] {
  return crew.map((m) => {
    if (m.id === exceptId) return m;
    if (m.assignment.type === type) {
      return { ...m, assignment: { type: "idle" } };
    }
    return m;
  });
}

/** Loyalty penalty when a crew member is buried; scales with dead member's rank */
export function funeralLoyaltyHit(
  crew: CrewMember[],
  deadMemberId: string,
): CrewMember[] {
  const dead = crew.find((m) => m.id === deadMemberId);
  if (!dead) return crew;

  const roleIdx = ROLE_ORDER.indexOf(dead.role);
  const penalty = 3 + roleIdx * 2;

  return crew.map((m) => {
    if (m.id === deadMemberId || m.status === "dead") return m;
    if (m.family !== dead.family) return m;
    const sameCrew = m.assignment.territoryId === dead.assignment.territoryId;
    const extra = sameCrew ? 3 : 0;
    return {
      ...m,
      loyalty: Math.max(10, m.loyalty - penalty - extra),
    };
  });
}

export function getActiveCrew(crew: CrewMember[], family: FamilyName): CrewMember[] {
  return crew.filter(
    (m) => m.family === family && m.status === "active",
  );
}

export function getBoss(crew: CrewMember[], family: FamilyName): CrewMember | undefined {
  return crew.find(
    (m) => m.family === family && m.role === "boss" && m.status !== "dead",
  );
}

export function roleUpkeep(role: CrewRole): number {
  switch (role) {
    case "boss":
      return 300;
    case "underboss":
      return 250;
    case "consigliere":
      return 200;
    case "capo":
      return 150;
    case "hitman":
      return 100;
    case "soldier":
      return 50;
    case "associate":
      return 25;
    default:
      return 50;
  }
}

export function crewCombatScore(member: CrewMember): number {
  const t = aggregateTraitEffects(member.traits);
  const s = member.skills;
  const skillSum =
    s.muscle * 1.2 +
    s.stealth * 0.8 +
    s.smarts * 0.6 +
    s.driving * 0.5 +
    (member.loyalty / 100) * 20;
  const roleMult =
    member.role === "hitman"
      ? 1.4
      : member.role === "underboss"
        ? 1.3
        : member.role === "capo"
          ? 1.2
          : member.role === "boss"
            ? 1.5
            : 1;
  return skillSum * roleMult * (1 + t.hitMod);
}

/** Clear racket managers who died, were jailed, or left the family. */
export function pruneManagers(state: {
  crew: CrewMember[];
  territories: { id: string; rackets: { id: string; managerId: string | null }[] }[];
}): typeof state.territories {
  return state.territories.map((t) => ({
    ...t,
    rackets: t.rackets.map((r) => {
      if (!r.managerId) return r;
      const m = state.crew.find((c) => c.id === r.managerId);
      if (!m || m.status === "dead" || m.status === "jailed") {
        return { ...r, managerId: null };
      }
      return r;
    }),
  }));
}

/** Per-turn XP for garrison / managers / lookouts. Skip managers of frozen rackets. */
export function tickAssignmentXp(
  crew: CrewMember[],
  playerFamily: FamilyName | null,
  territories?: Territory[],
  turn = 0,
): { crew: CrewMember[]; logs: { name: string; level: number }[] } {
  const frozenManagers = new Set<string>();
  if (territories) {
    for (const t of territories) {
      for (const r of t.rackets) {
        if (r.managerId && (r.frozenUntil ?? 0) > turn) {
          frozenManagers.add(r.managerId);
        }
      }
    }
  }
  const logs: { name: string; level: number }[] = [];
  const next = crew.map((m) => {
    if (m.status !== "active") return m;
    let amount = 0;
    if (m.assignment.type === "garrison") amount = 2;
    else if (m.assignment.type === "racket") {
      if (frozenManagers.has(m.id)) return m;
      amount = 3;
    } else if (m.assignment.type === "surveillance") amount = 3;
    if (amount <= 0) return m;
    const result = gainXp(m, amount);
    if (result.leveled && playerFamily && m.family === playerFamily) {
      logs.push({ name: result.member.name, level: result.member.level });
    }
    return result.member;
  });
  return { crew: next, logs };
}
