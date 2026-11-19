import type { HitApproach, HitBeat, HitPerspective, HitResult } from "@/types/game";

export interface ScaleKey {
  /** 0–1 through the phase, on the timeline clock. */
  at: number;
  scale: number;
}

export interface PhaseDef {
  name: string;
  /** Timeline seconds. Wall clock runs longer wherever `scale` drops. */
  duration: number;
  caption: HitBeat["phase"] | "hold";
  label: string;
  /** Playback rate across the phase. Omitted means full speed. */
  scale?: ScaleKey[];
  /** Timeline fraction when this phase's sound plays. Defaults to the start. */
  cueAt?: number;
}

/**
 * A window of slow motion about 0.8s long on screen. `at` is the timeline fraction
 * where it is slowest; the timeline only advances a little, so the wall clock holds.
 */
function slow(at: number): ScaleKey[] {
  const span = 0.075;
  const ramp = 0.035;
  const a = Math.max(0, at - ramp);
  const b = at;
  const c = Math.min(1, at + span);
  const d = Math.min(1, c + ramp);
  return [
    { at: 0, scale: 1 },
    { at: a, scale: 1 },
    { at: b, scale: 0.3 },
    { at: c, scale: 0.3 },
    { at: d, scale: 1 },
    { at: 1, scale: 1 },
  ];
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
        { name: "plant", duration: 3.4, caption: "approach", label: "The plant" },
        { name: "abort", duration: 4.4, caption: "complication", label: "Called off" },
        { name: "aftermath", duration: 3.4, caption: "getaway", label: "Away" },
      ];
    }
    if (result.markAbsent) {
      return [
        { name: "plant", duration: 3.2, caption: "approach", label: "The plant" },
        { name: "wait", duration: 4.6, caption: "complication", label: "The wait" },
        { name: "aftermath", duration: 3.6, caption: "execution", label: "Nobody" },
      ];
    }
    const fizzle = c === "dud" || c === "rain";
    return [
      { name: "stakeout", duration: 3.0, caption: "approach", label: "The stakeout" },
      { name: "wait", duration: 2.8, caption: "complication", label: "The wait" },
      {
        name: "detonate",
        duration: 3.2,
        caption: "execution",
        label: fizzle ? "The fuse" : "Detonation",
        scale: fizzle ? undefined : slow(0.28),
        cueAt: 0.22,
      },
      {
        name: "aftermath",
        duration: police(result) ? 3.2 : 2.6,
        caption: "getaway",
        label: police(result) ? "The law" : "Aftermath",
      },
    ];
  }
  if (approach === "drive_by") {
    return [
      { name: "roll", duration: 3.0, caption: "approach", label: "En route" },
      { name: "pass", duration: 2.4, caption: "complication", label: "The pass" },
      { name: "spray", duration: 3.4, caption: "execution", label: "The spray", scale: slow(0.32), cueAt: 0.28 },
      {
        name: "getaway",
        duration: police(result) ? 3.2 : 2.8,
        caption: "getaway",
        label: police(result) ? "The law" : "Getaway",
      },
    ];
  }
  if (approach === "summons") {
    return [
      { name: "call", duration: 2.4, caption: "approach", label: "The call" },
      { name: "drive", duration: 3.6, caption: "complication", label: "The drive" },
      { name: "back_room", duration: 3.2, caption: "execution", label: "The back room", scale: slow(0.5), cueAt: 0.45 },
      { name: "drive_off", duration: 2.6, caption: "getaway", label: "Gone" },
    ];
  }
  if (approach === "sitdown_betrayal") {
    return [
      { name: "arrive", duration: 2.6, caption: "approach", label: "Arrival" },
      { name: "table", duration: 2.8, caption: "complication", label: "The table" },
      { name: "handshake", duration: 3.4, caption: "execution", label: "The handshake", scale: slow(0.4), cueAt: 0.35 },
      {
        name: "walk_out",
        duration: police(result) ? 3.0 : 2.6,
        caption: "getaway",
        label: police(result) ? "The law" : "The walk",
      },
    ];
  }
  return [
    { name: "position", duration: 2.6, caption: "approach", label: "In position" },
    { name: "wait", duration: 3.0, caption: "complication", label: "The wait" },
    { name: "strike", duration: 3.4, caption: "execution", label: "The hit", scale: slow(0.24), cueAt: 0.2 },
    {
      name: "melt",
      duration: police(result) ? 3.0 : 2.6,
      caption: "getaway",
      label: police(result) ? "The law" : "Away",
    },
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

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Playback rate at `local` through the phase. Ramps are eased so the speed never steps. */
export function scaleAt(phase: PhaseDef, local: number): number {
  const keys = phase.scale;
  if (!keys || keys.length === 0) return 1;
  if (local <= keys[0]!.at) return keys[0]!.scale;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (local <= b.at) {
      const span = b.at - a.at;
      const t = span <= 1e-5 ? 1 : (local - a.at) / span;
      return a.scale + (b.scale - a.scale) * smooth(t);
    }
  }
  return keys[keys.length - 1]!.scale;
}

/**
 * Local fractions where a React render has to catch up (a pose, a prop, a light).
 * Motion itself reads the clock ref and does not wait on these.
 */
const RENDER_CUTS: Record<string, number[]> = {
  plant: [0.45, 0.75],
  detonate: [0.2, 0.5],
  handshake: [0.35, 0.43],
  drive: [0.38, 0.44, 0.6, 0.85],
  wait: [0.5],
};

/** Stable key for the current render bucket. Changes only when the picture's props need to. */
export function renderKey(phase: string, local: number): string {
  const cuts = RENDER_CUTS[phase];
  if (!cuts) return phase;
  let bucket = 0;
  for (const c of cuts) if (local >= c) bucket++;
  return bucket === 0 ? phase : `${phase}:${bucket}`;
}

/**
 * A local value that sits inside the current render bucket, just past the cut,
 * so a JSX check written against the old threshold still picks the right branch.
 */
export function frozenLocal(phase: string, local: number): number {
  const cuts = RENDER_CUTS[phase];
  if (!cuts) return local;
  let bucket = 0;
  for (const c of cuts) if (local >= c) bucket++;
  if (bucket === 0) return Math.min(local, (cuts[0] ?? 1) - 0.01);
  return Math.min(0.999, cuts[bucket - 1]! + 0.01);
}
