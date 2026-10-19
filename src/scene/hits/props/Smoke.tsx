import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  at: [number, number, number];
  /** Keep puffing instead of playing once. */
  loop?: boolean;
  color?: string;
  /** Scales the puffs. A column of fire smoke wants more than a fuse. */
  size?: number;
}

/** A few grey puffs rising off a dud fuse or a burning sedan. */
export default function Smoke({ active, at, loop = false, color = "#6a6a68", size = 1 }: Props) {
  const group = useRef<THREE.Group>(null);
  const start = useRef<number | null>(null);

  useFrame(({ clock }) => {
    if (!group.current) return;
    if (!active) {
      start.current = null;
      group.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const raw = clock.elapsedTime - start.current;
    const t = loop ? (raw % 1.4) / 1.4 : Math.min(1, raw / 1.4);
    group.current.visible = true;
    group.current.children.forEach((child, i) => {
      const local = Math.min(1, Math.max(0, t * 1.3 - i * 0.15));
      child.position.y = (0.3 + local * 1.4) * size;
      child.scale.setScalar((0.3 + local * 0.9) * size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.45 - local * 0.4);
    });
  });

  return (
    <group ref={group} position={at} visible={false}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[(i - 1) * 0.15, 0.3, 0]}>
          <sphereGeometry args={[0.22, 8, 8]} />
          <meshBasicMaterial color={color} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
