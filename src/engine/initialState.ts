import type {
  FamilyName,
  GameSettings,
  GameState,
  Territory,
  Racket,
} from "@/types/game";
import { FAMILIES, getFamilyDef } from "@/data/families";
import territoriesRaw from "@/data/territories.json";
import { createRng } from "./rng";
import {
  createCrewMember,
  generateRecruitmentPool,
  assignCrew,
  stampMade,
} from "./crew";
import { recruitTier } from "./recruiting";
import { initialRelations } from "./relations";
import { emptyDiplomacy } from "./diplomacy";
import { emptyIntel } from "./intel";
import {
  createRacket,
  mapBusinessTypeToRacket,
  MAX_RACKETS_PER_DISTRICT,
  launderCap,
} from "./economy";
import { computeTerritorySlots, maxRacketsFor, allowedRacketTypes } from "./territoryValue";
import { nextRacketSiteIndex } from "./cityLayout";
import { emptyVictory, finalTurnFor } from "./victory";

interface TerritoryRaw {
  id: string;
  name: string;
  owner: FamilyName | null;
  baseIncome: number;
  defenseBonus: number;
  isStrategic: boolean;
  x: number;
  y: number;
  adjacentTerritories: string[];
  businessType: string | null;
  strategicBonus?: Territory["strategicBonus"];
  emptyLot?: boolean;
}

const BOROUGH_MAP: Record<string, string> = {
  manhattan: "Manhattan",
  little_italy: "Manhattan",
  chinatown: "Manhattan",
  east_village: "Manhattan",
  soho: "Manhattan",
  tribeca: "Manhattan",
  west_village: "Manhattan",
  financial_district: "Manhattan",
  battery_park: "Manhattan",
  chelsea: "Manhattan",
  greenwich_village: "Manhattan",
  hells_kitchen: "Manhattan",
  alphabet_city: "Manhattan",
  lower_east_side: "Manhattan",
  brooklyn: "Brooklyn",
  williamsburg: "Brooklyn",
  downtown_brooklyn: "Brooklyn",
  bushwick: "Brooklyn",
  prospect_heights: "Brooklyn",
  crown_heights: "Brooklyn",
  park_slope: "Brooklyn",
  flatbush: "Brooklyn",
  bay_ridge: "Brooklyn",
  coney_island: "Brooklyn",
  queens: "Queens",
  astoria: "Queens",
  long_island_city: "Queens",
  woodside: "Queens",
  flushing: "Queens",
  corona: "Queens",
  jamaica: "Queens",
  elmhurst: "Queens",
  st_albans: "Queens",
  richmond_hill: "Queens",
  ozone_park: "Queens",
  howard_beach: "Queens",
  jfk_airport: "Queens",
  bronx: "Bronx",
  south_bronx: "Bronx",
  fordham: "Bronx",
  hunts_point: "Bronx",
  mott_haven: "Bronx",
  port_morris: "Bronx",
  yankee_stadium: "Bronx",
  concourse: "Bronx",
  highbridge: "Bronx",
  tremont: "Bronx",
  washington_heights: "Bronx",
  inwood: "Bronx",
  staten: "Staten Island",
  st_george: "Staten Island",
  tottenville: "Staten Island",
  newark: "New Jersey",
  jersey_city: "New Jersey",
  union_city: "New Jersey",
  hoboken: "New Jersey",
  yonkers: "Westchester",
};

function inferBorough(id: string): string {
  return BOROUGH_MAP[id] ?? "New York";
}

function loadTerritories(rng: ReturnType<typeof createRng>): Territory[] {
  return (territoriesRaw as TerritoryRaw[]).map((raw) => {
    const rackets: Racket[] = [];
    const racketType = mapBusinessTypeToRacket(raw.businessType);
    if (racketType && raw.owner) {
      rackets.push(
        createRacket(
          `racket_${raw.id}_0`,
          raw.id,
          racketType,
          raw.businessType === "mixed" ? 2 : 1,
          0,
          0,
        ),
      );
    }

    return {
      id: raw.id,
      name: raw.name,
      owner: raw.owner,
      borough: inferBorough(raw.id),
      baseIncome: raw.baseIncome,
      defenseBonus: raw.defenseBonus,
      isStrategic: raw.isStrategic,
      strategicBonus: raw.strategicBonus,
      x: raw.x,
      y: raw.y,
      emptyLot: raw.emptyLot,
      adjacentTerritories: raw.adjacentTerritories,
      heatLevel: raw.owner ? rng.int(1, 4) : 0,
      rackets,
      garrisonIds: [],
      leadershipVacuum: raw.owner ? 0 : rng.int(0, 2),
      discovered: false,
      buildingBlocks: 0,
      racketSlots: MAX_RACKETS_PER_DISTRICT,
    };
  });
}

