import type { CaptureTally, CrewMember, FamilyName, GameState, Territory } from "@/types/game";
import { CAPTURE_LIMIT_BASE, CAPTURE_LIMIT_MAX } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { assignCrew } from "./crew";
import type { Rng } from "./rng";

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
  return state.crew.filter(
    (c) =>
      c.family === state.playerFamily &&
      c.status === "active" &&
      (c.assignment.type === "idle" ||
        (c.assignment.type === "garrison" && c.assignment.territoryId === territoryId)),
  );
}

export function captureStrength(
  state: Pick<GameState, "crew" | "territories" | "playerFamily">,
  territoryId: string,
  attackerIds: string[],
): { atk: number; def: number; defenders: CrewMember[] } {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t || !state.playerFamily) return { atk: 0, def: 40, defenders: [] };

  const idSet = new Set(attackerIds);
  const attackers = state.crew.filter((c) => idSet.has(c.id) && c.status === "active");
  const defenders = state.crew.filter(
    (c) =>
      !!t.owner &&
      c.family === t.owner &&
      c.status === "active" &&
      t.garrisonIds.includes(c.id),
  );

  const atk =
    attackers.reduce((n, c) => n + c.skills.muscle, 0) *
    (1 + (getFamilyDef(state.playerFamily).bonuses.combatBonus || 0));
  const def =
    (defenders.reduce((n, c) => n + c.skills.muscle, 0) + 40) *
    (1 + t.defenseBonus) *
    (t.leadershipVacuum > 0 ? 0.7 : 1);

  return { atk, def, defenders };
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
  const validIds = attackerIds.filter((id) => eligible.has(id));
  if (validIds.length === 0) return { state, success: false };

  const { atk, def } = captureStrength(state, territoryId, validIds);
  const success = atk * (0.8 + rng.next() * 0.4) > def * (0.8 + rng.next() * 0.4);

  if (!success) {
    return {
      state: {
        ...state,
        heat: { ...state.heat, level: Math.min(100, state.heat.level + 4) },
        turnLog: [
          ...state.turnLog,
          {
            id: `log_atkfail_${Date.now()}`,
            turn: state.turn,
            category: "combat",
            text: `Attack on ${t.name} failed.`,
            family: state.playerFamily,
          },
        ],
      },
      success: false,
    };
  }

  const leadId = validIds[0]!;
  return {
    state: recordCapture({
      ...state,
      territories: state.territories.map((x) =>
        x.id === territoryId
          ? {
              ...x,
              owner: state.playerFamily,
              garrisonIds: [leadId],
              leadershipVacuum: 0,
              discovered: true,
            }
          : x,
      ),
      crew: assignCrew(
        state.crew.map((c) =>
          t.garrisonIds.includes(c.id)
            ? { ...c, status: "wounded" as const, assignment: { type: "idle" as const } }
            : c,
        ),
        leadId,
        { type: "garrison", territoryId },
      ),
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
          text: `Took ${t.name} by force.`,
          family: state.playerFamily,
        },
      ],
    }, state.playerFamily),
    success: true,
  };
}
