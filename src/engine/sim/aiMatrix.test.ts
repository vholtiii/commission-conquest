import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { FamilyName, GameSettings } from "@/types/game";
import { MEMORY_CAP } from "../ai/minds";
import { balanceNotes, simulateGame, type SimResult } from "./runSim";

type Mode = NonNullable<GameSettings["aiBrain"]>;
const MODES: Mode[] = ["classic", "brain"];

// Sixty games: at thirty, one family's top share moved ±13 points on reseeding alone.
const LEAGUE_SEEDS = Array.from({ length: 60 }, (_, i) => 101 + i * 7);
const LEAGUE_TURNS = 100;
const MATRIX_SEEDS = [11, 29, 47, 83, 97, 131, 163, 199, 211, 233, 257, 281, 307, 331, 359, 383];
const LONG_SEEDS = [5, 17, 31];
const LONG_TURNS = 200;

/** Gates. */
const MAX_TOP_SHARE = 0.5;
const MAX_EARLY_WIPE = 0.15;
const EARLY_WIPE_TURN = 30;
const NORMAL_DRIFT = 0.1;
const AI_MS_P95 = 15;
const ADAPT_CAP = 20;
const CREW_BELIEF_CAP = 80;

function league(mode: Mode): SimResult[] {
  return LEAGUE_SEEDS.map((seed, i) =>
    simulateGame({
      seed,
      family: ALL_FAMILY_NAMES[i % ALL_FAMILY_NAMES.length] as FamilyName,
      difficulty: "normal",
      gameLength: "long",
      strategy: "turtle",
      aiBrain: mode,
      maxTurns: LEAGUE_TURNS,
    }),
  );
}

function playerMatrix(mode: Mode): SimResult[] {
  const games: SimResult[] = [];
  const difficulties: GameSettings["difficulty"][] = ["easy", "normal", "hard"];
  for (const family of ALL_FAMILY_NAMES) {
    for (const difficulty of difficulties) {
      for (const seed of MATRIX_SEEDS) {
        games.push(simulateGame({ seed, family: family as FamilyName, difficulty, gameLength: "medium", aiBrain: mode }));
      }
    }
  }
  return games;
}

function longHaul(): SimResult[] {
  return LONG_SEEDS.map((seed, i) =>
    simulateGame({
      seed,
      family: ALL_FAMILY_NAMES[(i * 2) % ALL_FAMILY_NAMES.length] as FamilyName,
      difficulty: "normal",
      gameLength: "long",
      aiBrain: "brain",
      maxTurns: LONG_TURNS,
    }),
  );
}

