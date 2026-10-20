import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  at: [number, number, number];
  /** Yaw the man was facing, atan2(dx, dz). The pool opens ahead of his feet. */
  facing?: number;
}

const SPRAY = 7;

/** A pool that opens under a fallen man's chest, and a few drops thrown at his feet. */
export default function Blood({ active, at, facing = 0 }: Props) {
  const pool = useRef<THREE.Mesh>(null);
  const drops = useRef<THREE.InstancedMesh>(null);
  const start = useRef<number | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(
    () =>
      Array.from({ length: SPRAY }, (_, i) => ({
        x: Math.sin(i * 1.9) * (0.25 + (i % 3) * 0.12),
        z: Math.cos(i * 1.4) * (0.2 + (i % 4) * 0.1),
      })),
    [],
  );

  useFrame(({ clock }) => {
    if (!active) {
      start.current = null;
      if (pool.current) pool.current.visible = false;
      if (drops.current) drops.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const elapsed = clock.elapsedTime - start.current;
    const t = Math.min(1, elapsed / 1.2);
    // The chest is on the ground half a second after the shot. The pool waits for it.
    const poolT = Math.min(1, Math.max(0, (elapsed - 0.5) / 0.7));
    if (pool.current) {
      pool.current.visible = poolT > 0;
      const s = 0.15 + poolT * 0.7;
      pool.current.scale.set(s, s, 1);
      const mat = pool.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.35 + poolT * 0.4;
    }
    if (drops.current) {
      drops.current.visible = t < 0.45;
      seeds.forEach((seed, i) => {
        const k = Math.min(1, t * 2.4);
        dummy.position.set(seed.x * k, 0.02, seed.z * k);
        dummy.scale.setScalar(0.5 + k);
        dummy.updateMatrix();
        drops.current!.setMatrixAt(i, dummy.matrix);
      });
      drops.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={[at[0], 0.03, at[2]]}>
      <mesh
        ref={pool}
        position={[Math.sin(facing) * 0.45, 0, Math.cos(facing) * 0.45]}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <circleGeometry args={[0.55, 14]} />
        <meshBasicMaterial color="#4a1014" transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <instancedMesh ref={drops} args={[undefined, undefined, SPRAY]} visible={false}>
        <boxGeometry args={[0.07, 0.02, 0.07]} />
        <meshBasicMaterial color="#6a1418" transparent opacity={0.8} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
