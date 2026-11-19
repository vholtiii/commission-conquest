import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { type SedanSpec } from "@/scene/Sedan";
import { ReelSedan } from "@/scene/ReelSedan";
import { readReel, useInReel } from "../reelClock";

interface LightsProps {
  active: boolean;
  at: [number, number, number];
}

/** Red and blue blinkers. */
export function PoliceLights({ active, at }: LightsProps) {
  const a = useRef<THREE.PointLight>(null);
  const b = useRef<THREE.PointLight>(null);
  const inReel = useInReel();

  useFrame(({ clock }) => {
    if (!a.current || !b.current) return;
    if (!active) {
      a.current.intensity = 0;
      b.current.intensity = 0;
      return;
    }
    const now = inReel ? (readReel()?.time ?? clock.elapsedTime) : clock.elapsedTime;
    const blink = Math.sin(now * 18) > 0;
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

/** Dark wagon with a roof lamp, pulled across the escape lane. Stays mounted so its shaders are warm before it rolls in. */
export function PaddyWagon({ active, x, z, rot }: WagonProps) {
  const car: SedanSpec = { x, z, rot, color: "#14233f", accent: "#8a1a1a", lamps: true, scale: 1.05 };
  return (
    <group>
      <group visible={active}>
        <ReelSedan cars={[car]} attitude={false} />
      </group>
      <PoliceLights active={active} at={[x, 0.4, z]} />
    </group>
  );
}
