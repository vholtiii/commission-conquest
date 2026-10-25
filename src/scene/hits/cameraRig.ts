import * as THREE from "three";
import { BLOCK_SIZE, ROAD_GAP, racketBlockFor, type CityLayout } from "@/engine/cityLayout";
import { racketHeight } from "@/scene/RacketBuildings";
import type { Territory } from "@/types/game";

export interface CamControls {
  target: THREE.Vector3;
  update: () => void;
}

/** Turn a per-frame-at-60Hz fraction into one for this frame's delta. */
export function frameLerp(k: number, dt: number): number {
  return 1 - Math.pow(1 - k, Math.max(0, dt) * 60);
}

/** Smoothstep. Eases a 0–1 ramp in and out. */
export function ease(k: number): number {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
}

interface RigState {
  vel: THREE.Vector3;
  targetVel: THREE.Vector3;
  /** Handheld drift and shake added last frame, taken back out before the spring runs. */
  offset: THREE.Vector3;
  prevGoal: THREE.Vector3;
  prevLook: THREE.Vector3;
  hasPrev: boolean;
  shakeT: number;
}

const rigs = new WeakMap<THREE.Camera, RigState>();

function rigOf(camera: THREE.Camera): RigState {
  let r = rigs.get(camera);
  if (!r) {
    r = {
      vel: new THREE.Vector3(),
      targetVel: new THREE.Vector3(),
      offset: new THREE.Vector3(),
      prevGoal: new THREE.Vector3(),
      prevLook: new THREE.Vector3(),
      hasPrev: false,
      shakeT: 0,
    };
    rigs.set(camera, r);
  }
  return r;
}

/**
 * One implicit step of a critically damped spring; stable at any frame rate.
 * `goalVel` lets it ride along with a goal that is itself moving instead of trailing it.
 */
function springStep(
  x: THREE.Vector3,
  v: THREE.Vector3,
  goal: THREE.Vector3,
  omega: number,
  dt: number,
  goalVel?: THREE.Vector3,
): void {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const inv = 1 / (f + dt * hoo);
  for (const axis of ["x", "y", "z"] as const) {
    const xi = x[axis];
    const gv = goalVel ? goalVel[axis] : 0;
    const vi = (v[axis] + hoo * (goal[axis] - xi) + 2 * omega * dt * gv) * inv;
    v[axis] = vi;
    x[axis] = xi + dt * vi;
  }
}

/** Above this a goal did not move, it jumped; following it would fling the lens. */
const MAX_FOLLOW_SPEED = 40;
/** Fastest the camera moves on its own, over and above any subject it rides with. */
const MAX_CAM_SPEED = 9;
const goalVel = new THREE.Vector3();
const lookVel = new THREE.Vector3();
const before = new THREE.Vector3();

function velocityOf(out: THREE.Vector3, now: THREE.Vector3, prev: THREE.Vector3, dt: number): THREE.Vector3 {
  out.copy(now).sub(prev).divideScalar(dt);
  if (out.lengthSq() > MAX_FOLLOW_SPEED * MAX_FOLLOW_SPEED) out.set(0, 0, 0);
  return out;
}

/** Spring rate for the old per-frame-at-60Hz share, kept to a band that eases rather than snaps. */
export function springOmega(k: number): number {
  const rate = -Math.log(1 - Math.min(0.95, Math.max(0.01, k))) * 60;
  return THREE.MathUtils.clamp(rate * 0.45, 3, 12);
}

/**
 * Ease the camera and the orbit target toward a pose on a critically damped
 * spring: no overshoot, no lurch at the start. `k` is the old per-frame share
 * at 60Hz and sets the stiffness. `cut` jumps straight there. `follow` matches
 * the goal's own speed, for shots riding a moving subject. With `space`, a step
 * that would enter a building is refused and the camera waits a frame.
 */
