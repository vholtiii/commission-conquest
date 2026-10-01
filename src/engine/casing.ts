/**
 * Casing: what a lookout learns when he scouts a rival district, how deep
 * he can dig (tier), how likely he is to be spotted (detection → rung), and
 * what the cops make of a man loitering on a hot block.
 *
 * Pure functions only. Applying consequences (alerts, burns, grudges, held /
 * killed crew) happens in hitOps when the surveillance op resolves.
 */
import type {
  BusinessIntel,
  CasingClue,
  CasingRung,
  CasingTier,
  ClueKind,
  CrewMember,
  CrewRole,
  FamilyName,
  GameState,
  HitApproach,
  Racket,
  Territory,
  TradeLevel,
  TurnLogEntry,
} from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import type { Rng } from "./rng";
import { crewCombatScore } from "./crew";
import {
  RACKET_BASE_INCOME,
  RACKET_BUILD_COST,
  isLegitBusiness,
  isRacketFrozen,
  launderSiteStatus,
  racketIncome,
} from "./economy";
import { stockCap } from "./liquor";
import { getRelation } from "./relations";
import { getFamilyDef } from "@/data/families";
import { crewPresentIn } from "./crewLocation";
import { casingSkills } from "./crews";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Crew skills roll 15–55 (+ role bias), so the score lands roughly 15–75. */
export const TIER_THRESHOLDS: Record<Exclude<CasingTier, 1>, number> = {
  2: 35,
  3: 48,
  4: 60,
};

export const CLUE_TTL: Record<ClueKind, number> = {
  routine: 4,
  target_profile: 999,
  garrison_window: 0, // uses windowTurn + 1
  getaway: 6,
  cop_on_payroll: 6,
  patrol: 6,
  weak_link: 6,
  rat: 6,
};

/** Turns a district stays on alert after a spotted lookout. */
export const ALERT_TURNS = 3;
/** Turns a made lookout's face is known to the family. */
export const BURN_TURNS = 5;
/** Turns a grabbed lookout is held. */
export const HELD_TURNS = 2;
/** Turns a casing grudge steers rival hits. */
export const GRUDGE_TURNS = 5;

/* ------------------------------------------------------------------ */
/* Per-turn upkeep                                                     */
/* ------------------------------------------------------------------ */

/**
 * Let go anyone whose hold has run out. They come home active but shaken:
 * a little loyalty gone, and whatever they told their hosts stays told.
 */
export function releaseHeldCrew(
  state: Pick<GameState, "crew" | "turn" | "playerFamily">,
): { crew: CrewMember[]; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  const crew = state.crew.map((c) => {
    if (c.status !== "held") return c;
    if ((c.heldUntilTurn ?? 0) > state.turn) return c;
    if (c.family === state.playerFamily) {
      logs.push({
        id: `log_released_${c.id}_${state.turn}`,
        turn: state.turn,
        category: "combat",
        text: `${c.name} came home from ${c.heldBy ? `a ${c.heldBy} basement` : "somebody's basement"}. He isn't talking about it.`,
        family: c.family,
      });
    }
    return {
      ...c,
      status: "active" as const,
      loyalty: Math.max(0, c.loyalty - 5),
      heldUntilTurn: undefined,
      heldBy: undefined,
      assignment: { type: "idle" as const },
    };
  });
  return { crew, logs };
}

/** Drop grudges that have gone cold. */
export function pruneGrudges<S extends Pick<GameState, "grudges" | "turn">>(state: S): S {
  const live = (state.grudges ?? []).filter((g) => g.expiresTurn > state.turn);
  if (live.length === (state.grudges ?? []).length) return state;
  return { ...state, grudges: live };
}

/** Rival crew at or below this loyalty read as a weak link. */
const WEAK_LINK_LOYALTY = 45;
/** Player crew at or below this loyalty can be the rat. */
const RAT_LOYALTY = 35;

/* ------------------------------------------------------------------ */
/* Score, tier, chances                                                */
/* ------------------------------------------------------------------ */

export function casingScore(lookout: CrewMember): number {
  // Loose soldiers read sharper on the street than their sheet says.
  const sk = casingSkills(lookout);
  let score = 0.6 * sk.smarts + 0.4 * sk.stealth;
  score += Math.max(0, lookout.level - 1) * 1.5;
  if (lookout.traits.includes("ghost")) score += 8;
  if (lookout.traits.includes("smooth_talker")) score += 3;
  if (lookout.traits.includes("hothead")) score -= 5;
  if (lookout.traits.includes("enforcer")) score -= 5;
  return score;
}

