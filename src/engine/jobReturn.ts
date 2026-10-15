import type { CrewMember, GameState, Operation } from "@/types/game";
import { hitCrewIds } from "@/data/hitApproaches";
import { leaveTheTruck, TRUCK_ARM, TRUCK_HELD } from "./supplyRoutes";

/** A hit that has not come home. A casing does not count. */
export function onUnresolvedHit(memberId: string, operations: Operation[]): boolean {
  return operations.some((o) => !o.resolved && o.kind === "hit" && hitCrewIds(o).includes(memberId));
}

/** Active hitmen only, from any job, unless the man is already out on a hit. */
export function canSendOnHit(member: CrewMember, operations: Operation[]): boolean {
  return member.role === "hitman" && member.status === "active" && !onUnresolvedHit(member.id, operations);
}

/**
 * Who can be picked for a hit.
 * A hitman comes off any job. A capo or a loose soldier can plan from idle or
 * garrison. Anyone else has to be idle. The boss only sits the negotiator's chair.
 */
export function canJoinHit(member: CrewMember, operations: Operation[], asNegotiator = false): boolean {
  if (member.status !== "active" || onUnresolvedHit(member.id, operations)) return false;
  if (member.role === "boss") return asNegotiator;
  if (member.role === "hitman") return true;
  const posted = member.assignment.type === "idle" || member.assignment.type === "garrison";
  if (member.role === "capo" || (member.role === "soldier" && !member.capoId)) return posted;
  return member.assignment.type === "idle";
}

/** Remember the job he is walking off, and abandon a truck if that job was a route. */
export function pullForJob(state: GameState, ids: string[]): GameState {
  const idSet = new Set(ids);
  let next: GameState = {
    ...state,
    crew: state.crew.map((c) => {
      if (!idSet.has(c.id)) return c;
      if (c.assignment.type === "operation" || c.assignment.type === "surveillance") return c;
      return { ...c, returnTo: c.assignment };
    }),
  };
  for (const id of ids) {
    const man = next.crew.find((c) => c.id === id);
    if (man?.returnTo?.type === "delivery") next = leaveTheTruck(next, man);
  }
  return next;
}

/**
 * The job is over. A man still on his feet walks back to the post he left,
 * if it is still empty. A delivery arms the purchase of a new truck either way.
 */
export function releaseCrewHome(state: GameState, ids: string[], onlyOpId?: string): GameState {
  let crew = state.crew;
  let territories = state.territories;
  let supplyRoutes = state.supplyRoutes;
  for (const id of ids) {
    const man = crew.find((c) => c.id === id);
    if (!man) continue;
    const onSheet = man.assignment.type === "operation" || man.assignment.type === "surveillance";
    if (onSheet && onlyOpId && man.assignment.operationId && man.assignment.operationId !== onlyOpId) continue;
    const back = man.returnTo;
    if (back?.type === "delivery" && back.routeId) {
      supplyRoutes = supplyRoutes.map((r) =>
        r.id === back.routeId && r.truckReadyTurn === TRUCK_HELD ? { ...r, truckReadyTurn: TRUCK_ARM } : r,
      );
    }
    if (!onSheet) {
      if (back) crew = crew.map((c) => (c.id === id ? { ...c, returnTo: undefined } : c));
      continue;
    }
    const onFeet = man.status === "active";
    let assignment = man.assignment;
    if (onFeet && back?.type === "garrison" && back.territoryId) {
      assignment = back;
      territories = territories.map((t) =>
        t.id === back.territoryId && !t.garrisonIds.includes(id)
          ? { ...t, garrisonIds: [...t.garrisonIds, id] }
          : t,
      );
    } else if (onFeet && back?.type === "racket" && back.racketId) {
      let restored = false;
      territories = territories.map((t) => ({
        ...t,
        rackets: t.rackets.map((r) => {
          if (r.id !== back.racketId || r.managerId) return r;
          restored = true;
          return { ...r, managerId: id };
        }),
      }));
      assignment = restored ? back : { type: "idle" };
    } else if (onFeet && (back?.type === "safehouse" || back?.type === "delivery" || back?.type === "idle")) {
      assignment = back.type === "idle" ? { type: "idle" } : back;
    } else if (onFeet && (back?.type === "surveillance" || back?.type === "operation")) {
      const op = state.operations.find((o) => o.id === back.operationId);
      assignment = op && !op.resolved ? back : { type: "idle" };
    } else {
      assignment = { type: "idle" };
    }
    crew = crew.map((c) => (c.id === id ? { ...c, assignment, returnTo: undefined } : c));
  }
  return { ...state, crew, territories, supplyRoutes };
}