export function moveCam(
  camera: THREE.Camera,
  controls: CamControls | null,
  pos: THREE.Vector3,
  lookAt: THREE.Vector3,
  k: number,
  dt = 1 / 60,
  opts?: { cut?: boolean; follow?: boolean; space?: Space | null },
): void {
  const rig = rigOf(camera);
  camera.position.sub(rig.offset);
  rig.offset.set(0, 0, 0);
  const step = Math.min(0.05, Math.max(0, dt));
  if (opts?.cut) {
    camera.position.copy(pos);
    rig.vel.set(0, 0, 0);
    rig.targetVel.set(0, 0, 0);
    if (controls) {
      controls.target.copy(lookAt);
      controls.update();
    }
  } else {
    const follow = !!opts?.follow && rig.hasPrev && dt > 0;
    const omega = springOmega(k);
    before.copy(camera.position);
    const ride = follow ? velocityOf(goalVel, pos, rig.prevGoal, dt) : undefined;
    springStep(camera.position, rig.vel, pos, omega, step, ride);
    // A long recovery glides at a steady pace rather than whipping across.
    const limit = MAX_CAM_SPEED + (ride ? ride.length() : 0);
    if (step > 0 && camera.position.distanceTo(before) > limit * step) {
      camera.position.sub(before).setLength(limit * step).add(before);
      if (rig.vel.length() > limit) rig.vel.setLength(limit);
    }
    const space = opts?.space;
    if (space && !space.isClear(camera.position) && space.isClear(before)) {
      camera.position.copy(before);
      rig.vel.set(0, 0, 0);
    }
    if (controls) {
      springStep(
        controls.target,
        rig.targetVel,
        lookAt,
        omega * 1.15,
        step,
        follow ? velocityOf(lookVel, lookAt, rig.prevLook, dt) : undefined,
      );
      controls.update();
    }
  }
  rig.prevGoal.copy(pos);
  rig.prevLook.copy(lookAt);
  rig.hasPrev = true;
}

/** Takes this frame's drift and shake back out, e.g. when they would put the lens in a wall. */
export function dropOffset(camera: THREE.Camera): void {
  const rig = rigOf(camera);
  camera.position.sub(rig.offset);
  rig.offset.set(0, 0, 0);
}

/**
 * A jolt from a gun or a blast: smooth layered tremor rather than per-frame
 * noise, added to the offset so moveCam takes it back out next frame.
 */
export function applyShake(
  camera: THREE.Camera,
  amount: { current: number },
  dt = 1 / 60,
  space?: Space | null,
  seed = 0,
): void {
  if (amount.current <= 0.001) return;
  const rig = rigOf(camera);
  rig.shakeT += Math.max(0, dt);
  const t = rig.shakeT;
  const s = seed * 0.0213;
  const a = amount.current * 0.5;
  const dx = (Math.sin(t * 92 + s) * 0.6 + Math.sin(t * 143 + s * 2.3) * 0.4) * a;
  const dy = (Math.sin(t * 107 + s * 1.7) * 0.6 + Math.sin(t * 131 + s * 0.9) * 0.4) * a * 0.5;
  const dz = (Math.sin(t * 88 + s * 3.1) * 0.6 + Math.sin(t * 121 + s * 1.3) * 0.4) * a;
  camera.position.x += dx;
  camera.position.y += dy;
  camera.position.z += dz;
  // A jolt against a facade must not knock the lens through it.
  if (space && !space.isClear(camera.position)) {
    camera.position.x -= dx;
    camera.position.y -= dy;
    camera.position.z -= dz;
  } else {
    rig.offset.x += dx;
    rig.offset.y += dy;
    rig.offset.z += dz;
  }
  amount.current *= Math.pow(0.88, Math.max(0, dt) * 60);
}

/**
 * A little life in a held shot: two octaves of drift, different per reel.
 * Call it after moveCam; moveCam takes it back out next frame so it never piles up.
 */
export function handheld(camera: THREE.Camera, amount: number, seed = 0): void {
  if (amount <= 0) return;
  const rig = rigOf(camera);
  const t = performance.now() * 0.001;
  const s = seed * 0.0137;
  const x = (Math.sin(t * 0.9 + s) + 0.5 * Math.sin(t * 2.3 + s * 1.7)) * amount;
  const y = (Math.cos(t * 0.7 + s * 2.1) + 0.5 * Math.sin(t * 1.9 + s * 0.6)) * amount * 0.5;
  const z = (Math.sin(t * 0.8 + s * 3.3) + 0.5 * Math.cos(t * 2.1 + s)) * amount * 0.6;
  rig.offset.x += x;
  rig.offset.y += y;
  rig.offset.z += z;
  camera.position.x += x;
  camera.position.y += y;
  camera.position.z += z;
}

/** The map's lens. Reels narrow it for close work and give it back afterwards. */
export const BASE_FOV = 42;
const LENS: Record<Coverage, number> = { wide: 42, medium: 40, close: 35, pull: 44, body: 38 };

export function lensFor(coverage: Coverage): number {
  return LENS[coverage];
}

export function setLens(camera: THREE.Camera, fov: number, dt: number, cut = false): void {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera) return;
  const next = cut ? fov : THREE.MathUtils.damp(cam.fov, fov, 4, Math.min(0.05, dt));
  if (Math.abs(next - cam.fov) < 0.01) return;
  cam.fov = next;
  cam.updateProjectionMatrix();
}

