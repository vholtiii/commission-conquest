import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";

interface Props {
  layout: CityLayout;
}

const DURATION = 1.4;
const PARTICLE_COUNT = 24;

export default function HitFx({ layout }: Props) {
  const hitFxTerritoryId = useGameStore((s) => s.hitFxTerritoryId);
  const clearHitFx = useGameStore((s) => s.clearHitFx);
  const invalidate = useThree((s) => s.invalidate);

  const startTime = useRef<number | null>(null);
  const groupRef = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const pointsRef = useRef<THREE.Points>(null);

  const center = useMemo(() => {
    if (!hitFxTerritoryId) return null;
    return layout.centers.find((c) => c.territoryId === hitFxTerritoryId) ?? null;
  }, [hitFxTerritoryId, layout]);

  const velocities = useMemo(() => {
    const arr: THREE.Vector3[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
      const speed = 1.5 + Math.random() * 2.5;
      arr.push(new THREE.Vector3(Math.cos(angle) * speed, 1 + Math.random() * 2, Math.sin(angle) * speed));
    }
    return arr;
  }, []);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  useEffect(() => {
    if (hitFxTerritoryId) {
      startTime.current = null;
      invalidate();
    }
  }, [hitFxTerritoryId, invalidate]);

  useFrame(({ clock }) => {
    if (!hitFxTerritoryId || !center) return;
    if (startTime.current === null) startTime.current = clock.getElapsedTime();
    const elapsed = clock.getElapsedTime() - startTime.current;
    const t = Math.min(1, elapsed / DURATION);

    if (flashRef.current) {
      const scale = 0.4 + t * 3.2;
      flashRef.current.scale.setScalar(scale);
      const mat = flashRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - t * 1.6);
    }

    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const v = velocities[i]!;
      posAttr.setXYZ(i, v.x * t * 1.2, 0.6 + v.y * t, v.z * t * 1.2);
    }
    posAttr.needsUpdate = true;
    if (pointsRef.current) {
      const mat = pointsRef.current.material as THREE.PointsMaterial;
      mat.opacity = Math.max(0, 1 - t);
    }

    invalidate();

    if (t >= 1) {
      startTime.current = null;
      clearHitFx();
    }
  });

  if (!hitFxTerritoryId || !center) return null;

  return (
    <group ref={groupRef} position={[center.worldX, 0, center.worldZ]}>
      <mesh ref={flashRef} position={[0, 0.6, 0]}>
        <sphereGeometry args={[0.6, 12, 12]} />
        <meshBasicMaterial color="#ffb347" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      <points ref={pointsRef} geometry={geometry}>
        <pointsMaterial color="#8a8a8a" size={0.35} transparent opacity={0.8} depthWrite={false} />
      </points>
    </group>
  );
}
