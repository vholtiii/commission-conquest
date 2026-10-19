import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useGameStore } from "@/engine/store";
import { useReelLook } from "../reelLook";
import Smoke from "./Smoke";

interface Props {
  center: THREE.Vector3;
  /** Yaw toward the street, so the lamp stands on the kerb and not in the building. */
  facing?: number;
  /** 0–1. Drives how thick the rain is. */
  amount: number;
}

const FOG_NEAR = 12;
const FOG_FAR = 55;

/**
 * Night on one block: a streetlamp, rain, wet pavement, and a steam grate.
 * Mounted only while a reel is playing. The daytime sun is dimmed through useReelLook.
 */
export default function ReelAtmosphere({ center, facing = 0, amount }: Props) {
  const setGrade = useReelLook((s) => s.setGrade);
  const graphics = useGameStore((s) => s.settings.graphics ?? "auto");
  const low = graphics === "low";
  const { scene } = useThree();

  useEffect(() => {
    setGrade(1);
    return () => setGrade(0);
  }, [setGrade]);

  useFrame((_, dt) => {
    const fog = scene.fog;
    if (!(fog instanceof THREE.Fog)) return;
    const k = 1 - Math.exp(-dt / 0.6);
    fog.near += (FOG_NEAR - fog.near) * k;
    fog.far += (FOG_FAR - fog.far) * k;
  });

  const lamp = useMemo(() => {
    const x = center.x + Math.sin(facing) * 2.1;
    const z = center.z + Math.cos(facing) * 2.1;
    return new THREE.Vector3(x, 0, z);
  }, [center, facing]);

  const steam = useMemo<[number, number, number]>(
    () => [center.x - Math.sin(facing) * 1.2, 0, center.z - Math.cos(facing) * 1.2],
    [center, facing],
  );

  return (
    <group>
      <Streetlamp at={lamp} shadow={!low} />
      <pointLight
        position={[center.x - Math.sin(facing) * 6, 3.2, center.z - Math.cos(facing) * 5]}
        color="#6a88b0"
        intensity={1.4}
        distance={22}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, 0.045, center.z]}>
        <planeGeometry args={[16, 16]} />
        <meshStandardMaterial
          color="#0c1016"
          roughness={0.08}
          metalness={0.85}
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </mesh>
      <Rain amount={amount} low={low} />
      <Smoke active at={steam} loop size={0.85} />
    </group>
  );
}

function Streetlamp({ at, shadow }: { at: THREE.Vector3; shadow: boolean }) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);

  useEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  return (
    <group position={[at.x, 0, at.z]}>
      <mesh position={[0, 2.1, 0]} castShadow={shadow}>
        <cylinderGeometry args={[0.05, 0.07, 4.2, 6]} />
        <meshStandardMaterial color="#2a2c30" roughness={0.7} />
      </mesh>
      <mesh position={[0, 4.15, 0.15]}>
        <boxGeometry args={[0.28, 0.1, 0.45]} />
        <meshStandardMaterial color="#1c1e22" />
      </mesh>
      <spotLight
        ref={light}
        position={[0, 4.05, 0.2]}
        angle={0.7}
        penumbra={0.6}
        intensity={22}
        distance={18}
        color="#ffc98a"
        castShadow={shadow}
        shadow-mapSize-width={512}
        shadow-mapSize-height={512}
      />
      <object3D ref={target} position={[0, 0, 0.8]} />
    </group>
  );
}

function Rain({ amount, low }: { amount: number; low: boolean }) {
  const count = low ? 160 : 420;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const drops = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        x: (Math.random() - 0.5) * 16,
        y: Math.random() * 12,
        z: (Math.random() - 0.5) * 16,
        v: 0.65 + Math.random() * 0.7,
      })),
    [count],
  );
  const { camera } = useThree();

  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    const fall = dt * (8 + amount * 18);
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i]!;
      d.y -= fall * d.v;
      if (d.y < 0) d.y = 8 + Math.random() * 6;
      dummy.position.set(camera.position.x + d.x, d.y, camera.position.z + d.z);
      dummy.scale.set(1, 0.4 + d.v, 1);
      dummy.rotation.set(0.22, 0, 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[0.018, 0.5, 0.018]} />
      <meshBasicMaterial color="#d5dee8" transparent opacity={0.28 + amount * 0.22} depthWrite={false} />
    </instancedMesh>
  );
}
