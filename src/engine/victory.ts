import type { FamilyName, GameLength, GameState, VictoryState } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { livingBoss } from "./jail";
import { leadTurnsFor } from "./tempo";

export const LEAD_TURNS = 6;
/** Sudden-death streaks start counting on this turn; nobody is crowned in the opening weeks. */
export const STREAK_START_TURN = 10;
export const BANKRUPT_TURNS = 3;
/** Medium-length standing bar. Short and long games use `influenceBarFor`. */
export const INFLUENCE_BAR = 165;
export const INFLUENCE_MULT = 1.55;
export const WEALTH_FLOOR = 20_000;
/** The wealth bar climbs by this much every week. */
export const WEALTH_FLOOR_SLOPE = 1_000;
export const WEALTH_MULT = 2.75;
/**
 * Unwashed cash is worth this much toward the wealth win. Clean cash counts
 * in full, and a wealth win also needs clean cash to be CLEAN_SHARE of the pile.
 */
export const DIRTY_WEIGHT = 0.55;
/** Clean cash must be at least this share of clean plus dirty to win on wealth. */
export const CLEAN_SHARE = 0.35;
/** The same gate on Easy, for the streak and for the summit. */
export const EASY_CLEAN_SHARE = 0.2;
/** Share of every block a family must hold, and the lead over the next family. */
export const TURF_SHARE = 0.4;
export const TURF_MULT = 1.5;
/** On Easy a rival's streak runs this many weeks longer than the player's. */
export const EASY_RIVAL_EXTRA = 2;
/** On Hard the player's own streak runs this many weeks longer than a rival's. */
export const HARD_PLAYER_EXTRA = 2;
/** Share of a win bar at which the rest of the table starts to notice. */
export const RUNAWAY_WATCH = 0.8;

export function wealthFloor(turn: number): number {
  return WEALTH_FLOOR + WEALTH_FLOOR_SLOPE * turn;
}

/** Standing bar by game length. Short games crown sooner. */
export function influenceBarFor(length: GameLength | undefined): number {
  if (length === "short") return 150;
  if (length === "long") return 180;
  return INFLUENCE_BAR;
}

/** Clean cash as a share of clean plus dirty. Negative clean never qualifies. */
export function cleanShare(state: Pick<GameState, "money" | "dirtyMoney">): number {
  const total = state.money + Math.max(0, state.dirtyMoney);
  if (total <= 0) return 0;
  return Math.max(0, state.money) / total;
}

/** The clean share a wealth win asks for. Easy asks for less. */
export function cleanShareNeeded(state: Pick<GameState, "settings">): number {
  return state.settings.difficulty === "easy" ? EASY_CLEAN_SHARE : CLEAN_SHARE;
}

export function cleanShareOk(state: Pick<GameState, "money" | "dirtyMoney" | "settings">): boolean {
  return state.money > 0 && cleanShare(state) >= cleanShareNeeded(state);
}
export const SUMMIT_RATIO = 1.1;
/** On Easy the summit names whoever is first; no margin over the next family. */
export const EASY_SUMMIT_RATIO = 1;

/** How far ahead of the next family the summit wants the player to be. */
export function summitRatio(state: Pick<GameState, "settings">): number {
  return state.settings.difficulty === "easy" ? EASY_SUMMIT_RATIO : SUMMIT_RATIO;
}

export function finalTurnFor(length: GameLength | undefined): number {
  if (length === "short") return 30;
  if (length === "long") return 80;
  return 50;
}

export function emptyVictory(finalTurn = 50): VictoryState {
  return {
    won: false,
    lost: false,
    finalTurn,
    influenceLeadTurns: 0,
    wealthLeadTurns: 0,
    turfLeadTurns: 0,
    bankruptTurns: 0,
    rivalLeadTurns: {},
  };
}

export function seedRivalInfluence(
  existing: Partial<Record<FamilyName, number>> | undefined,
  player: FamilyName | null,
): Partial<Record<FamilyName, number>> {
  if (existing && Object.keys(existing).length > 0) return existing;
  const seeded: Partial<Record<FamilyName, number>> = {};
  for (const family of ALL_FAMILY_NAMES) {
    if (family !== player) seeded[family] = 120;
  }
  return seeded;
}

