/** Core game types for Commission Conquest overhaul */

export type FamilyName = "Moretti" | "Valenti" | "Ferraro" | "Salvati" | "Rinaldi";

export type CrewRole =
  | "associate"
  | "soldier"
  | "capo"
  | "hitman"
  | "underboss"
  | "consigliere"
  | "boss";

/** `held`: grabbed while casing and kept by a rival family for a few turns. */
export type CrewStatus = "active" | "wounded" | "jailed" | "dead" | "informant" | "held";

export type CrewTrait =
  | "marksman"
  | "wheelman"
  | "hothead"
  | "rat_risk"
  | "bookkeeper"
  | "made_man"
  | "ghost"
  | "enforcer"
  | "smooth_talker";

export type AssignmentType =
  | "idle"
  | "garrison"
  | "racket"
  | "delivery"
  | "operation"
  | "surveillance";

export type RacketType =
  | "still"
  | "brewery"
  | "warehouse"
  | "speakeasy"
  | "gambling"
  | "brothel"
  | "loan_shark"
  | "laundromat"
  | "deli"
  | "barber"
  | "restaurant"
  | "trucking"
  | "safehouse";

export type HitApproach = "ambush" | "drive_by" | "car_bomb" | "sitdown_betrayal";

export type HitRole =
  | "shooter"
  | "wheelman"
  | "lookout"
  | "bomb_maker"
  | "planter"
  | "negotiator"
  | "backup";

export type HitOutcome =
  | "clean_kill"
  | "messy_kill"
  | "botched_wounded"
  | "botched_arrested"
  | "botched_killed"
  | "target_escaped";

/** Which street wrinkle the cinematic should act out. */
export type HitComplication =
  | "patrol"
  | "rival_muscle"
  | "backup"
  | "rain"
  | "stall"
  | "blocked_lane"
  | "fruit_cart"
  | "escort"
  | "dud"
  | "wrong_car"
  | "cop_on_fender"
  | "pat_down"
  | "witness"
  | "kitchen_backup"
  | "toast"
  | "tipped"
  | "trap"
  | "mark_absent";

export type AiPersonality = "economic" | "expansionist" | "covert" | "smuggler" | "volatile";

export type RelationStatus = "war" | "hostile" | "cold" | "neutral" | "truce" | "allied";

export type PanelId =
  | "none"
  | "crew"
  | "rackets"
  | "operations"
  | "corruption"
  | "commission"
  | "log"
  | "district"
  | "hit_planner"
  | "crew_sheet"
  | "racket_build"
  | "capture"
  | "laundering"
  | "warehouse"
  | "event"
  | "cases"
  | "menu";

export interface CrewSkills {
  muscle: number;
  stealth: number;
  smarts: number;
  charm: number;
  driving: number;
}

export interface CrewAssignment {
  type: AssignmentType;
  territoryId?: string;
  racketId?: string;
  routeId?: string;
  operationId?: string;
}

export interface CrewMember {
  id: string;
  name: string;
  family: FamilyName;
  role: CrewRole;
  skills: CrewSkills;
  traits: CrewTrait[];
  loyalty: number;
  wanted: number;
  xp: number;
  level: number;
  status: CrewStatus;
  portraitSeed: number;
  assignment: CrewAssignment;
  hits: number;
  isPlayerBoss?: boolean;
  /** Turn this member last received their current role (for succession readiness). */
  roleSinceTurn?: number;
  /** While status is "held": turn he is released (exclusive). */
  heldUntilTurn?: number;
  /** While the boss is jailed: the turn the family passes if he is still inside (exclusive). */
  jailedUntilTurn?: number;
  /** Underboss running the family while the real boss is in jail. Role stays underboss. */
  actingBoss?: boolean;
  /** Alive behind bars for good. Counted as gone; no funeral to hold. */
  putAway?: boolean;
  /** Family holding him while status is "held". */
  heldBy?: FamilyName;
  /** Soldiers only: the capo whose crew he runs with. Undefined = freelance. */
  capoId?: string;
  /** Turn he joined his current crew (mentoring runs at half rate while settling). */
  crewSinceTurn?: number;
  /** Where he stood at the end of the previous turn (car bombs need him to move). */
  lastSiteId?: string;
  /**
   * A temporary trip that overrides his normal location until `untilTurn`
   * (exclusive): a sit-down or an AI boss's weekly visit.
   */
  awayAt?: { territoryId: string; untilTurn: number; reason: "sitdown" | "visit" };
}

/** A capo asking the boss to bring a man into his crew. */
export interface CrewRequest {
  id: string;
  turn: number;
  capoId: string;
  candidateId: string;
  /** The capo's line. */
  pitch: string;
  status: "pending" | "approved" | "rejected" | "expired";
  /** Turns the boss said "later"; the ask expires after one deferral. */
  deferred?: number;
}

/** Soldiers a capo can run before level 5, and after. */
export const CREW_SLOTS_BASE = 2;
export const CREW_SLOTS_VETERAN = 3;
export const CREW_VETERAN_LEVEL = 5;
/** Turns of half-rate mentoring after joining a crew. */
export const CREW_SETTLING_TURNS = 6;

