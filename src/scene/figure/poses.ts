/**
 * Joint targets for the reel figure. Angles are radians on the joint's local axes:
 * a negative X turn swings a hanging limb forward, a positive X turn on a shin or
 * forearm-free spine bends the knee back or leans the chest forward.
 */
export const JOINTS = [
  "hipY",
  "hipX",
  "hipZ",
  "spineX",
  "spineY",
  "spineZ",
  "neckX",
  "neckY",
  "lShoulderX",
  "lShoulderZ",
  "lElbow",
  "rShoulderX",
  "rShoulderY",
  "rShoulderZ",
  "rElbow",
  "lThigh",
  "lThighZ",
  "lKnee",
  "lAnkle",
  "rThigh",
  "rThighZ",
  "rKnee",
  "rAnkle",
  "tail",
  "fallPitch",
  "fallDrop",
  "fallBack",
] as const;

export type Joint = (typeof JOINTS)[number];
export type Joints = Record<Joint, number>;

export type PoseKind = "idle" | "walk" | "run" | "crouch" | "aim" | "talk" | "sit" | "handshake" | "getIn" | "down";

export interface PoseContext {
  /** Seconds. */
  t: number;
  /** Per-figure phase offset so a crowd does not move in step. */
  gait: number;
  /** 0-1 per figure, for idle habits. */
  seed: number;
  armed: boolean;
  /** Seconds since the shot, for `down`. */
  since: number;
  firing: boolean;
}

export function restJoints(): Joints {
  const j = {} as Joints;
  for (const k of JOINTS) j[k] = 0;
  return j;
}

