import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { FamilyName, GameSettings, GameState, HeatState } from "@/types/game";

const ledger = vi.hoisted(() => ({
  applied: {} as Record<string, number>,
  decay: 0,
  ricoRolls: 0,
}));

vi.mock("../heat", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../heat")>();
  return {
    ...mod,
    applyHeat: (heat: HeatState, amount: number, source: string, cut = 0) => {
      const next = mod.applyHeat(heat, amount, source, cut);
      ledger.applied[source] = (ledger.applied[source] ?? 0) + (next.level - heat.level);
      return next;
    },
    applyFederalIndictments: (state: GameState) => {
      if (state.heat.level >= 80 && mod.ricoTargets(state).length > 0) ledger.ricoRolls++;
      return mod.applyFederalIndictments(state);
    },
    processHeatTurn: (state: GameState, weekStart?: number) => {
      const out = mod.processHeatTurn(state, weekStart);
      ledger.decay += state.heat.level - out.heat.level;
      return out;
    },
  };
});

import { buildInitialState, startGame } from "../initialState";
import { createRng, type Rng } from "../rng";
import { endTurn, resolvePlayerHits } from "../turnPipeline";
import { applyEventChoice } from "../events";
import { attemptBribe } from "../bribes";
import { aggregateBribeEffects, economyHeat, quietHeatDecay, WARRANT } from "../heat";
import { associateRuns, isRacketFrozen, RACKET_HEAT_SCALE } from "../economy";
import { autoPlayer, type SimStrategy } from "./autoPlayer";

type Plan = SimStrategy | "managed";

