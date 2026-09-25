import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { SedanFleet, type SedanSpec } from "@/scene/Sedan";

interface LightsProps {
  active: boolean;
  at: [number, number, number];
}

/** Red and blue blinkers. */
export function PoliceLights({ active, at }: LightsProps) {
  const a = useRef<THREE.PointLight>(null);
  const b = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    if (!a.current || !b.current) return;
    a.current.visible = active;
    b.current.visible = active;
    if (!active) return;
    const blink = Math.sin(clock.elapsedTime * 18) > 0;
    a.current.intensity = blink ? 4 : 0.15;
    b.current.intensity = blink ? 0.15 : 4;
  });

  return (
    <group>
      <pointLight ref={a} position={[at[0] - 0.8, at[1] + 1.6, at[2]]} color="#ff2222" intensity={0} distance={12} />
      <pointLight ref={b} position={[at[0] + 0.8, at[1] + 1.6, at[2]]} color="#2244ff" intensity={0} distance={12} />
    </group>
  );
}

interface WagonProps {
  active: boolean;
  x: number;
  z: number;
  rot: number;
}

/** Dark wagon with a roof lamp, pulled across the escape lane. */
export function PaddyWagon({ active, x, z, rot }: WagonProps) {
  if (!active) return null;
  const car: SedanSpec = { x, z, rot, color: "#14233f", accent: "#8a1a1a", lamps: true, scale: 1.05 };
  return (
    <group>
      <SedanFleet cars={[car]} />
      <PoliceLights active at={[x, 0.4, z]} />
    </group>
  );
}
