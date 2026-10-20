import * as THREE from "three";

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

/**
 * Ease the chase camera and the orbit target toward a pose. `k` is the share
 * covered per frame at 60Hz; `dt` keeps the move the same speed at any rate.
 */
export function moveCam(
  camera: THREE.Camera,
  controls: CamControls | null,
  pos: THREE.Vector3,
  lookAt: THREE.Vector3,
  k: number,
  dt = 1 / 60,
): void {
  const a = frameLerp(k, dt);
  camera.position.lerp(pos, a);
  if (controls) {
    controls.target.lerp(lookAt, a);
    controls.update();
  }
}

export function applyShake(camera: THREE.Camera, amount: { current: number }, dt = 1 / 60): void {
  if (amount.current <= 0.001) return;
  camera.position.x += (Math.random() - 0.5) * amount.current;
  camera.position.z += (Math.random() - 0.5) * amount.current;
  amount.current *= Math.pow(0.88, Math.max(0, dt) * 60);
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

/**
 * A staged shot from the street side. `facing` is atan2(dx, dz) toward the road,
 * so the building stays behind the mark instead of filling the lens.
 */
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

/** A little life in a held shot. Call it after moveCam so the lerp does not eat it. */
export function handheld(camera: THREE.Camera, amount: number): void {
  if (amount <= 0) return;
  const t = performance.now() * 0.008;
  camera.position.x += Math.sin(t) * amount;
  camera.position.y += Math.cos(t * 1.37) * amount * 0.5;
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
