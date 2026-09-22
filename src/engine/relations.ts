import type { FamilyName, RelationStatus, RelationsMatrix } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";

/** Canonical key for a pair of families (alphabetically sorted) */
export function relationKey(a: FamilyName, b: FamilyName): string {
  return [a, b].sort().join("|");
}

export function getRelation(
  matrix: RelationsMatrix,
  a: FamilyName,
  b: FamilyName,
): number {
  if (a === b) return 100;
  return matrix.scores[relationKey(a, b)] ?? 0;
}

export function setRelationDelta(
  matrix: RelationsMatrix,
  a: FamilyName,
  b: FamilyName,
  delta: number,
): RelationsMatrix {
  if (a === b) return matrix;
  const key = relationKey(a, b);
  const current = matrix.scores[key] ?? 0;
  const next = Math.max(-100, Math.min(100, current + delta));
  return {
    scores: { ...matrix.scores, [key]: next },
  };
}

export function setRelation(
  matrix: RelationsMatrix,
  a: FamilyName,
  b: FamilyName,
  score: number,
): RelationsMatrix {
  if (a === b) return matrix;
  const key = relationKey(a, b);
  return {
    scores: { ...matrix.scores, [key]: Math.max(-100, Math.min(100, score)) },
  };
}

export function statusFromScore(score: number): RelationStatus {
  if (score <= -60) return "war";
  if (score <= -30) return "hostile";
  if (score <= -10) return "cold";
  if (score < 10) return "neutral";
  if (score < 40) return "truce";
  return "allied";
}

/** Small random variance per pair at game start */
export function initialRelations(seedOffset = 0): RelationsMatrix {
  const scores: Record<string, number> = {};
  const families = ALL_FAMILY_NAMES;

  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      const a = families[i]!;
      const b = families[j]!;
      const key = relationKey(a, b);
      const hash = (a.charCodeAt(0) + b.charCodeAt(0) + seedOffset) % 40;
      scores[key] = hash - 20;
    }
  }

  return { scores };
}

export function decayRelations(
  matrix: RelationsMatrix,
  amount = 1,
  opts?: {
    fear?: number;
    playerFamily?: FamilyName | null;
    /** Pair keys that do not drift this turn (active pacts). */
    frozenKeys?: Set<string>;
  },
): RelationsMatrix {
  const fear = opts?.fear ?? 0;
  const player = opts?.playerFamily;
  const scores: Record<string, number> = {};
  for (const [key, val] of Object.entries(matrix.scores)) {
    if (opts?.frozenKeys?.has(key)) {
      scores[key] = val;
      continue;
    }
    let step = amount;
    // Feared players: hostile rivals drift back to neutral more slowly
    if (
      player &&
      fear >= 50 &&
      val < -10 &&
      key.includes(player)
    ) {
      step = amount * 0.6;
    }
    if (val > 0) scores[key] = Math.max(0, val - step);
    else if (val < 0) scores[key] = Math.min(0, val + step);
    else scores[key] = 0;
  }
  return { scores };
}

export function getHostileFamilies(
  matrix: RelationsMatrix,
  family: FamilyName,
  threshold = -30,
): FamilyName[] {
  return ALL_FAMILY_NAMES.filter(
    (f) => f !== family && getRelation(matrix, family, f) <= threshold,
  );
}

export function getAlliedFamilies(
  matrix: RelationsMatrix,
  family: FamilyName,
  threshold = 40,
): FamilyName[] {
  return ALL_FAMILY_NAMES.filter(
    (f) => f !== family && getRelation(matrix, family, f) >= threshold,
  );
}
