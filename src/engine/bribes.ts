import type { BribeStatus, CrewMember, CrewRole, FamilyName, GameState } from "@/types/game";
import { emptyIntel, hasFreshCasing } from "./intel";
import { livingBoss, releaseBoss } from "./jail";
import { findClue } from "./casing";
import { commissionHealth, hasCase } from "./commission";
import { handsDown } from "./mourning";
import { activeRetainer } from "./lawyer";
import { createRng, hashString } from "./rng";

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

/** A failed buy still costs this share of the price. */
export const BRIBE_FAIL_FEE = 0.4;

export type PoliceTier = Exclude<keyof GameState["bribes"], "judge">;

const INNER: ReadonlySet<CrewRole> = new Set(["boss", "underboss", "consigliere", "capo"]);

export interface BribeOpts {
  territoryId?: string;
  family?: FamilyName;
  borough?: string;
}

export interface BribeBreakdown {
  rate: number;
  courier: CrewMember | null;
  helps: string[];
  hurts: string[];
}

export interface BribeReveal {
  desk: PoliceTier;
  landed: boolean;
  roll: number;
  need: number;
  hurts: string[];
  courierName?: string;
}

function clampRate(n: number): number {
  return Math.max(0.05, Math.min(0.95, n));
}

function ratLeaking(state: Pick<GameState, "ratLeakTurn" | "ratLeakWeeks" | "turn">): boolean {
  const weeks = state.ratLeakWeeks ?? 4;
  return (
    state.ratLeakTurn != null &&
    state.turn >= state.ratLeakTurn &&
    state.turn < state.ratLeakTurn + weeks
  );
}

function innerFree(state: GameState): CrewMember[] {
  const family = state.playerFamily;
  if (!family) return [];
  return state.crew.filter(
    (c) =>
      c.family === family &&
      c.status === "active" &&
      INNER.has(c.role) &&
      (c.assignment.type === "idle" || c.assignment.type === "garrison"),
  );
}

function charmScore(c: CrewMember): number {
  return c.skills.charm + (c.traits.includes("ghost") ? 20 : 0);
}

/** Idle inner-circle man who carries the envelope. Soldiers never go. */
export function envelopeMan(state: GameState, desk: "cops" | "captains"): CrewMember | null {
  const pool = innerFree(state);
  if (pool.length === 0) return null;
  if (desk === "cops") {
    return [...pool].sort((a, b) => charmScore(b) - charmScore(a))[0] ?? null;
  }
  const calm = pool.filter((c) => !c.traits.includes("hothead"));
  if (calm.length > 0) return calm[0] ?? null;
  return pool[0] ?? null;
}

function boroughHeat(state: GameState, borough: string): number {
  const blocks = state.territories.filter((t) => t.borough === borough);
  if (blocks.length === 0) return 0;
  return blocks.reduce((n, t) => n + (t.heatLevel ?? 0), 0) / blocks.length;
}

export function bribeBreakdown(state: GameState, type: PoliceTier, opts: BribeOpts = {}): BribeBreakdown {
  const helps: string[] = [];
  const hurts: string[] = [];
  let rate = 0;
  let courier: CrewMember | null = null;

  if (type === "cops") {
    courier = envelopeMan(state, "cops");
    rate = 0.8;
    if (courier) {
      rate += courier.skills.charm / 200;
      if (courier.traits.includes("ghost")) {
        rate += 0.12;
        helps.push(`${courier.name.split(" ").slice(-1)[0]} (ghost)`);
      } else {
        helps.push(`${courier.name.split(" ").slice(-1)[0]} carries it`);
      }
    }
    const tid = opts.territoryId;
    if (tid && hasFreshCasing(state, tid, 2)) {
      rate += 0.1;
      helps.push("cased");
    }
    if (tid) {
      const cop = findClue(state, tid, "cop_on_payroll");
      if (cop?.copBuyable) {
        rate += 0.15;
        helps.push("cop would take it");
      } else if (cop && cop.copBuyable === false) {
        rate -= 0.2;
        hurts.push("The cop on the corner is theirs");
      }
      const block = state.territories.find((t) => t.id === tid);
      const dh = block?.heatLevel ?? 0;
      if (dh > 0) {
        rate -= dh * 0.04;
        hurts.push(`Hot corner (heat ${Math.round(dh)})`);
      }
    }
    rate += state.reputation.respect / 2000;
  } else if (type === "captains") {
    courier = envelopeMan(state, "captains");
    rate = 0.6;
    rate += state.reputation.fear / 250;
    if (state.reputation.fear > 0) helps.push("fear");
    if (courier?.traits.includes("hothead")) {
      rate -= 0.15;
      hurts.push(`${courier.name.split(" ").slice(-1)[0]} is a hothead`);
    } else if (courier) {
      helps.push(`${courier.name.split(" ").slice(-1)[0]} carries it`);
    }
    const borough = opts.borough;
    if (borough) {
      const avg = boroughHeat(state, borough);
      if (avg > 0) {
        rate -= avg / 40;
        hurts.push(`${borough} is watched (heat ${Math.round(avg)})`);
      }
    }
  } else if (type === "chiefs") {
    rate = 0.4;
    const health = commissionHealth(state);
    rate += health.sway * 0.25;
    if (health.sway > 0.5) helps.push(health.tier);
    const target = opts.family;
    if (target && hasCase(state, target)) {
      rate += 0.12;
      helps.push("you have a case");
    }
    if (handsDown(state)) {
      rate -= 0.1;
      hurts.push("Funeral — chiefs won't be seen with you");
    }
    if (ratLeaking(state)) {
      rate -= 0.12;
      hurts.push("A rat is talking");
    }
    const book = state.crew.some(
      (c) =>
        c.family === state.playerFamily &&
        c.status === "active" &&
        c.traits.includes("bookkeeper"),
    );
    if (book) {
      rate += 0.08;
      helps.push("bookkeeper");
    }
    if (activeRetainer(state)) {
      rate += 0.08;
      helps.push("lawyer on retainer");
    }
  } else {
    rate = 0.25;
    rate += (state.reputation.respect + state.reputation.fear) / 350;
    const heat = state.heat.level;
    if (heat > 0) {
      rate -= heat / 80;
      hurts.push(`Heat ${Math.round(heat)} — too famous for the parlor`);
    }
    const spare = Math.max(0, state.money - BRIBE_COSTS.mayor);
    const cashBoost = Math.min(0.15, spare / 80_000);
    if (cashBoost > 0) {
      rate += cashBoost;
      helps.push("clean cash on the table");
    }
  }

  return { rate: clampRate(rate), courier, helps, hurts };
}

