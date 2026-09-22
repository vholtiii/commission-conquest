import type {
  BusinessIntel,
  CasingClue,
  CasingRung,
  CrewMember,
  Evidence,
  FamilyName,
  GameState,
  HitApproach,
  LookoutOutcome,
  LookoutReport,
  LookoutRivalOp,
  Operation,
} from "@/types/game";
import { calculateHitOdds, tipOffChance } from "./hitOps";
import { crewCombatScore } from "./crew";
import { emptyIntel } from "./intel";
import type { Rng } from "./rng";
import { hitCrewIds } from "@/data/hitApproaches";
import { crewPresentIn } from "./crewLocation";
import {
  casingProfile,
  casingScore,
  generateBusinessIntel,
  generateClues,
  lastName,
  pickTopMark,
  rollCasing,
  type CasingRoll,
} from "./casing";
import {
  addEvidence,
  makeEvidence,
  openIncidents,
  revealMotive,
} from "./incidents";

export { pickTopMark } from "./casing";

/* ------------------------------------------------------------------ */
/* Draft hits for the odds sample                                      */
/* ------------------------------------------------------------------ */

function idleCandidates(state: GameState): CrewMember[] {
  return state.crew.filter(
    (c) =>
      c.family === state.playerFamily &&
      c.status === "active" &&
      c.role !== "boss" &&
      (c.assignment.type === "idle" || c.assignment.type === "garrison"),
  );
}

/**
 * A modest one-man draft in the given approach so the report's before→after
 * odds have headroom under the 92% cap and reflect the routine the lookout found.
 */
function draftHit(
  state: GameState,
  territoryId: string,
  targetFamily: FamilyName,
  targetCrewId: string | undefined,
  approach: HitApproach,
): Operation {
  const pool = idleCandidates(state);
  const weakestShooter = [...pool]
    .filter((c) => c.role === "soldier" || c.role === "associate")
    .sort((a, b) => crewCombatScore(a) - crewCombatScore(b))[0];
  const bestDriver = [...pool].sort((a, b) => b.skills.driving - a.skills.driving)[0];
  const bestSmarts = [...pool].sort((a, b) => b.skills.smarts - a.skills.smarts)[0];
  const bestStealth = [...pool]
    .filter((c) => c.id !== bestSmarts?.id)
    .sort((a, b) => b.skills.stealth - a.skills.stealth)[0];
  const bestCharm = [...pool].sort((a, b) => b.skills.charm - a.skills.charm)[0];

  const op: Operation = {
    id: "draft_lookout_odds",
    family: state.playerFamily!,
    kind: "hit",
    targetCrewId,
    targetTerritoryId: territoryId,
    targetFamily,
    approach,
    shooterIds: [],
    surveilled: false,
    tippedOff: false,
    pendingTurns: 0,
    resolved: false,
  };

  switch (approach) {
    case "ambush":
      op.shooterIds = weakestShooter ? [weakestShooter.id] : [];
      break;
    case "drive_by":
      op.wheelmanId = bestDriver?.id;
      op.shooterIds = weakestShooter && weakestShooter.id !== bestDriver?.id ? [weakestShooter.id] : [];
      break;
    case "car_bomb":
      op.bombMakerId = bestSmarts?.id;
      op.planterId = bestStealth?.id;
      break;
    case "sitdown_betrayal":
      op.negotiatorId = bestCharm?.id;
      op.shooterIds = weakestShooter && weakestShooter.id !== bestCharm?.id ? [weakestShooter.id] : [];
      break;
  }
  return op;
}

function collectRivalOps(
  state: GameState,
  territoryId: string,
  targetFamily: FamilyName,
): LookoutRivalOp[] {
  return state.operations
    .filter(
      (o) =>
        !o.resolved &&
        o.family === targetFamily &&
        (o.targetTerritoryId === territoryId || o.originTerritoryId === territoryId),
    )
    .map((o) => ({
      operationId: o.id,
      approach: o.approach,
      targetTerritoryId: o.targetTerritoryId,
      targetFamily: o.targetFamily,
      pendingTurns: o.pendingTurns,
      aimedAtPlayer: o.targetFamily === state.playerFamily,
    }));
}

/* ------------------------------------------------------------------ */
/* Running the casing                                                  */
/* ------------------------------------------------------------------ */

/** Who actually does the looking: the lookout, or the sneakiest man on a surveil-first hit. */
export function effectiveLookout(state: GameState, op: Operation): CrewMember | undefined {
  if (op.lookoutId) {
    const l = state.crew.find((c) => c.id === op.lookoutId);
    if (l) return l;
  }
  const crew = hitCrewIds(op)
    .map((id) => state.crew.find((c) => c.id === id))
    .filter((c): c is CrewMember => !!c && c.status === "active");
  return [...crew].sort((a, b) => casingScore(b) - casingScore(a))[0];
}

export interface CasingResult {
  state: GameState;
  lookout?: CrewMember;
  roll: CasingRoll;
  clues: CasingClue[];
  business: BusinessIntel[];
  leads: Evidence[];
  present: CrewMember[];
}