export interface Racket {
  id: string;
  territoryId: string;
  type: RacketType;
  level: number;
  managerId: string | null;
  stock: number;
  heatGen: number;
  upgradeCost: number;
  /** Turn this racket was built (for map "NEW" feedback). */
  builtTurn?: number;
  /** Turn this racket was last upgraded (for map "UPGRADED" feedback). */
  upgradedTurn?: number;
  /** Frozen by Treasury audit until this turn (exclusive). */
  frozenUntil?: number;
  /** Accumulated over-wash scrutiny (decays when under cap). */
  scrutiny?: number;
  /**
   * Turn when this legit business becomes an active laundering site.
   * Undefined = not set up. Set to turn+1 on setup; ready once turn >= this.
   */
  launderReadyTurn?: number;
}

export interface DeliveryRoute {
  id: string;
  family: FamilyName;
  driverId: string;
  sourceTerritoryId: string;
  destTerritoryId: string;
  path: string[];
  cargo: number;
  status: "active" | "hijacked" | "seized" | "complete";
}

/** Incoming supplier whisky order. */
export interface PendingShipment {
  id: string;
  crates: number;
  destTerritoryId: string;
  arriveTurn: number;
  cost: number;
}

/** Per-turn liquor P&L summary (last closed turn). */
export interface LiquorLedger {
  produced: number;
  bought: number;
  sold: number;
  delivered: number;
  dumped: number;
  stolen: number;
  seized: number;
  /** Crates lost to warehouse pilferage (no/weak manager). */
  shrunk: number;
  cashIn: number;
  cashOut: number;
  heat: number;
}

export interface FamilyBonuses {
  combatBonus: number;
  incomeBonus: number;
  recruitmentDiscount: number;
  hitBonus?: number;
  heatReduction?: number;
}

export interface FamilyDef {
  name: FamilyName;
  boss: string;
  description: string;
  specialty: string;
  color: string;
  hex: string;
  personality: AiPersonality;
  bonuses: FamilyBonuses;
  startingTerritory: string;
}

export interface Territory {
  id: string;
  name: string;
  owner: FamilyName | null;
  borough: string;
  baseIncome: number;
  defenseBonus: number;
  isStrategic: boolean;
  strategicBonus?: {
    type: "income" | "combat" | "recruitment";
    value: number;
    description: string;
  };
  /** Map percent coords 0-100 for layout seed */
  x: number;
  y: number;
  /** Vacant ground: the city grid lays no buildings here, so it is always an empty lot. */
  emptyLot?: boolean;
  adjacentTerritories: string[];
  heatLevel: number;
  rackets: Racket[];
  garrisonIds: string[];
  leadershipVacuum: number;
  discovered: boolean;
  /** Building cells on the city grid that belong to this district. */
  buildingBlocks: number;
  /** Max rackets allowed (derived from buildingBlocks, typically 2–6). */
  racketSlots: number;
}

export interface BribeStatus {
  isActive: boolean;
  turnsRemaining: number;
  targetFamily?: FamilyName;
  targetTerritory?: string;
  cost: number;
  successRate: number;
}

export interface Operation {
  id: string;
  family: FamilyName;
  kind: "hit" | "surveillance";
  targetCrewId?: string;
  targetTerritoryId: string;
  /** District the hit team departs from (for map route + cinematic). */
  originTerritoryId?: string;
  targetFamily: FamilyName;
  approach?: HitApproach;
  /** Shooters (ambush/drive-by) or hidden backup (sit-down). */
  shooterIds: string[];
  wheelmanId?: string;
  lookoutId?: string;
  bombMakerId?: string;
  planterId?: string;
  negotiatorId?: string;
  surveilled: boolean;
  /** Target family got wind of the hit during the pending turn. */
  tippedOff?: boolean;
  /** Strike without knowing who is there — no targetCrewId. */
  blind?: boolean;
  pendingTurns: number;
  resolved: boolean;
  /** Turn the job resolved (exclusive of still-armed bombs). */
  resolvedTurn?: number;
  /** Why the attacker ordered this (recorded at plan time; copied onto the Incident). */
  motive?: Motive;
  /** Player hit declared as the answer to an open case; judged justified / wrong target on resolve. */
  answersIncidentId?: string;
  /**
   * Contract-hit foundation: the family that paid for this hit when `motive` is
   * "contract". Not yet assigned by the AI; reserved for a later pass.
   */
  contractFor?: FamilyName;
  /**
   * Car bomb on a boss: turns the package has sat armed waiting for the mark
   * to travel. The bomb goes off the first turn he changes sites.
   */
  armedTurns?: number;
  /**
   * "message": a hit meant to prove a point over a route dispute. Aimed at a
   * skilled non-boss (hitman, consigliere, senior capo). Costs less standing
   * than a plain hit, never starts a vendetta, and the shooter's family follows
   * it with a sit-down.
   */
  intent?: "message";
}

/** How long a planted car bomb waits for a boss to use his car. */
export const CAR_BOMB_ARMED_MAX_TURNS = 3;

/* ------------------------------------------------------------------ */
/* Supply routes and passage                                           */
/* ------------------------------------------------------------------ */

/** Price of crossing a rival family's turf with a truck. */
export interface PassageTerms {
  /** Dirty $ per crate crossing their districts, paid every run. */
  tollPerCrate: number;
  /** Share of each run's crates they skim off the truck (0–0.3). */
  cratesCut: number;
  /** One-time cash sweetener when the deal is struck. */
  gift: number;
  /** Turns the deal runs; null = open-ended until breach or war. */
  durationTurns: number | null;
}