function createFamilyRoster(
  rng: ReturnType<typeof createRng>,
  family: FamilyName,
): ReturnType<typeof createCrewMember>[] {
  const def = getFamilyDef(family);
  const boss = createCrewMember(rng, family, "boss", {
    name: def.boss,
    id: `boss_${family}`,
  });
  const underboss = createCrewMember(rng, family, "underboss", {
    id: `underboss_${family}`,
  });
  // Seed succession readiness: already held the seat long enough
  underboss.roleSinceTurn = -10;
  underboss.level = Math.max(underboss.level, 5);
  underboss.loyalty = Math.max(underboss.loyalty, 65);

  const consigliere = createCrewMember(rng, family, "consigliere", {
    id: `consigliere_${family}`,
  });
  const capo = createCrewMember(rng, family, "capo", {
    id: `capo_${family}_0`,
  });
  const soldiers = Array.from({ length: 3 }, (_, i) =>
    createCrewMember(rng, family, "soldier", {
      id: `soldier_${family}_${i}`,
    }),
  );
  const hitman = createCrewMember(rng, family, "hitman", {
    id: `hitman_${family}_0`,
  });

  return [boss, underboss, consigliere, capo, ...soldiers, hitman].map(stampMade);
}

function garrisonFamilyCrew(
  territories: Territory[],
  crew: ReturnType<typeof createCrewMember>[],
  family: FamilyName,
): { territories: Territory[]; crew: ReturnType<typeof createCrewMember>[] } {
  const owned = territories.filter((t) => t.owner === family);
  let updatedCrew = [...crew];
  const updatedTerritories = territories.map((t) => ({ ...t }));

  const familyCrew = updatedCrew.filter((c) => c.family === family && c.role !== "boss");
  owned.forEach((terr, idx) => {
    const garrison = familyCrew.slice(idx * 2, idx * 2 + 2);
    const tIdx = updatedTerritories.findIndex((x) => x.id === terr.id);
    if (tIdx >= 0) {
      updatedTerritories[tIdx]!.garrisonIds = garrison.map((g) => g.id);
    }
    garrison.forEach((g) => {
      updatedCrew = assignCrew(updatedCrew, g.id, {
        type: "garrison",
        territoryId: terr.id,
      });
    });
  });

  return { territories: updatedTerritories, crew: updatedCrew };
}

const DEFAULT_SETTINGS: GameSettings = {
  difficulty: "normal",
  gameLength: "medium",
  aiAggression: 1,
  seed: 42,
  skipCinematics: false,
  rivalCinematics: "brief",
  sfxVolume: 0.7,
};

/**
 * How busy each rival is. `runAiTurn` attempts `floor(aggression × 2)` actions
 * (at least one) and fires each with chance `0.5 + aggression × 0.15`.
 * Below 1.0 every personality still gets a single action, so the steps sit
 * where the count actually changes.
 */
export const DIFFICULTY_AGGRESSION: Record<GameSettings["difficulty"], number> = {
  easy: 0.45,
  normal: 1,
  hard: 1.5,
};

export function aggressionForDifficulty(difficulty: GameSettings["difficulty"]): number {
  return DIFFICULTY_AGGRESSION[difficulty];
}