export function tierForScore(score: number): CasingTier {
  if (score >= TIER_THRESHOLDS[4]) return 4;
  if (score >= TIER_THRESHOLDS[3]) return 3;
  if (score >= TIER_THRESHOLDS[2]) return 2;
  return 1;
}

/** Bookkeepers read the books one tier deeper than they read the street. */
export function businessTierFor(lookout: CrewMember, tier: CasingTier): CasingTier {
  if (!lookout.traits.includes("bookkeeper")) return tier;
  return Math.min(4, tier + 1) as CasingTier;
}

export function rivalGarrisonCount(
  state: Pick<GameState, "crew">,
  territory: Territory,
  family: FamilyName,
): number {
  return territory.garrisonIds.filter((id) => {
    const c = state.crew.find((m) => m.id === id);
    return !!c && c.family === family && (c.status === "active" || c.status === "wounded");
  }).length;
}

export function isDistrictAlerted(state: Pick<GameState, "intel" | "turn">, territoryId: string): boolean {
  return (state.intel?.alerted?.[territoryId] ?? 0) > state.turn;
}

export function isLookoutBurned(
  state: Pick<GameState, "intel" | "turn">,
  lookoutId: string,
  family: FamilyName,
): boolean {
  const b = state.intel?.burned?.[lookoutId];
  return !!b && b.family === family && b.expiresTurn > state.turn;
}

/** Chance the target family notices the lookout at all. */
export function detectionChance(
  state: GameState,
  lookout: CrewMember,
  territoryId: string,
  targetFamily: FamilyName,
): number {
  const territory = state.territories.find((t) => t.id === territoryId);
  if (!territory) return 0.03;
  const present = crewPresentIn(state, territoryId).filter((c) => c.family === targetFamily);
  const defenders = rivalGarrisonCount(state, territory, targetFamily);
  const top = pickTopMark(present);
  const def = getFamilyDef(targetFamily);
  const bossHome = present.some((c) => c.role === "boss");

  let chance =
    0.06 +
    state.heat.level / 400 +
    defenders * 0.03 +
    (top?.skills.smarts ?? 30) / 500 -
    casingSkills(lookout).stealth / 600;

  if (isDistrictAlerted(state, territoryId)) chance += 0.1;
  if (bossHome) chance += 0.05;
  if (def.personality === "covert") chance += 0.05;
  if (isLookoutBurned(state, lookout.id, targetFamily)) chance += 0.15;
  if (lookout.traits.includes("hothead")) chance += 0.03;

  return Math.max(0.03, Math.min(0.5, chance));
}

/** Chance the cops take an interest in a man loitering on the block. */
export function copChance(
  state: Pick<GameState, "heat">,
  lookout: CrewMember,
  territory: Territory | undefined,
): number {
  let chance = Math.max(0, state.heat.level - 40) / 200 + (territory?.heatLevel ?? 0) * 0.02;
  chance += lookout.wanted * 0.01;
  if (lookout.traits.includes("bookkeeper") || lookout.traits.includes("smooth_talker")) {
    chance *= 0.5;
  }
  return Math.max(0, Math.min(0.3, chance));
}

export interface CasingProfile {
  score: number;
  tier: CasingTier;
  businessTier: CasingTier;
  detectChance: number;
  copChance: number;
}

/** Everything the lookout picker needs to show before committing a man. */
export function casingProfile(
  state: GameState,
  lookout: CrewMember,
  territoryId: string,
  targetFamily: FamilyName,
): CasingProfile {
  const territory = state.territories.find((t) => t.id === territoryId);
  const score = casingScore(lookout);
  const tier = tierForScore(score);
  return {
    score,
    tier,
    businessTier: businessTierFor(lookout, tier),
    detectChance: detectionChance(state, lookout, territoryId, targetFamily),
    copChance: copChance(state, lookout, territory),
  };
}

/* ------------------------------------------------------------------ */
/* Detection roll → rung                                               */
/* ------------------------------------------------------------------ */

export type GrabbedFate = "wounded" | "held" | "killed";

