import * as THREE from "three";

export interface CamControls {
  target: THREE.Vector3;
  update: () => void;
}

/** Ease the chase camera and the orbit target toward a pose. */
export function moveCam(
  camera: THREE.Camera,
  controls: CamControls | null,
  pos: THREE.Vector3,
  lookAt: THREE.Vector3,
  k: number,
): void {
  camera.position.lerp(pos, k);
  if (controls) {
    controls.target.lerp(lookAt, k);
    controls.update();
  }
}

export function applyShake(camera: THREE.Camera, amount: { current: number }): void {
  if (amount.current <= 0.001) return;
  camera.position.x += (Math.random() - 0.5) * amount.current;
  camera.position.z += (Math.random() - 0.5) * amount.current;
  amount.current *= 0.88;
}

export type Coverage = "wide" | "medium" | "close" | "pull";

const COVERAGE = {
  wide: { radius: 7.2, height: 3.4, side: 0.7 },
  medium: { radius: 4.2, height: 2.1, side: 0.35 },
  close: { radius: 2.6, height: 1.7, side: 0.4 },
  pull: { radius: 9.5, height: 4.6, side: 1.2 },
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

export function coverageShot(
  center: THREE.Vector3,
  facing: number,
  coverage: Coverage,
  shot?: { drift?: number; side?: number },
): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const spec = COVERAGE[coverage];
  const drift = shot?.drift ?? 0;
  const side = shot?.side ?? 1;
  const angle = facing + spec.side * side + drift * 0.25;
  const radius = spec.radius * (0.94 + 0.12 * drift);
  const look = center.clone();
  look.y = coverage === "close" ? 0.55 : 0.8;
  return {
    pos: new THREE.Vector3(
      center.x + Math.sin(angle) * radius,
      spec.height,
      center.z + Math.cos(angle) * radius,
    ),
    look,
  };
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