function smooth(v: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function idle(j: Joints, c: PoseContext): void {
  const { t, seed } = c;
  j.spineX = 0.02 * Math.sin(t * 1.6 + seed * 6) + 0.03;
  j.hipZ = 0.035 * Math.sin(t * 0.45 + seed * 10);
  j.lThighZ = -j.hipZ;
  j.rThighZ = -j.hipZ;
  j.lThigh = -0.03;
  j.rThigh = 0.05;
  j.lKnee = 0.06 + Math.max(0, j.hipZ) * 2;
  j.rKnee = 0.06 + Math.max(0, -j.hipZ) * 2;
  j.lShoulderX = 0.02;
  j.rShoulderX = 0.02;
  j.lShoulderZ = -0.09;
  j.rShoulderZ = 0.09;
  j.lElbow = -0.18;
  j.rElbow = -0.18;
  // Now and then he looks down the street.
  const glance = Math.sin(t * 0.33 + seed * 20);
  j.neckY = 0.5 * Math.sign(glance) * smooth(Math.abs(glance), 0.7, 0.95);
  j.neckX = 0.03 * Math.sin(t * 0.9 + seed * 3);
}

function stride(j: Joints, c: PoseContext, run: boolean): void {
  const f = c.t * (run ? 12.5 : 7.4) + c.gait;
  const s = Math.sin(f);
  const co = Math.cos(f);
  const thigh = run ? 0.85 : 0.48;
  j.lThigh = -thigh * s;
  j.rThigh = thigh * s;
  // The knee folds while the leg swings through.
  j.lKnee = (run ? 0.25 : 0.08) + (run ? 1.25 : 0.62) * Math.max(0, co);
  j.rKnee = (run ? 0.25 : 0.08) + (run ? 1.25 : 0.62) * Math.max(0, -co);
  j.lAnkle = -0.25 * Math.max(0, co);
  j.rAnkle = -0.25 * Math.max(0, -co);
  const arm = run ? 0.85 : 0.42;
  j.lShoulderX = arm * s;
  j.rShoulderX = -arm * s;
  j.lShoulderZ = -0.07;
  j.rShoulderZ = 0.07;
  j.lElbow = run ? -1.35 : -0.25 - 0.2 * Math.max(0, -s);
  j.rElbow = run ? -1.35 : -0.25 - 0.2 * Math.max(0, s);
  j.hipY = (run ? 0.035 : 0.014) * Math.cos(2 * f) - (run ? 0.03 : 0);
  j.hipZ = 0.04 * s;
  j.spineY = (run ? 0.18 : 0.1) * s;
  j.spineX = run ? 0.22 : 0.05;
  j.neckX = run ? -0.12 : -0.02;
  j.tail = run ? 0.55 + 0.12 * Math.sin(2 * f) : 0.12 + 0.05 * Math.sin(2 * f);
}

function crouch(j: Joints, c: PoseContext): void {
  j.hipY = -0.2;
  j.lThigh = -1.25;
  j.rThigh = -0.5;
  j.lKnee = 1.75;
  j.rKnee = 1.9;
  j.lAnkle = -0.5;
  j.rAnkle = 0.4;
  j.spineX = 0.38;
  j.neckX = -0.3;
  j.lShoulderX = -0.4;
  j.lElbow = -0.9;
  j.rShoulderX = c.armed ? -1.35 : -0.35;
  j.rElbow = c.armed ? -0.15 : -0.9;
  j.tail = 0.3;
}

function aim(j: Joints, c: PoseContext): void {
  j.lThigh = -0.22;
  j.rThigh = 0.22;
  j.lKnee = 0.18;
  j.rKnee = 0.12;
  j.hipZ = 0.02;
  j.spineX = 0.06;
  const kick = c.firing ? 0.1 * Math.max(0, Math.sin(c.t * 34)) : 0;
  j.rShoulderX = -1.5 - kick;
  j.rShoulderZ = 0.08;
  j.rElbow = -0.06 + kick * 0.5;
  // Support hand under the grip.
  j.lShoulderX = -1.28 - kick;
  j.lShoulderZ = 0.55;
  j.lElbow = -0.55;
  j.neckX = 0.05;
}

function talk(j: Joints, c: PoseContext): void {
  idle(j, c);
  const g = Math.sin(c.t * 2.3 + c.seed * 9);
  j.rShoulderX = -0.55 - 0.3 * Math.max(0, g);
  j.rShoulderZ = 0.18;
  j.rElbow = -1.05 - 0.2 * Math.sin(c.t * 4.1);
  j.lShoulderX = -0.25 * Math.max(0, -g);
  j.lElbow = -0.4 - 0.5 * Math.max(0, -g);
  j.neckX = 0.06 * Math.sin(c.t * 3.1);
  j.neckY = 0;
}

function sit(j: Joints, c: PoseContext): void {
  talk(j, c);
  j.hipY = -0.24;
  j.lThigh = -1.5;
  j.rThigh = -1.45;
  j.lKnee = 1.5;
  j.rKnee = 1.45;
  j.lThighZ = -0.1;
  j.rThighZ = 0.1;
  j.hipZ = 0;
  j.spineX = 0.12;
  j.tail = 0;
}

function handshake(j: Joints, c: PoseContext): void {
  idle(j, c);
  j.spineX = 0.1;
  j.rShoulderX = -0.85 + 0.12 * Math.sin(c.t * 9);
  j.rShoulderZ = -0.05;
  j.rElbow = -0.45;
  j.neckX = 0.08;
  j.neckY = 0;
}

function getIn(j: Joints): void {
  j.hipY = -0.12;
  j.spineX = 0.95;
  j.neckX = -0.4;
  j.lThigh = -0.7;
  j.rThigh = -0.1;
  j.lKnee = 1.0;
  j.rKnee = 0.35;
  j.rShoulderX = -0.9;
  j.rElbow = -0.3;
  j.lShoulderX = -0.3;
  j.lElbow = -0.6;
  j.tail = 0.25;
}

/** The shot snaps him back, the knees go, then he lies on his back. */
function down(j: Joints, c: PoseContext): void {
  const impact = smooth(c.since, 0, 0.18);
  const knees = smooth(c.since, 0.18, 0.55);
  const flat = smooth(c.since, 0.45, 1.05);
  const buckle = knees * (1 - flat);
  j.spineX = -0.45 * impact * (1 - flat);
  j.spineZ = Math.sin(c.since * 26) * 0.18 * impact * (1 - knees);
  j.neckX = -0.4 * impact * (1 - flat) + 0.25 * flat;
  j.neckY = 0.45 * flat;
  j.lShoulderX = -2.0 * impact * (1 - flat) - 0.3 * flat;
  j.rShoulderX = -1.6 * impact * (1 - flat) - 0.15 * flat;
  j.lShoulderZ = -1.25 * flat;
  j.rShoulderZ = 0.9 * flat;
  j.lElbow = -0.5 * impact * (1 - flat) - 0.3 * flat;
  j.rElbow = -0.3 * impact * (1 - flat) - 0.6 * flat;
  j.lThigh = -0.7 * buckle + 0.1 * flat;
  j.rThigh = -0.55 * buckle - 0.25 * flat;
  j.lKnee = 1.3 * buckle + 0.08 * flat;
  j.rKnee = 1.2 * buckle + 0.45 * flat;
  j.rThighZ = 0.15 * flat;
  j.hipY = -0.24 * buckle;
  j.fallPitch = -1.5 * flat;
  j.fallDrop = 0.42 * flat;
  j.fallBack = 0.14 * impact;
}

export function targetPose(kind: PoseKind, c: PoseContext, out: Joints): Joints {
  for (const k of JOINTS) out[k] = 0;
  switch (kind) {
    case "walk":
      stride(out, c, false);
      break;
    case "run":
      stride(out, c, true);
      break;
    case "crouch":
      crouch(out, c);
      break;
    case "aim":
      aim(out, c);
      break;
    case "talk":
      talk(out, c);
      break;
    case "sit":
      sit(out, c);
      break;
    case "handshake":
      handshake(out, c);
      break;
    case "getIn":
      getIn(out);
      break;
    case "down":
      down(out, c);
      break;
    default:
      idle(out, c);
  }
  return out;
}

/** How quickly a joint chases its target. Cycles need to be tight; a fall carries its own timing. */
export function blendRate(kind: PoseKind): number {
  if (kind === "down") return 40;
  if (kind === "run") return 22;
  if (kind === "walk") return 18;
  return 9;
}