export interface CasingRoll {
  rung: CasingRung;
  /** Tier actually brought home (truncated when spotted early). */
  reachedTier: CasingTier;
  reachedBusinessTier: CasingTier;
  /** True when the mark himself saw the lookout (routine gets invalidated). */
  markSawHim: boolean;
  grabbedFate?: GrabbedFate;
  copTrouble?: "wanted" | "arrested";
}

export function rollCasing(
  state: GameState,
  rng: Rng,
  lookout: CrewMember,
  territoryId: string,
  targetFamily: FamilyName,
  profile: CasingProfile,
): CasingRoll {
  const present = crewPresentIn(state, territoryId).filter((c) => c.family === targetFamily);
  const top = pickTopMark(present);
  const def = getFamilyDef(targetFamily);

  // Cops first: an arrest ends the casing before the rival ever sees him.
  let copTrouble: CasingRoll["copTrouble"];
  if (rng.chance(profile.copChance)) {
    copTrouble =
      lookout.wanted + 1 > 5 && state.heat.level >= 50 ? "arrested" : "wanted";
  }
  if (copTrouble === "arrested") {
    return {
      rung: "clean",
      reachedTier: 1,
      reachedBusinessTier: 1,
      markSawHim: false,
      copTrouble,
    };
  }

  if (!rng.chance(profile.detectChance)) {
    return {
      rung: "clean",
      reachedTier: profile.tier,
      reachedBusinessTier: profile.businessTier,
      markSawHim: false,
      copTrouble,
    };
  }

  // Detected. Severity: how badly.
  const severity =
    rng.next() +
    (top?.skills.smarts ?? 30) / 200 -
    lookout.skills.stealth / 200 +
    (def.personality === "volatile" ? 0.1 : 0);

  // Turned: covert family, shaky lookout. He reports "clean" with a poisoned file.
  if (def.personality === "covert" && lookout.loyalty < 40 && rng.chance(0.4)) {
    return {
      rung: "turned",
      reachedTier: profile.tier,
      reachedBusinessTier: profile.businessTier,
      markSawHim: false,
      copTrouble,
    };
  }

  const markSawHim = !!top && rng.chance(0.35 + (top.skills.smarts ?? 30) / 200);

  if (severity < 0.5) {
    return {
      rung: "noticed",
      reachedTier: profile.tier,
      reachedBusinessTier: profile.businessTier,
      markSawHim,
      copTrouble,
    };
  }

  if (severity < 0.85) {
    return {
      rung: "made",
      reachedTier: Math.max(1, profile.tier - 1) as CasingTier,
      reachedBusinessTier: Math.max(1, profile.businessTier - 1) as CasingTier,
      markSawHim: true,
      copTrouble,
    };
  }

  // Grabbed.
  const relation = state.playerFamily
    ? getRelation(state.relations, lookout.family, targetFamily)
    : 0;
  let grabbedFate: GrabbedFate;
  if (def.personality === "volatile" && relation < -40 && rng.chance(0.5)) {
    grabbedFate = "killed";
  } else if (rng.chance(0.5)) {
    grabbedFate = "held";
  } else {
    grabbedFate = "wounded";
  }
  return {
    rung: "grabbed",
    reachedTier: 1,
    reachedBusinessTier: 1,
    markSawHim: true,
    grabbedFate,
    copTrouble,
  };
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

const ROLE_RANK: Record<CrewRole, number> = {
  associate: 1,
  soldier: 2,
  capo: 3,
  hitman: 4,
  consigliere: 5,
  underboss: 6,
  boss: 7,
};

/** Highest-value mark on the block: role first, then combat score. */
export function pickTopMark(crew: CrewMember[]): CrewMember | undefined {
  if (crew.length === 0) return undefined;
  return [...crew].sort((a, b) => {
    const rank = (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0);
    if (rank !== 0) return rank;
    return crewCombatScore(b) - crewCombatScore(a);
  })[0];
}

const NAME_SUFFIXES = new Set(["ii", "iii", "iv", "jr", "jr.", "sr", "sr."]);

/** Surname for flavor text, skipping generational suffixes and quoted nicknames. */
export function lastName(c: Pick<CrewMember, "name">): string {
  const parts = c.name.split(" ").filter((p) => !p.startsWith('"'));
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  return parts[parts.length - 1] ?? c.name;
}

/* ------------------------------------------------------------------ */
/* Clues                                                               */
/* ------------------------------------------------------------------ */

const APPROACHES: HitApproach[] = ["ambush", "drive_by", "car_bomb", "sitdown_betrayal"];

/** Which approach a mark's habits expose him to. */
function favoredApproach(mark: CrewMember, territory: Territory, rng: Rng): HitApproach {
  const weights: Record<HitApproach, number> = {
    ambush: 1,
    drive_by: 1,
    car_bomb: 1,
    sitdown_betrayal: 1,
    summons: 0,
  };
  if (mark.role === "boss" || mark.role === "underboss") {
    weights.car_bomb += 2; // convoys and routines
    weights.sitdown_betrayal += 1;
  }
  // A boss who has been on the road is a car-bomb mark.
  if (mark.role === "boss" && (mark.awayAt || (mark.lastSiteId && mark.lastSiteId !== territory.id))) {
    weights.car_bomb += 3;
  }
  if (mark.traits.includes("wheelman")) {
    weights.drive_by -= 0.8; // he outdrives you
    weights.ambush += 1.5; // catch him at the garage
    weights.car_bomb += 1;
  }
  if (mark.traits.includes("smooth_talker") || mark.skills.charm >= 50) {
    weights.sitdown_betrayal += 2;
  }
  if (mark.skills.smarts >= 55) weights.sitdown_betrayal -= 0.7;
  if (mark.traits.includes("ghost")) {
    weights.ambush -= 0.6;
    weights.car_bomb += 1;
  }
  if (mark.traits.includes("hothead")) weights.drive_by += 1.5; // stands on the corner
  if (territory.rackets.some((r) => r.type === "speakeasy" || r.type === "restaurant")) {
    weights.ambush += 1; // locks up late
    weights.sitdown_betrayal += 0.5;
  }
  if (territory.rackets.some((r) => r.type === "trucking" || r.type === "warehouse")) {
    weights.drive_by += 1; // out on the loading dock
  }

  const total = APPROACHES.reduce((s, a) => s + Math.max(0.1, weights[a]), 0);
  let roll = rng.next() * total;
  for (const a of APPROACHES) {
    roll -= Math.max(0.1, weights[a]);
    if (roll <= 0) return a;
  }
  return "ambush";
}

function routineText(mark: CrewMember, approach: HitApproach, territory: Territory, rng: Rng): string {
  const name = lastName(mark);
  const speak = territory.rackets.find((r) => r.type === "speakeasy" || r.type === "restaurant");
  const dock = territory.rackets.find((r) => r.type === "trucking" || r.type === "warehouse");
  const lines: Record<HitApproach, string[]> = {
    ambush: [
      speak
        ? `${name} locks up the ${RACKET_LABELS[speak.type].toLowerCase()} himself, last man out.`
        : `${name} eats alone at the same corner joint most nights.`,
      `${name} walks the two blocks home. No car, no company.`,
      `${name} takes a barber's chair every third morning, back to the door.`,
    ],
    drive_by: [
      dock
        ? `${name} stands on the loading dock at the ${RACKET_LABELS[dock.type].toLowerCase()} while the trucks run.`
        : `${name} holds court on the corner most afternoons, out in the open.`,
      `${name} takes his coffee at the sidewalk table. Same table.`,
    ],
    car_bomb: [
      `${name} drives the same ${rng.pick(["Packard", "Cadillac", "Buick", "Lincoln"])} every morning, parks it on the street.`,
      `${name} leaves the car with a kid who'd sell his mother for a sawbuck.`,
      `${name} runs a two-car routine but the second car is always late.`,
      ...(mark.role === "boss" && (mark.awayAt || mark.lastSiteId)
        ? [`${name}'s been on the road a lot lately. The car goes where he goes.`]
        : []),
    ],
    sitdown_betrayal: [
      `${name} takes any meeting that comes with a good bottle.`,
      `${name} likes to be seen making peace. He'll come to the table.`,
      `${name} has been asking around about a truce. He wants to talk.`,
    ],
    summons: [`${name} comes when he's called. He doesn't ask why.`],
  };
  return rng.pick(lines[approach]);
}

function profileText(mark: CrewMember): string {
  const name = lastName(mark);
  const bits: string[] = [];
  if (mark.skills.smarts >= 50) bits.push("sharp");
  else if (mark.skills.smarts <= 30) bits.push("slow");
  if (mark.skills.stealth >= 50) bits.push("hard to pin down");
  else if (mark.skills.stealth <= 30) bits.push("careless");
  if (mark.skills.muscle >= 50) bits.push("dangerous up close");
  if (mark.traits.includes("ghost")) bits.push("a ghost — never where you expect");
  if (mark.traits.includes("hothead")) bits.push("a hothead, easy to bait");
  if (mark.traits.includes("wheelman")) bits.push("drives like the devil");
  const desc = bits.length > 0 ? bits.join(", ") : "nothing special";
  return `${name}: ${desc}. ${mark.role === "boss" ? "Never travels light." : ""}`.trim();
}

function racketFlavor(territory: Territory): string {
  const r = territory.rackets[0];
  return r ? RACKET_LABELS[r.type].toLowerCase() : "block";
}

export interface ClueGenOptions {
  lookout: CrewMember;
  territoryId: string;
  targetFamily: FamilyName;
  /** Street tier actually brought home. */
  tier: CasingTier;
  /** Rival crew present when the report was filed. */
  present: CrewMember[];
  /** Turned lookout: one clue gets falsified. */
  poisoned?: boolean;
}

/** Roll the clue set for a report. Pure; caller writes them into intel. */
export function generateClues(state: GameState, rng: Rng, opts: ClueGenOptions): CasingClue[] {
  const territory = state.territories.find((t) => t.id === opts.territoryId);
  if (!territory) return [];
  const turn = state.turn;
  const mark = pickTopMark(opts.present);
  const garrison = rivalGarrisonCount(state, territory, opts.targetFamily);
  const clues: CasingClue[] = [];
  const base = {
    territoryId: territory.id,
    targetFamily: opts.targetFamily,
    turn,
    sourceLookoutId: opts.lookout.id,
  };
  const mk = (kind: ClueKind, extra: Partial<CasingClue>): CasingClue => ({
    id: `clue_${kind}_${territory.id}_${turn}_${rng.int(1000, 9999)}`,
    kind,
    expiresTurn: turn + CLUE_TTL[kind],
    text: "",
    ...base,
    ...extra,
  });

  const adjacentName = (): string | undefined => {
    const ids = territory.adjacentTerritories;
    if (ids.length === 0) return undefined;
    const id = rng.pick(ids);
    return state.territories.find((t) => t.id === id)?.name;
  };

  const addGetaway = () => {
    const via = adjacentName();
    clues.push(
      mk("getaway", {
        value: 1,
        text: via
          ? `Alley behind the ${racketFlavor(territory)} cuts straight through toward ${via}. Nobody watches it.`
          : `Service alley behind the ${racketFlavor(territory)} runs the whole block. Clean way out.`,
      }),
    );
  };

  // Tier 1: routine on the top mark (or a getaway if nobody's home).
  if (mark) {
    const approach = favoredApproach(mark, territory, rng);
    clues.push(
      mk("routine", {
        targetCrewId: mark.id,
        approach,
        text: routineText(mark, approach, territory, rng),
      }),
    );
  } else {
    addGetaway();
  }

  // Tier 2: profile + one of garrison window / getaway.
  if (opts.tier >= 2) {
    if (mark) {
      clues.push(
        mk("target_profile", {
          targetCrewId: mark.id,
          text: profileText(mark),
        }),
      );
    }
    const canWindow = garrison >= 2;
    if (canWindow && rng.chance(0.6)) {
      const windowTurn = turn + rng.int(1, 2);
      const value = Math.min(garrison - 1, rng.int(1, 2));
      const via = adjacentName();
      clues.push(
        mk("garrison_window", {
          value,
          windowTurn,
          expiresTurn: windowTurn + 1,
          text: `${value === 1 ? "One of the soldiers" : `${value} of the soldiers`} run${value === 1 ? "s" : ""} collections${via ? ` in ${via}` : ""} ${windowTurn === turn + 1 ? "tomorrow night" : "in two nights"}. Block's thin then.`,
        }),
      );
    } else if (!clues.some((c) => c.kind === "getaway")) {
      addGetaway();
    }
  }

  // Tier 3: cops + weak link.
  if (opts.tier >= 3) {
    const hot = (territory.heatLevel ?? 0) >= 3 || state.heat.level >= 50;
    if (hot && rng.chance(0.55)) {
      clues.push(
        mk("patrol", {
          text: `Precinct car rolls this block ${rng.pick(["twice a night", "on the hour", "every shift change"])}. Anything loud draws them fast.`,
        }),
      );
    } else {
      const buyable = rng.chance(0.5);
      clues.push(
        mk("cop_on_payroll", {
          copBuyable: buyable,
          text: buyable
            ? `Beat cop on the corner is on their payroll — but he'd take an envelope from anyone.`
            : `Beat cop on the corner is theirs, bought and paid. He'll look the other way for them, not for you.`,
        }),
      );
    }

    const weak = opts.present
      .filter((c) => c.id !== mark?.id || opts.present.length === 1)
      .filter((c) => c.loyalty <= WEAK_LINK_LOYALTY || c.traits.includes("rat_risk"))
      .sort((a, b) => a.loyalty - b.loyalty)[0];
    if (weak) {
      clues.push(
        mk("weak_link", {
          targetCrewId: weak.id,
          text: `${lastName(weak)} has been ${rng.pick(["complaining about his cut", "drinking alone and talking too much", "asking what other outfits pay"])}. He'd take a meeting.`,
        }),
      );
    }
  }

  // Tier 4: the rat in your own house.
  if (opts.tier >= 4 && state.playerFamily && opts.lookout.family === state.playerFamily) {
    const rat = state.crew
      .filter((c) => c.family === state.playerFamily && c.status === "active" && c.id !== opts.lookout.id)
      .filter((c) => c.traits.includes("rat_risk") || c.loyalty <= RAT_LOYALTY)
      .sort((a, b) => a.loyalty - b.loyalty)[0];
    if (rat) {
      clues.push(
        mk("rat", {
          ratCrewId: rat.id,
          text: `They knew your lookout was coming. Somebody in your outfit is talking — ${lastName(rat)}'s name came up.`,
        }),
      );
    }
  }

  if (opts.poisoned) poisonOne(clues, rng, garrison);

  return clues;
}

/** Falsify one clue in place. Prefers the ones that get people killed. */
function poisonOne(clues: CasingClue[], rng: Rng, garrison: number): void {
  const window = clues.find((c) => c.kind === "garrison_window");
  if (window) {
    window.value = Math.max(garrison, (window.value ?? 1) + 2); // "they'll all be gone"
    window.text = `Word is the whole crew clears out ${window.windowTurn && window.windowTurn > 0 ? "tomorrow night" : "soon"}. Block will be empty.`;
    window.poisoned = true;
    return;
  }
  const routine = clues.find((c) => c.kind === "routine");
  if (routine && routine.approach) {
    const others = APPROACHES.filter((a) => a !== routine.approach);
    routine.approach = rng.pick(others);
    routine.poisoned = true;
    return;
  }
  const first = clues[0];
  if (first) first.poisoned = true;
}

/* ------------------------------------------------------------------ */
/* Business intel                                                      */
/* ------------------------------------------------------------------ */

function tradeLevel(
  racket: Racket,
  manager: CrewMember | undefined,
  turn: number,
): TradeLevel {
  if (isRacketFrozen(racket, turn)) return "dead";
  if (RACKET_BASE_INCOME[racket.type] === 0) return "slow";
  if (!manager || manager.status !== "active") return "slow";
  return "busy";
}

function savingFor(
  state: GameState,
  territory: Territory,
  racket: Racket,
  family: FamilyName,
): BusinessIntel["savingFor"] {
  const cash = state.rivalTreasury?.[family] ?? 0;
  if (cash >= racket.upgradeCost) return "upgrade";
  const freeSlot = territory.rackets.length < territory.racketSlots;
  const cheapest = Math.min(...Object.values(RACKET_BUILD_COST));
  if (freeSlot && cash >= cheapest) return "new_racket";
  return undefined;
}

/** Snapshot every racket on the block at the given business tier. */
export function generateBusinessIntel(
  state: GameState,
  territory: Territory,
  targetFamily: FamilyName,
  tier: CasingTier,
): BusinessIntel[] {
  const turn = state.turn;
  const incomeBonus = getFamilyDef(targetFamily).bonuses.incomeBonus ?? 0;
  return territory.rackets.map((r) => {
    const manager = r.managerId ? state.crew.find((c) => c.id === r.managerId) : undefined;
    const intel: BusinessIntel = {
      racketId: r.id,
      territoryId: territory.id,
      turn,
      tier,
      type: r.type,
      level: r.level,
    };
    if (tier >= 2) {
      intel.managerId = r.managerId;
      intel.trade = tradeLevel(r, manager, turn);
    }
    if (tier >= 3) {
      intel.stock = r.stock;
      intel.heatGen = r.heatGen;
      intel.incomePerTurn = isRacketFrozen(r, turn) ? 0 : racketIncome(r, incomeBonus, manager, state.crew);
      if (r.frozenUntil && r.frozenUntil > turn) intel.frozenUntil = r.frozenUntil;
    }
    if (tier >= 4) {
      intel.launderStatus = isLegitBusiness(r.type) ? launderSiteStatus(r, turn) : "off";
      intel.routeIds = state.routes
        .filter(
          (rt) =>
            rt.family === targetFamily &&
            rt.status === "active" &&
            (rt.path.includes(territory.id) ||
              rt.sourceTerritoryId === territory.id ||
              rt.destTerritoryId === territory.id),
        )
        .map((rt) => rt.id);
      intel.savingFor = savingFor(state, territory, r, targetFamily);
    }
    return intel;
  });
}

/** One-line read of a racket for the report / planner. */
export function businessSummary(intel: BusinessIntel, turn: number): string {
  const label = `${RACKET_LABELS[intel.type]} Lv${intel.level}`;
  const parts: string[] = [];
  if (intel.trade) parts.push(intel.trade === "busy" ? "busy" : intel.trade === "slow" ? "slow" : "dead");
  if (intel.stock !== undefined && stockCapFor(intel) > 0) {
    parts.push(`${intel.stock} crates`);
  }
  if (intel.incomePerTurn !== undefined) parts.push(`~$${intel.incomePerTurn}/turn`);
  if (intel.frozenUntil && intel.frozenUntil > turn) parts.push("frozen by Treasury");
  if (intel.launderStatus === "ready") parts.push("washing money");
  if (intel.launderStatus === "setting_up") parts.push("setting up a wash");
  if (intel.routeIds && intel.routeIds.length > 0) parts.push(`${intel.routeIds.length} route(s) through`);
  if (intel.savingFor === "upgrade") parts.push("about to expand");
  if (intel.savingFor === "new_racket") parts.push("cash for a new racket");
  return parts.length > 0 ? `${label} — ${parts.join(", ")}` : label;
}

function stockCapFor(intel: BusinessIntel): number {
  const fake: Racket = {
    id: intel.racketId,
    territoryId: intel.territoryId,
    type: intel.type,
    level: intel.level,
    managerId: null,
    stock: 0,
    heatGen: 0,
    upgradeCost: 0,
  };
  return stockCap(fake);
}

/* ------------------------------------------------------------------ */
/* Lookups used by odds / planner                                      */
/* ------------------------------------------------------------------ */

/** Live (unexpired) clues for a district. */
export function cluesFor(
  state: Pick<GameState, "intel" | "turn">,
  territoryId: string,
): CasingClue[] {
  return (state.intel?.clues?.[territoryId] ?? []).filter((c) => c.expiresTurn > state.turn);
}

export function findClue(
  state: Pick<GameState, "intel" | "turn">,
  territoryId: string,
  kind: ClueKind,
  targetCrewId?: string,
): CasingClue | undefined {
  return cluesFor(state, territoryId).find(
    (c) => c.kind === kind && (targetCrewId === undefined || c.targetCrewId === targetCrewId),
  );
}

/** Garrison reduction from a live window clue on the given turn. */
export function garrisonWindowReduction(
  state: Pick<GameState, "intel" | "turn">,
  territoryId: string,
  opts?: { includePoisoned?: boolean },
): number {
  const clue = cluesFor(state, territoryId).find(
    (c) =>
      c.kind === "garrison_window" &&
      c.windowTurn === state.turn &&
      (opts?.includePoisoned !== false || !c.poisoned),
  );
  return clue?.value ?? 0;
}

/** A clue counts unless we're resolving for real and it was planted. */
export function clueHolds(clue: CasingClue | undefined, truth: boolean | undefined): clue is CasingClue {
  if (!clue) return false;
  return !truth || !clue.poisoned;
}

/** Latest business snapshots for a district. */
export function businessFor(
  state: Pick<GameState, "intel">,
  territoryId: string,
): BusinessIntel[] {
  return Object.values(state.intel?.business ?? {}).filter((b) => b.territoryId === territoryId);
}

/** Business snapshot ages out for stock/income after a couple of turns. */
export function isBusinessStale(intel: BusinessIntel, turn: number): boolean {
  return turn - intel.turn > 2;
}