/** A negotiated right of way through a rival family's districts. */
export interface PassageDeal {
  id: string;
  /** Family granting passage. */
  family: FamilyName;
  /** Family holding the right (the player for now). */
  holder: FamilyName;
  terms: PassageTerms;
  sinceTurn: number;
  /** Exclusive expiry turn; null = open-ended. */
  untilTurn: number | null;
  status: "active" | "expired" | "revoked" | "breached";
  /** Consecutive tolls the holder couldn't cover; two in a row is a breach. */
  missedTolls: number;
}

/** How a district on a route reads to the family running it. */
export type RouteHopKind = "own" | "unclaimed" | "deal" | "rival" | "hostile";

export interface RouteHop {
  territoryId: string;
  owner: FamilyName | null;
  kind: RouteHopKind;
  /** Best estimate of the per-hop hijack chance. */
  risk: number;
  /** Bounds when the block hasn't been cased (equal to `risk` when known). */
  riskMin: number;
  riskMax: number;
  /** Whether the estimate rests on live intel. */
  known: boolean;
}

export type RouteRiskLabel = "safe" | "toll" | "hot";

/**
 * Why a road is on offer. Each strategy picks the cheapest road under its own
 * idea of cost; roads that several strategies agree on carry all their labels.
 */
export type RouteStrategy =
  | "direct" // fewest hops, whatever the turf
  | "home_turf" // own / unclaimed blocks only
  | "toll_road" // own blocks plus families you hold a passage deal with
  | "cold_road" // lowest district heat along the way
  | "dodge" // goes around the family most likely to hit the truck
  | "detour"; // a road disjoint from Direct's middle hops

/** One way of getting crates from A to B. */
export interface RouteOption {
  id: string;
  path: string[];
  hops: RouteHop[];
  /** Every strategy that lands on this same road; the card title joins them. */
  strategies: RouteStrategy[];
  /** For "dodge": the family the road goes around. */
  dodges?: FamilyName;
  /** Combined run risk (best estimate) and bounds. */
  risk: number;
  riskMin: number;
  riskMax: number;
  /** Rival families whose turf the truck crosses. */
  families: FamilyName[];
  /** Of those, the ones with no active passage deal. */
  needsDeal: FamilyName[];
  label: RouteRiskLabel;
}

/** Roads on offer while the player is opening a route; the chosen one is drawn purple, the rest grey. */
export interface SupplyRoutePreview {
  options: { id: string; path: string[]; label: RouteRiskLabel; strategies: RouteStrategy[] }[];
  chosenId: string | null;
}

export type SupplyRunOutcome =
  | "delivered"
  | "hijacked"
  | "seized"
  | "stopped"
  | "no_stock"
  | "no_driver"
  | "waiting";

/** A standing order: N crates a week from one district to another. */
export interface SupplyRoute {
  id: string;
  family: FamilyName;
  sourceTerritoryId: string;
  destTerritoryId: string;
  path: string[];
  cratesPerTurn: number;
  driverId: string;
  /** Optional soldier riding shotgun: lower hijack odds, exposed to the shooting. */
  escortId?: string;
  status: "negotiating" | "active" | "suspended";
  suspendedReason?: string;
  sinceTurn: number;
  /** Families the player still needs a passage deal with before trucks roll. */
  awaitingFamilies: FamilyName[];
  /** Whether to roll without a deal (hot) if the table fails. */
  runHot: boolean;
  last?: { turn: number; outcome: SupplyRunOutcome; text: string; stoppedBy?: FamilyName };
}

/**
 * A sit-down between two families. Both bosses attend in person, so the
 * venue decides who travels — and whose car bomb goes off.
 * `venue` is always expressed from the player's point of view.
 */
export type SitdownVenue = "ours" | "theirs" | "neutral";

/**
 * What a table is about.
 *  - general    the old "ease off" talk, a single roll
 *  - passage    right of way for trucks (see PassageTerms)
 *  - truce      no hits, no captures between the two families for N weeks
 *  - territory  a district changes hands for cash
 *  - release    a man one family is holding goes home for a ransom
 *  - vendetta   the family drops its vendetta against the player for cash and standing
 *  - alliance   one family pays the other to hit a third family within N weeks
 *  - liquor     the rival buys crates for one of their speakeasies, delivered within N weeks
 *  - racket     a share of one district's weekly take, bought for N weeks
 */
export type SitdownAgenda =
  | "general"
  | "passage"
  | "truce"
  | "territory"
  | "release"
  | "vendetta"
  | "alliance"
  | "liquor"
  | "racket";

/**
 * Terms for an agenda table. Cash is signed from the player's side: positive
 * means the player pays the rival, negative means the rival pays the player.
 */
export interface AgendaTerms {
  cash: number;
  /** Standing the player throws in to sway them (spent when the deal strikes). */
  standing: number;
  /** Weeks the arrangement runs (truce) or the deadline to deliver (alliance, liquor). */
  weeks?: number;
  /** District changing hands (territory sale, or a district thrown in as a chip). */
  territoryId?: string;
  /** Man going home (release). */
  crewId?: string;
  /** Third family (alliance target). */
  targetFamily?: FamilyName;
  /** Crates owed (liquor). */
  crates?: number;
  /** Speakeasy district the crates go to (liquor). */
  destTerritoryId?: string;
  /** The player owes them one. Called in later. */
  favor?: boolean;
  /** Share of a district's weekly take (racket), 0.1–0.5. */
  share?: number;
  /** Who does the job (alliance): the family that makes the hit. */
  obligor?: FamilyName;
  /** This obligation was a favor called in — nothing is paid for it. */
  calledIn?: boolean;
}