/** Merge new clues over old ones for the same district (same kind + mark replaces). */
function mergeClues(existing: CasingClue[], fresh: CasingClue[], turn: number): CasingClue[] {
  const live = existing.filter((c) => c.expiresTurn > turn);
  const kept = live.filter(
    (old) =>
      !fresh.some(
        (n) =>
          n.kind === old.kind &&
          (n.targetCrewId ?? null) === (old.targetCrewId ?? null),
      ),
  );
  return [...kept, ...fresh];
}

/**
 * Roll the casing, generate clues and business intel, write them into intel,
 * and gather incident leads. Does NOT apply detection consequences (alerts,
 * burns, grudges, held / killed crew); the caller handles the rung.
 */
export function runCasing(
  state: GameState,
  op: Operation,
  rng: Rng,
  opts?: { forHit?: boolean },
): CasingResult {
  const lookout = effectiveLookout(state, op);
  const present = crewPresentIn(state, op.targetTerritoryId).filter(
    (c) => c.family === op.targetFamily,
  );

  if (!lookout) {
    // Nobody to look: bare-bones report, nothing learned beyond faces.
    return {
      state,
      lookout: undefined,
      roll: {
        rung: "clean",
        reachedTier: 1,
        reachedBusinessTier: 1,
        markSawHim: false,
      },
      clues: [],
      business: [],
      leads: [],
      present,
    };
  }

  const profile = casingProfile(state, lookout, op.targetTerritoryId, op.targetFamily);
  const roll = rollCasing(state, rng, lookout, op.targetTerritoryId, op.targetFamily, profile);

  // Arrested before he saw anything.
  if (roll.copTrouble === "arrested") {
    return { state, lookout, roll, clues: [], business: [], leads: [], present };
  }

  const territory = state.territories.find((t) => t.id === op.targetTerritoryId);
  const clues = generateClues(state, rng, {
    lookout,
    territoryId: op.targetTerritoryId,
    targetFamily: op.targetFamily,
    tier: roll.reachedTier,
    present,
    poisoned: roll.rung === "turned",
  });
  const business = territory
    ? generateBusinessIntel(state, territory, op.targetFamily, roll.reachedBusinessTier)
    : [];

  // Only the player keeps a file.
  let next = state;
  if (op.family === state.playerFamily) {
    const intel = state.intel ?? emptyIntel();
    const businessMap = { ...intel.business };
    for (const b of business) businessMap[b.racketId] = b;
    next = {
      ...state,
      intel: {
        ...intel,
        clues: {
          ...intel.clues,
          [op.targetTerritoryId]: mergeClues(
            intel.clues[op.targetTerritoryId] ?? [],
            clues,
            state.turn,
          ),
        },
        business: businessMap,
      },
    };
  }

  const leadResult = gatherIncidentLeads(next, op, roll, rng);
  next = leadResult.state;

  return { state: next, lookout, roll, clues, business, leads: leadResult.leads, present };
}

/* ------------------------------------------------------------------ */
/* Incident leads                                                      */
/* ------------------------------------------------------------------ */

