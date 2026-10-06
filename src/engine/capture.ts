import type { CaptureTally, CrewMember, FamilyName, GameState, Territory } from "@/types/game";
import { CAPTURE_LIMIT_BASE, CAPTURE_LIMIT_MAX } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { assignCrew, bumpLoyalty, isUnmade } from "./crew";
import { captureParty } from "./crews";
import type { Rng } from "./rng";
import { BOSS_PRESENCE, bossAdjacentTo, bossPresentIn, hqIsSoft } from "./bossPresence";
import { familyHq, type LocationState } from "./crewLocation";
import { safehouseCaptureDefence } from "./safehouse";
import { mattressDistrict, mattressSoldierBonus, MATTRESS_DEFENCE } from "./mattresses";

/* ------------------------------------------------------------------ */
/* Per-turn capture limit                                              */
/* ------------------------------------------------------------------ */

type TallyState = Pick<GameState, "turn" | "captureTally">;

function liveTally(state: TallyState): CaptureTally {
  const t = state.captureTally;
  if (!t || t.turn !== state.turn) return { turn: state.turn, byFamily: {} };
  return t;
}

/** Districts this family has already taken this turn. */
export function capturesThisTurn(state: TallyState, family: FamilyName): number {
  return liveTally(state).byFamily[family] ?? 0;
}

export interface CaptureAllowance {
  ok: boolean;
  used: number;
  /** Base moves for this family this turn (1, or 2 for expansionists). */
  limit: number;
  /** Why a second grab is allowed beyond the base, if it is. */
  bonusReason?: "expansionist" | "vacuum" | "vendetta";
  /** Why the grab is blocked, if it is. */
  blocked?: string;
}

/**
 * One district per family per turn. Two only in special cases:
 *  - an expansionist family (Valenti) always gets two moves;
 *  - a district with a leadership vacuum is blood in the water — it can be a second grab;
 *  - a district owned by a family you're in a vendetta with can be a second grab.
 * Never more than CAPTURE_LIMIT_MAX.
 */
export function captureAllowance(
  state: Pick<GameState, "turn" | "captureTally" | "vendettas">,
  family: FamilyName,
  target?: Pick<Territory, "owner" | "leadershipVacuum">,
): CaptureAllowance {
  const used = capturesThisTurn(state, family);
  let limit = CAPTURE_LIMIT_BASE;
  let bonusReason: CaptureAllowance["bonusReason"];

  if (getFamilyDef(family).personality === "expansionist") {
    limit = CAPTURE_LIMIT_MAX;
    bonusReason = "expansionist";
  } else if (target) {
    const vendetta =
      !!target.owner &&
      state.vendettas.includes(family) &&
      state.vendettas.includes(target.owner);
    if (target.leadershipVacuum > 0) {
      limit = CAPTURE_LIMIT_MAX;
      bonusReason = "vacuum";
    } else if (vendetta) {
      limit = CAPTURE_LIMIT_MAX;
      bonusReason = "vendetta";
    }
  }
  limit = Math.min(CAPTURE_LIMIT_MAX, limit);

  if (used >= limit) {
    const blocked =
      used >= CAPTURE_LIMIT_MAX
        ? "Two districts in one week is already pushing it. Consolidate."
        : "One district a week. Garrison what you took — or find a block with no boss.";
    return { ok: false, used, limit, bonusReason, blocked };
  }
  return { ok: true, used, limit, bonusReason };
}

/** Record a successful grab against this turn's tally. */
export function recordCapture<S extends TallyState>(state: S, family: FamilyName): S {
  const tally = liveTally(state);
  return {
    ...state,
    captureTally: {
      turn: state.turn,
      byFamily: { ...tally.byFamily, [family]: (tally.byFamily[family] ?? 0) + 1 },
    },
  };
}

export function eligibleCaptureCrew(
  state: Pick<GameState, "crew" | "playerFamily">,
  territoryId: string,
): CrewMember[] {
  if (!state.playerFamily) return [];
  return state.crew
    .filter(
      (c) =>
        c.family === state.playerFamily &&
        c.status === "active" &&
        (c.assignment.type === "idle" || c.assignment.type === "garrison"),
    )
    .sort((a, b) => {
      const here = (c: CrewMember) =>
        c.assignment.type === "garrison" && c.assignment.territoryId === territoryId ? 0 : 1;
      return here(a) - here(b);
    });
}