export type DealKind = "truce" | "alliance" | "liquor" | "favor" | "cut";

/** A struck arrangement that lives past the table and can be honored or broken. */
export interface Deal {
  id: string;
  kind: DealKind;
  /** The two families bound; the player is always one of them. */
  a: FamilyName;
  b: FamilyName;
  terms: AgendaTerms;
  sinceTurn: number;
  /** Exclusive expiry; null = until called in. */
  untilTurn: number | null;
  status: "active" | "honored" | "expired" | "breached";
  breachedBy?: FamilyName;
  /** Who has something to do (deliver crates, make the hit, owe the favor). */
  obligor?: FamilyName;
}

export type DealOutcome = "honored" | "breached" | "expired" | "called_in";

/** A deal closing, waiting to be shown as a card. */
export interface DealSettlement {
  dealId: string;
  kind: DealKind;
  other: FamilyName;
  outcome: DealOutcome;
  terms: AgendaTerms;
  /** What actually moved, signed from the player's side (positive = he paid). */
  cash: number;
  /** Relation change with `other`. */
  relation: number;
  /** Standing change for the player (breaches he committed). */
  standing: number;
  /** Respect change, when keeping the deal was worth saying so. */
  respect?: number;
  breachedBy?: FamilyName;
  /** The obligation a called-in favor turned into, if any. */
  becameDealId?: string;
  text: string;
  turn: number;
}

export interface Sitdown {
  id: string;
  /** Turn it was proposed. */
  proposedTurn: number;
  /** Turn it is held (the next endTurn after scheduling). */
  heldTurn: number;
  proposer: FamilyName;
  other: FamilyName;
  venue: SitdownVenue;
  venueTerritoryId: string;
  /** "at_table": both bosses sat down; the player still has to answer terms. */
  status: "proposed" | "scheduled" | "at_table" | "held" | "declined" | "aborted";
  /** Rival's counter-offer awaiting the player's answer. */
  counterVenue?: SitdownVenue;
  /** Set when held: the table went well. */
  success?: boolean;
  /** Men the player brought (max 2). They travel when the boss does. */
  playerEntourageIds?: string[];
  /** Men the other family brought. */
  rivalEntourageIds?: string[];
  /** The player's consigliere rides along and reads the room. */
  bringConsigliere?: boolean;
  /** Third family whose block hosts a neutral meeting. */
  hostFamily?: FamilyName;
  /** Where each boss left from, captured before the end-of-turn site snapshot. */
  travelFrom?: Partial<Record<FamilyName, string>>;
  /** What the meeting is about. Absent = the usual "ease off" talk. */
  purpose?: SitdownAgenda;
  /**
   * Terms on the table for agenda meetings (everything but "general" and
   * "passage"). `ask` is the rival's current number; `rounds` counts the
   * player's counters so far; `opener` is who named the first number.
   */
  table?: {
    ask: AgendaTerms;
    rounds: number;
    opener: FamilyName;
    /** The player's opening terms, when he proposed with a number in hand. */
    playerOpening?: AgendaTerms;
    /** Set once the table settles: what was agreed, and what it changed. */
    struck?: AgendaTerms;
    lines?: string[];
    /** They left over a lowball, or after the last round. */
    walkedOut?: boolean;
    /** The subject was gone by the time the bosses sat. */
    moot?: boolean;
  };
  /** Passage negotiation state. */
  passage?: {
    /** Route the deal is for (informational). */
    routeId?: string;
    /** The rival's current ask. */
    ask: PassageTerms;
    /** Counters the player has already made at this table. */
    rounds: number;
    /** Set when the rival came asking after a message hit or a hot run. */
    demanded?: boolean;
  };
}

export interface HitCasualtyDetail {
  crewId: string;
  fate: "wounded" | "dead" | "jailed";
  cause: "botch" | "firefight";
}

export interface HitBeat {
  phase: "approach" | "complication" | "execution" | "getaway";
  text: string;
}

export interface HitResult {
  operationId: string;
  outcome: HitOutcome;
  beats: HitBeat[];
  heatGain: number;
  fearGain: number;
  /** All affected crew IDs (target + attackers); kept for compatibility. */
  casualties: string[];
  casualtyDetail: HitCasualtyDetail[];
  defenders: number;
  tippedOff: boolean;
  targetDead: boolean;
  headline: string;
  successChance: number;
  /** Rival crew IDs revealed by this hit. */
  revealedIds?: string[];
  /** True when the strike was ordered blind. */
  blind?: boolean;
  /** Reputation deltas shown on the result card. */
  respectDelta?: number;
  influenceDelta?: number;
  /** Verdict line when this hit answered an open case. */
  caseJudgment?: string;
  /** Street wrinkle the cinematic branches on. */
  complication?: HitComplication;
  /** The mark never arrived (tipped, moved, or an empty block). */
  markAbsent?: boolean;
  /** The target family was waiting. */
  trap?: boolean;
  /** Block the strike actually landed on (a boss bomb travels with him). */
  strikeTerritoryId?: string;
}

/** Queued map cinematic played after a hit resolves. */
export type HitPerspective = "ours" | "incoming" | "witnessed";

