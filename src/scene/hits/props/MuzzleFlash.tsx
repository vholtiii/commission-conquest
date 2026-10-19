import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

interface Props {
  active: boolean;
  from: [number, number, number];
  to: [number, number, number];
  /** Shots in the burst. */
  shots?: number;
}

/** A star at the muzzle, a short tracer, and a puff once the burst is done. */
export default function MuzzleFlash({ active, from, to, shots = 5 }: Props) {
  const flash = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const tracer = useRef<THREE.Mesh>(null);
  const puff = useRef<THREE.Mesh>(null);
  const start = useRef<number | null>(null);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const spin = useMemo(() => Math.random() * Math.PI, []);
  const { camera } = useThree();

  useFrame(({ clock }) => {
    if (!active) {
      start.current = null;
      if (flash.current) flash.current.visible = false;
      if (light.current) light.current.intensity = 0;
      if (tracer.current) tracer.current.visible = false;
      if (puff.current) puff.current.visible = false;
      return;
    }
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    const interval = 0.9 / shots;
    const slot = Math.floor(t / interval);
    const on = slot < shots && t % interval < interval * 0.18;
    if (flash.current) {
      flash.current.visible = on;
      const s = 0.7 + Math.random() * 0.7;
      flash.current.scale.setScalar(s);
      flash.current.lookAt(camera.position);
      flash.current.rotateZ(spin + slot * 0.7);
    }
    if (light.current) light.current.intensity = on ? 14 : slot < shots ? 0.6 : 0;
    if (tracer.current) {
      tracer.current.visible = on;
      const a = new THREE.Vector3(...from);
      const b = new THREE.Vector3(...to);
      dir.copy(b).sub(a);
      const len = Math.max(0.2, dir.length());
      tracer.current.position.copy(a).addScaledVector(dir.normalize(), len * 0.45);
      tracer.current.scale.set(1, 1, len * 0.7);
      tracer.current.lookAt(b);
    }
    if (puff.current) {
      const after = slot >= shots;
      puff.current.visible = after && t < interval * shots + 0.6;
      const k = Math.min(1, Math.max(0, t - interval * shots) / 0.55);
      puff.current.scale.setScalar(0.2 + k * 0.8);
      const mat = puff.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.35 * (1 - k));
    }
  });

  return (
    <group>
      <group ref={flash} position={from} visible={false}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} rotation={[0, 0, (i * Math.PI) / 4]}>
            <boxGeometry args={[0.34, 0.045, 0.045]} />
            <meshBasicMaterial color="#fff4c8" />
          </mesh>
        ))}
      </group>
      <mesh ref={tracer} visible={false}>
        <boxGeometry args={[0.025, 0.025, 1]} />
        <meshBasicMaterial color="#ffd27a" transparent opacity={0.8} />
      </mesh>
      <mesh ref={puff} position={from} visible={false}>
        <sphereGeometry args={[0.16, 8, 8]} />
        <meshBasicMaterial color="#8a8a86" transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <pointLight ref={light} position={from} color="#ffd27a" intensity={0} distance={9} />
    </group>
  );
}