/**
 * How the boss's block bears on a fight over `territoryId`, for whichever
 * family is attacking: his weight next door helps the attack, a block he
 * stands on holds, and an HQ he left is soft.
 */
export function presenceCaptureMods(
  state: LocationState,
  attacker: FamilyName,
  territoryId: string,
): { atkMult: number; defMult: number; notes: string[] } {
  const t = state.territories.find((x) => x.id === territoryId);
  let atkMult = 1;
  let defMult = 1;
  const notes: string[] = [];
  if (!t) return { atkMult, defMult, notes };

  if (bossAdjacentTo(state, attacker, territoryId)) {
    atkMult *= BOSS_PRESENCE.captureAtkMult;
    notes.push("Your boss is next door");
  }
  if (t.owner && t.owner !== attacker) {
    if (bossPresentIn(state, t.owner, territoryId)) {
      defMult /= BOSS_PRESENCE.hqSoftDefMult;
      notes.push(`${t.owner}'s boss holds this block`);
    } else if (hqIsSoft(state, t.owner) && familyHq(state, t.owner) === territoryId) {
      defMult *= BOSS_PRESENCE.hqSoftDefMult;
      notes.push(`${t.owner}'s boss is away from his HQ`);
    }
  }
  return { atkMult, defMult, notes };
}

export function captureStrength(
  state: Pick<GameState, "crew" | "territories" | "playerFamily"> &
    Partial<LocationState> &
    Partial<Pick<GameState, "mattresses" | "turn" | "bribes">>,
  territoryId: string,
  attackerIds: string[],
): { atk: number; def: number; defenders: CrewMember[]; notes: string[] } {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t || !state.playerFamily) return { atk: 0, def: 40, defenders: [], notes: [] };

  const idSet = new Set(attackerIds);
  const attackers = state.crew.filter((c) => idSet.has(c.id) && c.status === "active");
  const defenders = state.crew.filter(
    (c) =>
      !!t.owner &&
      c.family === t.owner &&
      c.status === "active" &&
      t.garrisonIds.includes(c.id),
  );

  const mods = presenceCaptureMods(
    { ...state, routes: state.routes ?? [], operations: state.operations ?? [] },
    state.playerFamily,
    territoryId,
  );

  const muscle = (c: CrewMember) =>
    (c.skills.muscle + mattressSoldierBonus(state, c)) * (isUnmade(c) ? 0.75 : 1);
  const atk =
    attackers.reduce((n, c) => n + muscle(c), 0) *
    (1 + (getFamilyDef(state.playerFamily).bonuses.combatBonus || 0)) *
    mods.atkMult;
  let fortified = safehouseCaptureDefence(t, state.turn ?? 0);
  const notes = [...mods.notes];
  if (fortified > 1) {
    notes.push(`Safehouse on the block — defence +${Math.round((fortified - 1) * 100)}%`);
  }
  if (mattressDistrict(state, territoryId)) {
    fortified += MATTRESS_DEFENCE;
    notes.push("On the mattresses — defence +40%");
  }
  const def =
    (defenders.reduce((n, c) => n + muscle(c), 0) + 40) *
    (1 + t.defenseBonus) *
    (t.leadershipVacuum > 0 ? 0.7 : 1) *
    fortified *
    mods.defMult;

  return { atk, def, defenders, notes };
}

/**
 * P(atk * U(0.8,1.2) > def * U(0.8,1.2)) via discrete integration.
 * Equivalent to P(atk/def > V/U) where U,V ~ Uniform(0.8,1.2).
 */
export function captureOdds(atk: number, def: number): number {
  if (atk <= 0) return 0;
  if (def <= 0) return 1;
  const steps = 20;
  const lo = 0.8;
  const hi = 1.2;
  const span = hi - lo;
  const step = span / steps;
  let wins = 0;
  let total = 0;
  for (let i = 0; i < steps; i++) {
    const u = lo + (i + 0.5) * step;
    for (let j = 0; j < steps; j++) {
      const v = lo + (j + 0.5) * step;
      total += 1;
      if (atk * u > def * v) wins += 1;
    }
  }
  return wins / total;
}

const CAPTURE_MUSCLE = 1;

