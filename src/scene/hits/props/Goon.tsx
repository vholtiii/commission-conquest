import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type GoonPose = "stand" | "walk" | "crouch" | "down" | "run";

interface Props {
  position: [number, number, number];
  /** Yaw. 0 faces +X. */
  rot?: number;
  pose?: GoonPose;
  /** Coat colour. */
  color?: string;
  gun?: boolean;
  /** Swing the legs. */
  moving?: boolean;
}

const COAT = "#1a1c22";

/** Stylised figure: coat, fedora, optional tommy gun. About a sedan tall. */
export default function Goon({
  position,
  rot = 0,
  pose = "stand",
  color = COAT,
  gun = false,
  moving = false,
}: Props) {
  const left = useRef<THREE.Mesh>(null);
  const right = useRef<THREE.Mesh>(null);
  const crouch = pose === "crouch";
  const down = pose === "down";
  const speed = pose === "run" ? 14 : 8;

  useFrame(({ clock }) => {
    const swing = moving && !down ? Math.sin(clock.elapsedTime * speed) * 0.55 : 0;
    if (left.current) left.current.rotation.x = swing;
    if (right.current) right.current.rotation.x = -swing;
  });

  return (
    <group position={position} rotation={[down ? Math.PI / 2.2 : 0, rot, 0]} scale={crouch ? 0.82 : 1}>
      <mesh position={[0, down ? 0.15 : 0.48, 0]} castShadow>
        <boxGeometry args={[0.22, 0.42, 0.16]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh ref={left} position={[-0.07, 0.16, 0]}>
        <boxGeometry args={[0.07, 0.28, 0.07]} />
        <meshStandardMaterial color="#14161c" />
      </mesh>
      <mesh ref={right} position={[0.07, 0.16, 0]}>
        <boxGeometry args={[0.07, 0.28, 0.07]} />
        <meshStandardMaterial color="#14161c" />
      </mesh>
      <mesh position={[0, 0.78, 0]}>
        <sphereGeometry args={[0.09, 10, 8]} />
        <meshStandardMaterial color="#c4a484" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.88, 0]}>
        <boxGeometry args={[0.22, 0.025, 0.22]} />
        <meshStandardMaterial color="#111114" />
      </mesh>
      <mesh position={[0, 0.93, 0]}>
        <boxGeometry args={[0.12, 0.07, 0.12]} />
        <meshStandardMaterial color="#111114" />
      </mesh>
      {gun && !down && (
        <mesh position={[0.16, 0.5, 0.08]} rotation={[0, 0, -0.4]}>
          <boxGeometry args={[0.28, 0.04, 0.04]} />
          <meshStandardMaterial color="#2a2a28" metalness={0.4} />
        </mesh>
      )}
    </group>
  );
}
