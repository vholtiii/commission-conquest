import type { HitApproach, HitBeat, HitPerspective, HitResult } from "@/types/game";

export interface PhaseDef {
  name: string;
  duration: number;
  caption: HitBeat["phase"] | "hold";
  label: string;
}

function police(result: HitResult): boolean {
  return result.outcome === "botched_arrested" || result.outcome === "botched_killed";
}

/**
 * A witnessed hit is somebody else's business: you arrive as the shots go off,
 * so only the last two beats play — roughly half the reel.
 */
export function timelineFor(
  approach: HitApproach,
  result: HitResult,
  perspective: HitPerspective = "ours",
): PhaseDef[] {
  const full = fullTimeline(approach, result);
  return perspective === "witnessed" ? full.slice(-2) : full;
}

function fullTimeline(approach: HitApproach, result: HitResult): PhaseDef[] {
  const c = result.complication;
  if (approach === "car_bomb") {
    if (c === "cop_on_fender") {
      return [
        { name: "plant", duration: 2.2, caption: "approach", label: "The plant" },
        { name: "abort", duration: 2.6, caption: "complication", label: "Called off" },
        { name: "aftermath", duration: 1.8, caption: "getaway", label: "Away" },
      ];
    }
    if (result.markAbsent) {
      return [
        { name: "plant", duration: 1.8, caption: "approach", label: "The plant" },
        { name: "wait", duration: 2.8, caption: "complication", label: "The wait" },
        { name: "aftermath", duration: 2.0, caption: "execution", label: "Nobody" },
      ];
    }
    const fizzle = c === "dud" || c === "rain";
    return [
      { name: "plant", duration: 1.8, caption: "approach", label: "The plant" },
      { name: "wait", duration: 1.8, caption: "complication", label: "The wait" },
      { name: "detonate", duration: 1.8, caption: "execution", label: fizzle ? "The fuse" : "Detonation" },
      { name: "aftermath", duration: police(result) ? 2.2 : 1.6, caption: "getaway", label: police(result) ? "The law" : "Aftermath" },
    ];
  }
  if (approach === "drive_by") {
    return [
      { name: "roll", duration: 2.0, caption: "approach", label: "En route" },
      { name: "pass", duration: 1.6, caption: "complication", label: "The pass" },
      { name: "spray", duration: 1.6, caption: "execution", label: "The spray" },
      { name: "getaway", duration: police(result) ? 2.2 : 1.8, caption: "getaway", label: police(result) ? "The law" : "Getaway" },
    ];
  }
  if (approach === "summons") {
    return [
      { name: "call", duration: 1.6, caption: "approach", label: "The call" },
      { name: "drive", duration: 2.4, caption: "complication", label: "The drive" },
      { name: "back_room", duration: 1.6, caption: "execution", label: "The back room" },
      { name: "drive_off", duration: 1.8, caption: "getaway", label: "Gone" },
    ];
  }
  if (approach === "sitdown_betrayal") {
    return [
      { name: "arrive", duration: 2.0, caption: "approach", label: "Arrival" },
      { name: "table", duration: 2.2, caption: "complication", label: "The table" },
      { name: "handshake", duration: 1.4, caption: "execution", label: "The handshake" },
      { name: "walk_out", duration: police(result) ? 2.2 : 1.6, caption: "getaway", label: police(result) ? "The law" : "The walk" },
    ];
  }
  return [
    { name: "position", duration: 1.8, caption: "approach", label: "In position" },
    { name: "wait", duration: 2.0, caption: "complication", label: "The wait" },
    { name: "strike", duration: 1.5, caption: "execution", label: "The hit" },
    { name: "melt", duration: police(result) ? 2.2 : 1.7, caption: "getaway", label: police(result) ? "The law" : "Away" },
  ];
}

export function totalDuration(phases: PhaseDef[]): number {
  return phases.reduce((sum, p) => sum + p.duration, 0);
}

export function phaseAt(
  phases: PhaseDef[],
  t: number,
): { phase: PhaseDef; local: number; index: number } {
  let acc = 0;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    if (t < acc + phase.duration || i === phases.length - 1) {
      const local = phase.duration <= 0 ? 1 : Math.min(1, Math.max(0, (t - acc) / phase.duration));
      return { phase, local, index: i };
    }
    acc += phase.duration;
  }
  const last = phases[phases.length - 1]!;
  return { phase: last, local: 1, index: Math.max(0, phases.length - 1) };
}
