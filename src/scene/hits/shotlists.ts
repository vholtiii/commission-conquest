/** Shot ranges for one beat. `start`/`end` are fractions of that beat, and together they cover 0–1. */
export interface ShotRange {
  id: string;
  start: number;
  end: number;
}

function shot(id: string, start: number, end: number): ShotRange {
  return { id, start, end };
}

export const DRIVE_BY: Record<string, ShotRange[]> = {
  roll: [shot("roll-track", 0, 0.55), shot("roll-window", 0.55, 1)],
  pass: [shot("pass-two", 0, 0.45), shot("pass-kerb", 0.45, 1)],
  spray: [shot("spray-wide", 0, 0.28), shot("spray-punch", 0.28, 0.62), shot("spray-hold", 0.62, 1)],
  getaway: [shot("getaway-body", 0, 0.55), shot("getaway-pull", 0.55, 1)],
};

export const CAR_BOMB: Record<string, ShotRange[]> = {
  stakeout: [shot("stake-car", 0, 0.4), shot("stake-watch", 0.4, 0.75), shot("stake-door", 0.75, 1)],
  plant: [shot("plant-walk", 0, 0.45), shot("plant-kneel", 0.45, 0.75), shot("plant-leave", 0.75, 1)],
  wait: [shot("wait-push", 0, 1)],
  abort: [shot("abort-two", 0, 0.4), shot("abort-close", 0.4, 1)],
  detonate: [shot("detonate-wide", 0, 0.22), shot("detonate-punch", 0.22, 0.62), shot("detonate-hold", 0.62, 1)],
  aftermath: [shot("aftermath-body", 0, 0.58), shot("aftermath-crane", 0.58, 1)],
};

export const AMBUSH: Record<string, ShotRange[]> = {
  position: [shot("position-alley", 0, 1)],
  wait: [shot("wait-long", 0, 1)],
  strike: [shot("strike-wide", 0, 0.2), shot("strike-punch", 0.2, 0.58), shot("strike-fall", 0.58, 1)],
  melt: [shot("melt-body", 0, 0.55), shot("melt-pull", 0.55, 1)],
};

export const SUMMONS: Record<string, ShotRange[]> = {
  call: [shot("call-door", 0, 1)],
  drive: [shot("drive-car", 0, 0.4), shot("drive-walk", 0.4, 1)],
  back_room: [shot("room-dolly", 0, 0.45), shot("room-hold", 0.45, 1)],
  drive_off: [shot("off-track", 0, 1)],
};

export const BETRAYAL: Record<string, ShotRange[]> = {
  arrive: [shot("arrive-kerb", 0, 1)],
  table: [shot("table-push", 0, 1)],
  handshake: [shot("hands-close", 0, 0.35), shot("hands-punch", 0.35, 0.7), shot("hands-hold", 0.7, 1)],
  walk_out: [shot("walk-body", 0, 0.55), shot("walk-pull", 0.55, 1)],
};

/** Sit-down beats. The drive is split by how far the cars have come, not by a timeline phase name. */
export const SITDOWN: Record<string, ShotRange[]> = {
  "drive-chase": [shot("chase-p", 0, 0.5), shot("chase-r", 0.5, 1)],
  "drive-arrive": [shot("arrive", 0, 0.4), shot("walk", 0.4, 0.78), shot("meet", 0.78, 1)],
  table: [shot("table-street", 0, 0.34), shot("table-window", 0.34, 0.67), shot("table-post", 0.67, 1)],
  "exit-handshake": [shot("ex-shake", 0, 0.45), shot("ex-cars", 0.45, 0.78), shot("ex-away", 0.78, 1)],
  "exit-betrayed": [shot("ex-window", 0, 0.14), shot("ex-punch", 0.14, 0.42), shot("ex-pull", 0.42, 1)],
  "exit-trap": [shot("ex-out", 0, 0.47), shot("ex-away", 0.47, 1)],
  "exit-leave": [shot("ex-out", 0, 0.43), shot("ex-away", 0.43, 1)],
};

export const SHOT_LISTS: Record<string, Record<string, ShotRange[]>> = {
  drive_by: DRIVE_BY,
  car_bomb: CAR_BOMB,
  ambush: AMBUSH,
  summons: SUMMONS,
  sitdown_betrayal: BETRAYAL,
};

/** True when the ranges cover the whole beat without a gap. */
export function listCovers(shots: { start: number; end: number }[]): boolean {
  if (shots.length === 0) return false;
  const sorted = [...shots].sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted[0]!.start > 0.001) return false;
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor + 0.001) return false;
    if (s.end < s.start) return false;
    cursor = Math.max(cursor, s.end);
  }
  return cursor >= 0.999;
}