export function resetLens(camera: THREE.Camera): void {
  setLens(camera, BASE_FOV, 0, true);
  const rig = rigs.get(camera);
  if (rig) {
    camera.position.sub(rig.offset);
    rig.offset.set(0, 0, 0);
    rig.vel.set(0, 0, 0);
    rig.targetVel.set(0, 0, 0);
    rig.hasPrev = false;
    rig.shakeT = 0;
  }
}

/** Direction a curve tangent travels, in the same atan2(dx, dz) coverageShot expects. */
export function facingOf(tangent: THREE.Vector3): number {
  return Math.atan2(tangent.x, tangent.z);
}

export type Coverage = "wide" | "medium" | "close" | "pull" | "body";

const COVERAGE = {
  wide: { radius: 7.2, height: 3.4, side: 0.7 },
  medium: { radius: 4.2, height: 2.1, side: 0.35 },
  close: { radius: 2.6, height: 1.7, side: 0.4 },
  pull: { radius: 9.5, height: 4.6, side: 1.2 },
  body: { radius: 3.0, height: 1.25, side: 0.85 },
} as const;

/** Left or right of the mark, stable for one operation so two reels are not the same shot. */
export function reelSide(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h & 1 ? 1 : -1;
}

export interface Shot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

/**
 * A staged shot from the street side. `facing` is atan2(dx, dz) toward the road,
 * so the building stays behind the mark instead of filling the lens.
 */
export function coverageShot(
  center: THREE.Vector3,
  facing: number,
  coverage: Coverage,
  shot?: { drift?: number; side?: number; lookY?: number },
): Shot {
  const spec = COVERAGE[coverage];
  const drift = shot?.drift ?? 0;
  const side = shot?.side ?? 1;
  const angle = facing + spec.side * side + drift * 0.25;
  const radius = spec.radius * (0.94 + 0.12 * drift);
  const look = center.clone();
  look.y = shot?.lookY ?? (coverage === "body" ? 0.2 : coverage === "close" ? 0.55 : 0.8);
  return {
    pos: new THREE.Vector3(
      center.x + Math.sin(angle) * radius,
      spec.height,
      center.z + Math.cos(angle) * radius,
    ),
    look,
  };
}

/** Low on the body for the first 60% of a beat, then out to the pull. */
export function bodyThenPull(
  center: THREE.Vector3,
  facing: number,
  local: number,
  shot?: { drift?: number; side?: number },
): Shot {
  const low = coverageShot(center, facing, "body", shot);
  if (local <= 0.6) return low;
  const wide = coverageShot(center, facing, "pull", shot);
  const k = ease((local - 0.6) / 0.4);
  return { pos: low.pos.lerp(wide.pos, k), look: low.look.lerp(wide.look, k) };
}

/** Trailing a car or a walker: low, behind and off one shoulder, looking down the way he is going. */
export function trackShot(subject: THREE.Vector3, heading: number, side = 1, opts?: { back?: number; height?: number }): Shot {
  const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
  const back = opts?.back ?? 3.0;
  const pos = subject.clone().addScaledVector(fwd, -back).addScaledVector(right, side * 1.0);
  pos.y = opts?.height ?? 1.2;
  const look = subject.clone().addScaledVector(fwd, 1.6);
  look.y = 0.6;
  return { pos, look };
}

/**
 * Both subjects in frame: the eye sits off the line between them, far enough for
 * the lens to hold both, a little nearer `a` so it reads over his shoulder.
 */
export function twoShot(
  a: THREE.Vector3,
  b: THREE.Vector3,
  side = 1,
  opts?: { fov?: number; margin?: number; height?: number; push?: number },
): Shot {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a);
  dir.y = 0;
  if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
  const span = dir.length() + (opts?.margin ?? 1.8);
  dir.normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side);
  // The canvas sits between the toolbar and the roster, so it is barely wider than 4:3.
  const hfov = THREE.MathUtils.degToRad(opts?.fov ?? BASE_FOV) * 1.2;
  const dist = Math.max(2.0, (span / 2 / Math.tan(hfov / 2)) * 1.08) * (1 - (opts?.push ?? 0));
  const pos = mid.clone().addScaledVector(perp, dist).addScaledVector(dir, -dist * 0.22);
  pos.y = opts?.height ?? 1.35;
  const look = mid.clone();
  look.y = 0.7;
  return { pos, look };
}

