import type { FamilyName, GameState } from "@/types/game";
import { needsManager, launderSlack } from "./economy";
import { activeDeals, dealKindLabel, dealPartner } from "./deals";
import type { OnboardingAction } from "./onboarding";
import { lawyerAuditReads } from "./auditReads";
import { lawyerShortName } from "./lawyer";

export interface LooseEnd {
  id: string;
  label: string;
  count: number;
  action: OnboardingAction;
}

/** Dirty cash and spare room both have to clear this before the wash is worth a nag. */
const LAUNDER_NAG_MIN = 500;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Things the player probably meant to handle before the week closes.
 * Read off the state each time; nothing is stored.
 */
export function unfinishedBusiness(state: GameState): LooseEnd[] {
  const family = state.playerFamily;
  if (!family) return [];
  const ends: LooseEnd[] = [];
  const turn = state.turn;

  const idle = state.crew.filter(
    (c) =>
      c.family === family &&
      c.status === "active" &&
      c.assignment.type === "idle" &&
      c.role !== "boss" &&
      !(c.awayAt && c.awayAt.untilTurn > turn),
  );
  if (idle.length > 0) {
    ends.push({
      id: "idle",
      label: `${plural(idle.length, "man", "men")} idle`,
      count: idle.length,
      action: { kind: "panel", panel: "crew" },
    });
  }

  const unmanaged: { territoryId: string }[] = [];
  for (const t of state.territories) {
    if (t.owner !== family) continue;
    for (const r of t.rackets) {
      if (needsManager(r.type) && !r.managerId) unmanaged.push({ territoryId: t.id });
    }
  }
  if (unmanaged.length > 0) {
    ends.push({
      id: "unmanaged",
      label: `${plural(unmanaged.length, "racket", "rackets")} unmanaged`,
      count: unmanaged.length,
      action:
        unmanaged.length === 1
          ? { kind: "territory", territoryId: unmanaged[0]!.territoryId }
          : { kind: "panel", panel: "rackets" },
    });
  }

  const inside = state.crew.filter(
    (c) => c.family === family && c.status === "jailed" && c.role !== "boss" && !c.caseFought,
  );
  if (inside.length > 0) {
    ends.push({
      id: "inside",
      label: `${plural(inside.length, "man", "men")} inside with no lawyer working the case`,
      count: inside.length,
      action: { kind: "panel", panel: "lawyer" },
    });
  }

  for (const read of lawyerAuditReads(state)) {
    if (read.advice !== "pause" || !(state.launderPlan?.[read.racketId] ?? 0)) continue;
    ends.push({
      id: `audit_${read.racketId}`,
      label: `${lawyerShortName(state)} says pause the ${read.label} in ${read.districtName}`,
      count: 1,
      action: { kind: "panel", panel: "laundering" },
    });
  }

  const slack = launderSlack(state);
  if (slack.unrouted >= LAUNDER_NAG_MIN && slack.spareCap >= LAUNDER_NAG_MIN) {
    const room = Math.min(slack.unrouted, slack.spareCap);
    ends.push({
      id: "laundry",
      label: `$${room.toLocaleString("en-US")} of dirty cash could be washing`,
      count: 1,
      action: { kind: "panel", panel: "laundering" },
    });
  }

  const expiring: string[] = [];
  for (const deal of activeDeals(state)) {
    if (deal.untilTurn === turn + 1) {
      expiring.push(`${dealKindLabel(deal.kind).toLowerCase()} with ${dealPartner(state, deal)}`);
    }
  }
  const pacts = state.diplomacy?.pacts ?? {};
  for (const rival of Object.keys(pacts) as FamilyName[]) {
    if (pacts[rival] === turn + 1) expiring.push(`pact with ${rival}`);
  }
  for (const p of state.passageDeals ?? []) {
    if (p.status === "active" && p.holder === family && p.untilTurn === turn + 1) {
      expiring.push(`passage through ${p.family}`);
    }
  }
  if (expiring.length > 0) {
    ends.push({
      id: "expiring",
      label:
        expiring.length === 1
          ? `The ${expiring[0]} runs out this week`
          : `${expiring.length} deals run out this week`,
      count: expiring.length,
      action: { kind: "panel", panel: "commission" },
    });
  }

  return ends;
}

/** "2 men idle, 1 racket unmanaged" */
export function looseEndsSummary(ends: LooseEnd[]): string {
  return ends.map((e) => e.label).join(", ");
}