export function buildInitialState(
  seed = DEFAULT_SETTINGS.seed,
  settings: Partial<GameSettings> = {},
): GameState {
  const difficulty = settings.difficulty ?? DEFAULT_SETTINGS.difficulty;
  const mergedSettings: GameSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    seed,
    difficulty,
    aiAggression: aggressionForDifficulty(difficulty),
  };
  const rng = createRng(seed);

  let territories = computeTerritorySlots(loadTerritories(rng), seed);
  let crew = FAMILIES.flatMap((f) => createFamilyRoster(rng, f.name));

  for (const family of FAMILIES) {
    const result = garrisonFamilyCrew(territories, crew, family.name);
    territories = result.territories;
    crew = result.crew;
  }

  return {
    version: 5,
    seed,
    settings: mergedSettings,
    playerFamily: null,
    turn: 1,
    date: { year: 1925, month: 1, day: 1 },
    money: 5000,
    dirtyMoney: 2000,
    lastNetIncome: 0,
    influence: 100,
    territories,
    crew,
    recruitmentPool: [],
    routes: [],
    operations: [],
    events: [],
    activeEvent: null,
    turnLog: [
      {
        id: "log_start",
        turn: 1,
        category: "system",
        text: "Commission Conquest — choose your family to begin.",
      },
    ],
    relations: initialRelations(seed),
    diplomacy: emptyDiplomacy(),
    reputation: {
      respect: 10,
      fear: 5,
      loyalty: 50,
      streetInfluence: 10,
      publicPerception: 50,
    },
    heat: { level: 5, sources: [], consequences: [] },
    bribes: {
      cops: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
      captains: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
      chiefs: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
      mayor: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
      judge: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
    },
    rivalInfluence: {},
    vendettas: [],
    grudges: [],
    captureTally: { turn: 1, byFamily: {} },
    crewRequests: [],
    defunctFamilies: [],
    incidents: [],
    rumors: [],
    sitdowns: [],
    pendingSitdownResults: [],
    sitdownCinematicQueue: [],
    sitdownPhase: null,
    deals: [],
    pendingDealSettlements: [],
    supplyRoutes: [],
    passageDeals: [],
    passageLeverage: {},
    messageHitTurns: {},
    commissionCall: null,
    familyDinner: null,
    mattresses: null,
    mattressReadyUntil: 0,
    mourningUntil: 0,
    ratAffair: null,
    making: null,
    commissionHistory: [],
    pendingRulings: [],
    victory: emptyVictory(finalTurnFor(mergedSettings.gameLength)),
    liquorStock: 20,
    pendingShipments: [],
    liquorLedger: null,
    launderPlan: {},
    launderNudgeShown: false,
    lawyerReadyTurn: 0,
    streetLawyerUntil: 0,
    streetLawyerBailUsed: false,
    selectedTerritoryId: null,
    flyToTerritoryId: null,
    flyToFocus: null,
    flyToNonce: 0,
    hitFxTerritoryId: null,
    buildFx: null,
    cinematicQueue: [],
    incomingHitReel: [],
    pendingHitCinematic: null,
    activePanel: "none",
    selectedCrewId: null,
    hitTargetPreviewId: null,
    supplyRouteFocusId: null,
    supplyRoutePreview: null,
    focusReason: null,
    pendingHitResult: null,
    pendingReports: [],
    intel: emptyIntel(),
    rivalTreasury: {},
    started: false,
  };
}

