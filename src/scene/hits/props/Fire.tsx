import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import Smoke from "./Smoke";

interface Props {
  active: boolean;
  at: [number, number, number];
}

/** A burning wreck: flickering tongues, a hot light, and a black column. */
export default function Fire({ active, at }: Props) {
  const tongues = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    if (!tongues.current || !light.current) return;
    tongues.current.visible = active;
    light.current.visible = active;
    if (!active) {
      light.current.intensity = 0;
      return;
    }
    const t = clock.elapsedTime;
    light.current.intensity = 3.2 + Math.sin(t * 17) * 1.4 + Math.sin(t * 9) * 0.6;
    tongues.current.children.forEach((child, i) => {
      const s = 0.7 + Math.sin(t * (11 + i * 3) + i) * 0.25;
      child.scale.set(s, 0.8 + s * 0.6, s);
      child.position.y = 0.35 + Math.sin(t * 8 + i) * 0.06;
    });
  });

  return (
    <group position={at}>
      <group ref={tongues} visible={false}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[(i - 1) * 0.22, 0.4, (i % 2) * 0.1]}>
            <coneGeometry args={[0.16, 0.55, 6]} />
            <meshBasicMaterial color={i === 1 ? "#ffb04a" : "#ff5a1f"} transparent opacity={0.85} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <pointLight ref={light} position={[0, 0.8, 0]} color="#ff6a22" intensity={0} distance={10} />
      <Smoke active={active} at={[0, 0.6, 0]} loop color="#141414" size={1.7} />
    </group>
  );
}
