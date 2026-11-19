import * as THREE from "three";
import { ease, type Shot } from "./cameraRig";

export type ShotMove = "static" | "dollyIn" | "dollyOut" | "orbit" | "crane" | "push" | "track";

export interface DirectedShot {
  id: string;
  /** Fractions of the beat. */
  start: number;
  end: number;
  frame: (u: number) => Shot;
  move?: ShotMove;
  /** Field of view at the start and end of the shot. */
  fov: readonly [number, number];
  transition?: "cut" | "ease";
  /** Spring stiffness for an eased transition. */
  k?: number;
  follow?: boolean;
  handheld?: number;
  /** A fast snap toward the subject, `at` being 0–1 through the shot. */
  punch?: { at: number; fov: number };
  focus?: (u: number) => THREE.Vector3;
  /** Pull the lens back until every one of these stays in frame. */
  subjects?: (u: number) => THREE.Vector3[];
}

export interface CameraFrame {
  frame: (
    beatKey: string,
    shot: Shot,
    opts: {
      k: number;
      dt: number;
      coverage: "wide" | "medium" | "close" | "pull" | "body";
      fov?: number;
      cut?: boolean;
      handheld?: number;
      follow?: boolean;
      focus?: THREE.Vector3;
      preview?: Shot[];
    },
  ) => void;
}

const offset = new THREE.Vector3();
const orbitAxis = new THREE.Vector3(0, 1, 0);
const raised = new THREE.Vector3();
const right = new THREE.Vector3();
const rel = new THREE.Vector3();

/** Dolly, orbit, or crane on top of a framed shot. `u` is 0–1 through the shot. */
export function applyMove(shot: Shot, move: ShotMove | undefined, u: number): Shot {
  if (!move || move === "static" || move === "track") return shot;
  const k = ease(u);
  const look = shot.look.clone();
  offset.copy(shot.pos).sub(look);
  const dist = Math.max(0.4, offset.length());
  if (move === "dollyIn" || move === "push") {
    offset.setLength(dist * (1 - k * (move === "push" ? 0.38 : 0.26)));
  } else if (move === "dollyOut") {
    offset.setLength(dist * (1 + k * 0.34));
  } else if (move === "orbit") {
    offset.applyAxisAngle(orbitAxis, k * 0.5);
  } else if (move === "crane") {
    offset.y += k * 2.5;
    offset.setLength(dist * (1 + k * 0.28));
  }
  return { pos: look.clone().add(offset), look };
}

/** Field of view along the shot, with a brief punch-in over the top of the ramp. */
export function fovAt(spec: DirectedShot, u: number): number {
  let fov = spec.fov[0] + (spec.fov[1] - spec.fov[0]) * ease(u);
  const punch = spec.punch;
  if (!punch) return fov;
  const width = 0.16;
  if (u < punch.at || u > punch.at + width) return fov;
  const k = (u - punch.at) / width;
  const env = k < 0.28 ? k / 0.28 : 1 - (k - 0.28) / 0.72;
  return fov + (punch.fov - fov) * ease(Math.max(0, env));
}

/** Move the camera back along its view until `subjects` fit the lens. */
export function holdSubjects(shot: Shot, subjects: THREE.Vector3[], fovDeg: number): Shot {
  if (subjects.length === 0) return shot;
  offset.copy(shot.pos).sub(shot.look);
  offset.y = 0;
  if (offset.lengthSq() < 1e-6) return shot;
  offset.normalize();
  right.set(-offset.z, 0, offset.x);
  let reach = 0.45;
  for (const s of subjects) {
    rel.copy(s).sub(shot.look);
    reach = Math.max(reach, Math.abs(rel.dot(right)), Math.abs(rel.y - shot.look.y) * 1.15);
  }
  const half = THREE.MathUtils.degToRad(fovDeg) * 0.5;
  const dist = Math.max(offset.length() === 0 ? 0 : shot.pos.distanceTo(shot.look), (reach / Math.tan(half)) * 1.2);
  raised.copy(shot.pos).sub(shot.look);
  if (raised.lengthSq() < 1e-6) raised.set(0, 0.4, 1);
  raised.setLength(dist);
  return { pos: shot.look.clone().add(raised), look: shot.look.clone() };
}

export function activeShot(shots: DirectedShot[], local: number): { spec: DirectedShot; u: number } | null {
  if (shots.length === 0) return null;
  const l = Math.min(0.9999, Math.max(0, local));
  let spec = shots[shots.length - 1]!;
  for (const s of shots) {
    if (l >= s.start && l < s.end) {
      spec = s;
      break;
    }
  }
  const span = Math.max(1e-4, spec.end - spec.start);
  const u = Math.min(1, Math.max(0, (l - spec.start) / span));
  return { spec, u };
}

/** Run the shot list for this frame: move, lens, focus, and a hard cut only where the shot asks. */
export function playShots(cam: CameraFrame, shots: DirectedShot[], local: number, dt: number): void {
  const hit = activeShot(shots, local);
  if (!hit) return;
  const { spec, u } = hit;
  const fov = fovAt(spec, u);
  let shot = applyMove(spec.frame(u), spec.move, u);
  if (spec.subjects) shot = holdSubjects(shot, spec.subjects(u), fov);
  const opening = u < 0.08;
  const preview = opening
    ? [0, 0.5, 1].map((sample) => applyMove(spec.frame(sample), spec.move, sample))
    : undefined;
  cam.frame(spec.id, shot, {
    k: spec.k ?? 0.16,
    dt,
    coverage: "medium",
    fov,
    cut: (spec.transition ?? "ease") === "cut",
    handheld: spec.handheld,
    follow: spec.follow,
    focus: spec.focus ? spec.focus(u) : shot.look,
    preview,
  });
}