/** Player selects family — grant starting territory (manhattan) + crew */
export function startGame(state: GameState, family: FamilyName): GameState {
  const def = getFamilyDef(family);
  const rng = createRng(state.seed + family.charCodeAt(0));

  const startTerritoryId = "manhattan";
  let territories = state.territories.map((t) => {
    if (t.id === startTerritoryId) {
      const racketType = mapBusinessTypeToRacket("loan_sharking")!;
      const rackets =
        t.owner === family
          ? t.rackets
          : [
              ...t.rackets,
              createRacket(
                `racket_${t.id}_player`,
                t.id,
                racketType,
                2,
                0,
                nextRacketSiteIndex(t.rackets),
              ),
            ];
      return {
        ...t,
        owner: family,
        discovered: true,
        rackets,
        garrisonIds: [],
        leadershipVacuum: 0,
      };
    }
    if (t.owner === family) {
      return { ...t, discovered: true };
    }
    return t;
  });

  const adjacentIds = new Set(
    territories.find((t) => t.id === startTerritoryId)?.adjacentTerritories ?? [],
  );
  // Neighbours are known from day one, and so is every empty lot: vacant
  // ground is public — anyone driving past can see there's nothing on it.
  territories = territories.map((t) =>
    adjacentIds.has(t.id) || t.emptyLot ? { ...t, discovered: true } : t,
  );

  let crew = state.crew.map((c) =>
    c.family === family && c.role === "boss"
      ? { ...c, isPlayerBoss: true, assignment: { type: "idle" as const } }
      : c,
  );

  const startingCrew = [
    createCrewMember(rng, family, "soldier", { id: `player_soldier_0` }),
    createCrewMember(rng, family, "soldier", { id: `player_soldier_1` }),
    createCrewMember(rng, family, "capo", { id: `player_capo_0` }),
  ].map(stampMade);

  crew = [...crew, ...startingCrew];

  crew = assignCrew(crew, startingCrew[0]!.id, {
    type: "garrison",
    territoryId: startTerritoryId,
  });
  crew = assignCrew(crew, startingCrew[1]!.id, {
    type: "garrison",
    territoryId: startTerritoryId,
  });
  crew = assignCrew(crew, startingCrew[2]!.id, {
    type: "racket",
    territoryId: startTerritoryId,
  });

  // Wire starting capo as manager of the Manhattan starter racket
  const startTerr = territories.find((t) => t.id === startTerritoryId);
  const starterRacket =
    startTerr?.rackets.find((r) => r.id === `racket_${startTerritoryId}_player`) ??
    startTerr?.rackets[0];
  if (starterRacket) {
    territories = territories.map((t) =>
      t.id === startTerritoryId
        ? {
            ...t,
            rackets: t.rackets.map((r) =>
              r.id === starterRacket.id
                ? { ...r, managerId: startingCrew[2]!.id }
                : r,
            ),
          }
        : t,
    );
    crew = assignCrew(crew, startingCrew[2]!.id, {
      type: "racket",
      territoryId: startTerritoryId,
      racketId: starterRacket.id,
    });
  }

  const garrisonIds = [startingCrew[0]!.id, startingCrew[1]!.id];
  territories = territories.map((t) =>
    t.id === startTerritoryId
      ? { ...t, garrisonIds: [...t.garrisonIds, ...garrisonIds] }
      : t,
  );

  // Seed rival treasuries
  const rivalTreasury: Partial<Record<FamilyName, number>> = {};
  const rivalInfluence: Partial<Record<FamilyName, number>> = {};
  for (const f of FAMILIES.map((x) => x.name)) {
    if (f === family) continue;
    const owned = territories.filter((t) => t.owner === f).length;
    rivalTreasury[f] = 2000 + owned * 400;
    rivalInfluence[f] = 120;
  }

  // Seed starting legit businesses for laundering
  const launderPlan: Record<string, number> = {};
  const laundryId = `racket_${startTerritoryId}_laundry`;
  const laundry = {
    ...createRacket(
      laundryId,
      startTerritoryId,
      "laundromat",
      1,
      state.turn,
      nextRacketSiteIndex(
        territories.find((t) => t.id === startTerritoryId)?.rackets ?? [],
      ),
    ),
    launderReadyTurn: 0,
  };
  territories = territories.map((t) => {
    if (t.id !== startTerritoryId) return t;
    if (t.rackets.some((r) => r.id === laundryId)) return t;
    if (t.rackets.length >= maxRacketsFor(t)) return t;
    return { ...t, rackets: [...t.rackets, laundry] };
  });
  launderPlan[laundryId] = launderCap(laundry, null, state.turn);

  const secondDistrict = territories.find(
    (t) =>
      t.owner === family &&
      t.id !== startTerritoryId &&
      t.rackets.length < maxRacketsFor(t),
  );
  if (secondDistrict && allowedRacketTypes(secondDistrict).includes("deli")) {
    const deliId = `racket_${secondDistrict.id}_deli`;
    const deli = {
      ...createRacket(
        deliId,
        secondDistrict.id,
        "deli",
        1,
        state.turn,
        nextRacketSiteIndex(secondDistrict.rackets),
      ),
      launderReadyTurn: 0,
    };
    territories = territories.map((t) =>
      t.id === secondDistrict.id ? { ...t, rackets: [...t.rackets, deli] } : t,
    );
    launderPlan[deliId] = launderCap(deli, null, state.turn);
  }

  const recruitmentPool = generateRecruitmentPool(rng, family, 4, recruitTier(15));
  const startTerritoryName =
    territories.find((t) => t.id === startTerritoryId)?.name ?? "Manhattan";

  return {
    ...state,
    playerFamily: family,
    started: true,
    territories,
    crew,
    recruitmentPool,
    money: 8000,
    dirtyMoney: 3000,
    influence: 120,
    launderPlan,
    launderNudgeShown: false,
    diplomacy: state.diplomacy ?? emptyDiplomacy(),
    reputation: {
      respect: 15,
      fear: 10,
      loyalty: 55,
      streetInfluence: 15,
      publicPerception: 50,
    },
    turnLog: [
      ...state.turnLog,
      {
        id: `log_family_${family}`,
        turn: state.turn,
        category: "system",
        text: `${def.name} family takes the table. Stronghold established in ${startTerritoryName}.`,
        family,
      },
    ],
    selectedTerritoryId: startTerritoryId,
    flyToTerritoryId: startTerritoryId,
    flyToNonce: (state.flyToNonce ?? 0) + 1,
    rivalTreasury,
    rivalInfluence,
    victory: {
      ...emptyVictory(finalTurnFor(state.settings.gameLength)),
    },
  };
}
