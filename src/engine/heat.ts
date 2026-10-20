import type { BribeStatus, CrewMember, GameState, HeatState, TurnLogEntry } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { jailInCrew } from "./jail";
import { isLegitBusiness, isRacketFrozen, legitCoverWantedDrop, processEconomyTurn, STREET_LAWYER_HEAT_DECAY, COUNSEL_HEAT_DECAY } from "./economy";
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
  | "counselUntil"
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

  if ((state.counselUntil ?? 0) > state.turn) {
    reducers.push({
      label: "counsel",
      effect: `−${COUNSEL_HEAT_DECAY} heat/wk`,
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
  /** Extra heat cooled each week. */
  heatReduction: number;
  /** Share of new heat that never lands (capped at 75% when applied). */
  heatGenerationReduction: number;
}

const BRIBE_HEAT: Record<keyof GameState["bribes"], BribeEffectSummary> = {
  cops: { heatReduction: 2, heatGenerationReduction: 0.25 },
  captains: { heatReduction: 1, heatGenerationReduction: 0.1 },
  chiefs: { heatReduction: 0, heatGenerationReduction: 0 },
  mayor: { heatReduction: 3, heatGenerationReduction: 0.15 },
  judge: { heatReduction: 0, heatGenerationReduction: 0 },
};

export function bribeEffects(
  bribeType: keyof GameState["bribes"],
  isActive: boolean,
): BribeEffectSummary {
  const fx = BRIBE_HEAT[bribeType];
  if (!isActive || !fx) return { heatReduction: 0, heatGenerationReduction: 0 };
  return { ...fx };
}

export function aggregateBribeEffects(
  bribes: GameState["bribes"],
): BribeEffectSummary {
  const keys = Object.keys(bribes) as (keyof GameState["bribes"])[];
  return keys.reduce(
    (acc, key) => {
      const fx = bribeEffects(key, bribes[key].isActive);
      acc.heatReduction += fx.heatReduction;
      acc.heatGenerationReduction += fx.heatGenerationReduction;
      return acc;
    },
    { heatReduction: 0, heatGenerationReduction: 0 },
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

/**
 * Heat a quiet week sheds: the base 2, bribes, the lawyers, and the family's
 * own cooling. One number, so the forecast and the turn can't drift apart.
 */
export function quietHeatDecay(
  state: Pick<GameState, "bribes" | "turn" | "streetLawyerUntil" | "counselUntil" | "playerFamily">,
): number {
  const bribeFx = aggregateBribeEffects(state.bribes);
  let decay = 2 + bribeFx.heatReduction;
  if ((state.streetLawyerUntil ?? 0) > state.turn) decay += STREET_LAWYER_HEAT_DECAY;
  if ((state.counselUntil ?? 0) > state.turn) decay += COUNSEL_HEAT_DECAY;
  if (state.playerFamily) {
    const bonus = getFamilyDef(state.playerFamily).bonuses.heatReduction ?? 0;
    if (bonus) decay += Math.floor(bonus * 10);
  }
  return decay;
}

/**
 * The whole week the economy books against the player: rackets, dumped cash
 * and washes, after the bribe cut. The same number the turn applies.
 */
export function economyHeat(state: GameState): number {
  const family = state.playerFamily;
  if (!family) return 0;
  const cut = Math.min(0.75, aggregateBribeEffects(state.bribes).heatGenerationReduction);
  return processEconomyTurn(state, family).heatDelta * (1 - cut);
}

const FEDERAL_LEVEL = 80;

/** Short name for the top bar. The full labels stay on HEAT_THRESHOLDS. */
export function heatLineName(level: number): string {
  if (level >= 80) return "Federal";
  if (level >= 60) return "Warrants";
  if (level >= 40) return "Raids";
  if (level >= 20) return "Patrols";
  return "Quiet";
}

export interface HeatForecast {
  /** Economy heat added on a quiet week (rackets, dumps, washes), after bribes. */
  generated: number;
  /** Heat a quiet week cools. */
  decay: number;
  /** generated − decay. Positive climbs. */
  net: number;
  /** Short line under the Heat stat. */
  label: string;
  /** Tooltip: the two numbers, the line, and what a job adds. */
  detail: string;
  /** A climbing line is one or two weeks away. */
  urgent: boolean;
  /** The line the drift crosses, when it crosses one. */
  line: HeatThreshold | null;
  /** Weeks until that crossing. Uncapped. Null when the week holds. */
  weeks: number | null;
  direction: "climb" | "fall" | "hold";
}

function formatHeat(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function weekCount(gap: number, pace: number): number {
  if (pace <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(gap / pace));
}

function cappedWeeks(weeks: number): string {
  return `~${Math.min(12, weeks)}w`;
}

/** Men the warrant list would name if heat is, or were, at the line. */
function warrantMen(state: GameState): number {
  const family = state.playerFamily;
  if (!family) return 0;
  const hot = {
    ...state,
    heat: { ...state.heat, level: Math.max(state.heat.level, WARRANT.heatFloor) },
  };
  return state.crew.filter((c) => c.family === family && arrestRisk(hot, c).listed).length;
}

/**
 * Where the heat is headed if the week stays quiet: rackets cook, the street
 * cools, and hits and captures are left out. The count caps at 12 weeks.
 */
export function heatForecast(state: GameState): HeatForecast {
  const generated = economyHeat(state);
  const decay = quietHeatDecay(state);
  const net = generated - decay;
  const level = state.heat.level;
  const current = [...HEAT_THRESHOLDS].reverse().find((t) => level >= t.level) ?? null;
  const next = HEAT_THRESHOLDS.find((t) => t.level > level) ?? null;
  const flat = Math.abs(net) < 0.05;
  const atFederal = level >= FEDERAL_LEVEL;

  let direction: HeatForecast["direction"] = "hold";
  let line: HeatThreshold | null = null;
  let weeks: number | null = null;

  if (!atFederal && !flat && net > 0 && next) {
    direction = "climb";
    line = next;
    weeks = weekCount(next.level - level, net);
  } else if (!atFederal && !flat && net < 0 && current) {
    direction = "fall";
    line = current;
    weeks = Math.floor((level - current.level) / Math.abs(net)) + 1;
  }

  let label = "Quiet";
  if (atFederal) label = "Federal";
  else if (direction === "climb" && line && weeks != null) {
    label = weeks === 1 ? `${heatLineName(line.level)} next week` : `${heatLineName(line.level)} ${cappedWeeks(weeks)}`;
  } else if (direction === "fall" && line && weeks != null) {
    label = weeks === 1 ? `${heatLineName(line.level)} lift next week` : `${heatLineName(line.level)} lift ${cappedWeeks(weeks)}`;
  } else if (current) label = heatLineName(current.level);

  const urgent = direction === "climb" && weeks != null && weeks <= 2;
  const talked = line ?? current;
  const mentionsWarrants = (talked?.level ?? 0) >= WARRANT.heatFloor || level >= WARRANT.heatFloor;
  const listed = mentionsWarrants ? warrantMen(state) : 0;
  const detail = [
    `Rackets, dumps and washes add ${formatHeat(generated)} a week. The street cools ${formatHeat(decay)}.`,
    talked ? talked.consequence : null,
    mentionsWarrants
      ? listed === 0
        ? "Nobody is on the warrant list."
        : level >= WARRANT.heatFloor
          ? `${listed} of your men are on the warrant list.`
          : `${listed} of your men would be on the warrant list.`
      : null,
    "A hit or a capture adds heat on top of this.",
  ]
    .filter(Boolean)
    .join(" ");

  return { generated, decay, net, label, detail, urgent, line, weeks, direction };
}

export function processHeatTurn(state: GameState): HeatTurnResult {
  const logs: TurnLogEntry[] = [];

  let heat = decayHeat(state.heat, quietHeatDecay(state));

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
