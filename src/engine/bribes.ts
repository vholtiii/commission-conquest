import type { BribeStatus, FamilyName, GameState } from "@/types/game";
import { emptyIntel } from "./intel";
import { livingBoss, releaseBoss } from "./jail";

const BRIBE_COSTS = {
  cops: 500,
  captains: 2000,
  chiefs: 8000,
  mayor: 25000,
} as const;

const BRIBE_DURATION = {
  cops: 3,
  captains: 5,
  chiefs: 7,
  mayor: 10,
} as const;

const BRIBE_BASE_RATE = {
  cops: 0.8,
  captains: 0.6,
  chiefs: 0.4,
  mayor: 0.25,
} as const;

function judgeCost(wanted: number): number {
  return 6000 + 2000 * Math.max(0, wanted);
}

function attemptJudgeBribe(state: GameState): GameState {
  const family = state.playerFamily;
  const boss = family ? livingBoss(state, family) : undefined;
  if (!family || !boss || boss.status !== "jailed") {
    return {
      ...state,
      turnLog: [
        ...state.turnLog,
        {
          id: `log_judge_nobody_${state.turn}`,
          turn: state.turn,
          category: "system",
          text: "The judge has nobody of yours to let out.",
        },
      ],
    };
  }
  const cost = judgeCost(boss.wanted);
  if (state.money < cost) {
    return {
      ...state,
      turnLog: [
        ...state.turnLog,
        {
          id: `log_judge_cash_${state.turn}`,
          turn: state.turn,
          category: "system",
          text: `Buying the judge takes $${cost} in clean cash.`,
        },
      ],
    };
  }
  const mayorBonus = state.bribes.mayor?.isActive ? 0.35 : 0;
  const rate = Math.max(
    0.05,
    Math.min(
      0.95,
      0.5 +
        state.reputation.respect / 400 +
        state.reputation.fear / 400 -
        state.heat.level / 250 +
        mayorBonus,
    ),
  );
  if (Math.random() >= rate) {
    return {
      ...state,
      money: state.money - cost,
      heat: {
        ...state.heat,
        level: Math.min(100, state.heat.level + 5),
        sources: [...state.heat.sources, "Failed judge bribe"].slice(-25),
      },
      turnLog: [
        ...state.turnLog,
        {
          id: `log_judge_fail_${state.turn}`,
          turn: state.turn,
          category: "heat",
          text: `The judge kept the $${cost} and left ${boss.name} where he sits.`,
        },
      ],
    };
  }
  const freed = releaseBoss(state, family);
  return {
    ...freed,
    money: freed.money - cost,
    heat: {
      ...freed.heat,
      level: Math.min(100, freed.heat.level + 8),
      sources: [...freed.heat.sources, "Judge bought"].slice(-25),
    },
    turnLog: [
      ...freed.turnLog,
      {
        id: `log_judge_ok_${state.turn}`,
        turn: state.turn,
        category: "system",
        text: `${boss.name} walks out of the Tombs. The street already knows who paid.`,
      },
    ],
  };
}

export function attemptBribe(
  state: GameState,
  type: keyof GameState["bribes"],
  targetFamily?: FamilyName,
  targetTerritory?: string,
): GameState {
  if (type === "judge") return attemptJudgeBribe(state);
  const cost = BRIBE_COSTS[type];
  if (state.money < cost) {
    return {
      ...state,
      turnLog: [
        ...state.turnLog,
        {
          id: `log_bribe_fail_cash_${state.turn}_${type}`,
          turn: state.turn,
          category: "system",
          text: `Not enough clean cash to grease the ${type}.`,
        },
      ],
    };
  }

  if (type === "cops" && !targetTerritory) {
    return {
      ...state,
      turnLog: [
        ...state.turnLog,
        {
          id: `log_bribe_need_district_${state.turn}`,
          turn: state.turn,
          category: "system",
          text: "Pick a rival district for the beat cops to watch.",
        },
      ],
    };
  }
  if (type === "chiefs" && !targetFamily) {
    return {
      ...state,
      turnLog: [
        ...state.turnLog,
        {
          id: `log_bribe_need_family_${state.turn}`,
          turn: state.turn,
          category: "system",
          text: "Pick a family for the chiefs to open the books on.",
        },
      ],
    };
  }

  const respectBonus = state.reputation.respect / 400;
  const fearBonus = state.reputation.fear / 400;
  const heatPenalty = state.heat.level / 250;
  const rate = Math.max(
    0.05,
    Math.min(0.95, BRIBE_BASE_RATE[type] + respectBonus + fearBonus - heatPenalty),
  );
  const success = Math.random() < rate;

  if (!success) {
    return {
      ...state,
      money: state.money - Math.floor(cost * 0.4),
      heat: {
        ...state.heat,
        level: Math.min(100, state.heat.level + 5),
        sources: [...state.heat.sources, `Failed ${type} bribe`].slice(-25),
      },
      turnLog: [
        ...state.turnLog,
        {
          id: `log_bribe_fail_${state.turn}_${type}`,
          turn: state.turn,
          category: "heat",
          text: `The ${type} bribe fell through — word is spreading.`,
        },
      ],
    };
  }

  const status: BribeStatus = {
    isActive: true,
    turnsRemaining: BRIBE_DURATION[type],
    targetFamily,
    targetTerritory,
    cost,
    successRate: rate,
  };

  const intel = { ...(state.intel ?? emptyIntel()) };
  let intelText = "";
  if (type === "cops" && targetTerritory) {
    intel.districtReveal = {
      ...intel.districtReveal,
      [targetTerritory]: state.turn + BRIBE_DURATION.cops,
    };
    const name =
      state.territories.find((t) => t.id === targetTerritory)?.name ?? "the district";
    intelText = ` Cops will watch ${name} for ${BRIBE_DURATION.cops} turns.`;
  }
  if (type === "chiefs" && targetFamily) {
    intel.familyReveal = {
      ...intel.familyReveal,
      [targetFamily]: state.turn + BRIBE_DURATION.chiefs,
    };
    intelText = ` Chiefs open the books on ${targetFamily} for ${BRIBE_DURATION.chiefs} turns.`;
  }

  return {
    ...state,
    money: state.money - cost,
    bribes: { ...state.bribes, [type]: status },
    intel,
    heat: {
      ...state.heat,
      level: Math.max(0, state.heat.level - (type === "cops" ? 5 : type === "mayor" ? 8 : 2)),
    },
    turnLog: [
      ...state.turnLog,
      {
        id: `log_bribe_ok_${state.turn}_${type}`,
        turn: state.turn,
        category: "system",
        text: `Bought the ${type} for $${cost}.${intelText}`,
      },
    ],
  };
}
