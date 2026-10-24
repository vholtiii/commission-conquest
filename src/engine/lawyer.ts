import type { CrewMember, GameState, LawyerRetainer, RetainerTier } from "@/types/game";

export interface RetainerSpec {
  label: string;
  cost: number;
  heatDecay: number;
  /** Off bail, the case, the plea, and quieting a name. */
  discount: number;
  blurb: string;
}

export const RETAINER_WEEKS = 4;

export const RETAINERS: Record<RetainerTier, RetainerSpec> = {
  street: {
    label: "Street",
    cost: 2000,
    heatDecay: 1,
    discount: 0.15,
    blurb: "Hears things in the courthouse hallway. Half of it is true.",
  },
  house: {
    label: "House",
    cost: 3600,
    heatDecay: 2,
    discount: 0.3,
    blurb: "Reads the Treasury's mail. Knows when a file opens, roughly when it lands.",
  },
  top: {
    label: "Top-shelf",
    cost: 6000,
    heatDecay: 3,
    discount: 0.4,
    blurb: "Plays cards with the auditors. Warns you before a file opens, and names the week.",
  },
};

export const RETAINER_ORDER: RetainerTier[] = ["street", "house", "top"];

export const RATE_STEP = 0.15;
export const RATE_COOL = 0.05;
export const RATE_CAP = 2;

export const BAIL_HEAT = 3;
export const FIGHT_WEEKS = 2;

const NAMES = [
  "Saul Feinberg, Esq.",
  "Irving Lasker, Esq.",
  "Morris Gold, Esq.",
  "Abe Rothstein, Esq.",
  "Leo Brandt, Esq.",
  "Sid Marcus, Esq.",
  "Herman Kessler, Esq.",
  "Jules Weintraub, Esq.",
];

/** One lawyer per game, picked off the seed. */
export function lawyerName(state: Pick<GameState, "lawyerName" | "seed">): string {
  if (state.lawyerName) return state.lawyerName;
  const i = Math.abs(Math.floor(state.seed ?? 0) * 2654435761) % NAMES.length;
  return NAMES[i]!;
}

/** "Saul Feinberg, Esq." → "Feinberg" */
export function lawyerShortName(state: Pick<GameState, "lawyerName" | "seed">): string {
  const full = lawyerName(state).replace(/, Esq\.$/, "");
  return full.split(" ").slice(-1)[0] ?? full;
}

export function activeRetainer(
  state: Pick<GameState, "lawyerRetainer" | "turn">,
): RetainerTier | null {
  const r = state.lawyerRetainer;
  return r && r.until > state.turn ? r.tier : null;
}

export function retainerHeatDecay(state: Pick<GameState, "lawyerRetainer" | "turn">): number {
  const tier = activeRetainer(state);
  return tier ? RETAINERS[tier].heatDecay : 0;
}

export function currentRate(state: Pick<GameState, "lawyerRate">): number {
  return state.lawyerRate ?? 1;
}

export function bumpRate(rate: number | undefined): number {
  return Math.min(RATE_CAP, Math.round(((rate ?? 1) + RATE_STEP) * 100) / 100);
}

export function coolRate(rate: number | undefined): number {
  return Math.max(1, Math.round(((rate ?? 1) - RATE_COOL) * 100) / 100);
}

export function weeksToCool(rate: number | undefined): number {
  const over = (rate ?? 1) - 1;
  return over > 0 ? Math.ceil(over / RATE_COOL - 1e-9) : 0;
}

/** A fee at his current rate, less the retainer's cut when it's case work. */
export function lawyerFee(
  state: Pick<GameState, "lawyerRate" | "lawyerRetainer" | "turn">,
  base: number,
  caseWork: boolean,
): number {
  const tier = caseWork ? activeRetainer(state) : null;
  const discount = tier ? RETAINERS[tier].discount : 0;
  return Math.round((base * currentRate(state) * (1 - discount)) / 10) * 10;
}

function seniorMan(man: Pick<CrewMember, "role">): boolean {
  return man.role === "capo" || man.role === "underboss" || man.role === "consigliere";
}

export function bailBase(man: Pick<CrewMember, "wanted" | "role">): number {
  const base = 800 + 300 * Math.max(0, man.wanted);
  return seniorMan(man) ? Math.round(base * 1.5) : base;
}

export function fightBase(man: Pick<CrewMember, "wanted">): number {
  return 600 + 200 * Math.max(0, man.wanted);
}

export function retainerFee(
  state: Pick<GameState, "lawyerRate" | "lawyerRetainer" | "turn">,
  tier: RetainerTier,
): number {
  return lawyerFee(state, RETAINERS[tier].cost, false);
}

/** Weeks left on a man's sentence, counting this one. */
export function weeksInside(man: Pick<CrewMember, "jailedUntilTurn">, turn: number): number {
  return Math.max(0, (man.jailedUntilTurn ?? turn) - turn);
}

interface LegacyLawyerFields {
  streetLawyerUntil?: number;
  counselUntil?: number;
}

/** Older saves kept the street lawyer and house counsel as two separate retainers. */
export function migrateRetainer(
  saved: Partial<GameState> & LegacyLawyerFields,
  turn: number,
): LawyerRetainer | null {
  if (saved.lawyerRetainer !== undefined) return saved.lawyerRetainer;
  const counsel = saved.counselUntil ?? 0;
  const street = saved.streetLawyerUntil ?? 0;
  if (counsel > turn) return { tier: "house", until: Math.max(counsel, street) };
  if (street > turn) return { tier: "street", until: street };
  return null;
}
