import type { FamilyName, TurnLogEntry } from "@/types/game";

function mentionsPlayer(text: string, player: FamilyName): boolean {
  return (
    text.includes("shook down your") ||
    text.includes("your unguarded") ||
    text.includes(`from ${player}`) ||
    text.includes(`hijacks a ${player}`)
  );
}

/** Lower numbers surface first. Tier 7 is rival-on-rival noise. */
export function digestPriority(log: TurnLogEntry, playerFamily: FamilyName | null): number {
  if (
    log.id.startsWith("log_sitdown_held_") ||
    log.id.startsWith("log_sitdown_table_") ||
    log.id.startsWith("log_sitdown_abort_") ||
    log.id.startsWith("log_sitdown_host_")
  ) {
    return 0;
  }
  if (log.category === "hit") return 1;
  if (
    log.id.startsWith("log_raid_") ||
    log.id.startsWith("log_audit_") ||
    log.id.startsWith("log_heat_warrant_") ||
    log.id.startsWith("log_heat_federal_")
  ) {
    return 2;
  }
  if (
    log.category === "ai" &&
    playerFamily &&
    mentionsPlayer(log.text, playerFamily)
  ) {
    return 3;
  }
  if (log.category === "event" || log.category === "diplomacy") return 4;
  if (
    log.id.startsWith("log_ship_") ||
    log.id.startsWith("log_dump_") ||
    log.id.startsWith("log_liquor_") ||
    log.category === "delivery"
  ) {
    return 5;
  }
  if (
    log.id.startsWith("log_xp_") ||
    log.id.startsWith("log_launder_nudge_") ||
    log.id.startsWith("log_boss_")
  ) {
    return 6;
  }
  if (log.category === "ai") return 7;
  return 8;
}

function isDigestCandidate(log: TurnLogEntry, turn: number): boolean {
  if (log.turn !== turn) return false;
  if (
    log.category === "system" &&
    !log.id.startsWith("log_xp_") &&
    !log.id.startsWith("log_boss_")
  ) {
    return false;
  }
  return true;
}

export function selectDigestLines(
  logs: TurnLogEntry[],
  playerFamily: FamilyName | null,
  turn?: number,
): TurnLogEntry[] {
  const pool =
    turn == null ? logs : logs.filter((log) => isDigestCandidate(log, turn));
  const ranked = pool
    .map((log, index) => ({ log, index, priority: digestPriority(log, playerFamily) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const picked: { log: TurnLogEntry; priority: number }[] = [];
  let rivalNoise = 0;
  for (const item of ranked) {
    if (item.priority === 7) {
      if (rivalNoise >= 1) continue;
      rivalNoise += 1;
    }
    picked.push(item);
    if (picked.length >= 6) break;
  }

  if (picked.length === 0) return [];
  if (picked.length < 3 && picked.every((item) => item.priority >= 5)) return [];
  return picked.map((item) => item.log);
}
