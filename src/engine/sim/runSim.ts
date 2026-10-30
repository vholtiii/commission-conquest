import { writeFileSync } from "node:fs";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { FamilyName, GameLength, GameSettings, GameState } from "@/types/game";
import { buildInitialState, startGame } from "../initialState";
import { normalizeIntel, revealKnownDistricts } from "../intel";
import { stockCap, makeManagerLookup } from "../liquor";
import { handsDown } from "../mourning";
import { createRng } from "../rng";
import { endTurn } from "../turnPipeline";
import { familyInfluence, familyWealth } from "../victory";
import { placementBonus } from "../districtFeatures";
import { playerLeaderless } from "../interregnum";
import { racketIncome } from "../economy";
import { valueScore } from "../territoryValue";
import { autoPlayer, type SimStrategy } from "./autoPlayer";
import { atPeace } from "../deals";
import { MEMORY_CAP } from "../ai/minds";
import { beliefError } from "../ai/aiBeliefs";

const AI_ACTION_LOG = /^ai_([a-z]+)_(?:fail_|quiet_)?([A-Z][a-z]+)_/;
const AI_ACTION_KINDS = new Set(["racket", "expand", "hit", "delivery", "hijack", "shift", "shake", "scout"]);

/** What the rival families did and thought over a game, for the AI suite. */
export interface AiMetrics {
  /** Rival action counts by kind, per family. */
  actions: Record<string, Record<string, number>>;
  /** Goal-weeks by goal kind, across all rivals. */
  goals: Record<string, number>;
  /** Blocks that changed hands, all families. */
  turnover: number;
  pactsSigned: number;
  pactsBroken: number;
  /** Blocks taken from, or hits run on, a family the attacker was at peace with all week. */
  contradictions: number;
  contradictionNotes: string[];
  /** AI time per week, ms. */
  aiMs: number[];
  peakMemories: number;
  peakAdaptEntries: number;
  peakCrewBeliefs: number;
  beliefErrorSum: number;
  beliefErrorSamples: number;
  scouts: number;
  goalSwitches: number;
}

function emptyAiMetrics(): AiMetrics {
  return {
    actions: {},
    goals: {},
    turnover: 0,
    pactsSigned: 0,
    pactsBroken: 0,
    contradictions: 0,
    contradictionNotes: [],
    aiMs: [],
    peakMemories: 0,
    peakAdaptEntries: 0,
    peakCrewBeliefs: 0,
    beliefErrorSum: 0,
    beliefErrorSamples: 0,
    scouts: 0,
    goalSwitches: 0,
  };
}

function traceOn(): boolean {
  return typeof process !== "undefined" && !!process.env.AI_TRACE;
}