/**
 * Mark and shooter across the frame from nearly side-on, the mark nearer the
 * lens. Any closer to the line of fire and the shooter's back fills the shot.
 */
export function executionShot(mark: THREE.Vector3, shooter: THREE.Vector3, side = 1): Shot {
  const toShooter = shooter.clone().sub(mark);
  toShooter.y = 0;
  const gap = Math.max(0.6, toShooter.length());
  if (toShooter.lengthSq() < 1e-4) toShooter.set(0, 0, 1);
  toShooter.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), side * 1.15);
  const look = mark.clone().lerp(shooter, 0.4);
  const pos = look.clone().addScaledVector(toShooter, Math.max(2.8, gap * 1.9));
  pos.y = 1.15;
  look.y = 0.55;
  return { pos, look };
}

/**
 * Low on the pavement a few doors down from the mark, looking past him at the
 * street. `facing` points from his building to the road. Stays on the kerb line,
 * so a car parked in the road never ends up between the lens and the mark.
 */
export function kerbShot(mark: THREE.Vector3, facing: number, threat: THREE.Vector3, side = 1): Shot {
  const out = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
  const along = new THREE.Vector3(out.z, 0, -out.x).multiplyScalar(side);
  const pos = mark.clone().addScaledVector(along, 2.6).addScaledVector(out, 0.3);
  pos.y = 1.0;
  const look = mark.clone().lerp(threat, 0.45);
  look.y = 0.6;
  return { pos, look };
}

export function orbitAround(
  center: THREE.Vector3,
  radius: number,
  angle: number,
  height: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    center.x + Math.cos(angle) * radius,
    height,
    center.z + Math.sin(angle) * radius,
  );
}

/** What a camera may not sit inside, and what it may not look through. */
export interface Space {
  isClear(p: THREE.Vector3): boolean;
  sees(from: THREE.Vector3, to: THREE.Vector3): boolean;
  /** The camera can travel from one point to the other without passing through a building. */
  passable(from: THREE.Vector3, to: THREE.Vector3): boolean;
}

const PITCH = BLOCK_SIZE + ROAD_GAP;
const spaces = new WeakMap<CityLayout, { key: string; space: Space }>();

/**
 * Building cells as boxes, with the same heights the city draws plus a margin for roofs.
 * Rackets stand in for the block they are built on and are far taller, so they count too.
 */
export function spaceFor(layout: CityLayout, territories: readonly Territory[] = []): Space {
  const rackets: { gx: number; gz: number; h: number }[] = [];
  for (const t of territories) {
    t.rackets.forEach((r, i) => {
      const b = racketBlockFor(layout, t.id, typeof r.siteIndex === "number" ? r.siteIndex : i);
      if (b) rackets.push({ gx: b.gx, gz: b.gz, h: racketHeight(r.level, b.kind !== "building") + 0.5 });
    });
  }
  const key = rackets.map((r) => `${r.gx},${r.gz},${r.h}`).join(";");
  const hit = spaces.get(layout);
  if (hit && hit.key === key) return hit.space;
  const heights = new Map<number, number>();
  for (const b of layout.blocks) {
    if (b.kind !== "building") continue;
    heights.set(b.gz * 1000 + b.gx, THREE.MathUtils.clamp(b.heightBias * 2.4, 1.0, 4.2) + 0.45);
  }
  for (const r of rackets) {
    const cell = r.gz * 1000 + r.gx;
    heights.set(cell, Math.max(heights.get(cell) ?? 0, r.h));
  }
  const half = BLOCK_SIZE / 2 + 0.14;
  const ox = layout.width / 2 - BLOCK_SIZE / 2;
  const oz = layout.depth / 2 - BLOCK_SIZE / 2;
  const cellOf = (x: number, z: number): number => Math.round((z + oz) / PITCH) * 1000 + Math.round((x + ox) / PITCH);
  const blocked = (x: number, y: number, z: number, skip = -1): boolean => {
    const gx = Math.round((x + ox) / PITCH);
    const gz = Math.round((z + oz) / PITCH);
    if (gz * 1000 + gx === skip) return false;
    const h = heights.get(gz * 1000 + gx);
    if (h === undefined || y >= h) return false;
    const cx = gx * PITCH - ox;
    const cz = gz * PITCH - oz;
    // The slot between two buildings is too narrow to film from or through.
    const dx = x - cx;
    const dz = z - cz;
    const reachX = heights.has(gz * 1000 + gx + Math.sign(dx)) ? PITCH / 2 : half;
    const reachZ = heights.has((gz + Math.sign(dz)) * 1000 + gx) ? PITCH / 2 : half;
    return Math.abs(dx) <= reachX && Math.abs(dz) <= reachZ;
  };
  const space: Space = {
    isClear: (p) => !blocked(p.x, p.y, p.z),
    sees: (from, to) => {
      // Whoever is pressed against a wall must not hide himself.
      const own = cellOf(to.x, to.z);
      const steps = 10;
      for (let i = 1; i < steps; i++) {
        const k = i / steps;
        if (blocked(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k, own)) return false;
      }
      return true;
    },
    passable: (from, to) => {
      const steps = Math.max(2, Math.ceil(from.distanceTo(to) / 0.25));
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        if (blocked(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k)) return false;
      }
      return true;
    },
  };
  spaces.set(layout, { key, space });
  return space;
}