function entropy(counts: Record<string, number>): number {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const n of Object.values(counts)) {
    if (n <= 0) continue;
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Mean, over every rival in every game, of how evenly it spread its moves. */
function actionEntropy(games: SimResult[]): number {
  const hs = games.flatMap((g) => Object.values(g.ai.actions).map(entropy));
  return hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 0;
}

function perWeek(games: SimResult[], pick: (g: SimResult) => number): number {
  const weeks = games.reduce((s, g) => s + g.weeks, 0);
  return weeks ? games.reduce((s, g) => s + pick(g), 0) / weeks : 0;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

function winRate(games: SimResult[], difficulty: GameSettings["difficulty"]): number {
  const pool = games.filter((g) => g.difficulty === difficulty);
  return pool.length ? pool.filter((g) => g.outcome === "won").length / pool.length : 0;
}

function share(games: SimResult[], pred: (g: SimResult) => boolean): number {
  return games.length ? games.filter(pred).length / games.length : 0;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

describe("rival AI suite", () => {
  it("clears the AI balance gates", () => {
    const leagues = Object.fromEntries(MODES.map((m) => [m, league(m)])) as Record<Mode, SimResult[]>;
    const matrices = Object.fromEntries(MODES.map((m) => [m, playerMatrix(m)])) as Record<Mode, SimResult[]>;
    const long = longHaul();

    const metrics = (mode: Mode) => {
      const lg = leagues[mode];
      const mx = matrices[mode];
      const all = [...lg, ...mx];
      return {
        winEasy: winRate(mx, "easy"),
        winNormal: winRate(mx, "normal"),
        winHard: winRate(mx, "hard"),
        actionEntropy: actionEntropy(lg),
        goalEntropy: entropy(lg.reduce<Record<string, number>>((acc, g) => {
          for (const [k, n] of Object.entries(g.ai.goals)) acc[k] = (acc[k] ?? 0) + n;
          return acc;
        }, {})),
        turnoverPerWeek: perWeek(lg, (g) => g.ai.turnover),
        pactsPerGame: lg.reduce((s, g) => s + g.ai.pactsSigned, 0) / lg.length,
        breaksPerGame: lg.reduce((s, g) => s + g.ai.pactsBroken, 0) / lg.length,
        contradictions: all.reduce((s, g) => s + g.ai.contradictions, 0),
        aiMsP95: p95(all.flatMap((g) => g.ai.aiMs)),
        scoutsPerGame: lg.reduce((s, g) => s + g.ai.scouts, 0) / lg.length,
        beliefError: (() => {
          const n = lg.reduce((s, g) => s + g.ai.beliefErrorSamples, 0);
          return n ? lg.reduce((s, g) => s + g.ai.beliefErrorSum, 0) / n : 0;
        })(),
        topShare: Object.fromEntries(ALL_FAMILY_NAMES.map((f) => [f, share(lg, (g) => g.topFamily === f)])),
        earlyWipe: Object.fromEntries(
          ALL_FAMILY_NAMES.map((f) => [f, share(lg, (g) => g.defunct.some((d) => d.family === f && d.turn < EARLY_WIPE_TURN))]),
        ),
      };
    };
    const classic = metrics("classic");
    const brain = metrics("brain");

    const gates: string[] = [];
    const stability = [...matrices.brain, ...leagues.brain, ...long].flatMap((g) =>
      g.problems
        .filter((p) => !(g.maxTurns && p.startsWith("unfinished")))
        .map((p) => `${g.family} ${g.difficulty} seed ${g.seed} ${g.maxTurns ? `${g.maxTurns}w` : ""}: ${p}`),
    );
    gates.push(...stability.map((s) => `stability: ${s}`));
    gates.push(...balanceNotes(matrices.brain).map((n) => `balance: ${n}`));
    if (Math.abs(brain.winNormal - classic.winNormal) > NORMAL_DRIFT) {
      gates.push(`normal win rate moved ${pct(classic.winNormal)} -> ${pct(brain.winNormal)}`);
    }
    for (const f of ALL_FAMILY_NAMES) {
      if (brain.topShare[f]! > MAX_TOP_SHARE) gates.push(`${f} finished on top in ${pct(brain.topShare[f]!)} of league games`);
      if (brain.earlyWipe[f]! > MAX_EARLY_WIPE) gates.push(`${f} wiped out before week ${EARLY_WIPE_TURN} in ${pct(brain.earlyWipe[f]!)} of league games`);
    }
    if (!(brain.actionEntropy > classic.actionEntropy)) {
      gates.push(`action entropy ${brain.actionEntropy.toFixed(2)} not above classic ${classic.actionEntropy.toFixed(2)}`);
    }
    if (!(brain.turnoverPerWeek > classic.turnoverPerWeek)) {
      gates.push(`turf turnover ${brain.turnoverPerWeek.toFixed(3)} not above classic ${classic.turnoverPerWeek.toFixed(3)}`);
    }
    if (brain.contradictions > 0) {
      const notes = [...leagues.brain, ...matrices.brain].flatMap((g) => g.ai.contradictionNotes).slice(0, 5);
      gates.push(`${brain.contradictions} contradictory acts: ${notes.join(" | ")}`);
    }
    if (brain.aiMsP95 >= AI_MS_P95) gates.push(`AI p95 ${brain.aiMsP95.toFixed(1)}ms`);
    for (const g of long) {
      if (g.ai.peakMemories > MEMORY_CAP) gates.push(`long haul seed ${g.seed}: ${g.ai.peakMemories} memories`);
      if (g.ai.peakAdaptEntries > ADAPT_CAP) gates.push(`long haul seed ${g.seed}: ${g.ai.peakAdaptEntries} adapt entries`);
      if (g.ai.peakCrewBeliefs > CREW_BELIEF_CAP) gates.push(`long haul seed ${g.seed}: ${g.ai.peakCrewBeliefs} crew beliefs`);
    }

    const row = (label: string, c: string, b: string) => `${label.padEnd(26)} ${c.padStart(10)} ${b.padStart(10)}`;
    const lines = [
      row("metric", "classic", "brain"),
      row("win easy/normal/hard", `${pct(classic.winEasy)}/${pct(classic.winNormal)}/${pct(classic.winHard)}`, `${pct(brain.winEasy)}/${pct(brain.winNormal)}/${pct(brain.winHard)}`),
      row("action entropy (bits)", classic.actionEntropy.toFixed(2), brain.actionEntropy.toFixed(2)),
      row("goal entropy (bits)", classic.goalEntropy.toFixed(2), brain.goalEntropy.toFixed(2)),
      row("turf turnover / week", classic.turnoverPerWeek.toFixed(3), brain.turnoverPerWeek.toFixed(3)),
      row("rival pacts / game", classic.pactsPerGame.toFixed(1), brain.pactsPerGame.toFixed(1)),
      row("pacts broken / game", classic.breaksPerGame.toFixed(1), brain.breaksPerGame.toFixed(1)),
      row("scouts / game", classic.scoutsPerGame.toFixed(1), brain.scoutsPerGame.toFixed(1)),
      row("belief error (men)", classic.beliefError.toFixed(2), brain.beliefError.toFixed(2)),
      row("contradictions", String(classic.contradictions), String(brain.contradictions)),
      row("AI ms p95", classic.aiMsP95.toFixed(2), brain.aiMsP95.toFixed(2)),
      ...ALL_FAMILY_NAMES.map((f) => row(`top / wiped<${EARLY_WIPE_TURN}: ${f}`, `${pct(classic.topShare[f]!)}/${pct(classic.earlyWipe[f]!)}`, `${pct(brain.topShare[f]!)}/${pct(brain.earlyWipe[f]!)}`)),
      row("long haul peak memories", "-", String(Math.max(...long.map((g) => g.ai.peakMemories)))),
    ];
    console.log(lines.join("\n"));
    console.log(gates.length ? `AI gates failed:\n${gates.join("\n")}` : "AI gates clear");

    writeFileSync(
      "sim-ai.json",
      JSON.stringify(
        {
          classic,
          brain,
          gates,
          games: [...leagues.classic, ...leagues.brain, ...matrices.classic, ...matrices.brain, ...long].map(({ timeline: _t, ...g }) => ({
            ...g,
            ai: { ...g.ai, aiMs: undefined, aiMsP95: p95(g.ai.aiMs) },
          })),
        },
        null,
        2,
      ),
    );
    expect(gates, gates.join("\n")).toEqual([]);
  }, 1_800_000);
});