export interface StandingDrivers {
  respect: number;
  fear: number;
  streetInfluence: number;
}

const INFLUENCE_WEIGHTS = { respect: 0.04, fear: 0.03, streetInfluence: 0.02 } as const;
const INFLUENCE_UPKEEP = 2;
export const INFLUENCE_CAP = 300;

/** Weekly standing drift. The same curve for every family at the table. */
export function influenceTick(rep: StandingDrivers): number {
  return (
    rep.respect * INFLUENCE_WEIGHTS.respect +
    rep.fear * INFLUENCE_WEIGHTS.fear +
    rep.streetInfluence * INFLUENCE_WEIGHTS.streetInfluence -
    INFLUENCE_UPKEEP
  );
}

/** Tooltip lines for the Influence stat: what this week's drift is made of. */
export function influenceBreakdown(rep: StandingDrivers, influence: number): string {
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
  const part = (label: string, value: number, weight: number) =>
    `${label} ${Math.round(value)} × ${weight} = ${signed(value * weight)}`;
  const net = influenceTick(rep);
  return [
    `Each week:`,
    part("Respect", rep.respect, INFLUENCE_WEIGHTS.respect),
    part("Fear", rep.fear, INFLUENCE_WEIGHTS.fear),
    part("Street", rep.streetInfluence, INFLUENCE_WEIGHTS.streetInfluence),
    `Upkeep ${signed(-INFLUENCE_UPKEEP)}`,
    `Net ${signed(net)} a week${influence >= INFLUENCE_CAP && net > 0 ? ` (capped at ${INFLUENCE_CAP})` : ""}`,
    ``,
    `Spent on: sit-downs, demands, pacts, Commission calls and lobbying, and standing thrown into deals.`,
    `Lost when you break a deal. Gained from message hits, Commission errands and hosting sit-downs.`,
  ].join("\n");
}

/**
 * A rival's standing drivers, read off the map. Turf earns respect, muscle
 * earns fear, and the personality decides which the street remembers.
 */
export function rivalStandingDrivers(state: GameState, family: FamilyName): StandingDrivers {
  const turf = state.territories.filter((t) => t.owner === family).length;
  const personality = getFamilyDef(family).personality;
  return {
    respect: 5 + turf * 3 + (personality === "economic" ? 10 : 0),
    fear: 3 + turf * 2 + (personality === "volatile" ? 10 : 0),
    streetInfluence: 5 + turf * 2 + (personality === "smuggler" || personality === "covert" ? 5 : 0),
  };
}

export function familyInfluence(state: GameState, family: FamilyName): number {
  if (family === state.playerFamily) return state.influence;
  return state.rivalInfluence?.[family] ?? 0;
}

export function familyWealth(state: GameState, family: FamilyName): number {
  if (family === state.playerFamily) return state.money + state.dirtyMoney * DIRTY_WEIGHT;
  return state.rivalTreasury?.[family] ?? 0;
}

/** Families still at the table. A finished family keeps its name on the map and nothing else. */
function seated(state: Pick<GameState, "defunctFamilies">): FamilyName[] {
  const gone = new Set(state.defunctFamilies ?? []);
  return ALL_FAMILY_NAMES.filter((f) => !gone.has(f));
}

/** Best score among seated families other than `except`. */
function bestOther(state: GameState, except: FamilyName, score: (f: FamilyName) => number): number {
  let best = 0;
  for (const f of seated(state)) {
    if (f === except) continue;
    best = Math.max(best, score(f));
  }
  return best;
}

/**
 * Lead by 10%, trail by more than 10%, or close: within 10% either way.
 * `lead` is the margin a lead needs; Easy passes 1, so level or better leads.
 */
function gap(player: number, second: number, lead = SUMMIT_RATIO): "lead" | "close" | "trail" {
  if (second <= 0) return player > 0 ? "lead" : "close";
  if (player >= second * lead) return "lead";
  if (player >= second * (2 - SUMMIT_RATIO)) return "close";
  return "trail";
}

function districtsOf(state: GameState, family: FamilyName): number {
  return state.territories.filter((t) => t.owner === family).length;
}

/** Share of the game, counted back from the summit, in which Hard rivals plan for it. */
export const SUMMIT_WATCH_SHARE = 0.25;
/** A player within ten percent, but not clear, weighs this much of a player who would be named. */
const SUMMIT_CLOSE_WEIGHT = 0.6;

