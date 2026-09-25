import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  at: [number, number, number];
  /** Second, smaller blast for a messy kill. */
  secondary?: boolean;
}

const DEBRIS = 18;

/** Fireball, shockwave ring, debris and a flash. Plays once while `active`. */
export default function Explosion({ active, at, secondary = false }: Props) {
  const ball = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const bits = useRef<THREE.InstancedMesh>(null);
  const start = useRef<number | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(
    () =>
      Array.from({ length: DEBRIS }, (_, i) => ({
        vx: Math.sin(i * 1.7) * (0.6 + (i % 5) * 0.15),
        vz: Math.cos(i * 1.3) * (0.6 + (i % 4) * 0.18),
        vy: 1.2 + (i % 6) * 0.25,
      })),
    [],
  );

  useFrame(({ clock }) => {
    if (!active) {
      start.current = null;
      if (ball.current) ball.current.visible = false;
      if (ring.current) ring.current.visible = false;
      if (light.current) light.current.intensity = 0;
      if (bits.current) bits.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const t = Math.min(1, (clock.elapsedTime - start.current) / 1.3);
    const scale = secondary ? 1.35 : 1;
    if (ball.current) {
      ball.current.visible = t < 0.85;
      const s = (0.3 + t * 2.4) * scale;
      ball.current.scale.setScalar(s);
      const mat = ball.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - t * 1.15);
    }
    if (ring.current) {
      ring.current.visible = true;
      const s = (0.4 + t * 4.2) * scale;
      ring.current.scale.set(s, s, s);
      const mat = ring.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.7 - t);
    }
    if (light.current) light.current.intensity = Math.max(0, (1 - t) * (secondary ? 10 : 7));
    if (bits.current) {
      bits.current.visible = true;
      seeds.forEach((seed, i) => {
        const y = seed.vy * t * 2.2 - 3.2 * t * t;
        dummy.position.set(seed.vx * t * 2.4, Math.max(0.05, y), seed.vz * t * 2.4);
        dummy.scale.setScalar(1 - t * 0.4);
        dummy.updateMatrix();
        bits.current!.setMatrixAt(i, dummy.matrix);
      });
      bits.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={at}>
      <mesh ref={ball} visible={false}>
        <sphereGeometry args={[0.55, 12, 12]} />
        <meshBasicMaterial color="#ff6b2d" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.55, 0.72, 20]} />
        <meshBasicMaterial color="#ffd27a" transparent opacity={0.7} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <instancedMesh ref={bits} args={[undefined, undefined, DEBRIS]} visible={false}>
        <boxGeometry args={[0.08, 0.08, 0.08]} />
        <meshStandardMaterial color="#3a2a22" />
      </instancedMesh>
      <pointLight ref={light} color="#ff6b2d" intensity={0} distance={14} />
    </group>
  );
}
