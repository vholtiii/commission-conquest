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
export function coverageShot(
  center: THREE.Vector3,
  facing: number,
  coverage: Coverage,
): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const spec = COVERAGE[coverage];
  const angle = facing + spec.side;
  const look = center.clone();
  look.y = coverage === "close" ? 0.55 : 0.8;
  return {
    pos: new THREE.Vector3(
      center.x + Math.sin(angle) * spec.radius,
      spec.height,
      center.z + Math.cos(angle) * spec.radius,
    ),
    look,
  };
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