const MIN_EYE = 0.9;

type Variant = (s: Shot) => Shot;

function around(angle: number): Variant {
  return (s) => {
    const off = s.pos.clone().sub(s.look);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    return { pos: s.look.clone().add(off).setY(s.pos.y), look: s.look };
  };
}

function pullIn(k: number): Variant {
  return (s) => ({ pos: s.look.clone().lerp(s.pos, k).setY(Math.max(s.pos.y * 0.9, MIN_EYE)), look: s.look });
}

function raise(dy: number, k = 1): Variant {
  return (s) => ({ pos: s.look.clone().lerp(s.pos, k).setY(s.pos.y + dy), look: s.look });
}

const VARIANTS: Variant[] = [
  (s) => s,
  around(0.45),
  around(-0.45),
  pullIn(0.7),
  around(0.9),
  around(-0.9),
  raise(1.4, 0.85),
  pullIn(0.5),
  around(Math.PI),
  around(1.5),
  around(-1.5),
  raise(3.2, 0.7),
];

/** How long the asked-for shot must stay usable before the camera gives up a fix for it. */
const BASE_HOLD = 0.6;

/**
 * Keeps a reel's camera out of the buildings. Tries the asked-for shot, then
 * swings round, steps in, or rises, and sticks with whatever worked last so the
 * camera does not hop between fixes from one frame to the next.
 */
export class ShotSolver {
  private last = 0;
  private baseOkFor = 0;
  constructor(private readonly space: Space | null) {}

  /** Floor the eye height without dipping under the subject's chest. */
  private floor(s: Shot): Shot {
    const y = Math.max(MIN_EYE, s.pos.y, s.look.y + 0.15);
    return { pos: s.pos.clone().setY(y), look: s.look.clone() };
  }

  private ok(s: Shot): boolean {
    if (!this.space) return true;
    return this.space.isClear(s.pos) && this.space.sees(s.pos, s.look);
  }

  /**
   * `from` is where the camera is now, mid-shot: a fix is then chosen by how near
   * and reachable it is. Without it (a new beat) fixes go in order of preference.
   */
  resolve(shot: Shot, from?: THREE.Vector3, dt = 1 / 60): Shot {
    const base = this.floor(shot);
    const space = this.space;
    if (!space) return base;
    if (this.last === 0) {
      if (this.ok(base)) return base;
    } else {
      const baseOk = this.ok(base) && (!from || space.passable(from, base.pos));
      this.baseOkFor = baseOk ? this.baseOkFor + Math.max(0, dt) : 0;
      if (baseOk && this.baseOkFor >= BASE_HOLD) {
        this.last = 0;
        this.baseOkFor = 0;
        return base;
      }
      const sticky = VARIANTS[this.last]!(base);
      if (this.ok(sticky)) return sticky;
    }
    let best = -1;
    let bestScore = Infinity;
    let bestShot: Shot | null = null;
    for (let i = 1; i < VARIANTS.length; i++) {
      const s = VARIANTS[i]!(base);
      if (!this.ok(s)) continue;
      const score = from ? from.distanceToSquared(s.pos) + (space.passable(from, s.pos) ? 0 : 1e6) : i;
      if (score < bestScore) {
        best = i;
        bestScore = score;
        bestShot = s;
      }
    }
    if (bestShot) {
      this.last = best;
      this.baseOkFor = 0;
      return bestShot;
    }
    this.last = 0;
    // Nothing at street level works: go straight up until clear of every roof, racket towers included.
    const up = base.look.clone().add(new THREE.Vector3(0.6, 5.5, 0.6));
    while (up.y < 14 && !this.space.isClear(up)) up.y += 0.5;
    return { pos: up, look: base.look };
  }

  reset(): void {
    this.last = 0;
    this.baseOkFor = 0;
  }
}