/**
 * Weeks before the summit at which rival families start working against
 * whoever it would name. Hard only: on Easy and Normal they never look that far.
 */
export function summitWatchWeeks(state: Pick<GameState, "settings" | "victory">): number {
  if (state.settings.difficulty !== "hard") return 0;
  const finalTurn = state.victory?.finalTurn || finalTurnFor(state.settings.gameLength);
  return Math.floor(finalTurn * SUMMIT_WATCH_SHARE);
}

export interface SummitThreat {
  track: "influence" | "wealth";
  weeksLeft: number;
  window: number;
  /** Ten percent clear of the next family today; otherwise within ten percent of it. */
  leading: boolean;
  /** 1 when the window opens, 2.5 in the last week. A family that is only close weighs 0.6 of that. */
  pressure: number;
}

/**
 * What the table sees coming at the summit: the tracks on which the player
 * would be named today, or is close enough to be. Rivals read the totals, not
 * the split between clean and dirty cash. Strongest claim first.
 */
export function summitThreats(state: GameState): SummitThreat[] {
  const player = state.playerFamily;
  const window = summitWatchWeeks(state);
  if (!player || window <= 0 || state.victory?.won || state.victory?.lost) return [];
  const finalTurn = state.victory?.finalTurn || finalTurnFor(state.settings.gameLength);
  const weeksLeft = finalTurn - state.turn;
  if (weeksLeft < 0 || weeksLeft > window) return [];
  const ramp = 1 + 1.5 * (1 - weeksLeft / window);
  const found: { threat: SummitThreat; ratio: number }[] = [];
  for (const track of ["influence", "wealth"] as const) {
    const score = (f: FamilyName) => (track === "influence" ? familyInfluence(state, f) : familyWealth(state, f));
    const mine = score(player);
    const second = bestOther(state, player, score);
    const how = gap(mine, second);
    if (how === "trail") continue;
    const leading = how === "lead";
    found.push({
      threat: { track, weeksLeft, window, leading, pressure: ramp * (leading ? 1 : SUMMIT_CLOSE_WEIGHT) },
      ratio: second > 0 ? mine / second : Number.POSITIVE_INFINITY,
    });
  }
  return found
    .sort((a, b) => Number(b.threat.leading) - Number(a.threat.leading) || b.ratio - a.ratio)
    .map((row) => row.threat);
}

export type WinTrack = "influence" | "wealth" | "turf";

const TRACKS: WinTrack[] = ["influence", "wealth", "turf"];

export interface TrackStanding {
  value: number;
  /** The higher of the fixed bar and the lead the next family forces. */
  bar: number;
  /** The smaller of value/fixed-bar and value/(next × lead). 1 clears the bar. */
  progress: number;
  second: number;
  secondName: FamilyName | null;
}

function scoreOf(state: GameState, family: FamilyName, track: WinTrack): number {
  if (track === "influence") return familyInfluence(state, family);
  if (track === "wealth") return familyWealth(state, family);
  return districtsOf(state, family);
}

/** Where one family stands on one track, against the fixed bar and the next family. */
export function trackStanding(state: GameState, family: FamilyName, track: WinTrack): TrackStanding {
  const value = scoreOf(state, family, track);
  let second = 0;
  let secondName: FamilyName | null = null;
  for (const other of seated(state)) {
    if (other === family) continue;
    const n = scoreOf(state, other, track);
    if (n >= second) {
      second = n;
      secondName = other;
    }
  }
  let fixed = influenceBarFor(state.settings.gameLength);
  let mult = INFLUENCE_MULT;
  if (track === "wealth") {
    fixed = wealthFloor(state.turn);
    mult = WEALTH_MULT;
  } else if (track === "turf") {
    fixed = Math.ceil((state.territories.length || 1) * TURF_SHARE);
    mult = TURF_MULT;
  }
  const bar = Math.max(fixed, second * mult);
  const progress = bar <= 0 ? (value > 0 ? 1 : 0) : value / bar;
  return { value, bar, progress, second, secondName };
}

