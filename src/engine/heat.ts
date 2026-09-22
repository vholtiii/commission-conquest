import type { BribeStatus, GameState, HeatState, TurnLogEntry } from "@/types/game";
import { getFamilyDef } from "@/data/families";

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
  if (state.heat.level < 60 || !state.playerFamily) return state;

  const crew = state.crew.map((c) => {
    if (c.family !== state.playerFamily) return c;
    if (c.status !== "active") return c;
    if (c.wanted > 5 && Math.random() < 0.08) {
      return { ...c, status: "jailed" as const };
    }
    return c;
  });

  return { ...state, crew };
}
