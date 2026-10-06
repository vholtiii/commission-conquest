import type { BribeStatus, CrewMember, GameState, HeatState, TurnLogEntry } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { jailInCrew } from "./jail";
import { isLegitBusiness, isRacketFrozen, legitCoverWantedDrop, STREET_LAWYER_HEAT_DECAY } from "./economy";
import { SAFEHOUSE, laidLowHouse } from "./safehouse";

/** When the law starts picking men up at the end of the week. */
export const WARRANT = {
  /** Family heat at which bench warrants go out. */
  heatFloor: 60,
  /** A man has to be wanted above this to be on the warrant list. */
  wantedFloor: 5,
  /** Weekly chance a man on the list is picked up. */
  chance: 0.08,
} as const;

export interface ArrestReducer {
  /** Short label for the UI chip, e.g. "Cops paid". */
  label: string;
  /** What it's doing, e.g. "−2 heat/wk". */
  effect: string;
}

export interface ArrestRisk {
  /** Chance this man is picked up at the end of the week, 0–1. */
  chance: number;
  /** True when he's on the warrant list right now (heat and wanted both over the line). */
  listed: boolean;
  /** Things pulling his odds down — bribes cooling the heat, a safehouse or legit front shedding his wanted. */
  reducers: ArrestReducer[];
  /** One-line explanation for a tooltip. */
  note: string;
}

type ArrestState = Pick<
  GameState,
  | "heat"
  | "bribes"
  | "territories"
  | "turn"
  | "playerFamily"
  | "ratLeakTurn"
  | "ratLeakWeeks"
  | "streetLawyerUntil"
>;

/** A spared rat keeps talking for this many weeks, unless a harsher leak says otherwise. */
const RAT_LEAK_WEEKS = 4;

function leakWeeks(state: Pick<ArrestState, "ratLeakWeeks">): number {
  return state.ratLeakWeeks ?? RAT_LEAK_WEEKS;
}

function ratLeaking(state: Pick<ArrestState, "ratLeakTurn" | "ratLeakWeeks" | "turn">): boolean {
  return state.ratLeakTurn != null && state.turn >= state.ratLeakTurn && state.turn < state.ratLeakTurn + leakWeeks(state);
}

const BRIBE_LABEL: Record<keyof GameState["bribes"], string> = {
  cops: "cops",
  captains: "captains",
  chiefs: "chiefs",
  mayor: "mayor",
  judge: "judge",
};

/**
 * The odds a man gets picked up this week and what's working in his favour.
 * Mirrors `applyWarrantConsequences`: the roll only happens once the family's
 * heat is at the warrant line and the man is wanted above the floor.
 */
export function arrestRisk(state: ArrestState, m: CrewMember): ArrestRisk {
  const reducers: ArrestReducer[] = [];

  const paid = (Object.keys(state.bribes) as (keyof GameState["bribes"])[]).filter((k) => {
    const b = state.bribes[k];
    return b?.isActive && bribeEffects(k, true).heatReduction > 0;
  });
  if (paid.length > 0) {
    const cooling = paid.reduce((sum, k) => sum + bribeEffects(k, true).heatReduction, 0);
    reducers.push({
      label: `${paid.map((k) => BRIBE_LABEL[k]).join(", ")} paid`,
      effect: `−${cooling} heat/wk`,
    });
  }

  if ((state.streetLawyerUntil ?? 0) > state.turn) {
    reducers.push({
      label: "street lawyer",
      effect: `−${STREET_LAWYER_HEAT_DECAY} heat/wk`,
    });
  }

  if (m.status === "active" || m.status === "wounded") {
    const house = laidLowHouse(state, m);
    if (house) {
      reducers.push({
        label: "lying low",
        effect: `−${house.level + SAFEHOUSE.wantedBonus} wanted/wk`,
      });
    } else {
      let front = 0;
      for (const t of state.territories) {
        for (const r of t.rackets) {
          if (r.managerId !== m.id || !isLegitBusiness(r.type) || isRacketFrozen(r, state.turn)) continue;
          front = Math.max(front, legitCoverWantedDrop(r.level));
        }
      }
      if (front > 0) reducers.push({ label: "legit front", effect: `−${front} wanted/wk` });
    }
  }

  if (m.status !== "active") {
    return { chance: 0, listed: false, reducers, note: "Not on the street — nothing to pick up." };
  }

  const leaking = ratLeaking(state);
  const wantedFloor = leaking ? WARRANT.wantedFloor - 2 : WARRANT.wantedFloor;
  const hot = state.heat.level >= WARRANT.heatFloor;
  const wanted = m.wanted > wantedFloor;
  const listed = hot && wanted;
  const chance = listed ? (leaking ? 0.14 : WARRANT.chance) : 0;
  const heatLine = `heat ${Math.round(state.heat.level)}/${WARRANT.heatFloor}`;
  const wantedLine = `wanted ${m.wanted} (list starts at ${wantedFloor + 1})`;
  const note = listed
    ? `On the warrant list (${heatLine}, ${wantedLine}): ${Math.round(chance * 100)}% a week he's picked up.`
    : `Warrants go out at heat ${WARRANT.heatFloor} for men wanted over ${WARRANT.wantedFloor}; then it's ${Math.round(WARRANT.chance * 100)}% a week. Now: ${heatLine}, ${wantedLine}.`;
  return { chance, listed, reducers, note };
}