function recordAiWeek(before: GameState, after: GameState, newLogs: GameState["turnLog"], m: AiMetrics) {
  const owners = new Map(before.territories.map((t) => [t.id, t.owner]));
  const peaceAllWeek = (a: FamilyName, b: FamilyName) => atPeace(before, a, b) && atPeace(after, a, b);
  for (const line of newLogs) {
    const hit = AI_ACTION_LOG.exec(line.id);
    if (!hit || !AI_ACTION_KINDS.has(hit[1]!)) continue;
    const fam = hit[2]!;
    const row = (m.actions[fam] ??= {});
    row[hit[1]!] = (row[hit[1]!] ?? 0) + 1;
    // A grab or a shakedown on a family it was at peace with all week; the log names the owner at the time.
    const victim = (
      line.id.startsWith("ai_expand_") ? / from ([A-Z][a-z]+)/.exec(line.text) : line.id.startsWith("ai_shake_") ? /shook down ([A-Z][a-z]+)'s/.exec(line.text) : null
    )?.[1] as FamilyName | undefined;
    if (victim && victim !== fam && peaceAllWeek(fam as FamilyName, victim)) {
      m.contradictions++;
      if (m.contradictionNotes.length < 5) m.contradictionNotes.push(`w${before.turn} ${line.id} vs ${victim}: ${line.text}`);
    }
  }
  for (const t of after.territories) {
    if (owners.get(t.id) !== t.owner) m.turnover++;
  }
  for (const [fam, tr] of Object.entries(after.aiTrace?.families ?? {})) {
    if (!tr) continue;
    if (tr.goal) m.goals[tr.goal.kind] = (m.goals[tr.goal.kind] ?? 0) + 1;
    for (const act of tr.chosen) {
      const target = /^hit ([A-Z][a-z]+)$/.exec(act)?.[1];
      if (target && peaceAllWeek(fam as FamilyName, target as FamilyName)) {
        m.contradictions++;
        if (m.contradictionNotes.length < 5) m.contradictionNotes.push(`w${before.turn} ${fam} ${act}`);
      }
    }
  }
  if (after.aiTrace && after.aiTrace !== before.aiTrace) m.aiMs.push(after.aiTrace.ms);
  const key = (e: NonNullable<GameState["diplomacy"]["rivalPactLog"]>[number]) => `${e.turn}:${e.a}:${e.b}:${e.kind}:${e.event}`;
  const known = new Set((before.diplomacy.rivalPactLog ?? []).map(key));
  for (const e of after.diplomacy.rivalPactLog ?? []) {
    if (known.has(key(e))) continue;
    if (e.event === "signed") m.pactsSigned++;
    if (e.event === "broken") m.pactsBroken++;
  }
  for (const mind of Object.values(after.aiMinds ?? {})) {
    if (!mind) continue;
    m.peakMemories = Math.max(m.peakMemories, mind.memories.length);
    m.peakAdaptEntries = Math.max(m.peakAdaptEntries, mind.adapt.weakHits.length, mind.adapt.playerHits.length);
    m.peakCrewBeliefs = Math.max(m.peakCrewBeliefs, Object.keys(mind.beliefs.crew).length);
  }
  if (after.turn % 10 === 0 && after.aiMinds) {
    for (const f of ALL_FAMILY_NAMES) {
      if (f === after.playerFamily) continue;
      m.beliefErrorSum += beliefError(after, f);
      m.beliefErrorSamples++;
    }
  }
  if (traceOn() && after.aiTrace) {
    for (const [fam, tr] of Object.entries(after.aiTrace.families)) {
      if (!tr) continue;
      console.log(
        `[w${after.aiTrace.turn}] ${fam}: ${tr.goal ? `${tr.goal.kind}${tr.goal.target ? `→${tr.goal.target}` : ""}` : "none"} | ${tr.goalReason} | did: ${tr.chosen.join("; ") || "nothing"}`,
      );
    }
  }
}

function finishAiMetrics(state: GameState, m: AiMetrics) {
  for (const mind of Object.values(state.aiMinds ?? {})) {
    if (!mind) continue;
    m.scouts += mind.stats.scouts;
    m.goalSwitches += mind.stats.goalSwitches;
  }
}

export interface WeekSnapshot {
  turn: number;
  wealth: Record<string, number>;
  districts: Record<string, number>;
}

export interface SimRequest {
  seed: number;
  family: FamilyName;
  difficulty: GameSettings["difficulty"];
  gameLength: GameLength;
  strategy?: SimStrategy;
  aiBrain?: GameSettings["aiBrain"];
  /** Move the summit to this week, for long AI runs. */
  maxTurns?: number;
  /** Small, normal, or large city. Missing plays the normal map. */
  mapSize?: GameSettings["mapSize"];
}

export interface SimResult {
  aiBrain?: GameSettings["aiBrain"];
  maxTurns?: number;
  ai: AiMetrics;
  /** Family holding the most blocks at the end, ties broken on wealth. */
  topFamily: string;
  seed: number;
  family: FamilyName;
  difficulty: GameSettings["difficulty"];
  gameLength: GameLength;
  strategy?: SimStrategy;
  outcome: "won" | "lost" | "unfinished";
  reason?: string;
  turn: number;
  finalTurn: number;
  wealth: Record<string, number>;
  influence: Record<string, number>;
  districts: Record<string, number>;
  defunct: { family: string; turn: number }[];
  mourningWeeks: number;
  weeks: number;
  hits: number;
  hitsAbsent: number;
  bankruptWeeks: number;
  slowestEndTurnMs: number;
  problems: string[];
  playerRegencies: number;
  playerRegenciesSurvived: number;
  rivalRegencies: number;
  rivalRegenciesLost: number;
  beltWeeks: number;
  rivalWeeks: number;
  heatSum: number;
  heatSamples: number;
  placeBase: number;
  placeExtra: number;
  openingSpread: number;
  /** Rival reels aimed at the player, summed across the game. */
  hitsTaken: number;
  districtsLost: number;
  districtsGained: number;
  peakClean: number;
  peakDirty: number;
  /** Weeks the player's heat sat at 100. */
  heatCapWeeks: number;
  peakHeat: number;
  /** Longest run of weeks where nobody could order a hit. */
  longestQuiet: number;
  timeline: WeekSnapshot[];
}