export interface HitCinematic {
  operationId: string;
  originTerritoryId: string;
  targetTerritoryId: string;
  path: string[];
  approach: HitApproach;
  result: HitResult;
  /**
   * "ours" is a hit we ordered; "incoming" is a rival hitting our people;
   * "witnessed" is rival-on-rival violence in a district we know — a short
   * reel of the shooters and the mark, no result card, no intel.
   */
  perspective: HitPerspective;
  attackerFamily: FamilyName;
  targetFamily: FamilyName;
  targetCrewId?: string;
  targetName: string;
}

export interface BuildFxState {
  territoryId: string;
  racketId?: string;
  nonce: number;
  kind: "build" | "upgrade";
  type: RacketType;
  level?: number;
}

export interface GameEventChoice {
  id: string;
  text: string;
  effects: Partial<{
    money: number;
    dirtyMoney: number;
    heat: number;
    respect: number;
    fear: number;
    loyalty: number;
    crates: number;
    /** Push every pending shipment arriveTurn by this many turns. */
    shipmentDelay: number;
    /** 0–1 fraction of in-flight shipment crates lost. */
    shipmentLoss: number;
    crewStatus: { crewId: string; status: CrewStatus };
    relationDelta: { family: FamilyName; delta: number };
  }>;
}

export interface GameEvent {
  id: string;
  templateId: string;
  title: string;
  description: string;
  choices: GameEventChoice[];
  isActive: boolean;
}

export interface TurnLogEntry {
  id: string;
  turn: number;
  category:
    | "hit"
    | "ai"
    | "economy"
    | "heat"
    | "event"
    | "combat"
    | "delivery"
    | "diplomacy"
    | "system";
  text: string;
  family?: FamilyName;
}

export interface DiplomacyState {
  /** Non-aggression pacts: rival -> turn the pact lapses (exclusive). */
  pacts: Partial<Record<FamilyName, number>>;
  /** Per-rival cooldown: rival -> first turn another action is allowed. */
  cooldowns: Partial<Record<FamilyName, number>>;
  /**
   * A host whose table was bloodied won't host the betrayer again.
   * Key `${host}|${guest}`, value exclusive expiry turn.
   */
  hostBans?: Record<string, number>;
}

/** Where the player is pointed after a sit-down result card. */
export type SitdownFollow =
  | "case_venue"
  | "plan_hit"
  | "open_liquor"
  | "open_commission"
  | "open_deals";

/** Shown after the table breaks up. */
export interface SitdownResult {
  sitdownId: string;
  family: FamilyName;
  venueTerritoryId: string;
  purpose?: SitdownAgenda;
  success: boolean;
  lines: string[];
  deltas: { relation: number; respect: number; fear?: number };
  struck?: PassageTerms;
  /** Agenda terms the table settled on. */
  struckTerms?: AgendaTerms;
  betrayal?: "ours" | "theirs";
  hostFee?: number;
  follow: SitdownFollow;
}

/** Drive to the venue, then the letterboxed table. */
export interface SitdownCinematic {
  sitdownId: string;
  family: FamilyName;
  venueTerritoryId: string;
  /** Null when that boss is hosting and stays put. */
  playerPath: string[] | null;
  rivalPath: string[] | null;
  purpose?: SitdownAgenda;
  outcome: "handshake" | "walk" | "betrayed" | "trap" | "aborted";
  /** Filled for general meetings up front; passage fills it when terms are settled. */
  result?: SitdownResult;
}

export interface RelationsMatrix {
  /** Key: `${a}|${b}` sorted alphabetically; value -100..100 */
  scores: Record<string, number>;
}

export interface Reputation {
  respect: number;
  fear: number;
  loyalty: number;
  streetInfluence: number;
  publicPerception: number;
}

export type IntelSource = "surveillance" | "hit" | "bribe" | "sighting";

export interface IntelEntry {
  territoryId: string;
  turn: number;
  source: IntelSource;
}

export type LookoutOutcome = "clean" | "spotted" | "spotted_wounded";

/* ------------------------------------------------------------------ */
/* Casing                                                              */
/* ------------------------------------------------------------------ */

/** Depth of a casing report, set by the lookout's smarts/stealth (+traits). */
export type CasingTier = 1 | 2 | 3 | 4;

/**
 * How badly the casing went.
 * clean → noticed (district alerted) → made (lookout burned, grudge) →
 * grabbed (wounded / held / killed) → turned (poisoned report; reports as "clean").
 */
export type CasingRung = "clean" | "noticed" | "made" | "grabbed" | "turned";

export type ClueKind =
  | "routine"
  | "target_profile"
  | "garrison_window"
  | "getaway"
  | "cop_on_payroll"
  | "patrol"
  | "weak_link"
  | "rat";

export interface CasingClue {
  id: string;
  kind: ClueKind;
  territoryId: string;
  targetFamily: FamilyName;
  /** Rival mark this clue is about (routine, target_profile, weak_link). */
  targetCrewId?: string;
  /** routine: the approach it favours. */
  approach?: HitApproach;
  /** garrison_window: defenders removed; getaway: hops saved. */
  value?: number;
  /** garrison_window: the turn the garrison thins. */
  windowTurn?: number;
  /** rat: the player crew member leaking. */
  ratCrewId?: string;
  /** cop_on_payroll: true when he would take an envelope from you too. */
  copBuyable?: boolean;
  turn: number;
  /** Exclusive expiry turn. */
  expiresTurn: number;
  text: string;
  sourceLookoutId?: string;
  /** Planted by a turned lookout. Hidden from UI; resolves against the player. */
  poisoned?: boolean;
}

export type TradeLevel = "busy" | "slow" | "dead";
export type LaunderSiteStatus = "off" | "setting_up" | "ready";