export interface HeatThreshold {
  level: number;
  label: string;
  consequence: string;
}

export const HEAT_THRESHOLDS: HeatThreshold[] = [
  { level: 20, label: "Street Patrols", consequence: "Increased police foot patrols in hot districts." },
  { level: 40, label: "Raids", consequence: "Vice squad raids on rackets — income reduced." },
  { level: 60, label: "Warrants", consequence: "Bench warrants issued for known associates." },
  { level: 80, label: "Federal Investigation", consequence: "FBI task force targeting commission families." },
];

export interface BribeEffectSummary {
  heatReduction: number;
  heatGenerationReduction: number;
  economicPressure: number;
  intelBonus: number;
  shutdownEffect: boolean;
}

export function bribeEffects(
  bribeType: keyof GameState["bribes"],
  isActive: boolean,
): BribeEffectSummary {
  if (!isActive) {
    return {
      heatReduction: 0,
      heatGenerationReduction: 0,
      economicPressure: 0,
      intelBonus: 0,
      shutdownEffect: false,
    };
  }

  switch (bribeType) {
    case "cops":
      return {
        heatReduction: 2,
        heatGenerationReduction: 0.25,
        economicPressure: 0,
        intelBonus: 0,
        shutdownEffect: false,
      };
    case "captains":
      return {
        heatReduction: 1,
        heatGenerationReduction: 0.1,
        economicPressure: 0.15,
        intelBonus: 0,
        shutdownEffect: false,
      };
    case "chiefs":
      return {
        heatReduction: 0,
        heatGenerationReduction: 0,
        economicPressure: 0,
        intelBonus: 0.4,
        shutdownEffect: false,
      };
    case "mayor":
      return {
        heatReduction: 3,
        heatGenerationReduction: 0.15,
        economicPressure: 0,
        intelBonus: 0,
        shutdownEffect: true,
      };
    default:
      return {
        heatReduction: 0,
        heatGenerationReduction: 0,
        economicPressure: 0,
        intelBonus: 0,
        shutdownEffect: false,
      };
  }
}

export function aggregateBribeEffects(
  bribes: GameState["bribes"],
): BribeEffectSummary {
  const keys = Object.keys(bribes) as (keyof GameState["bribes"])[];
  return keys.reduce(
    (acc, key) => {
      const status = bribes[key];
      const fx = bribeEffects(key, status.isActive);
      acc.heatReduction += fx.heatReduction;
      acc.heatGenerationReduction += fx.heatGenerationReduction;
      acc.economicPressure += fx.economicPressure;
      acc.intelBonus += fx.intelBonus;
      acc.shutdownEffect = acc.shutdownEffect || fx.shutdownEffect;
      return acc;
    },
    {
      heatReduction: 0,
      heatGenerationReduction: 0,
      economicPressure: 0,
      intelBonus: 0,
      shutdownEffect: false,
    },
  );
}

