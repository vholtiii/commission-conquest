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
  /** Family holding him while status is "held". */
  heldBy?: FamilyName;
}

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
  /** Why the attacker ordered this (recorded at plan time; copied onto the Incident). */
  motive?: Motive;
  /** Player hit declared as the answer to an open case; judged justified / wrong target on resolve. */
  answersIncidentId?: string;
  /**
   * Contract-hit foundation: the family that paid for this hit when `motive` is
   * "contract". Not yet assigned by the AI; reserved for a later pass.
   */
  contractFor?: FamilyName;
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
}

/** Queued map cinematic played after a player hit resolves. */
export interface HitCinematic {
  operationId: string;
  originTerritoryId: string;
  targetTerritoryId: string;
  path: string[];
  approach: HitApproach;
  result: HitResult;
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

export type IntelSource = "surveillance" | "hit" | "bribe";

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
  reason: "casing" | "wrong_target";
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

export interface VictoryState {
  won: boolean;
  lost: boolean;
  reason?: string;
  commissionChairTurns: number;
}

export interface GameSettings {
  difficulty: "easy" | "normal" | "hard";
  aiAggression: number;
  seed: number;
  /** When true, skip the ~4s hit travel cinematic and show the result immediately. */
  skipCinematics?: boolean;
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
  };
  vendettas: FamilyName[];
  /** Rival scores to settle (drive AI retaliation targeting). */
  grudges: Grudge[];
  /** Hits/hijacks against the player awaiting attribution. */
  incidents: Incident[];
  /** Turn-start rumors (current turn's, plus recent history). */
  rumors: Rumor[];
  /** Districts taken this turn, per family. Self-resets when `turn` changes. */
  captureTally: CaptureTally;
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
  /** Player hit cinematics waiting to play (FIFO). */
  cinematicQueue: HitCinematic[];
  activePanel: PanelId;
  selectedCrewId: string | null;
  /** Rival crew highlighted on the map while planning a hit. */
  hitTargetPreviewId: string | null;
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