/** Odds the money lands. */
export function bribeSuccessRate(state: GameState, type: PoliceTier, opts: BribeOpts = {}): number {
  return bribeBreakdown(state, type, opts).rate;
}

function judgeCost(wanted: number): number {
  return 6000 + 2000 * Math.max(0, wanted);
}

function attemptJudgeBribe(state: GameState): { state: GameState } {
  const family = state.playerFamily;
  const boss = family ? livingBoss(state, family) : undefined;
  if (!family || !boss || boss.status !== "jailed") {
    return {
      state: {
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
      },
    };
  }
  const cost = judgeCost(boss.wanted);
  if (state.money < cost) {
    return {
      state: {
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
      },
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
      state: {
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
      },
    };
  }
  const freed = releaseBoss(state, family);
  return {
    state: {
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
    },
  };
}

function logOnly(state: GameState, id: string, text: string): { state: GameState } {
  return {
    state: {
      ...state,
      turnLog: [
        ...state.turnLog,
        { id, turn: state.turn, category: "system", text },
      ],
    },
  };
}

export function attemptBribe(
  state: GameState,
  type: keyof GameState["bribes"],
  targetFamily?: FamilyName,
  targetTerritory?: string,
  targetBorough?: string,
): { state: GameState; reveal?: BribeReveal } {
  if (type === "judge") return attemptJudgeBribe(state);
  if (state.bribes[type]?.isActive) return { state };
  const cost = BRIBE_COSTS[type];
  if (state.money < cost) {
    return logOnly(state, `log_bribe_fail_cash_${state.turn}_${type}`, `Not enough clean cash to grease the ${type}.`);
  }

  if (type === "cops" && !targetTerritory) {
    return logOnly(
      state,
      `log_bribe_need_district_${state.turn}`,
      "Pick a rival district for the beat cops to watch.",
    );
  }
  if (type === "captains" && !targetBorough) {
    return logOnly(
      state,
      `log_bribe_need_borough_${state.turn}`,
      "Pick a borough for the captains to look the other way.",
    );
  }
  if (type === "chiefs" && !targetFamily) {
    return logOnly(
      state,
      `log_bribe_need_family_${state.turn}`,
      "Pick a family for the chiefs to open the books on.",
    );
  }

  const opts: BribeOpts = { territoryId: targetTerritory, family: targetFamily, borough: targetBorough };
  const breakdown = bribeBreakdown(state, type, opts);
  const rate = breakdown.rate;
  const rng = createRng(hashString(`${state.seed}:bribe:${state.turn}:${type}:${targetTerritory ?? ""}:${targetBorough ?? ""}:${targetFamily ?? ""}`));
  const roll = rng.int(1, 100);
  const need = Math.round(rate * 100);
  const success = roll <= need;
  const reveal: BribeReveal = {
    desk: type,
    landed: success,
    roll,
    need,
    hurts: breakdown.hurts,
    courierName: breakdown.courier?.name,
  };

  if (!success) {
    return {
      reveal,
      state: {
        ...state,
        money: state.money - Math.floor(cost * BRIBE_FAIL_FEE),
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
            text: `The ${type} bribe fell through. They kept $${Math.floor(cost * BRIBE_FAIL_FEE)} and word is spreading.`,
          },
        ],
      },
    };
  }

  const status: BribeStatus = {
    isActive: true,
    turnsRemaining: BRIBE_DURATION[type],
    targetFamily,
    targetTerritory,
    targetBorough,
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
    const name = state.territories.find((t) => t.id === targetTerritory)?.name ?? "the district";
    intelText = ` Cops will watch ${name} for ${BRIBE_DURATION.cops} turns.`;
  }
  if (type === "captains" && targetBorough) {
    const until = state.turn + BRIBE_DURATION.captains;
    const extra: Record<string, number> = { ...intel.districtReveal };
    for (const t of state.territories) {
      if (t.borough !== targetBorough || !t.discovered) continue;
      if (!t.owner || t.owner === state.playerFamily) continue;
      extra[t.id] = Math.max(extra[t.id] ?? 0, until);
    }
    intel.districtReveal = extra;
    intelText = ` Captains look the other way in ${targetBorough} for ${BRIBE_DURATION.captains} turns.`;
  }
  if (type === "chiefs" && targetFamily) {
    intel.familyReveal = {
      ...intel.familyReveal,
      [targetFamily]: state.turn + BRIBE_DURATION.chiefs,
    };
    intelText = ` Chiefs open the books on ${targetFamily} for ${BRIBE_DURATION.chiefs} turns.`;
  }

  return {
    reveal,
    state: {
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
    },
  };
}
