/**
 * How long a family waits. Volatile families want short truces and send
 * messages sooner; economic families sit on a grudge. City-wide cadences
 * (dinner, errands, the Commission) jitter once per seed so two games
 * don't tick on the same clock.
 */
import type { AiPersonality, GameLength } from "@/types/game";

export interface Tempo {
  truceWeeks: number;
  contractWeeks: number;
  /** Weeks before this family sends another message hit. */
  messageCooldown: number;
  /** How long a passage grudge stays warm. */
  passageGrudge: number;
  /** Weeks a standing liquor sale runs. */
  standingSaleWeeks: number;
  /**
   * Weeks before the player of this temperament can call another man in.
   * Same patience as the message cooldown: a hot family acts again sooner.
   */
  callInCooldown: number;
  /** Sit-down copy. Only the extremes get a word. */
  lengthWord: "short" | "long" | null;
}

const TABLE: Record<AiPersonality, Tempo> = {
  economic: {
    truceWeeks: 8,
    contractWeeks: 6,
    messageCooldown: 8,
    passageGrudge: 6,
    standingSaleWeeks: 6,
    callInCooldown: 8,
    lengthWord: "long",
  },
  expansionist: {
    truceWeeks: 5,
    contractWeeks: 6,
    messageCooldown: 6,
    passageGrudge: 8,
    standingSaleWeeks: 6,
    callInCooldown: 6,
    lengthWord: null,
  },
  covert: {
    truceWeeks: 7,
    contractWeeks: 8,
    messageCooldown: 7,
    passageGrudge: 8,
    standingSaleWeeks: 6,
    callInCooldown: 7,
    lengthWord: null,
  },
  smuggler: {
    truceWeeks: 6,
    contractWeeks: 6,
    messageCooldown: 5,
    passageGrudge: 8,
    standingSaleWeeks: 8,
    callInCooldown: 5,
    lengthWord: null,
  },
  volatile: {
    truceWeeks: 4,
    contractWeeks: 4,
    messageCooldown: 4,
    passageGrudge: 10,
    standingSaleWeeks: 5,
    callInCooldown: 4,
    lengthWord: "short",
  },
};

export function tempoFor(personality: AiPersonality): Tempo {
  return TABLE[personality];
}

/** Stable for a seed. Dinner is 7–10 weeks; errands and Commission asks are 6–10. */
export function cadence(seed: number, kind: "dinner" | "errand" | "commission"): number {
  const salt = kind === "dinner" ? 3 : kind === "errand" ? 11 : 19;
  const n = (Math.abs(seed) ^ (salt * 0x9e3779b1)) >>> 0;
  if (kind === "dinner") return 7 + (n % 4);
  return 6 + (n % 5);
}

/** Sudden-death streak length. Short games crown sooner; long games ask for a longer run. */
export function leadTurnsFor(length: GameLength | undefined): number {
  if (length === "short") return 5;
  if (length === "long") return 8;
  return 6;
}
