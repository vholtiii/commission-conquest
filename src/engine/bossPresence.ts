import type { CrewMember, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { crewPresentIn, familyHq, resolveCrewTerritoryId, type LocationState } from "./crewLocation";

/**
 * The boss's block. Wherever he holds court, the family leans in: rackets on
 * that block run harder, his shooters learn faster, the men there stand
 * taller, the neighbours are easier to read and easier to take. The HQ he
 * left behind goes soft in the same breath.
 */
export const BOSS_PRESENCE = {
  /** Racket income and launder capacity on his block. */
  incomeMult: 1.25,
  launderCapMult: 1.25,
  /** Unmanaged rackets on his block run at full instead of 70%. */
  unmanagedFloor: 1.0,
  /** Extra crates a still/brewery turns out per level while he's there. */
  productionPerLevel: 1,
  /** Extra crates a speakeasy pours per level while he's there. */
  speakeasyPullPerLevel: 1,
  /** Build / upgrade discount on his block. */
  buildDiscount: 0.15,
  /** Attack strength vs districts adjacent to his block. */
  captureAtkMult: 1.2,
  /** Defence of the HQ while he's elsewhere. */
  hqSoftDefMult: 0.8,
  /** Rival AI success roll vs a soft HQ (+) or vs the block he stands on (−). */
  aiHqSoftRoll: 0.1,
  aiBossBlockRoll: 0.1,
  /** Passage terms when his block borders the table. */
  askMult: 0.9,
  /** Mentoring for his crew garrisoned on his block. */
  mentorMult: 2,
  /** Chance per rival present next door that the street puts a face to him. */
  intelFlipChance: 0.35,
  /** Loyalty for family men on his block; more once he's settled in. */
  loyaltyPerTurn: 1,
  loyaltySettledPerTurn: 2,
  loyaltySettledTurns: 3,
} as const;

type PresenceState = LocationState & Partial<Pick<GameState, "bossStay">>;

function activeBoss(state: Pick<GameState, "crew">, family: FamilyName): CrewMember | undefined {
  const acting = state.crew.find(
    (c) => c.family === family && c.actingBoss && c.status === "active",
  );
  if (acting) return acting;
  return state.crew.find((c) => c.family === family && c.role === "boss" && c.status === "active");
}

/**
 * Where the boss holds court this week: his standing site, trips ignored. A
 * sit-down across town doesn't move his desk.
 */
export function bossPresenceDistrict(state: PresenceState, family: FamilyName): string | null {
  const boss = activeBoss(state, family);
  if (!boss) return null;
  const grounded = boss.awayAt ? { ...state, crew: state.crew.map((c) => (c.id === boss.id ? { ...c, awayAt: undefined } : c)) } : state;
  return resolveCrewTerritoryId(grounded, boss.id);
}

export function bossPresentIn(state: PresenceState, family: FamilyName, territoryId: string): boolean {
  return bossPresenceDistrict(state, family) === territoryId;
}

/** True when the boss's block borders `territoryId` (not the block itself). */
export function bossAdjacentTo(state: PresenceState, family: FamilyName, territoryId: string): boolean {
  const here = bossPresenceDistrict(state, family);
  if (!here || here === territoryId) return false;
  const t = state.territories.find((x) => x.id === here);
  return !!t && t.adjacentTerritories.includes(territoryId);
}

/** The HQ is soft while the boss holds court somewhere else. */
export function hqIsSoft(state: PresenceState, family: FamilyName): boolean {
  const hq = familyHq(state, family);
  const here = bossPresenceDistrict(state, family);
  return !!hq && !!here && here !== hq;
}

/** Consecutive turns the boss has held this block (0 when he isn't there). */
export function bossStayTurns(state: PresenceState, family: FamilyName): number {
  const here = bossPresenceDistrict(state, family);
  const stay = state.bossStay?.[family];
  if (!here || !stay || stay.territoryId !== here) return 0;
  return Math.max(0, (state.turn ?? 0) - stay.since);
}

/** Loyalty a family man on the boss's block gains this turn. */
export function presenceLoyaltyGain(stayTurns: number): number {
  return stayTurns >= BOSS_PRESENCE.loyaltySettledTurns
    ? BOSS_PRESENCE.loyaltySettledPerTurn
    : BOSS_PRESENCE.loyaltyPerTurn;
}

/** Discounted build / upgrade cost on the boss's block. */
export function presenceBuildCost(cost: number, bossHere: boolean): number {
  return bossHere ? Math.floor(cost * (1 - BOSS_PRESENCE.buildDiscount)) : cost;
}

export interface PresenceTickResult {
  state: GameState;
  logs: TurnLogEntry[];
}

/**
 * End-of-week pass: the stay counter, the loyalty rally on the boss's block,
 * and the intel that bleeds in from the blocks next door. Rivals get the
 * rally too; only the player gets the intel and the log lines.
 */
export function tickBossPresence(state: GameState, rng: Rng): PresenceTickResult {
  const logs: TurnLogEntry[] = [];
  const families = [...new Set(state.crew.filter((c) => c.role === "boss" && c.status === "active").map((c) => c.family))];
  let next = state;
  const bossStay: NonNullable<GameState["bossStay"]> = { ...(state.bossStay ?? {}) };

  for (const family of families) {
    const here = bossPresenceDistrict(next, family);
    if (!here) {
      delete bossStay[family];
      continue;
    }
    const prev = bossStay[family];
    if (!prev || prev.territoryId !== here) bossStay[family] = { territoryId: here, since: state.turn };
    const stayTurns = Math.max(0, state.turn - bossStay[family]!.since);
    const gain = presenceLoyaltyGain(stayTurns);

    // The rally: every active family man on his block, the boss himself aside.
    const boss = activeBoss(next, family);
    const rallied: string[] = [];
    const crew = next.crew.map((c) => {
      if (c.family !== family || c.status !== "active" || c.id === boss?.id) return c;
      if (resolveCrewTerritoryId(next, c.id) !== here) return c;
      if (c.loyalty >= 100) return c;
      rallied.push(c.name);
      return { ...c, loyalty: Math.min(100, c.loyalty + gain) };
    });
    next = { ...next, crew };

    if (family !== state.playerFamily) continue;

    const block = next.territories.find((t) => t.id === here);
    if (rallied.length > 0) {
      logs.push({
        id: `log_boss_rally_${state.turn}`,
        turn: state.turn,
        category: "system",
        text: `The boss spent the week in ${block?.name ?? "his district"} — ${
          rallied.length === 1 ? rallied[0] : `${rallied.length} of the men`
        } noticed (+${gain} loyalty${stayTurns >= BOSS_PRESENCE.loyaltySettledTurns ? ", settled in" : ""}).`,
        family,
      });
    }

    // Eyes on the neighbours: rival blocks next door are read for the week,
    // and some of the faces there get names.
    const neighbours = (block?.adjacentTerritories ?? [])
      .map((id) => next.territories.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t && !!t.owner && t.owner !== family);
    if (neighbours.length > 0) {
      const intel = next.intel;
      const districtReveal = { ...intel.districtReveal };
      const known = { ...intel.known };
      const named: string[] = [];
      for (const t of neighbours) {
        districtReveal[t.id] = Math.max(districtReveal[t.id] ?? 0, state.turn + 1);
        for (const c of crewPresentIn(next, t.id)) {
          if (c.family === family) continue;
          const already = known[c.id];
          if (already && already.territoryId === t.id && already.source !== "sighting") continue;
          if (!rng.chance(BOSS_PRESENCE.intelFlipChance)) continue;
          known[c.id] = { territoryId: t.id, turn: state.turn, source: "surveillance" };
          named.push(`${c.name} (${t.name})`);
        }
      }
      next = { ...next, intel: { ...intel, districtReveal, known } };
      if (named.length > 0) {
        logs.push({
          id: `log_boss_eyes_${state.turn}`,
          turn: state.turn,
          category: "system",
          text: `From ${block?.name ?? "the boss's block"} the family keeps an eye on the neighbours: ${named.join(", ")}.`,
          family,
        });
      }
    }
  }

  return { state: { ...next, bossStay }, logs };
}