export function streakWeeks(state: GameState, family: FamilyName, track: WinTrack): number {
  const victory = state.victory;
  if (family === state.playerFamily) {
    if (track === "influence") return victory?.influenceLeadTurns ?? 0;
    if (track === "wealth") return victory?.wealthLeadTurns ?? 0;
    return victory?.turfLeadTurns ?? 0;
  }
  return victory?.rivalLeadTurns?.[family]?.[track] ?? 0;
}

/** Weeks the player must hold a sudden-death bar. Hard asks for more. */
export function playerWeeksNeeded(state: Pick<GameState, "settings">): number {
  const base = leadTurnsFor(state.settings.gameLength);
  return state.settings.difficulty === "hard" ? base + HARD_PLAYER_EXTRA : base;
}

export function weeksNeeded(state: GameState, family: FamilyName): number {
  return family === state.playerFamily ? playerWeeksNeeded(state) : rivalWeeksNeeded(state);
}

/**
 * Whether `family` is clearing one sudden-death bar this week, measured
 * against the best other family still seated. The player's wealth bar also
 * needs clean cash to be CLEAN_SHARE of the pile. Rivals have one treasury.
 */
export function clearsBar(state: GameState, family: FamilyName, track: WinTrack): boolean {
  if (state.turn < STREAK_START_TURN) return false;
  if ((state.defunctFamilies ?? []).includes(family)) return false;
  if (track === "wealth" && family === state.playerFamily && !cleanShareOk(state)) return false;
  return trackStanding(state, family, track).progress >= 1;
}

export type RunawayLevel = "watch" | "pressing" | "critical";

export interface Runaway {
  family: FamilyName;
  track: WinTrack;
  level: RunawayLevel;
  progress: number;
  /** 0 below the watch line, 1 at the bar, then more as a live streak fills. */
  pressure: number;
  weeks: number;
  need: number;
}

/** Every family far enough along a track that the rest of the table can see it. */
export function runaways(state: GameState): Runaway[] {
  const out: Runaway[] = [];
  for (const family of seated(state)) {
    for (const track of TRACKS) {
      const standing = trackStanding(state, family, track);
      if (standing.progress < RUNAWAY_WATCH) continue;
      const need = weeksNeeded(state, family);
      const weeks = streakWeeks(state, family, track);
      const live = clearsBar(state, family, track) && weeks > 0;
      const level: RunawayLevel =
        live && weeks * 2 >= need ? "critical" : live ? "pressing" : "watch";
      const climb = Math.min(1, Math.max(0, (standing.progress - RUNAWAY_WATCH) / (1 - RUNAWAY_WATCH)));
      const filled = live ? Math.min(1.5, (weeks / Math.max(1, need)) * 1.5) : 0;
      out.push({
        family,
        track,
        level,
        progress: standing.progress,
        pressure: climb + (live ? 1 : 0) + filled,
        weeks,
        need,
      });
    }
  }
  return out.sort((a, b) => b.pressure - a.pressure);
}

/** Families currently clearing a sudden-death bar, player or rival. */
export function familiesPressingSuddenDeath(state: GameState): FamilyName[] {
  if (state.turn < STREAK_START_TURN) return [];
  return seated(state).filter((f) => TRACKS.some((track) => clearsBar(state, f, track)));
}

export function rivalWeeksNeeded(state: GameState): number {
  const base = leadTurnsFor(state.settings.gameLength);
  return state.settings.difficulty === "easy" ? base + EASY_RIVAL_EXTRA : base;
}

function emptyClock(): { influence: number; wealth: number; turf: number } {
  return { influence: 0, wealth: 0, turf: 0 };
}

const TRACK_WORD: Record<WinTrack, string> = {
  influence: "standing",
  wealth: "wealth",
  turf: "the city",
};

/** The week a rival's streak starts: who, on what, and how many weeks they have left. */
export function rivalStreakStarts(
  before: VictoryState | undefined,
  after: VictoryState,
  needed: number,
): { family: FamilyName; track: WinTrack; left: number }[] {
  const starts: { family: FamilyName; track: WinTrack; left: number }[] = [];
  for (const family of Object.keys(after.rivalLeadTurns ?? {}) as FamilyName[]) {
    const prev = before?.rivalLeadTurns?.[family] ?? emptyClock();
    const next = after.rivalLeadTurns?.[family];
    if (!next) continue;
    for (const track of TRACKS) {
      if (prev[track] === 0 && next[track] === 1) {
        starts.push({ family, track, left: Math.max(1, needed - 1) });
      }
    }
  }
  return starts;
}

