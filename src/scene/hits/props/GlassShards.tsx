import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  at: [number, number, number];
}

const COUNT = 10;

/** A burst of pale shards falling from a window or storefront. */
export default function GlassShards({ active, at }: Props) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const start = useRef<number | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, i) => ({
        x: ((i % 5) - 2) * 0.12,
        z: ((i % 3) - 1) * 0.08,
        vx: Math.sin(i) * 0.4,
      })),
    [],
  );

  useFrame(({ clock }) => {
    if (!mesh.current) return;
    if (!active) {
      start.current = null;
      mesh.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const t = Math.min(1, (clock.elapsedTime - start.current) / 0.9);
    mesh.current.visible = t < 1;
    seeds.forEach((seed, i) => {
      dummy.position.set(seed.x + seed.vx * t, 1.1 - t * 1.3, seed.z);
      dummy.rotation.set(t * 4, t * 2, 0);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, COUNT]} position={at} visible={false}>
      <boxGeometry args={[0.06, 0.08, 0.015]} />
      <meshStandardMaterial color="#d5dde6" metalness={0.6} roughness={0.15} transparent opacity={0.8} />
    </instancedMesh>
  );
}
