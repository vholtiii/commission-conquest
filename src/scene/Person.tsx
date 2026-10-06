import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type PersonPose = "stand" | "walk" | "crouch" | "down" | "run";
export type PersonRole = "boss" | "soldier" | "associate";

interface Props {
  position: [number, number, number];
  /** Yaw. 0 faces +X. */
  rot?: number;
  pose?: PersonPose;
  /** Coat colour, usually the family colour. */
  color?: string;
  gun?: boolean;
  /** Swing the arms and legs. */
  moving?: boolean;
  /** Boss: longer coat and a taller hat. Soldier: hat, and a gun when asked. Associate: neither. */
  role?: PersonRole;
}

const SHIRT = "#cfc6b8";
const SKIN = "#c4a484";
const HAT = "#111114";
const TROUSER = "#14161c";

/** One figure for the street and the hit reels. Knees go, then the torso, when he is shot. */
export default function Person({
  position,
  rot = 0,
  pose = "stand",
  color = "#1a1c22",
  gun = false,
  moving = false,
  role = "soldier",
}: Props) {
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const fall = useRef(pose === "down" ? 1 : 0);

  const boss = role === "boss";
  const hatted = role !== "associate";
  const armed = gun && role === "soldier";
  const coatH = boss ? 0.5 : 0.4;
  const hip = 0.36;

  useFrame(({ clock }, delta) => {
    const down = pose === "down";
    const speed = pose === "run" ? 14 : 8;
    const swing = moving && !down ? Math.sin(clock.elapsedTime * speed) * 0.55 : 0;
    fall.current = THREE.MathUtils.damp(fall.current, down ? 1 : 0, 5, delta);
    const f = fall.current;
    const knee = (pose === "crouch" ? 0.7 : 0) + Math.min(1, f / 0.4) * 1.15;
    const pitch = Math.max(0, (f - 0.22) / 0.78) * (Math.PI / 2.15);
    if (leftLeg.current) leftLeg.current.rotation.x = swing + knee;
    if (rightLeg.current) rightLeg.current.rotation.x = -swing + knee * 0.65;
    if (leftArm.current) leftArm.current.rotation.x = -swing;
    if (rightArm.current) rightArm.current.rotation.x = swing * 0.6;
    if (torso.current) {
      torso.current.rotation.x = pitch;
      torso.current.position.y = hip - (pose === "crouch" ? 0.1 : 0) - f * 0.16;
    }
  });

  return (
    <group position={position} rotation={[0, rot, 0]}>
      <group ref={leftLeg} position={[-0.07, hip, 0]}>
        <mesh position={[0, -0.18, 0]} castShadow>
          <boxGeometry args={[0.07, 0.36, 0.07]} />
          <meshStandardMaterial color={TROUSER} roughness={0.75} />
        </mesh>
      </group>
      <group ref={rightLeg} position={[0.07, hip, 0]}>
        <mesh position={[0, -0.18, 0]} castShadow>
          <boxGeometry args={[0.07, 0.36, 0.07]} />
          <meshStandardMaterial color={TROUSER} roughness={0.75} />
        </mesh>
      </group>

      <group ref={torso} position={[0, hip, 0]}>
        <mesh position={[0, coatH / 2, 0]} castShadow>
          <boxGeometry args={[0.26, coatH, 0.16]} />
          <meshStandardMaterial color={color} roughness={0.65} />
        </mesh>
        <mesh position={[0, coatH * 0.42, 0.09]}>
          <boxGeometry args={[0.1, 0.16, 0.02]} />
          <meshStandardMaterial color={SHIRT} roughness={0.8} />
        </mesh>
        <mesh position={[0, coatH - 0.02, 0]}>
          <boxGeometry args={[0.34, 0.06, 0.16]} />
          <meshStandardMaterial color={color} roughness={0.65} />
        </mesh>

        <group ref={leftArm} position={[-0.18, coatH - 0.04, 0]}>
          <mesh position={[0, -0.16, 0]} castShadow>
            <boxGeometry args={[0.06, 0.32, 0.06]} />
            <meshStandardMaterial color={color} roughness={0.7} />
          </mesh>
        </group>
        <group ref={rightArm} position={[0.18, coatH - 0.04, 0]}>
          <mesh position={[0, -0.16, 0]} castShadow>
            <boxGeometry args={[0.06, 0.32, 0.06]} />
            <meshStandardMaterial color={color} roughness={0.7} />
          </mesh>
          {armed && (
            <mesh position={[0.08, -0.2, 0.1]} rotation={[0.4, 0, -0.5]}>
              <boxGeometry args={[0.26, 0.035, 0.035]} />
              <meshStandardMaterial color="#2a2a28" metalness={0.45} roughness={0.4} />
            </mesh>
          )}
        </group>

        <mesh position={[0, coatH + 0.04, 0]}>
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshStandardMaterial color={SKIN} roughness={0.6} />
        </mesh>
        <mesh position={[0, coatH + 0.14, 0]} castShadow>
          <sphereGeometry args={[0.09, 12, 10]} />
          <meshStandardMaterial color={SKIN} roughness={0.55} />
        </mesh>
        {hatted && (
          <>
            <mesh position={[0, coatH + 0.2, 0]}>
              <boxGeometry args={[0.22, 0.02, 0.22]} />
              <meshStandardMaterial color={HAT} />
            </mesh>
            <mesh position={[0, coatH + (boss ? 0.26 : 0.24), 0]}>
              <boxGeometry args={[0.13, boss ? 0.08 : 0.055, 0.13]} />
              <meshStandardMaterial color={HAT} />
            </mesh>
          </>
        )}
      </group>
    </group>
  );
}
