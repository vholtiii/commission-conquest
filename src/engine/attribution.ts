import type { FamilyName, GameState, HitCinematic, HitResult, Operation, TurnLogEntry } from "@/types/game";
import { CASE_THIN_THRESHOLD } from "@/types/game";
import { getRelation, statusFromScore } from "./relations";
import { activeDeals } from "./deals";
import { isSolved, topSuspect } from "./incidents";

export type AttributionLevel = "named" | "suspected" | "unknown";

export interface Attribution {
  level: AttributionLevel;
  /** Who the street points at. Set for named and suspected lines. */
  family?: FamilyName;
}

/**
 * How much the Commission knows about who ordered a hit. Our own jobs we
 * know. Hits on us go by the case file. Rival-on-rival work is named only
 * when it was meant to be read as a signature: open war, a message hit, a
 * public killing, blood at a table, or a contract we brokered ourselves.
 */
export function attributeHit(state: GameState, op: Operation, result: HitResult): Attribution {
  const attacker = op.family;
  const victim = op.targetFamily;
  const player = state.playerFamily;

  if (attacker === player) return { level: "named", family: attacker };

  if (victim === player) {
    const incident = (state.incidents ?? []).find((i) => i.id.startsWith(`case_hit_${op.id}_`));
    const top = incident ? topSuspect(incident) : undefined;
    if (incident && top && isSolved(incident)) return { level: "named", family: top.family };
    if (top && top.confidence >= CASE_THIN_THRESHOLD) return { level: "suspected", family: top.family };
    return { level: "unknown" };
  }

  const status = statusFromScore(getRelation(state.relations, attacker, victim));
  const contract = activeDeals({ deals: state.deals ?? [], turn: state.turn, playerFamily: player }).some(
    (d) => d.kind === "alliance" && d.obligor === attacker && d.terms.targetFamily === victim,
  );
  const signature =
    status === "war" ||
    op.intent === "message" ||
    op.approach === "sitdown_betrayal" ||
    result.outcome === "messy_kill" ||
    contract;
  if (signature) return { level: "named", family: attacker };

  // Shooters left behind, dead or in cuffs, get identified.
  const exposed = result.outcome === "botched_arrested" || result.outcome === "botched_killed";
  const grudge = (state.grudges ?? []).some(
    (g) => g.family === attacker && g.against === victim && g.expiresTurn > state.turn,
  );
  if (status === "hostile" || exposed || grudge) return { level: "suspected", family: attacker };

  return { level: "unknown" };
}

/** Attribution for a reel or its card, from the operation it came from. */
export function attributeCinematic(state: GameState, cinematic: HitCinematic): Attribution {
  const op = state.operations.find((o) => o.id === cinematic.operationId);
  if (!op) {
    return cinematic.attackerFamily === state.playerFamily
      ? { level: "named", family: cinematic.attackerFamily }
      : { level: "unknown" };
  }
  return attributeHit(state, op, cinematic.result);
}

/** "Salvati", "Salvati?" or "Somebody", for headers and badges. */
export function attributionLabel(who: Attribution): string {
  if (who.level === "named" && who.family) return who.family;
  if (who.level === "suspected" && who.family) return `${who.family}?`;
  return "Somebody";
}

function roleWord(role: string): string {
  return role.replace("_", " ");
}

/** One line for the minutes: who did what to whom, as far as anyone can say. */
export function hitMinute(
  state: Pick<GameState, "crew" | "territories">,
  op: Operation,
  result: HitResult,
  who: Attribution,
): string {
  const mark = op.targetCrewId ? state.crew.find((c) => c.id === op.targetCrewId) : undefined;
  const block = state.territories.find((t) => t.id === (result.strikeTerritoryId ?? op.targetTerritoryId))?.name;
  const subject = who.level === "named" && who.family ? who.family : "Somebody";
  const target = mark
    ? `${mark.name}, ${roleWord(mark.role)} to the ${op.targetFamily} family`
    : `the ${op.targetFamily} family${block ? ` on ${block}` : ""}`;

  let line: string;
  if (result.markAbsent) {
    line = `${subject} came for ${target} and found nobody home.`;
  } else if (result.targetDead) {
    const inBlock = block ? ` in ${block}` : "";
    const verb =
      op.approach === "car_bomb"
        ? "put a bomb under"
        : op.approach === "sitdown_betrayal" || op.approach === "drive_by"
          ? "shot"
          : "gunned down";
    const where =
      op.approach === "sitdown_betrayal"
        ? " at the table"
        : op.approach === "drive_by"
          ? ` from a passing car${inBlock}`
          : inBlock;
    line = `${subject} ${verb} ${target}${where}.`;
  } else {
    const tail =
      result.outcome === "botched_arrested"
        ? "the cops took the shooters"
        : result.outcome === "botched_killed"
          ? "the shooters were cut down"
          : result.outcome === "botched_wounded"
            ? "he lived"
            : "he walked away";
    line = `${subject} went after ${target} — ${tail}.`;
  }

  if (who.level === "suspected" && who.family) line += ` The street says ${who.family}.`;
  if (who.level === "named" && op.intent === "message") line += " A message.";
  return line;
}

/** Log entry for a rival-ordered hit, carrying only what the street knows. */
export function hitLogEntry(state: GameState, op: Operation, result: HitResult, id: string): TurnLogEntry {
  const who = attributeHit(state, op, result);
  return {
    id,
    turn: state.turn,
    category: "hit",
    text: hitMinute(state, op, result, who),
    family: who.level === "named" ? who.family : undefined,
    attribution: who.level,
    suspect: who.level === "suspected" ? who.family : undefined,
    victim: op.targetFamily,
  };
}