interface GameHeat {
  strategy: Plan;
  family: FamilyName;
  difficulty: GameSettings["difficulty"];
  seed: number;
  weeks: number;
  series: number[];
  bandWeeks: [number, number, number, number, number];
  firstAt: Record<"20" | "40" | "60" | "80", number | null>;
  capWeeks: number;
  peak: number;
  /** Heat added by source over the game. */
  sources: Record<string, number>;
  decay: number;
  arrests: number;
  arrestsHot: number;
  /** Mean share of net income lost to raids, across weeks. */
  raidShare: number;
  bribeSpend: number;
  forecastNet: number[];
  rackets: number[];
  /** Racket book heat each week, after bribes. */
  book: number[];
  /** Dumps, stash and washes each week. */
  extra: number[];
  startHeat: number;
  cash: number[];
  bribeTries: number;
  bribesHeld: number;
  /** Clean cash the raids took, estimated from the week's net and heat. */
  raidCash: number;
  /** RICO indictments, and how many took the boss. */
  rico: number;
  ricoBoss: number;
  /** Weeks the federal pass ran at 80+ with someone to name. */
  ricoRolls: number;
  peakWanted: number;
  /** Man-weeks over the warrant line's wanted floor. */
  listed: number;
  outcome: string;
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function add(rec: Record<string, number>, key: string, n: number) {
  if (n === 0) return;
  rec[key] = (rec[key] ?? 0) + n;
}

function jailedIds(s: GameState): Set<string> {
  return new Set(s.crew.filter((c) => c.family === s.playerFamily && c.status === "jailed").map((c) => c.id));
}

/** A player who buys protection when the line gets close. */
function buyProtection(state: GameState): GameState {
  const h = state.heat.level;
  let next = state;
  const rival = next.territories.find((t) => t.owner && t.owner !== next.playerFamily);
  if (h >= 30 && !next.bribes.cops.isActive && next.money >= 1500 && rival) {
    next = attemptBribe(next, "cops", undefined, rival.id).state;
  }
  if (h >= 45 && !next.bribes.captains.isActive && next.money >= 5000 && rival) {
    next = attemptBribe(next, "captains", undefined, undefined, rival.borough).state;
  }
  if (h >= 60 && !next.bribes.mayor.isActive && next.money >= 40000) {
    next = attemptBribe(next, "mayor").state;
  }
  return next;
}

function answerEvent(state: GameState, rng: Rng): GameState {
  const evt = state.activeEvent;
  if (!evt || evt.choices.length === 0) return { ...state, activeEvent: null };
  const pick = evt.choices[Math.floor(rng.next() * evt.choices.length)]!;
  const next = applyEventChoice(state, evt, pick.id);
  return next.activeEvent === evt ? { ...next, activeEvent: null } : next;
}

function playHeat(seed: number, family: FamilyName, difficulty: GameSettings["difficulty"], plan: Plan): GameHeat {
  const random = Math.random;
  Math.random = seededRandom(seed * 7919 + ALL_FAMILY_NAMES.indexOf(family));
  try {
    let state = startGame(
      buildInitialState(seed, {
        seed,
        difficulty,
        gameLength: "medium",
        aiAggression: difficulty === "easy" ? 0.45 : difficulty === "hard" ? 1.5 : 1,
      }),
      family,
    );
    const rng = createRng(seed);
    const out: GameHeat = {
      strategy: plan,
      family,
      difficulty,
      seed,
      weeks: 0,
      series: [],
      bandWeeks: [0, 0, 0, 0, 0],
      firstAt: { "20": null, "40": null, "60": null, "80": null },
      capWeeks: 0,
      peak: 0,
      sources: {},
      decay: 0,
      arrests: 0,
      arrestsHot: 0,
      raidShare: 0,
      bribeSpend: 0,
      forecastNet: [],
      rackets: [],
      book: [],
      extra: [],
      startHeat: state.heat.level,
      cash: [],
      bribeTries: 0,
      bribesHeld: 0,
      raidCash: 0,
      rico: 0,
      ricoBoss: 0,
      ricoRolls: 0,
      peakWanted: 0,
      listed: 0,
      outcome: "unfinished",
    };
    const limit = state.victory.finalTurn + 2;
    while (!state.victory.won && !state.victory.lost && state.turn <= limit) {
      if (state.activeEvent) {
        const h0 = state.heat.level;
        state = answerEvent(state, rng);
        add(out.sources, "event choices", state.heat.level - h0);
      }
      let h0 = state.heat.level;
      state = autoPlayer(state, rng, plan === "managed" ? "balanced" : plan);
      add(out.sources, "captures & orders", state.heat.level - h0);
      if (plan === "managed") {
        h0 = state.heat.level;
        const cash = state.money;
        const paidBefore = (["cops", "captains", "mayor"] as const).filter((k) => state.bribes[k].isActive).length;
        state = buyProtection(state);
        out.bribeSpend += cash - state.money;
        if (cash !== state.money) out.bribeTries++;
        out.bribesHeld += (["cops", "captains", "mayor"] as const).filter((k) => state.bribes[k].isActive).length - paidBefore;
        add(out.sources, "bribes (net)", state.heat.level - h0);
      }
      h0 = state.heat.level;
      state = resolvePlayerHits(state, createRng(state.seed + state.turn * 131)).state;
      add(out.sources, "own hits", state.heat.level - h0);

      out.cash.push(state.money);
      const econ = economyHeat(state);
      const cut = Math.min(0.75, aggregateBribeEffects(state.bribes).heatGenerationReduction);
      let raw = 0;
      for (const t of state.territories) {
        if (t.owner !== state.playerFamily) continue;
        for (const r of t.rackets) {
          if (associateRuns(state.crew, r)) continue;
          raw += isRacketFrozen(r, state.turn) ? r.heatGen * 0.5 : r.heatGen;
        }
      }
      const book = Math.round(raw * RACKET_HEAT_SCALE) * (1 - cut);
      out.book.push(book);
      out.extra.push(econ - book);
      out.forecastNet.push(econ - quietHeatDecay(state));
      out.rackets.push(
        state.territories
          .filter((t) => t.owner === state.playerFamily)
          .reduce((n, t) => n + t.rackets.length, 0),
      );

      const jailedBefore = jailedIds(state);
      const seenLogs = new Set(state.turnLog.map((l) => l.id));
      ledger.applied = {};
      ledger.decay = 0;
      ledger.ricoRolls = 0;
      h0 = state.heat.level;
      state = endTurn(state, rng);
      const applied = Object.values(ledger.applied).reduce((a, b) => a + b, 0);
      for (const [k, v] of Object.entries(ledger.applied)) add(out.sources, k, v);
      out.decay += ledger.decay;
      out.ricoRolls += ledger.ricoRolls;
      add(out.sources, "in-week other", state.heat.level - h0 - applied + ledger.decay);

      const h = state.heat.level;
      out.weeks++;
      out.series.push(Math.round(h * 10) / 10);
      out.bandWeeks[Math.min(4, Math.floor(h / 20))]++;
      for (const line of [20, 40, 60, 80] as const) {
        const key = String(line) as keyof GameHeat["firstAt"];
        if (out.firstAt[key] == null && h >= line) out.firstAt[key] = state.turn;
      }
      if (h >= 100) out.capWeeks++;
      out.peak = Math.max(out.peak, h);
      const rico = new Set<string>();
      for (const l of state.turnLog) {
        if (seenLogs.has(l.id) || !l.id.startsWith("log_rico_") || !l.crewId) continue;
        rico.add(l.crewId);
        out.rico++;
        if (state.crew.find((c) => c.id === l.crewId)?.role === "boss") out.ricoBoss++;
      }
      for (const id of jailedIds(state)) {
        if (jailedBefore.has(id) || rico.has(id)) continue;
        out.arrests++;
        if (h >= 60) out.arrestsHot++;
      }
      for (const c of state.crew) {
        if (c.family === state.playerFamily && c.status !== "dead") out.peakWanted = Math.max(out.peakWanted, c.wanted);
      }
      out.listed += state.crew.filter(
        (c) => c.family === state.playerFamily && c.status === "active" && c.wanted > WARRANT.wantedFloor,
      ).length;
      out.raidShare += h >= 40 ? 0.1 + (h - 40) / 200 : 0;
      if (h >= 40) out.raidCash += Math.max(0, Math.floor(state.lastNetIncome * (0.1 + (h - 40) / 200)));
    }
    out.raidShare /= Math.max(1, out.weeks);
    out.outcome = state.victory.won ? "won" : state.victory.lost ? "lost" : "unfinished";
    return out;
  } finally {
    Math.random = random;
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

function summarize(label: string, games: GameHeat[]) {
  const weeks = games.reduce((n, g) => n + g.weeks, 0);
  const band = [0, 1, 2, 3, 4].map((i) => games.reduce((n, g) => n + g.bandWeeks[i]!, 0) / Math.max(1, weeks));
  const reach = (k: keyof GameHeat["firstAt"]) => {
    const hit = games.filter((g) => g.firstAt[k] != null);
    return { share: hit.length / games.length, week: hit.length ? Math.round(mean(hit.map((g) => g.firstAt[k]!))) : null };
  };
  const at = (w: number) => r1(mean(games.filter((g) => g.series.length >= w).map((g) => g.series[w - 1]!)));
  const sources: Record<string, number> = {};
  for (const g of games) for (const [k, v] of Object.entries(g.sources)) add(sources, k, v / g.weeks / games.length);
  return {
    label,
    games: games.length,
    meanHeat: r1(mean(games.flatMap((g) => g.series))),
    peak: r1(mean(games.map((g) => g.peak))),
    curve: { w5: at(5), w10: at(10), w20: at(20), w30: at(30), w40: at(40), w50: at(50), w60: at(60) },
    bands: {
      quiet: r1(band[0]! * 100),
      patrols: r1(band[1]! * 100),
      raids: r1(band[2]! * 100),
      warrants: r1(band[3]! * 100),
      federal: r1(band[4]! * 100),
    },
    reach20: reach("20"),
    reach40: reach("40"),
    reach60: reach("60"),
    reach80: reach("80"),
    capWeeks: r1(mean(games.map((g) => g.capWeeks))),
    perWeek: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    decayPerWeek: r1(mean(games.map((g) => g.decay / g.weeks))),
    arrests: r1(mean(games.map((g) => g.arrests))),
    warrantArrests: r1(mean(games.map((g) => g.arrestsHot))),
    raidShare: r1(mean(games.map((g) => g.raidShare)) * 100),
    bribeSpend: Math.round(mean(games.map((g) => g.bribeSpend))),
    forecastNet: r1(mean(games.flatMap((g) => g.forecastNet))),
    rackets: r1(mean(games.map((g) => mean(g.rackets)))),
    startHeat: r1(mean(games.map((g) => g.startHeat))),
    bookAt: [1, 5, 10, 20, 40].map((w) => r1(mean(games.filter((g) => g.book.length >= w).map((g) => g.book[w - 1]!)))),
    extraAt: [1, 5, 10, 20, 40].map((w) => r1(mean(games.filter((g) => g.extra.length >= w).map((g) => g.extra[w - 1]!)))),
    racketsAt: [1, 5, 10, 20, 40].map((w) => r1(mean(games.filter((g) => g.rackets.length >= w).map((g) => g.rackets[w - 1]!)))),
    length: r1(mean(games.map((g) => g.weeks))),
    cashAt: [1, 5, 10, 20, 40].map((w) => Math.round(mean(games.filter((g) => g.cash.length >= w).map((g) => g.cash[w - 1]!)))),
    bribeTries: r1(mean(games.map((g) => g.bribeTries))),
    bribesHeld: r1(mean(games.map((g) => g.bribesHeld))),
    raidCash: Math.round(mean(games.map((g) => g.raidCash))),
    endCash: Math.round(mean(games.map((g) => g.cash[g.cash.length - 1] ?? 0))),
    rico: r1(mean(games.map((g) => g.rico))),
    ricoBoss: r1(mean(games.map((g) => g.ricoBoss))),
    ricoRolls: r1(mean(games.map((g) => g.ricoRolls))),
    ricoBossGames: games.filter((g) => g.ricoBoss > 0).length,
    peakWanted: r1(mean(games.map((g) => g.peakWanted))),
    listedPerWeek: r1(mean(games.map((g) => g.listed / Math.max(1, g.weeks)))),
    won: games.filter((g) => g.outcome === "won").length,
    lost: games.filter((g) => g.outcome === "lost").length,
  };
}

const PLANS: Plan[] = ["balanced", "racketeer", "warmonger", "expansionist", "turtle", "managed"];
const SEEDS = (process.env.HEAT_SEEDS ?? "11,29,47,83,131").split(",").map(Number);
const DIFFS: GameSettings["difficulty"][] = ["easy", "normal", "hard"];

describe("heat study", () => {
  it("plays and reports", () => {
    const games: GameHeat[] = [];
    for (const plan of PLANS) {
      for (const difficulty of DIFFS) {
        SEEDS.forEach((seed, i) => {
          const family = ALL_FAMILY_NAMES[(i + PLANS.indexOf(plan)) % ALL_FAMILY_NAMES.length]!;
          games.push(playHeat(seed, family, difficulty, plan));
        });
      }
    }
    const rows = [
      ...PLANS.map((p) => summarize(p, games.filter((g) => g.strategy === p))),
      ...DIFFS.map((d) => summarize(`diff:${d}`, games.filter((g) => g.difficulty === d && g.strategy !== "managed"))),
      summarize("all unmanaged", games.filter((g) => g.strategy !== "managed")),
    ];
    for (const r of rows) {
      console.log(
        `${r.label.padEnd(14)} mean ${String(r.meanHeat).padStart(5)} peak ${String(r.peak).padStart(5)} | ` +
          `curve ${Object.values(r.curve).join("/")} | bands q${r.bands.quiet} p${r.bands.patrols} r${r.bands.raids} w${r.bands.warrants} f${r.bands.federal} | ` +
          `reach40 ${Math.round(r.reach40.share * 100)}%@${r.reach40.week} reach60 ${Math.round(r.reach60.share * 100)}%@${r.reach60.week} reach80 ${Math.round(r.reach80.share * 100)}%@${r.reach80.week} | ` +
          `cap ${r.capWeeks} arrests ${r.arrests} (warrant ${r.warrantArrests}) raid ${r.raidShare}% rackets ${r.rackets} fcst ${r.forecastNet} bribes $${r.bribeSpend} W${r.won}/L${r.lost}`,
      );
      console.log(`   per week: ${JSON.stringify(r.perWeek)} decay ${r.decayPerWeek}`);
      console.log(
        `   start ${r.startHeat} len ${r.length} | wk1/5/10/20/40 rackets ${r.racketsAt.join("/")} book ${r.bookAt.join("/")} dumps+stash+wash ${r.extraAt.join("/")} cash ${r.cashAt.join("/")} | bribe tries ${r.bribeTries} landed ${r.bribesHeld} | raids took $${r.raidCash} end cash $${r.endCash}`,
      );
      console.log(
        `   law: warrant arrests ${r.warrantArrests} (all arrests ${r.arrests}) | RICO ${r.rico} of ${r.ricoRolls} federal weeks (boss ${r.ricoBoss}, in ${r.ricoBossGames}/${r.games} games) | peak wanted ${r.peakWanted} listed men/wk ${r.listedPerWeek}`,
      );
    }
    writeFileSync(
      process.env.HEAT_OUT ?? "sim-heat.json",
      JSON.stringify({ rows, games: games.map((g) => ({ ...g, forecastNet: undefined, rackets: undefined, book: undefined, extra: undefined, cash: undefined })) }, null, 2),
    );
    expect(games.length).toBe(PLANS.length * DIFFS.length * SEEDS.length);
  });
});