/** What a skilled lookout learns about a rival racket. Fields fill in by tier. */
export interface BusinessIntel {
  racketId: string;
  territoryId: string;
  turn: number;
  tier: CasingTier;
  type: RacketType;
  level: number;
  /** Tier 2+ */
  managerId?: string | null;
  trade?: TradeLevel;
  /** Tier 3+ */
  stock?: number;
  heatGen?: number;
  incomePerTurn?: number;
  frozenUntil?: number;
  /** Tier 4 */
  launderStatus?: LaunderSiteStatus;
  routeIds?: string[];
  savingFor?: "upgrade" | "new_racket";
}

export interface LookoutRivalOp {
  operationId: string;
  approach?: HitApproach;
  targetTerritoryId: string;
  targetFamily: FamilyName;
  pendingTurns: number;
  aimedAtPlayer: boolean;
}

export interface LookoutReport {
  id: string;
  operationId: string;
  turn: number;
  territoryId: string;
  targetFamily: FamilyName;
  lookoutId?: string;
  outcome: LookoutOutcome;
  relationDelta: number;
  spottedIds: string[];
  newIds: string[];
  garrison: number;
  defenseBonus: number;
  rackets: { type: RacketType; level: number }[];
  rivalOps: LookoutRivalOp[];
  oddsSample?: { targetCrewId: string; before: number; after: number };
  tipRiskAfter?: number;
  /** True when generated by a Surveil-first hit finishing its casing turn. */
  forHit?: boolean;
  /** Casing depth reached (absent on legacy reports). */
  tier?: CasingTier;
  /** Detection rung. "turned" is never reported; it shows as "clean". */
  rung?: CasingRung;
  clues?: CasingClue[];
  business?: BusinessIntel[];
  /** Human-readable fallout lines ("Vitale changed his routine", "Held 2 turns"). */
  consequences?: string[];
  /** Evidence gathered for open cases while casing this district. */
  incidentLeads?: Evidence[];
  /** Cop trouble while loitering on a hot block. */
  copTrouble?: "wanted" | "arrested";
}

export interface BurnedLookout {
  family: FamilyName;
  /** Exclusive expiry turn. */
  expiresTurn: number;
}

export interface IntelState {
  /** Per-crew sightings; expires when the crew moves or dies. */
  known: Record<string, IntelEntry>;
  /** Territory IDs revealed until this turn (exclusive). */
  districtReveal: Record<string, number>;
  /** Families fully revealed until this turn (exclusive). */
  familyReveal: Partial<Record<FamilyName, number>>;
  /** Latest lookout report per territory (persisted; UI marks stale). */
  reports: Record<string, LookoutReport>;
  /** Live casing clues by territory ID. */
  clues: Record<string, CasingClue[]>;
  /** Latest business snapshot by racket ID. */
  business: Record<string, BusinessIntel>;
  /** Districts on alert after a spotted lookout: territoryId → expiry turn (exclusive). */
  alerted: Record<string, number>;
  /** Lookouts whose face a family knows: lookoutId → family + expiry. */
  burned: Record<string, BurnedLookout>;
}

/* ------------------------------------------------------------------ */
/* Grudges, incidents, rumors                                          */
/* ------------------------------------------------------------------ */

/** A rival family's score to settle; steers rival AI hit targeting. */
export interface Grudge {
  id: string;
  /** The offended family. */
  family: FamilyName;
  /** Who they hold it against. */
  against: FamilyName;
  /** Specific man they want (e.g. the lookout they made). */
  crewId?: string;
  territoryId: string;
  /** "passage": trucks through their turf without a deal, a broken deal, or a hijack. */
  reason: "casing" | "wrong_target" | "passage";
  turn: number;
  /** Exclusive expiry turn. */
  expiresTurn: number;
}

export type Motive =
  | "vendetta"
  | "territory"
  | "retaliation_casing"
  | "route_dispute"
  | "contract"
  | "power_grab"
  | "opportunist";

export type IncidentKind = "hit" | "hijack";

export type EvidenceSource =
  | "scene"
  | "casing"
  | "cops"
  | "chief"
  | "sitdown"
  | "intel"
  | "capture"
  | "rumor"
  | "pattern";

export interface Evidence {
  id: string;
  turn: number;
  source: EvidenceSource;
  text: string;
  /** Confidence shifts per family (may be negative to clear someone). */
  shifts: Partial<Record<FamilyName, number>>;
  /** Sit-down admissions may name who paid (contract foundation). */
  revealsHiredBy?: boolean;
  /** Set on shifts that should fade (false rumors); exclusive expiry turn. */
  decaysTurn?: number;
}

/** A hit or hijack against the player awaiting attribution. */
export interface Incident {
  id: string;
  turn: number;
  kind: IncidentKind;
  territoryId: string;
  victimCrewId?: string;
  routeId?: string;
  approach?: HitApproach;
  outcome?: HitOutcome;
  /** Hidden from UI. */
  actualFamily: FamilyName;
  /** Hidden from UI. */
  actualMotive: Motive;
  /** Hidden from UI. Contract foundation: the family behind the shooters. */
  hiredBy?: FamilyName;
  /** Visible 0..1 confidence per family. */
  suspects: Partial<Record<FamilyName, number>>;
  motiveKnown: boolean;
  /** Visible once revealed through sit-down or Tier 4 casing. */
  knownMotive?: Motive;
  /** Visible once revealed (contract foundation). */
  knownHiredBy?: FamilyName;
  evidence: Evidence[];
  /** One family at or above the solve threshold. */
  solved: boolean;
  /** Turn the trail goes cold (exclusive). */
  coldTurn: number;
  /** Set when the player retaliated; closes the case. */
  answeredTurn?: number;
  answeredFamily?: FamilyName;
}