/** Casing the scene of a hit, or a suspect's block, feeds open cases. */
function gatherIncidentLeads(
  state: GameState,
  op: Operation,
  roll: CasingRoll,
  rng: Rng,
): { state: GameState; leads: Evidence[] } {
  const leads: Evidence[] = [];
  if (op.family !== state.playerFamily) return { state, leads };
  if (roll.reachedTier < 2) return { state, leads };
  let next = state;
  const turn = state.turn;

  for (const inc of openIncidents(state)) {
    const culpritTurf = state.territories.find((t) => t.id === inc.territoryId);

    // 1. The scene itself, while the trail is warm.
    if (inc.territoryId === op.targetTerritoryId && turn - inc.turn <= 2) {
      const culpritDistrict = state.territories.find(
        (t) => t.owner === inc.actualFamily && culpritTurf?.adjacentTerritories.includes(t.id),
      );
      const toward = culpritDistrict?.name ?? "across the river";
      const ev = makeEvidence(
        "casing",
        turn,
        rng.pick([
          `Kid on the corner saw the car head off toward ${toward}.`,
          `Bartender says the shooters drank at a joint out toward ${toward} before.`,
          `Tire marks and a witness: they came in from ${toward}.`,
        ]),
        { [inc.actualFamily]: 0.2 },
        undefined,
        rng,
      );
      leads.push(ev);
      next = addEvidence(next, inc.id, ev);

      if (roll.reachedTier >= 3) {
        const face = state.crew.find(
          (c) => c.family === inc.actualFamily && c.status !== "dead" && (state.intel?.known?.[c.id] || c.role === "boss"),
        );
        const ev3 = makeEvidence(
          "casing",
          turn,
          face
            ? `A face got picked out: ${lastName(face)}, ${inc.actualFamily}.`
            : `Somebody recognized the hats. ${inc.actualFamily} men.`,
          { [inc.actualFamily]: 0.35 },
          undefined,
          rng,
        );
        leads.push(ev3);
        next = addEvidence(next, inc.id, ev3);
      }
      if (roll.reachedTier >= 4 && !inc.motiveKnown) {
        next = revealMotive(next, inc.id);
        const ev4 = makeEvidence(
          "casing",
          turn,
          `The why came out with the who. Everybody on the block knows it.`,
          {},
          undefined,
          rng,
        );
        leads.push(ev4);
        next = addEvidence(next, inc.id, ev4);
      }
      continue;
    }

    // 2. A suspect's block: their soldiers give it away, or clear themselves.
    if ((inc.suspects[op.targetFamily] ?? 0) > 0 && op.targetFamily !== state.playerFamily) {
      if (op.targetFamily === inc.actualFamily) {
        const ev = makeEvidence(
          "casing",
          turn,
          rng.pick([
            inc.kind === "hijack"
              ? `Their boys are flush and drinking on it. Crates with your stencil out back.`
              : `One of their soldiers has a fresh bandage and a new suit.`,
            `They went quiet when your name came up. Too quiet.`,
          ]),
          { [op.targetFamily]: 0.25 },
          undefined,
          rng,
        );
        leads.push(ev);
        next = addEvidence(next, inc.id, ev);
      } else if (roll.reachedTier >= 3) {
        const ev = makeEvidence(
          "casing",
          turn,
          `Nothing. They were all home that night, and they're as curious as you are.`,
          { [op.targetFamily]: -0.15 },
          undefined,
          rng,
        );
        leads.push(ev);
        next = addEvidence(next, inc.id, ev);
      }
    }
  }

  return { state: next, leads };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export function rungToOutcome(rung: CasingRung, wounded: boolean): LookoutOutcome {
  if (rung === "clean" || rung === "turned") return "clean";
  return wounded ? "spotted_wounded" : "spotted";
}

export interface ReportOpts {
  forHit?: boolean;
  casing?: CasingResult;
  /** Fallout lines the resolver applied ("Held 2 turns", "Vitale changed his routine"). */
  consequences?: string[];
}

export function buildLookoutReport(
  stateBefore: GameState,
  stateAfter: GameState,
  op: Operation,
  presentIds: string[],
  outcome: LookoutOutcome,
  relationDelta: number,
  opts?: ReportOpts,
): LookoutReport {
  const territory = stateAfter.territories.find((t) => t.id === op.targetTerritoryId);
  const knownBefore = stateBefore.intel?.known ?? emptyIntel().known;
  const spotted = presentIds
    .map((id) => stateAfter.crew.find((c) => c.id === id))
    .filter((c): c is CrewMember => !!c);
  const newIds = presentIds.filter((id) => !knownBefore[id]);

  const garrison = territory
    ? territory.garrisonIds.filter((id) => {
        const c = stateAfter.crew.find((m) => m.id === id);
        return (
          !!c &&
          c.family === op.targetFamily &&
          (c.status === "active" || c.status === "wounded")
        );
      }).length
    : 0;

  const rackets = (territory?.rackets ?? []).map((r) => ({
    type: r.type,
    level: r.level,
  }));

  const rivalOps = collectRivalOps(stateAfter, op.targetTerritoryId, op.targetFamily);
  const casing = opts?.casing;

  let oddsSample: LookoutReport["oddsSample"];
  let tipRiskAfter: number | undefined;

  if (stateAfter.playerFamily) {
    const top = pickTopMark(spotted);
    const routine = casing?.clues.find((c) => c.kind === "routine" && c.targetCrewId === top?.id);
    const approach: HitApproach = routine?.approach ?? "ambush";
    const draftBefore = draftHit(stateBefore, op.targetTerritoryId, op.targetFamily, top?.id, approach);
    const draftAfter = draftHit(stateAfter, op.targetTerritoryId, op.targetFamily, top?.id, approach);
    if (top) {
      oddsSample = {
        targetCrewId: top.id,
        before: calculateHitOdds(stateBefore, draftBefore),
        after: calculateHitOdds(stateAfter, draftAfter),
      };
    }
    tipRiskAfter = tipOffChance(stateAfter, draftAfter);
  }

  // A turned lookout's report looks clean.
  const rung: CasingRung | undefined = casing
    ? casing.roll.rung === "turned"
      ? "clean"
      : casing.roll.rung
    : undefined;

  return {
    id: `lookout_${op.id}_${stateAfter.turn}`,
    operationId: op.id,
    turn: stateAfter.turn,
    territoryId: op.targetTerritoryId,
    targetFamily: op.targetFamily,
    lookoutId: casing?.lookout?.id ?? op.lookoutId,
    outcome,
    relationDelta,
    spottedIds: presentIds,
    newIds,
    garrison,
    defenseBonus: territory?.defenseBonus ?? 0,
    rackets,
    rivalOps,
    oddsSample,
    tipRiskAfter,
    forHit: opts?.forHit,
    tier: casing?.roll.reachedTier,
    rung,
    clues: casing?.clues,
    business: casing?.business,
    consequences: opts?.consequences,
    incidentLeads: casing?.leads,
    copTrouble: casing?.roll.copTrouble,
  };
}