export function streakStartLine(family: FamilyName, track: WinTrack, left: number): string {
  const word = TRACK_WORD[track];
  return `${family} is pulling away on ${word}. ${left} week${left === 1 ? "" : "s"} like this and the city is theirs.`;
}

/** A clock that was running and is now back at zero, and the game is still going. */
export function streakBreaks(
  before: VictoryState | undefined,
  after: VictoryState,
  player: FamilyName | null,
): { family: FamilyName; track: WinTrack; weeks: number }[] {
  if (!before || after.won || after.lost) return [];
  const out: { family: FamilyName; track: WinTrack; weeks: number }[] = [];
  if (player) {
    const rows: [WinTrack, number, number][] = [
      ["influence", before.influenceLeadTurns, after.influenceLeadTurns],
      ["wealth", before.wealthLeadTurns, after.wealthLeadTurns],
      ["turf", before.turfLeadTurns ?? 0, after.turfLeadTurns ?? 0],
    ];
    for (const [track, prev, next] of rows) {
      if (prev > 0 && next === 0) out.push({ family: player, track, weeks: prev });
    }
  }
  const names = new Set<FamilyName>([
    ...(Object.keys(before.rivalLeadTurns ?? {}) as FamilyName[]),
    ...(Object.keys(after.rivalLeadTurns ?? {}) as FamilyName[]),
  ]);
  for (const family of names) {
    const prev = before.rivalLeadTurns?.[family] ?? emptyClock();
    const next = after.rivalLeadTurns?.[family] ?? emptyClock();
    for (const track of TRACKS) {
      if (prev[track] > 0 && next[track] === 0) out.push({ family, track, weeks: prev[track] });
    }
  }
  return out;
}

export function streakBreakLine(family: FamilyName, track: WinTrack, weeks: number, player: FamilyName | null): string {
  const word = TRACK_WORD[track];
  const who = family === player ? "Your" : `${family}'s`;
  return `${who} run on ${word} breaks after ${weeks} week${weeks === 1 ? "" : "s"}.`;
}

function rivalReason(family: FamilyName, track: WinTrack, weeks: number): string {
  if (track === "influence") return `The ${family} held the city's standing for ${weeks} weeks.`;
  if (track === "wealth") return `The ${family} were the richest family in the city for ${weeks} weeks.`;
  return `The ${family} held the city for ${weeks} weeks.`;
}

