import * as THREE from "three";

/** Where the lens is sharp during a reel. Post passes read it; empty means the map is in focus everywhere. */
export const reelFocus = {
  active: false,
  point: new THREE.Vector3(),
};

export function setReelFocus(point: THREE.Vector3 | null): void {
  reelFocus.active = point != null;
  if (point) reelFocus.point.copy(point);
}
