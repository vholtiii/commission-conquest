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