export type RumorFidelity = "vague" | "where" | "who" | "how" | "from_whom";

/** Word on the street at the start of a turn. */
export interface Rumor {
  id: string;
  turn: number;
  kind: "pending_hit" | "past_incident";
  fidelity: RumorFidelity;
  /** Hidden from UI: the pending op this rumor is about (pending_hit). */
  operationId?: string;
  incidentId?: string;
  territoryId?: string;
  targetCrewId?: string;
  approach?: HitApproach;
  family?: FamilyName;
  text: string;
  /** Hidden from UI: nothing behind it. */
  false: boolean;
  dismissed?: boolean;
}

export interface HeatState {
  level: number;
  sources: string[];
  consequences: string[];
}

export type GameLength = "short" | "medium" | "long";

export interface VictoryState {
  won: boolean;
  lost: boolean;
  reason?: string;
  /** Turn the summit is held. Set once when the game starts. */
  finalTurn: number;
  /** Consecutive turns the player has held a sudden-death influence lead. */
  influenceLeadTurns: number;
  /** Consecutive turns the player has held a sudden-death wealth lead. */
  wealthLeadTurns: number;
  /** Consecutive turns both cash pools have been negative. */
  bankruptTurns: number;
}

export interface GameSettings {
  difficulty: "easy" | "normal" | "hard";
  /** Short 30, medium 50, long 80. Copied onto victory.finalTurn at start. */
  gameLength?: GameLength;
  aiAggression: number;
  seed: number;
  /** When true, skip the hit cinematic and show the result immediately. */
  skipCinematics?: boolean;
  /** Rival-on-rival hits in discovered districts: a brief reel, or nothing. Defaults to "brief". */
  rivalCinematics?: "brief" | "off";
  /** Sound-effects loudness, 0 (off) to 1. Defaults to 0.7. */
  sfxVolume?: number;
}

/** How many districts each family has grabbed on a given turn. */
export interface CaptureTally {
  turn: number;
  byFamily: Partial<Record<FamilyName, number>>;
}

/** Base number of districts a family can take per turn, and the hard ceiling. */
export const CAPTURE_LIMIT_BASE = 1;
export const CAPTURE_LIMIT_MAX = 2;

export interface GameState {
  version: number;
  seed: number;
  settings: GameSettings;
  playerFamily: FamilyName | null;
  turn: number;
  date: { year: number; month: number; day: number };
  money: number;
  dirtyMoney: number;
  lastNetIncome: number;
  influence: number;
  /** Standing orders: racketId -> dirty $ to wash per turn. */
  launderPlan: Record<string, number>;
  /** One-time nudge when sitting on dirty cash with nothing routed. */
  launderNudgeShown: boolean;
  /** Rival AI cash pools (player uses money/dirtyMoney). */
  rivalTreasury: Partial<Record<FamilyName, number>>;
  territories: Territory[];
  crew: CrewMember[];
  recruitmentPool: CrewMember[];
  routes: DeliveryRoute[];
  operations: Operation[];
  events: GameEvent[];
  activeEvent: GameEvent | null;
  turnLog: TurnLogEntry[];
  relations: RelationsMatrix;
  /** Sit-downs, tribute, and non-aggression pacts. */
  diplomacy: DiplomacyState;
  reputation: Reputation;
  intel: IntelState;
  heat: HeatState;
  bribes: {
    cops: BribeStatus;
    captains: BribeStatus;
    chiefs: BribeStatus;
    mayor: BribeStatus;
    judge: BribeStatus;
  };
  /** Rival standing, spent on the same diplomacy the player pays influence for. */
  rivalInfluence: Partial<Record<FamilyName, number>>;
  vendettas: FamilyName[];
  /** Rival scores to settle (drive AI retaliation targeting). */
  grudges: Grudge[];
  /** Hits/hijacks against the player awaiting attribution. */
  incidents: Incident[];
  /** Turn-start rumors (current turn's, plus recent history). */
  rumors: Rumor[];
  /** Districts taken this turn, per family. Self-resets when `turn` changes. */
  captureTally: CaptureTally;
  /** Capos asking to bring men into their crews (pending first, then history). */
  crewRequests: CrewRequest[];
  /** Sit-downs both bosses must travel to (scheduled, then held or aborted). */
  sitdowns: Sitdown[];
  /** Result cards waiting after a table breaks up. */
  pendingSitdownResults: SitdownResult[];
  /** Drives to the table, played after hit cinematics. */
  sitdownCinematicQueue: SitdownCinematic[];
  /** drive → table (panel) → exit. Null when nothing is playing. */
  sitdownPhase: "drive" | "table" | "exit" | null;
  /** Arrangements struck at the table: truces, jobs owed, favors. */
  deals: Deal[];
  /** Deals that closed this week, waiting for their card (FIFO). */
  pendingDealSettlements: DealSettlement[];
  /** Standing liquor orders between the player's districts. */
  supplyRoutes: SupplyRoute[];
  /** Rights of way the player holds through rival turf (active, then history). */
  passageDeals: PassageDeal[];
  /**
   * Leverage after a message hit: family → exclusive expiry turn. While it
   * holds, that family's passage asks are cheaper and their stops on the
   * player's trucks are rarer.
   */
  passageLeverage: Partial<Record<FamilyName, number>>;
  /** Last turn each rival sent a message (cooldown). */
  messageHitTurns: Partial<Record<FamilyName, number>>;
  victory: VictoryState;
  liquorStock: number;
  /** Supplier orders awaiting arrival. */
  pendingShipments: PendingShipment[];
  /** Last turn's liquor P&L (null before first liquor turn). */
  liquorLedger: LiquorLedger | null;
  selectedTerritoryId: string | null;
  flyToTerritoryId: string | null;
  /** World point and camera distance for a roster zoom. Null keeps the wider district framing. */
  flyToFocus: { x: number; z: number; distance: number } | null;
  /** Increments on each fly request so camera re-triggers for the same district. */
  flyToNonce: number;
  hitFxTerritoryId: string | null;
  /** Brief FX when a racket is built or upgraded. */
  buildFx: BuildFxState | null;
  /** Hit cinematics waiting to play (FIFO): ours, then incoming. */
  cinematicQueue: HitCinematic[];
  /** Rival hits on the player, filled by endTurn and consumed by nextTurn. */
  incomingHitReel: HitCinematic[];
  /** The cinematic whose result card is up, so the card knows whose hit it was. */
  pendingHitCinematic: HitCinematic | null;
  activePanel: PanelId;
  selectedCrewId: string | null;
  /** Rival crew highlighted on the map while planning a hit. */
  hitTargetPreviewId: string | null;
  /** Supply route drawn on the map after clicking it in the Warehouse panel. */
  supplyRouteFocusId: string | null;
  /** Candidate roads drawn on the map while a new supply route is being planned. */
  supplyRoutePreview: SupplyRoutePreview | null;
  /** Where each boss has been holding court, and since when (`bossPresence.ts`). */
  bossStay?: Partial<Record<FamilyName, { territoryId: string; since: number }>>;
  /** Last week the player's boss was seen arriving on each block (`standing.ts`). */
  streetSeen?: Record<string, number>;
  /** Why the camera landed where it did after selecting a crew member. */
  focusReason: string | null;
  pendingHitResult: HitResult | null;
  /** Lookout report cards waiting to be dismissed (FIFO, player only). */
  pendingReports: LookoutReport[];
  started: boolean;
}