function finite(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

function checkNumbers(state: GameState, problems: string[]) {
  if (!finite(state.money) || !finite(state.dirtyMoney) || !finite(state.influence)) {
    problems.push(`non-finite cash or influence on turn ${state.turn}`);
  }
  for (const [name, cash] of Object.entries(state.rivalTreasury ?? {})) {
    if (!finite(cash)) problems.push(`${name} treasury not finite on turn ${state.turn}`);
  }
  for (const [name, standing] of Object.entries(state.rivalInfluence ?? {})) {
    if (!finite(standing)) problems.push(`${name} influence not finite on turn ${state.turn}`);
  }
  const lookup = makeManagerLookup(state.crew, state.playerFamily);
  for (const t of state.territories) {
    for (const r of t.rackets) {
      const rawCap = stockCap(r, lookup(r));
      const cap = t.feature === "docks" && r.type === "warehouse" ? Math.floor(rawCap * 1.25) : rawCap;
      const proofed = r.proofed ?? 0;
      if (!finite(r.stock) || r.stock < 0 || r.stock > cap) {
        problems.push(`${r.id} stock ${r.stock} outside 0..${cap} on turn ${state.turn}`);
      }
      if (!finite(proofed) || proofed > r.stock) {
        problems.push(`${r.id} proofed ${proofed} above stock on turn ${state.turn}`);
      }
    }
  }
  if (state.turnLog.length > 200) problems.push(`turn log ${state.turnLog.length}`);
  if ((state.history?.length ?? 0) > 120) problems.push("history over 120");
  if ((state.headlines?.length ?? 0) > 100) problems.push("headlines over 100");
}

function roundTrip(state: GameState, problems: string[]) {
  const raw = JSON.parse(JSON.stringify(state)) as GameState;
  const loaded = revealKnownDistricts({ ...raw, intel: normalizeIntel(raw.intel) });
  if (loaded.money !== state.money || loaded.crew.length !== state.crew.length) {
    problems.push("save round trip dropped money or crew");
  }
  if (loaded.territories.length !== state.territories.length) problems.push("save round trip dropped a district");
  if ((loaded.history?.length ?? 0) !== (state.history?.length ?? 0)) problems.push("save round trip dropped history");
}

/** A few engine paths roll `Math.random`; seed it per game so a run repeats exactly. */
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

export function simulateGame(request: SimRequest): SimResult {
  const random = Math.random;
  Math.random = seededRandom(request.seed * 7919 + ALL_FAMILY_NAMES.indexOf(request.family));
  try {
    return playGame(request);
  } finally {
    Math.random = random;
  }
}

function playGame(request: SimRequest): SimResult {
  const problems: string[] = [];
  let state = startGame(
    buildInitialState(request.seed, {
      seed: request.seed,
      difficulty: request.difficulty,
      gameLength: request.gameLength,
      mapSize: request.mapSize,
      aiAggression: request.difficulty === "easy" ? 0.45 : request.difficulty === "hard" ? 1.5 : 1,
    }),
    request.family,
  );
  if (request.aiBrain) state = { ...state, settings: { ...state.settings, aiBrain: request.aiBrain } };
  if (request.maxTurns) state = { ...state, victory: { ...state.victory, finalTurn: request.maxTurns } };
  const ai = emptyAiMetrics();
  const rng = createRng(request.seed);
  const seenDefunct = new Set<string>(state.defunctFamilies ?? []);
  const defunct: { family: string; turn: number }[] = [];
  let mourningWeeks = 0;
  let bankruptWeeks = 0;
  let hits = 0;
  let hitsAbsent = 0;
  let slowest = 0;
  let playerRegencies = 0;
  let playerRegenciesSurvived = 0;
  let rivalRegencies = 0;
  let rivalRegenciesLost = 0;
  let beltWeeks = 0;
  let rivalWeeks = 0;
  let heatSum = 0;
  let heatSamples = 0;
  let placeBase = 0;
  let placeExtra = 0;
  let hitsTaken = 0;
  let districtsLost = 0;
  let districtsGained = 0;
  let peakClean = state.money;
  let peakDirty = state.dirtyMoney;
  let heatCapWeeks = 0;
  let peakHeat = state.heat.level;
  let longestQuiet = 0;
  let quietRun = 0;
  const timeline: WeekSnapshot[] = [];
  const ownedBy = (s: GameState) =>
    new Set(s.territories.filter((t) => t.owner === s.playerFamily).map((t) => t.id));
  const snap = (s: GameState): WeekSnapshot => {
    const wealth: Record<string, number> = {};
    const districts: Record<string, number> = {};
    for (const name of ALL_FAMILY_NAMES) {
      wealth[name] = familyWealth(s, name);
      districts[name] = s.territories.filter((t) => t.owner === name).length;
    }
    return { turn: s.turn, wealth, districts };
  };
  timeline.push(snap(state));
  let wasLeaderless = false;
  const seenRegency = new Set<string>();
  let openRivalClock: string | null = null;
  const openingTotals = ALL_FAMILY_NAMES.map((name) =>
    state.territories.filter((t) => t.owner === name).reduce((n, t) => n + valueScore(t), 0),
  );
  const openingMax = Math.max(...openingTotals, 1);
  const openingMin = Math.min(...openingTotals);
  const openingSpread = (openingMax - openingMin) / openingMax;
  const limit = state.victory.finalTurn + 2;

  try {
    while (!state.victory.won && !state.victory.lost && state.turn <= limit) {
      const held = ownedBy(state);
      state = autoPlayer(state, rng, request.strategy ?? "balanced");
      const before = state.turnLog.length;
      const prior = state;
      const started = performance.now();
      state = endTurn(state, rng);
      slowest = Math.max(slowest, performance.now() - started);
      const seenIds = new Set(prior.turnLog.map((l) => l.id));
      recordAiWeek(prior, state, state.turnLog.filter((l) => !seenIds.has(l.id)), ai);
      hitsTaken += state.incomingHitReel?.length ?? 0;
      const heldAfter = ownedBy(state);
      for (const id of held) if (!heldAfter.has(id)) districtsLost++;
      for (const id of heldAfter) if (!held.has(id)) districtsGained++;
      peakClean = Math.max(peakClean, state.money);
      peakDirty = Math.max(peakDirty, state.dirtyMoney);
      if (state.heat.level >= 100) heatCapWeeks++;
      peakHeat = Math.max(peakHeat, state.heat.level);
      if (handsDown(state)) {
        quietRun++;
        longestQuiet = Math.max(longestQuiet, quietRun);
      } else {
        quietRun = 0;
      }
      if (state.turn % 5 === 0) timeline.push(snap(state));
      checkNumbers(state, problems);
      const leaderlessNow = playerLeaderless(state);
      if (leaderlessNow && !wasLeaderless) playerRegencies++;
      if (wasLeaderless && !leaderlessNow && !state.victory.lost) playerRegenciesSurvived++;
      wasLeaderless = leaderlessNow && !state.victory.lost;
      const reg = state.interregnum;
      const rivalKey = reg && reg.family !== state.playerFamily ? `${reg.family}:${reg.startedTurn}` : null;
      if (openRivalClock && openRivalClock !== rivalKey) {
        const fam = openRivalClock.slice(0, openRivalClock.indexOf(":"));
        if ((state.defunctFamilies ?? []).includes(fam as FamilyName)) rivalRegenciesLost++;
        openRivalClock = null;
      }
      if (rivalKey && !seenRegency.has(rivalKey)) {
        seenRegency.add(rivalKey);
        rivalRegencies++;
        openRivalClock = rivalKey;
      }
      beltWeeks += state.beltThisWeek?.length ?? 0;
      rivalWeeks += ALL_FAMILY_NAMES.filter((name) => name !== state.playerFamily).length;
      for (const name of ALL_FAMILY_NAMES) {
        if (name === state.playerFamily) continue;
        heatSum += state.rivalHeat?.[name] ?? 0;
        heatSamples++;
      }
      if (state.playerFamily) {
        for (const t of state.territories) {
          if (t.owner !== state.playerFamily) continue;
          for (const r of t.rackets) {
            if (r.type === "speakeasy" || r.type === "safehouse") continue;
            const mult = placementBonus(t, r, t.rackets).mult;
            const bare = racketIncome(r, 0, null, state.crew, false, 1);
            placeBase += bare;
            placeExtra += racketIncome(r, 0, null, state.crew, false, mult) - bare;
          }
        }
      }
      if (handsDown(state)) mourningWeeks++;
      if (state.money < 0 && state.dirtyMoney < 0) bankruptWeeks++;
      for (const name of state.defunctFamilies ?? []) {
        if (!seenDefunct.has(name)) {
          seenDefunct.add(name);
          defunct.push({ family: name, turn: state.turn });
        }
      }
      for (const line of state.turnLog.slice(before)) {
        if (line.category !== "hit") continue;
        if (!/came for|gunned down|shot |put a bomb|went after|found nobody home/.test(line.text)) continue;
        hits++;
        if (line.text.includes("found nobody home")) hitsAbsent++;
      }
      if (problems.length > 8) break;
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (timeline[timeline.length - 1]?.turn !== state.turn) timeline.push(snap(state));
  finishAiMetrics(state, ai);
  if (ai.peakMemories > MEMORY_CAP) problems.push(`memories reached ${ai.peakMemories}`);

  if (!state.victory.won && !state.victory.lost) problems.push(`unfinished at turn ${state.turn}`);
  if (slowest >= 250) problems.push(`slowest endTurn ${slowest.toFixed(1)}ms`);
  roundTrip(state, problems);

  const wealth: Record<string, number> = {};
  const influence: Record<string, number> = {};
  const districts: Record<string, number> = {};
  for (const name of ALL_FAMILY_NAMES) {
    wealth[name] = familyWealth(state, name);
    influence[name] = familyInfluence(state, name);
    districts[name] = state.territories.filter((t) => t.owner === name).length;
  }

  const topFamily =
    [...ALL_FAMILY_NAMES].sort((a, b) => districts[b]! - districts[a]! || wealth[b]! - wealth[a]!)[0] ?? "";

  return {
    ...request,
    ai,
    topFamily,
    outcome: state.victory.won ? "won" : state.victory.lost ? "lost" : "unfinished",
    reason: state.victory.reason,
    turn: state.turn,
    finalTurn: state.victory.finalTurn,
    wealth,
    influence,
    districts,
    defunct,
    mourningWeeks,
    weeks: Math.max(1, state.turn - 1),
    hits,
    hitsAbsent,
    bankruptWeeks,
    slowestEndTurnMs: Math.round(slowest),
    problems,
    playerRegencies,
    playerRegenciesSurvived,
    rivalRegencies,
    rivalRegenciesLost,
    beltWeeks,
    rivalWeeks,
    heatSum,
    heatSamples,
    placeBase,
    placeExtra,
    openingSpread,
    hitsTaken,
    districtsLost,
    districtsGained,
    peakClean,
    peakDirty,
    heatCapWeeks,
    peakHeat,
    longestQuiet,
    timeline,
  };
}

export interface SimReport {
  games: SimResult[];
  stability: string[];
  balance: string[];
}

function rate(games: SimResult[], pred: (g: SimResult) => boolean): number {
  if (games.length === 0) return 0;
  return games.filter(pred).length / games.length;
}

export function balanceNotes(games: SimResult[]): string[] {
  const notes: string[] = [];
  const byDiff = (d: GameSettings["difficulty"]) => rate(games.filter((g) => g.difficulty === d && g.gameLength === "medium"), (g) => g.outcome === "won");
  const easy = byDiff("easy");
  const normal = byDiff("normal");
  const hard = byDiff("hard");
  if (!(easy >= normal && normal >= hard)) {
    notes.push(`win rate did not fall with difficulty (easy ${pct(easy)}, normal ${pct(normal)}, hard ${pct(hard)})`);
  }
  const normalGames = games.filter((g) => g.difficulty === "normal" && g.gameLength === "medium");
  const broke = rate(normalGames, (g) => g.outcome === "lost" && /bankrupt|broke|cash/i.test(g.reason ?? ""));
  if (broke >= 0.1) notes.push(`normal bankrupt losses ${pct(broke)}`);
  for (const name of ALL_FAMILY_NAMES) {
    const leadWealth = rate(games, (g) => top(g.wealth) === name && name !== g.family);
    const leadInfluence = rate(games, (g) => top(g.influence) === name && name !== g.family);
    if (leadWealth > 0.5) notes.push(`${name} led wealth in ${pct(leadWealth)} of games`);
    if (leadInfluence > 0.5) notes.push(`${name} led influence in ${pct(leadInfluence)} of games`);
  }
  const early = rate(games, (g) => g.defunct.some((d) => d.turn < 15));
  if (early >= 0.2) notes.push(`early defunct in ${pct(early)} of games`);
  const mourning = games.reduce((s, g) => s + g.mourningWeeks, 0) / Math.max(1, games.reduce((s, g) => s + g.weeks, 0));
  if (mourning >= 0.25) notes.push(`funeral quiet covered ${pct(mourning)} of weeks`);
  const hitTotal = games.reduce((s, g) => s + g.hits, 0);
  const absent = hitTotal === 0 ? 0 : games.reduce((s, g) => s + g.hitsAbsent, 0) / hitTotal;
  if (absent >= 0.4) notes.push(`marks absent on ${pct(absent)} of resolved hits`);
  const regencies = games.reduce((s, g) => s + g.playerRegencies, 0);
  if (regencies >= 8) {
    const lived = games.reduce((s, g) => s + g.playerRegenciesSurvived, 0) / regencies;
    if (lived < 0.25 || lived > 0.65) notes.push(`player survived ${pct(lived)} of leaderless periods`);
  }
  const rivalRegs = games.reduce((s, g) => s + g.rivalRegencies, 0);
  if (rivalRegs >= 8) {
    const collapsed = games.reduce((s, g) => s + g.rivalRegenciesLost, 0) / rivalRegs;
    if (collapsed >= 0.5) notes.push(`rival leaderless periods ended the family ${pct(collapsed)} of the time`);
  }
  const wins = games.filter((g) => g.outcome === "won");
  if (wins.length >= 10) {
    const avg = wins.length / ALL_FAMILY_NAMES.length;
    for (const name of ALL_FAMILY_NAMES) {
      const share = wins.filter((g) => g.family === name).length;
      if (share > avg * 2) notes.push(`${name} won ${share} games, more than twice the average`);
    }
  }
  const widest = Math.max(...games.map((g) => g.openingSpread));
  if (widest > 0.15) notes.push(`opening value spread reached ${pct(widest)}`);
  const belt = games.reduce((s, g) => s + g.beltWeeks, 0) / Math.max(1, games.reduce((s, g) => s + g.rivalWeeks, 0));
  if (belt >= 0.15) notes.push(`rivals tightened belts on ${pct(belt)} of rival-weeks`);
  const heatSamples = games.reduce((s, g) => s + g.heatSamples, 0);
  const heat = heatSamples === 0 ? 0 : games.reduce((s, g) => s + g.heatSum, 0) / heatSamples;
  if (heat < 10 || heat > 50) notes.push(`average rival heat ${heat.toFixed(1)}`);
  const placeBase = games.reduce((s, g) => s + g.placeBase, 0);
  const placeShare = placeBase === 0 ? 0 : games.reduce((s, g) => s + g.placeExtra, 0) / (placeBase + games.reduce((s, g) => s + g.placeExtra, 0));
  if (placeShare < 0.05 || placeShare > 0.2) notes.push(`placement bonus was ${pct(placeShare)} of racket income`);
  return notes;
}

function top(scores: Record<string, number>): string {
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function writeReport(report: SimReport, file = "sim-report.json") {
  writeFileSync(file, JSON.stringify(report, null, 2));
}
