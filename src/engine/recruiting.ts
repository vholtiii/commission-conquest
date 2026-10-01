import type { CrewMember, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import type { Rng } from "./rng";
import { createCrewMember } from "./crew";

/**
 * Total respect decides who walks in each week. Higher tiers bring more men,
 * and from Respected up they arrive already sharper.
 */
export interface RecruitTier {
  min: number;
  label: string;
  walkIns: number;
  skillBonus: number;
  /** Chance each arrival has at least one trait. */
  traitChance: number;
  /** Crew-panel line after the count, when the tier changes the quality. */
  quality?: string;
}

export const RECRUIT_TIERS: RecruitTier[] = [
  { min: 0, label: "Nobody", walkIns: 1, skillBonus: 0, traitChance: 0 },
  { min: 25, label: "Known", walkIns: 2, skillBonus: 0, traitChance: 0 },
  { min: 50, label: "Respected", walkIns: 3, skillBonus: 8, traitChance: 0.5, quality: "sharper than average" },
  { min: 75, label: "Renowned", walkIns: 4, skillBonus: 15, traitChance: 1, quality: "the best of the street" },
];

/** Walk-ins stop arriving once this many are waiting to be hired. */
export const POOL_CAP = 6;

export function recruitTier(respect: number): RecruitTier {
  const score = Math.max(0, Math.min(100, respect));
  let tier = RECRUIT_TIERS[0]!;
  for (const next of RECRUIT_TIERS) {
    if (score >= next.min) tier = next;
  }
  return tier;
}

/** The tier above the current one, for the "next at N" hint. */
export function nextRecruitTier(respect: number): RecruitTier | null {
  const current = recruitTier(respect);
  return RECRUIT_TIERS.find((t) => t.min > current.min) ?? null;
}

export function recruitTierLine(tier: RecruitTier): string {
  const men = tier.walkIns === 1 ? "1 man a week" : `${tier.walkIns} men a week`;
  return tier.quality ? `${tier.label} — ${men}, ${tier.quality}` : `${tier.label} — ${men}`;
}

export function rollRecruit(rng: Rng, family: FamilyName, tier: RecruitTier): CrewMember {
  const gifted = tier.traitChance > 0 && rng.chance(tier.traitChance);
  return createCrewMember(rng, family, "associate", {
    skillBonus: tier.skillBonus,
    minTraits: gifted ? 1 : 0,
  });
}

/** In the pool because his family is finished, not because he walked in. */
export function isFreeAgent(member: Pick<CrewMember, "freeUntilTurn">): boolean {
  return member.freeUntilTurn != null;
}

function round50(n: number): number {
  return Math.round(n / 50) * 50;
}

/**
 * $800 for an ordinary man, rising with his skill total, capped at $1,400,
 * then the family's recruitment discount.
 */
export function recruitPrice(member: CrewMember, family: FamilyName): number {
  // A man from a finished family asks for nothing while he waits.
  if (isFreeAgent(member)) return 0;
  const sum =
    member.skills.muscle +
    member.skills.stealth +
    member.skills.smarts +
    member.skills.charm +
    member.skills.driving;
  const priced = Math.max(800, Math.min(1400, round50(800 + Math.max(0, sum - 175) * 4)));
  const discount = getFamilyDef(family).bonuses.recruitmentDiscount || 0;
  return Math.floor(priced * (1 - discount));
}

/**
 * The week's walk-ins, from the respect the family holds right now.
 * A full pool takes nobody new until someone is hired.
 */
export function walkIns(
  state: GameState,
  rng: Rng,
): { state: GameState; log?: TurnLogEntry } {
  const family = state.playerFamily;
  if (!family) return { state };
  const tier = recruitTier(state.reputation.respect);
  const pool = state.recruitmentPool ?? [];
  // Scattered men waiting on you don't crowd out the week's walk-ins.
  const walkedIn = pool.filter((c) => !isFreeAgent(c)).length;
  const sanctioned = (state.diplomacy?.sanctionUntil ?? 0) > state.turn;
  const arriving = Math.max(0, Math.min(tier.walkIns, Math.max(0, POOL_CAP - walkedIn)) - (sanctioned ? 1 : 0));
  if (arriving <= 0) return { state };
  const men = Array.from({ length: arriving }, () => rollRecruit(rng, family, tier));
  return {
    state: { ...state, recruitmentPool: [...pool, ...men] },
    log: {
      id: `log_walkin_${state.turn}`,
      turn: state.turn,
      category: "system",
      text:
        arriving === 1
          ? "A man came looking for work."
          : `${arriving} men came looking for work.`,
      family,
    },
  };
}