export function applyHeat(
  heat: HeatState,
  amount: number,
  source: string,
  generationReduction = 0,
): HeatState {
  const effective = amount * (1 - Math.min(0.75, generationReduction));
  const level = Math.max(0, Math.min(100, heat.level + effective));
  const sources = effective > 0 ? [...heat.sources, source].slice(-25) : heat.sources;
  return { ...heat, level, sources };
}

export function decayHeat(heat: HeatState, amount: number): HeatState {
  return {
    ...heat,
    level: Math.max(0, heat.level - amount),
  };
}

export function getActiveConsequences(level: number): string[] {
  return HEAT_THRESHOLDS.filter((t) => level >= t.level).map((t) => t.consequence);
}

export function tickBribes(bribes: GameState["bribes"]): GameState["bribes"] {
  const next = { ...bribes };
  for (const key of Object.keys(next) as (keyof GameState["bribes"])[]) {
    const b: BribeStatus = { ...next[key] };
    if (b.isActive && b.turnsRemaining > 0) {
      b.turnsRemaining -= 1;
      if (b.turnsRemaining <= 0) {
        b.isActive = false;
      }
    }
    next[key] = b;
  }
  return next;
}

export interface HeatTurnResult {
  heat: HeatState;
  logs: TurnLogEntry[];
  incomePenalty: number;
  warrantRisk: boolean;
}

export function processHeatTurn(state: GameState): HeatTurnResult {
  const logs: TurnLogEntry[] = [];
  const bribeFx = aggregateBribeEffects(state.bribes);

  let heat = decayHeat(state.heat, 2 + bribeFx.heatReduction);

  if ((state.streetLawyerUntil ?? 0) > state.turn) {
    heat = decayHeat(heat, STREET_LAWYER_HEAT_DECAY);
  }

  if (state.playerFamily) {
    const def = getFamilyDef(state.playerFamily);
    if (def.bonuses.heatReduction) {
      heat = decayHeat(heat, Math.floor(def.bonuses.heatReduction * 10));
    }
  }

  const consequences = getActiveConsequences(heat.level);
  heat = { ...heat, consequences };

  let incomePenalty = 0;
  let warrantRisk = false;

  if (heat.level >= 40) {
    incomePenalty = 0.1 + (heat.level - 40) / 200;
    logs.push({
      id: `log_heat_raid_${state.turn}`,
      turn: state.turn,
      category: "heat",
      text: "Vice raids squeeze racket profits across the city.",
    });
  }

  if (heat.level >= 60) {
    warrantRisk = true;
    logs.push({
      id: `log_heat_warrant_${state.turn}`,
      turn: state.turn,
      category: "heat",
      text: "Judges sign warrants — crews are laying low.",
    });
  }

  if (heat.level >= 80) {
    logs.push({
      id: `log_heat_federal_${state.turn}`,
      turn: state.turn,
      category: "heat",
      text: "Federal agents build a RICO case against the commission.",
    });
  }

  return { heat, logs, incomePenalty, warrantRisk };
}

export function applyWarrantConsequences(state: GameState): GameState {
  if (!state.playerFamily) return state;

  let crew = state.crew;
  let turnLog = state.turnLog;
  // The week a spared rat starts talking, wanted climbs across the family.
  if (ratLeaking(state) && state.turn === state.ratLeakTurn && !state.ratLeakSilent) {
    crew = crew.map((c) =>
      c.family === state.playerFamily && c.status === "active" ? { ...c, wanted: c.wanted + 1 } : c,
    );
    turnLog = [
      ...turnLog,
      {
        id: `log_rat_leak_${state.turn}`,
        turn: state.turn,
        category: "heat" as const,
        text: "The rat you spared is still talking. Wanted levels climb across the family.",
        family: state.playerFamily,
      },
    ];
  }

  if (state.heat.level < WARRANT.heatFloor) return { ...state, crew, turnLog };

  for (const c of crew) {
    if (c.family !== state.playerFamily) continue;
    if (c.status !== "active") continue;
    const { chance } = arrestRisk(state, c);
    if (chance > 0 && Math.random() < chance) {
      crew = jailInCrew(crew, c.id, state.turn);
    }
  }

  return { ...state, crew, turnLog };
}
