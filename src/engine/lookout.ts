import type {
  CrewMember,
  CrewRole,
  FamilyName,
  GameState,
  LookoutOutcome,
  LookoutReport,
  LookoutRivalOp,
  Operation,
} from "@/types/game";
import { calculateHitOdds, tipOffChance } from "./hitOps";
import { crewCombatScore } from "./crew";
import { emptyIntel } from "./intel";

const ROLE_RANK: Record<CrewRole, number> = {
  associate: 1,
  soldier: 2,
  capo: 3,
  hitman: 4,
  consigliere: 5,
  underboss: 6,
  boss: 7,
};

function pickTopTarget(crew: CrewMember[]): CrewMember | undefined {
  if (crew.length === 0) return undefined;
  return [...crew].sort((a, b) => {
    const rank = (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0);
    if (rank !== 0) return rank;
    return crewCombatScore(b) - crewCombatScore(a);
  })[0];
}

function draftAmbush(
  state: GameState,
  territoryId: string,
  targetFamily: FamilyName,
  targetCrewId?: string,
): Operation {
  // One mid-tier shooter so the +6% intel bonus has headroom under the 92% cap
  const shooters = state.crew
    .filter(
      (c) =>
        c.family === state.playerFamily &&
        c.status === "active" &&
        (c.role === "soldier" || c.role === "associate") &&
        (c.assignment.type === "idle" || c.assignment.type === "garrison"),
    )
    .sort((a, b) => crewCombatScore(a) - crewCombatScore(b))
    .slice(0, 1)
    .map((c) => c.id);

  return {
    id: "draft_lookout_odds",
    family: state.playerFamily!,
    kind: "hit",
    targetCrewId,
    targetTerritoryId: territoryId,
    targetFamily,
    approach: "ambush",
    shooterIds: shooters,
    surveilled: false,
    tippedOff: false,
    pendingTurns: 0,
    resolved: false,
  };
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

export function buildLookoutReport(
  stateBefore: GameState,
  stateAfter: GameState,
  op: Operation,
  presentIds: string[],
  outcome: LookoutOutcome,
  relationDelta: number,
  opts?: { forHit?: boolean },
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

  let oddsSample: LookoutReport["oddsSample"];
  let tipRiskAfter: number | undefined;

  if (stateAfter.playerFamily) {
    const top = pickTopTarget(spotted);
    const draftBefore = draftAmbush(
      stateBefore,
      op.targetTerritoryId,
      op.targetFamily,
      top?.id,
    );
    const draftAfter = draftAmbush(
      stateAfter,
      op.targetTerritoryId,
      op.targetFamily,
      top?.id,
    );
    if (top) {
      oddsSample = {
        targetCrewId: top.id,
        before: calculateHitOdds(stateBefore, draftBefore),
        after: calculateHitOdds(stateAfter, draftAfter),
      };
    }
    tipRiskAfter = tipOffChance(stateAfter, draftAfter);
  }

  return {
    id: `lookout_${op.id}_${stateAfter.turn}`,
    operationId: op.id,
    turn: stateAfter.turn,
    territoryId: op.targetTerritoryId,
    targetFamily: op.targetFamily,
    lookoutId: op.lookoutId,
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
  };
}
