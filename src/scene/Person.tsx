import { useRef, type RefObject } from "react";
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
const BAND = "#6a2a2a";
const TROUSER = "#14161c";
const SHOE = "#0c0c0e";
const GUN = "#2a2a28";

const cloth = { roughness: 0.88, metalness: 0.02 } as const;

/** 0 before `a`, 1 after `b`, smooth between. */
function smooth(v: number, a: number, b: number): number {
  const t = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** One figure for the street and the hit reels. A shot puts him on the pavement. */
export default function Person({
  position,
  rot = 0,
  pose = "stand",
  color = "#1a1c22",
  gun = false,
  moving = false,
  role = "soldier",
}: Props) {
  const body = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const leftShin = useRef<THREE.Group>(null);
  const rightShin = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftFore = useRef<THREE.Group>(null);
  const rightFore = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const hat = useRef<THREE.Group>(null);
  const fallenHat = useRef<THREE.Group>(null);
  const hatDrop = useRef(pose === "down" ? 1 : 0);
  const hitAt = useRef<number | null>(null);
  const bornDown = useRef(pose === "down");
  // Eased so a pose or `moving` change blends over a few frames instead of snapping.
  const crouchAmt = useRef(pose === "crouch" ? 1 : 0);
  const stride = useRef(moving ? 1 : 0);
  // Nobody in a crowd marches in step.
  const gait = useRef(Math.random() * Math.PI * 2);

  const boss = role === "boss";
  const hatted = role !== "associate";
  const armed = gun && role === "soldier";
  const coatH = boss ? 0.48 : 0.38;
  const hip = 0.5;
  /** Brim height while the hat is still on, where the fallen one starts. */
  const hatRest = hip + coatH + 0.155;
  const hatY = coatH + 0.11 + 0.045;

  useFrame(({ clock }, delta) => {
    const down = pose === "down";
    if (down && hitAt.current === null) {
      hitAt.current = bornDown.current ? clock.elapsedTime - 1 : clock.elapsedTime;
    }
    if (!down) {
      hitAt.current = null;
      hatDrop.current = 0;
    }
    const since = hitAt.current === null ? 0 : clock.elapsedTime - hitAt.current;
    // Three beats: the shot snaps him back, the knees go, then he meets the pavement.
    const impact = down ? smooth(since, 0, 0.2) : 0;
    const knees = down ? smooth(since, 0.2, 0.55) : 0;
    const flat = down ? smooth(since, 0.45, 1) : 0;

    const speed = pose === "run" ? 14 : 8;
    stride.current = THREE.MathUtils.damp(stride.current, moving && !down ? 1 : 0, 10, delta);
    crouchAmt.current = THREE.MathUtils.damp(crouchAmt.current, pose === "crouch" ? 1 : 0, 9, delta);
    const swing = Math.sin(clock.elapsedTime * speed + gait.current) * 0.55 * stride.current;
    const crouch = crouchAmt.current;
    const fallKnee = knees * (1 - flat) * 1.3;
    const thighFlat = (Math.PI / 2) * 0.95 * flat;
    const kneeL = crouch * 0.7 + fallKnee;
    const kneeR = (fallKnee > 0 || flat > 0 ? crouch * 0.7 : crouch * 0.7 * 0.65) + fallKnee;

    if (body.current) {
      const sink = (knees * 0.45 + flat * 0.55) * (hip - 0.1);
      body.current.position.y = -sink;
      body.current.position.z = -0.22 * Math.max(impact, flat);
    }
    if (leftLeg.current) leftLeg.current.rotation.x = swing * (1 - flat) + kneeL + thighFlat;
    if (rightLeg.current) rightLeg.current.rotation.x = -swing * (1 - flat) + kneeR + thighFlat;
    if (leftShin.current) {
      leftShin.current.rotation.x = -Math.max(0, swing) * 0.45 * (1 - flat) - kneeL * 0.95;
    }
    if (rightShin.current) {
      rightShin.current.rotation.x = -Math.max(0, -swing) * 0.45 * (1 - flat) - kneeR * 0.95;
    }

    const armUp = impact * (1 - flat * 0.35);
    if (leftArm.current) {
      leftArm.current.rotation.x = THREE.MathUtils.lerp(-swing, -2.0, armUp);
      leftArm.current.rotation.z = 1.15 * flat;
    }
    if (rightArm.current) {
      rightArm.current.rotation.x = THREE.MathUtils.lerp(swing * 0.6, -1.6, armUp);
      rightArm.current.rotation.z = 0;
    }
    if (leftFore.current) leftFore.current.rotation.x = Math.abs(swing) * 0.4 * (1 - flat) + armUp * 0.5;
    if (rightFore.current) rightFore.current.rotation.x = Math.abs(swing) * 0.28 * (1 - flat) + armUp * 0.3;
    if (torso.current) {
      torso.current.rotation.x = -0.3 * impact * (1 - flat) + (Math.PI / 2) * flat;
      torso.current.rotation.y = 0;
      torso.current.rotation.z = Math.sin(since * 28) * 0.22 * impact * (1 - knees) + 0.2 * flat;
      torso.current.position.y = hip - crouch * 0.1;
    }
    if (hat.current) hat.current.visible = hatted && !(down && since > 0.18);
    if (fallenHat.current) {
      if (down && since > 0.18) hatDrop.current = Math.min(1, hatDrop.current + delta * 3.2);
      const d = hatDrop.current;
      fallenHat.current.visible = hatted && d > 0.01;
      fallenHat.current.position.set(0.2 * d, hatRest * (1 - d) + 0.1 * d, 0.3 * d);
      fallenHat.current.rotation.z = d * (Math.PI / 2);
    }
  });

  return (
    <group position={position} rotation={[0, rot, 0]}>
      <group ref={body}>
        <Leg which="left" hip={hip} thighRef={leftLeg} shinRef={leftShin} />
        <Leg which="right" hip={hip} thighRef={rightLeg} shinRef={rightShin} />

        <group ref={torso} position={[0, hip, 0]}>
          <mesh position={[0, coatH * 0.46, 0]} castShadow>
            <boxGeometry args={[boss ? 0.28 : 0.24, coatH, 0.14]} />
            <meshStandardMaterial color={color} {...cloth} />
          </mesh>
          <mesh position={[0, coatH - 0.015, 0]} castShadow>
            <boxGeometry args={[0.3, 0.05, 0.16]} />
            <meshStandardMaterial color={color} {...cloth} />
          </mesh>
          <mesh position={[-0.045, coatH * 0.55, 0.072]} rotation={[0, 0, 0.35]}>
            <boxGeometry args={[0.035, coatH * 0.55, 0.012]} />
            <meshStandardMaterial color={color} roughness={0.8} />
          </mesh>
          <mesh position={[0.045, coatH * 0.55, 0.072]} rotation={[0, 0, -0.35]}>
            <boxGeometry args={[0.035, coatH * 0.55, 0.012]} />
            <meshStandardMaterial color={color} roughness={0.8} />
          </mesh>
          <mesh position={[0, coatH * 0.28, 0.075]}>
            <boxGeometry args={[0.07, 0.1, 0.012]} />
            <meshStandardMaterial color={SHIRT} roughness={0.9} />
          </mesh>
          <mesh position={[0, coatH + 0.02, 0]}>
            <cylinderGeometry args={[0.035, 0.04, 0.05, 8]} />
            <meshStandardMaterial color={SKIN} roughness={0.65} />
          </mesh>
          <mesh position={[0, coatH + 0.11, 0]} castShadow>
            <sphereGeometry args={[0.078, 14, 12]} />
            <meshStandardMaterial color={SKIN} roughness={0.55} />
          </mesh>

          <Arm side={-1} coatH={coatH} color={color} upperRef={leftArm} foreRef={leftFore} />
          <Arm side={1} coatH={coatH} color={color} upperRef={rightArm} foreRef={rightFore} gun={armed} />
          {hatted && (
            <group ref={hat} position={[0, hatY, 0]}>
              <Fedora tall={boss} />
            </group>
          )}
        </group>
      </group>
      {hatted && (
        <group ref={fallenHat} visible={false}>
          <Fedora tall={boss} />
        </group>
      )}
    </group>
  );
}

function Fedora({ tall }: { tall: boolean }) {
  return (
    <>
      <mesh>
        <boxGeometry args={[0.2, 0.012, 0.2]} />
        <meshStandardMaterial color={HAT} roughness={0.7} />
      </mesh>
      <mesh position={[0, tall ? 0.055 : 0.04, 0.01]}>
        <boxGeometry args={[0.11, tall ? 0.09 : 0.065, 0.12]} />
        <meshStandardMaterial color={HAT} roughness={0.65} />
      </mesh>
      <mesh position={[0, tall ? 0.03 : 0.022, 0.01]}>
        <boxGeometry args={[0.115, 0.012, 0.125]} />
        <meshStandardMaterial color={BAND} roughness={0.5} />
      </mesh>
    </>
  );
}

function Leg({
  which,
  hip,
  thighRef,
  shinRef,
}: {
  which: "left" | "right";
  hip: number;
  thighRef: RefObject<THREE.Group | null>;
  shinRef: RefObject<THREE.Group | null>;
}) {
  const x = which === "left" ? -0.07 : 0.07;
  return (
    <group ref={thighRef} position={[x, hip, 0]}>
      <mesh position={[0, -0.12, 0]} castShadow>
        <boxGeometry args={[0.07, 0.24, 0.08]} />
        <meshStandardMaterial color={TROUSER} {...cloth} />
      </mesh>
      <group ref={shinRef} position={[0, -0.24, 0]}>
        <mesh position={[0, -0.1, 0]} castShadow>
          <boxGeometry args={[0.06, 0.2, 0.07]} />
          <meshStandardMaterial color={TROUSER} {...cloth} />
        </mesh>
        <mesh position={[0, -0.21, 0.02]}>
          <boxGeometry args={[0.075, 0.04, 0.12]} />
          <meshStandardMaterial color={SHOE} roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

function Arm({
  side,
  coatH,
  color,
  upperRef,
  foreRef,
  gun = false,
}: {
  side: -1 | 1;
  coatH: number;
  color: string;
  upperRef: RefObject<THREE.Group | null>;
  foreRef: RefObject<THREE.Group | null>;
  gun?: boolean;
}) {
  return (
    <group ref={upperRef} position={[side * 0.16, coatH - 0.02, 0]}>
      <mesh position={[0, -0.09, 0]} castShadow>
        <boxGeometry args={[0.055, 0.18, 0.06]} />
        <meshStandardMaterial color={color} {...cloth} />
      </mesh>
      <group ref={foreRef} position={[0, -0.18, 0]}>
        <mesh position={[0, -0.08, 0]} castShadow>
          <boxGeometry args={[0.048, 0.16, 0.05]} />
          <meshStandardMaterial color={color} {...cloth} />
        </mesh>
        <mesh position={[side * 0.01, -0.17, 0.01]}>
          <boxGeometry args={[0.04, 0.045, 0.04]} />
          <meshStandardMaterial color={SKIN} roughness={0.6} />
        </mesh>
        {gun && (
          <group position={[0.02, -0.1, 0.06]} rotation={[0.35, 0.2, -0.4]}>
            <mesh position={[0.08, 0, 0]}>
              <boxGeometry args={[0.2, 0.028, 0.028]} />
              <meshStandardMaterial color={GUN} metalness={0.55} roughness={0.35} />
            </mesh>
            <mesh position={[-0.02, -0.03, 0]}>
              <boxGeometry args={[0.05, 0.06, 0.03]} />
              <meshStandardMaterial color={GUN} metalness={0.4} roughness={0.45} />
            </mesh>
          </group>
        )}
      </group>
    </group>
  );
}