export const FAMILY_HEX: Record<FamilyName, string> = {
  Moretti: "#9B1B2E", // crimson
  Valenti: "#D4A017", // gold
  Ferraro: "#1F6B4A", // emerald
  Salvati: "#2E6EB5", // blue
  Rinaldi: "#6E3CB5", // violet
};

/** Status overlays — deliberately outside the family palette. */
export const MAP_STATUS = {
  /** Confirmed pending hit target (reticle + route). */
  hitPending: "#FF2D95",
  /** Hit planner preview / aiming at a district. */
  hitPreview: "#FF8AC8",
  /** Vendetta-marked rival turf (corner brackets). Cyan: no family uses it. */
  vendetta: "#3FE0D0",
  /** Unclaimed / neutral. */
  neutral: "#7a7f87",
  /** Supply route the player clicked, or the road chosen for a new one (dotted). */
  supplyRoute: "#B266FF",
  /** Other roads on offer for a new supply route (dotted). */
  supplyOption: "#8a8f98",
} as const;

export const RACKET_LABELS: Record<RacketType, string> = {
  still: "Backroom Still",
  brewery: "Brewery",
  warehouse: "Warehouse",
  speakeasy: "Speakeasy",
  gambling: "Gambling Den",
  brothel: "Brothel",
  loan_shark: "Loan Sharking",
  laundromat: "Laundromat",
  deli: "Corner Deli",
  barber: "Barber Shop",
  restaurant: "Restaurant",
  trucking: "Trucking Co.",
  safehouse: "Safehouse",
};

export const APPROACH_LABELS: Record<HitApproach, string> = {
  ambush: "Ambush",
  drive_by: "Drive-by",
  car_bomb: "Car Bomb",
  sitdown_betrayal: "Sit-down Betrayal",
};

export const MOTIVE_LABELS: Record<Motive, string> = {
  vendetta: "Vendetta",
  territory: "Territory",
  retaliation_casing: "Payback for casing",
  route_dispute: "Route dispute",
  contract: "Contract",
  power_grab: "Power grab",
  opportunist: "Opportunist",
};

export const CLUE_LABELS: Record<ClueKind, string> = {
  routine: "Routine",
  target_profile: "Profile",
  garrison_window: "Garrison window",
  getaway: "Getaway",
  cop_on_payroll: "Cop on the corner",
  patrol: "Patrol pattern",
  weak_link: "Weak link",
  rat: "Rat",
};

export const CASING_TIER_LABELS: Record<CasingTier, string> = {
  1: "Eyes",
  2: "Ears",
  3: "Nose",
  4: "Inside man",
};

export const CASING_RUNG_LABELS: Record<CasingRung, string> = {
  clean: "Clean",
  noticed: "Noticed",
  made: "Made",
  grabbed: "Grabbed",
  // Never shown; a turned lookout reports "clean".
  turned: "Clean",
};

/** Confidence at which an open case counts as solved. */
export const CASE_SOLVED_THRESHOLD = 0.8;
/** Below this, retaliating against a family is "reckless". */
export const CASE_THIN_THRESHOLD = 0.5;