export function checkVictory(state: GameState): VictoryState {
  const victory: VictoryState = {
    ...emptyVictory(),
    ...state.victory,
    finalTurn: state.victory?.finalTurn || finalTurnFor(state.settings.gameLength),
  };
  if (victory.won || victory.lost) return victory;
  if (!state.playerFamily || !state.started) return victory;

  const player = state.playerFamily;
  const reg = state.interregnum;
  if (reg?.family === player) {
    if (state.turn >= reg.deadline) {
      return {
        ...victory,
        lost: true,
        reason:
          reg.cause === "put_away"
            ? "Five weeks with no boss. The family never recovered from the Tombs."
            : "Five weeks with no boss. The chair stayed empty.",
      };
    }
  } else {
  const boss = livingBoss(state, player);
  if (!boss || boss.status === "dead") {
    const putAway = state.crew.some(
      (c) => c.family === player && c.role === "boss" && c.putAway,
    );
    return {
      ...victory,
      lost: true,
      reason: putAway
        ? "Your boss never left the Tombs, and no underboss was ready."
        : "Your boss is dead and no underboss could take the chair.",
    };
  }
  if (boss.status === "jailed" && state.turn >= (boss.jailedUntilTurn ?? state.turn)) {
    return {
      ...victory,
      lost: true,
      reason: "Your boss never left the Tombs, and no underboss was ready.",
    };
  }
  }

  const broke = state.money < 0 && state.dirtyMoney < 0;
  const bankruptTurns = broke ? victory.bankruptTurns + 1 : 0;
  if (bankruptTurns >= BANKRUPT_TURNS) {
    return {
      ...victory,
      bankruptTurns,
      lost: true,
      reason: `Bankrupt for ${BANKRUPT_TURNS} weeks — both coffers are empty.`,
    };
  }

  const alive = seated(state);
  if (alive.length === 1 && alive[0] === player) {
    return {
      ...victory,
      bankruptTurns,
      won: true,
      winner: player,
      reason: "The last family standing.",
    };
  }

  const leadTurns = playerWeeksNeeded(state);
  const streaksFrozen = state.interregnum?.family === player;
  const bump = (held: boolean, prev: number) => (streaksFrozen ? prev : held ? prev + 1 : 0);
  const influenceLeadTurns = bump(clearsBar(state, player, "influence"), victory.influenceLeadTurns);
  const wealthLeadTurns = bump(clearsBar(state, player, "wealth"), victory.wealthLeadTurns);
  const turfLeadTurns = bump(clearsBar(state, player, "turf"), victory.turfLeadTurns ?? 0);
  const crowned = !streaksFrozen && {
    influence: influenceLeadTurns >= leadTurns,
    wealth: wealthLeadTurns >= leadTurns,
    turf: turfLeadTurns >= leadTurns,
  };
  if (crowned && (crowned.influence || crowned.wealth || crowned.turf)) {
    const reason = crowned.influence
      ? `Standing for ${leadTurns} weeks — the Commission bends.`
      : crowned.wealth
        ? `The richest family in the city for ${leadTurns} weeks.`
        : `You held the city for ${leadTurns} weeks.`;
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns,
      turfLeadTurns,
      won: true,
      winner: player,
      reason,
    };
  }

  const clocks: VictoryState["rivalLeadTurns"] = {};
  const needed = rivalWeeksNeeded(state);
  let rivalWin: { family: FamilyName; track: WinTrack } | null = null;
  for (const family of alive) {
    if (family === player) continue;
    const prev = victory.rivalLeadTurns?.[family] ?? emptyClock();
    const frozen = state.interregnum?.family === family;
    const clock = emptyClock();
    for (const track of TRACKS) {
      const held = clearsBar(state, family, track);
      clock[track] = frozen ? prev[track] : held ? prev[track] + 1 : 0;
      if (!frozen && !rivalWin && clock[track] >= needed) rivalWin = { family, track };
    }
    if (clock.influence || clock.wealth || clock.turf) clocks[family] = clock;
  }
  if (rivalWin) {
    return {
      ...victory,
      bankruptTurns,
      influenceLeadTurns,
      wealthLeadTurns,
      turfLeadTurns,
      rivalLeadTurns: clocks,
      lost: true,
      winner: rivalWin.family,
      reason: rivalReason(rivalWin.family, rivalWin.track, needed),
    };
  }

  const next: VictoryState = {
    ...victory,
    bankruptTurns,
    influenceLeadTurns,
    wealthLeadTurns,
    turfLeadTurns,
    rivalLeadTurns: clocks,
  };

  if (state.turn < next.finalTurn) return next;

  const inf = familyInfluence(state, player);
  const infSecond = bestOther(state, player, (f) => familyInfluence(state, f));
  const wealth = familyWealth(state, player);
  const wealthSecond = bestOther(state, player, (f) => familyWealth(state, f));
  const margin = summitRatio(state);
  const infGap = gap(inf, infSecond, margin);
  let wealthGap = gap(wealth, wealthSecond, margin);
  if (wealthGap === "lead" && !cleanShareOk(state)) wealthGap = "close";
  if (infGap === "lead" || wealthGap === "lead") {
    const which = infGap === "lead" ? "standing" : "wealth";
    return {
      ...next,
      won: true,
      winner: player,
      reason: `The summit names you first in ${which}.`,
    };
  }
  if (infGap === "close" && wealthGap === "close") {
    const mine = districtsOf(state, player);
    const rivals = alive.filter((f) => f !== player);
    const bestRival = rivals.length === 0 ? 0 : Math.max(...rivals.map((f) => districtsOf(state, f)));
    if (mine > bestRival) {
      return {
        ...next,
        won: true,
        winner: player,
        reason: "Too close to call on the books — the map breaks the tie.",
      };
    }
  }
  return {
    ...next,
    lost: true,
    reason: "The summit adjourns. Another family leaves with the city.",
  };
}

export interface TrackRace {
  track: WinTrack;
  label: string;
  value: number;
  bar: number;
  second: number;
  secondName: FamilyName | null;
  missing: string;
  streak: number;
  need: number;
}

