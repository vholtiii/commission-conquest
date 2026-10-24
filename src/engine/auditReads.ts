import type { GameState, RetainerTier, TurnLogEntry } from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import { AUDIT_THRESHOLD, isLaunderSiteSetUp } from "./economy";
import { activeRetainer, lawyerShortName } from "./lawyer";
import { createRng, hashString } from "./rng";

/** Scrutiny at which the better lawyers start to smell a file coming. */
export const NEAR_FILE = 0.6;
const STREET_SPOTS_FILE = 0.6;
const STREET_FALSE_ALARM = 0.2;
const HOUSE_SPOTS_NEAR = 0.5;

export interface AuditRead {
  racketId: string;
  territoryId: string;
  label: string;
  districtName: string;
  /** "pause": he says stop washing here. "ease": he says pull it back. */
  advice: "pause" | "ease";
  /** What he says on the front's row. */
  tag: string;
  /** The week he names, top-shelf only. */
  dueTurn?: number;
}

/** A roll that holds steady for one file, or for a fortnight when there's no file. */
function steadyRoll(state: Pick<GameState, "seed" | "turn">, racketId: string, tier: RetainerTier, key: number | string): number {
  return createRng(hashString(`${state.seed}:${racketId}:${tier}:${key}`)).next();
}

/**
 * What the lawyer tells you about Treasury and your fronts. How much he sees
 * depends on the retainer: nothing without one, patchy on the street, reliable
 * at the house, and the exact week from the top shelf.
 */
export function lawyerAuditReads(state: GameState): AuditRead[] {
  const tier = activeRetainer(state);
  if (!tier || !state.playerFamily) return [];
  const reads: AuditRead[] = [];
  const fortnight = Math.floor(state.turn / 2);
  for (const t of state.territories) {
    if (t.owner !== state.playerFamily) continue;
    for (const r of t.rackets) {
      if (!isLaunderSiteSetUp(r)) continue;
      const base = {
        racketId: r.id,
        territoryId: t.id,
        label: RACKET_LABELS[r.type],
        districtName: t.name,
      };
      const scrutiny = r.scrutiny ?? 0;
      const open = r.auditDueTurn != null && r.auditDueTurn > state.turn;
      if (tier === "street") {
        if (open) {
          if (steadyRoll(state, r.id, tier, r.auditOpenedTurn ?? 0) < STREET_SPOTS_FILE) {
            reads.push({ ...base, advice: "pause", tag: "Lawyer: pause this one" });
          }
        } else if (scrutiny > 0 && steadyRoll(state, r.id, tier, `false:${fortnight}`) < STREET_FALSE_ALARM) {
          reads.push({ ...base, advice: "pause", tag: "Lawyer: pause this one" });
        }
        continue;
      }
      if (open) {
        const weeks = r.auditDueTurn! - state.turn;
        reads.push(
          tier === "top"
            ? {
                ...base,
                advice: "pause",
                tag: `Treasury file open: lands week ${r.auditDueTurn} (${weeks === 1 ? "next week" : `${weeks} weeks`})`,
                dueTurn: r.auditDueTurn,
              }
            : { ...base, advice: "pause", tag: "Treasury file open, lands within a few weeks" },
        );
        continue;
      }
      if (scrutiny >= NEAR_FILE && scrutiny < AUDIT_THRESHOLD) {
        const spots = tier === "top" || steadyRoll(state, r.id, tier, `near:${fortnight}`) < HOUSE_SPOTS_NEAR;
        if (spots) reads.push({ ...base, advice: "ease", tag: "Lawyer: ease off before Treasury opens a file" });
      }
    }
  }
  return reads;
}

/** Log lines for fronts the lawyer flags this week that he wasn't flagging last week. */
export function newFlagLogs(before: GameState, after: GameState): TurnLogEntry[] {
  const was = new Set(lawyerAuditReads(before).map((r) => r.racketId));
  const name = lawyerShortName(after);
  return lawyerAuditReads(after)
    .filter((r) => !was.has(r.racketId))
    .map((r) => ({
      id: `log_lawyer_flag_${after.turn}_${r.racketId}`,
      turn: after.turn,
      category: "economy" as const,
      text:
        r.advice === "pause"
          ? `${name} says pause the ${r.label} in ${r.districtName}.`
          : `${name} says ease off the ${r.label} in ${r.districtName}.`,
      family: after.playerFamily ?? undefined,
      territoryId: r.territoryId,
      tone: "warning" as const,
    }));
}
