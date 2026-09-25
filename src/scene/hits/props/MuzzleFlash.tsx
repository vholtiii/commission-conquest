import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  from: [number, number, number];
  to: [number, number, number];
  /** Shots in the burst. */
  shots?: number;
}

/** Strobe at the muzzle plus a tracer stretched toward the target. */
export default function MuzzleFlash({ active, from, to, shots = 5 }: Props) {
  const flash = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const tracer = useRef<THREE.Mesh>(null);
  const start = useRef<number | null>(null);
  const dir = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    if (!active) {
      start.current = null;
      if (flash.current) flash.current.visible = false;
      if (light.current) light.current.intensity = 0;
      if (tracer.current) tracer.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    const interval = 0.9 / shots;
    const slot = Math.floor(t / interval);
    const on = slot < shots && t % interval < interval * 0.35;
    if (flash.current) flash.current.visible = on;
    if (light.current) light.current.intensity = on ? 6 : 0.4;
    if (tracer.current) {
      tracer.current.visible = on;
      const a = new THREE.Vector3(...from);
      const b = new THREE.Vector3(...to);
      dir.copy(b).sub(a);
      const len = dir.length();
      tracer.current.position.copy(a).addScaledVector(dir.normalize(), len * 0.55);
      tracer.current.scale.set(1, 1, len);
      tracer.current.lookAt(b);
    }
  });

  return (
    <group>
      <mesh ref={flash} position={from} visible={false}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshBasicMaterial color="#ffe9a8" />
      </mesh>
      <mesh ref={tracer} visible={false}>
        <boxGeometry args={[0.03, 0.03, 1]} />
        <meshBasicMaterial color="#ffd27a" transparent opacity={0.85} />
      </mesh>
      <pointLight ref={light} position={from} color="#ffd27a" intensity={0} distance={8} />
    </group>
  );
}