export interface RaceStatus {
  tracks: TrackRace[];
  rivals: { family: FamilyName; track: WinTrack; weeks: number; need: number; text: string }[];
  summitWeeks: number;
  namedToday: string;
  closest: string;
  streakLive: boolean;
}

function moneyShort(n: number): string {
  return `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

/** Where the player stands on each track, and which rivals are already on a clock. */
export function raceStatus(state: GameState): RaceStatus {
  const player = state.playerFamily;
  const need = playerWeeksNeeded(state);
  const rivalNeed = rivalWeeksNeeded(state);
  const empty: RaceStatus = {
    tracks: [],
    rivals: [],
    summitWeeks: Math.max(0, (state.victory?.finalTurn ?? 50) - state.turn),
    namedToday: "Nobody",
    closest: "",
    streakLive: false,
  };
  if (!player) return empty;
  const others = seated(state).filter((f) => f !== player);
  const standing = trackStanding(state, player, "influence");
  const wealthStanding = trackStanding(state, player, "wealth");
  const turfStanding = trackStanding(state, player, "turf");
  const inf = standing.value;
  const wealth = wealthStanding.value;
  const v = state.victory;
  const clean = Math.round(cleanShare(state) * 100);
  const shortOf = (row: TrackStanding, unit: string) =>
    row.progress >= 1 ? "Clear" : `${Math.max(0, Math.ceil(row.bar - row.value))} ${unit} short`;
  const tracks: TrackRace[] = [
    {
      track: "influence",
      label: "Standing",
      value: Math.round(standing.value),
      bar: Math.round(standing.bar),
      second: Math.round(standing.second),
      secondName: standing.secondName,
      missing: shortOf(standing, "standing"),
      streak: v?.influenceLeadTurns ?? 0,
      need,
    },
    {
      track: "wealth",
      label: "Wealth",
      value: Math.round(wealthStanding.value),
      bar: Math.round(wealthStanding.bar),
      second: Math.round(wealthStanding.second),
      secondName: wealthStanding.secondName,
      missing: !cleanShareOk(state)
        ? `clean share ${clean}% of ${Math.round(cleanShareNeeded(state) * 100)}%`
        : wealthStanding.progress >= 1
          ? "Clear"
          : `${moneyShort(wealthStanding.bar - wealthStanding.value)} short`,
      streak: v?.wealthLeadTurns ?? 0,
      need,
    },
    {
      track: "turf",
      label: "Turf",
      value: turfStanding.value,
      bar: Math.ceil(turfStanding.bar),
      second: turfStanding.second,
      secondName: turfStanding.secondName,
      missing: shortOf(turfStanding, "blocks"),
      streak: v?.turfLeadTurns ?? 0,
      need,
    },
  ];
  const rivals = (Object.entries(v?.rivalLeadTurns ?? {}) as [FamilyName, { influence: number; wealth: number; turf: number }][])
    .flatMap(([family, clock]) =>
      TRACKS.filter((track) => clock[track] > 0).map((track) => ({
        family,
        track,
        weeks: clock[track],
        need: rivalNeed,
        text: `${family}: ${TRACK_WORD[track]} ${clock[track]} of ${rivalNeed} weeks`,
      })),
    )
    .sort((a, b) => b.weeks / b.need - a.weeks / a.need);
  const margin = summitRatio(state);
  const infGap = gap(inf, standing.second, margin);
  let wealthGap = gap(wealth, wealthStanding.second, margin);
  if (wealthGap === "lead" && !cleanShareOk(state)) wealthGap = "close";
  const namedToday =
    infGap === "lead" ? `${player} on standing` : wealthGap === "lead" ? `${player} on wealth` : "too close to call";
  const closestRival = others
    .map((f) => ({ f, w: familyWealth(state, f), i: familyInfluence(state, f) }))
    .sort((a, b) => b.w + b.i - (a.w + a.i))[0];
  return {
    tracks,
    rivals,
    summitWeeks: Math.max(0, (v?.finalTurn ?? 50) - state.turn),
    namedToday,
    closest: closestRival ? `${closestRival.f} is the nearest` : "",
    streakLive: tracks.some((t) => t.streak > 0) || rivals.length > 0,
  };
}