/** Taking a block by force hardens the men who did it. */
function hardenFromCapture(
  crew: CrewMember[],
  ids: string[],
): { crew: CrewMember[]; gained: string[] } {
  const set = new Set(ids);
  const gained: string[] = [];
  const next = crew.map((c) => {
    if (!set.has(c.id) || c.status === "dead" || c.skills.muscle >= 100) return c;
    gained.push(c.name.split(" ").slice(-1)[0] ?? c.name);
    return { ...c, skills: { ...c.skills, muscle: c.skills.muscle + CAPTURE_MUSCLE } };
  });
  return { crew: next, gained };
}

export function resolveCapture(
  state: GameState,
  territoryId: string,
  attackerIds: string[],
  rng: Rng,
): { state: GameState; success: boolean; blocked?: string } {
  if (!state.playerFamily || attackerIds.length === 0) {
    return { state, success: false };
  }
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t || t.owner === state.playerFamily) {
    return { state, success: false };
  }

  const allowance = captureAllowance(state, state.playerFamily, t);
  if (!allowance.ok) {
    return { state, success: false, blocked: allowance.blocked };
  }

  const eligible = new Set(eligibleCaptureCrew(state, territoryId).map((c) => c.id));
  const chosen = attackerIds.filter((id) => eligible.has(id));
  if (chosen.length === 0) return { state, success: false };
  // A boss, capo, or consigliere brings his free crew. Their muscle is in the roll.
  const validIds = captureParty(state.crew, chosen).filter((id) => {
    const c = state.crew.find((m) => m.id === id);
    return !!c && c.family === state.playerFamily && c.status === "active";
  });

  const { atk, def } = captureStrength(state, territoryId, validIds);
  const success = atk * (0.8 + rng.next() * 0.4) > def * (0.8 + rng.next() * 0.4);

  if (!success) {
    const paid = bumpLoyalty(state.crew, validIds, 1);
    const names = paid.gained.length > 0 ? ` Loyalty +1 for ${paid.gained.join(", ")}.` : "";
    return {
      state: {
        ...state,
        crew: paid.crew,
        heat: { ...state.heat, level: Math.min(100, state.heat.level + 4) },
        turnLog: [
          ...state.turnLog,
          {
            id: `log_atkfail_${Date.now()}`,
            turn: state.turn,
            category: "combat",
            text: `Attack on ${t.name} failed.${names}`,
            family: state.playerFamily,
          },
        ],
      },
      success: false,
    };
  }

  const party = new Set(validIds);
  let taken = state.crew.map((c) =>
    t.garrisonIds.includes(c.id) && !party.has(c.id)
      ? { ...c, status: "wounded" as const, assignment: { type: "idle" as const } }
      : c,
  );
  for (const id of validIds) {
    taken = assignCrew(taken, id, { type: "garrison", territoryId });
  }
  const hardened = hardenFromCapture(taken, validIds);
  const paid = bumpLoyalty(hardened.crew, validIds, 3);
  const muscleLine =
    hardened.gained.length > 0 ? ` Muscle +${CAPTURE_MUSCLE} for ${hardened.gained.join(", ")}.` : "";
  const loyalLine = paid.gained.length > 0 ? ` Loyalty +3 for ${paid.gained.join(", ")}.` : "";
  return {
    state: recordCapture({
      ...state,
      territories: state.territories.map((x) => ({
        ...x,
        garrisonIds:
          x.id === territoryId
            ? validIds
            : x.garrisonIds.filter((id) => !party.has(id)),
        rackets: x.rackets.map((r) =>
          r.managerId && party.has(r.managerId) ? { ...r, managerId: null } : r,
        ),
        ...(x.id === territoryId
          ? { owner: state.playerFamily, leadershipVacuum: 0, discovered: true }
          : {}),
      })),
      crew: paid.crew,
      heat: { ...state.heat, level: Math.min(100, state.heat.level + 8) },
      reputation: {
        ...state.reputation,
        fear: Math.min(100, state.reputation.fear + 3),
        streetInfluence: Math.min(100, state.reputation.streetInfluence + 2),
      },
      turnLog: [
        ...state.turnLog,
        {
          id: `log_atk_${Date.now()}`,
          turn: state.turn,
          category: "combat",
          text: `Took ${t.name} by force.${muscleLine}${loyalLine}`,
          family: state.playerFamily,
        },
      ],
    }, state.playerFamily),
    success: true,
  };
}
