import { useEffect, useMemo, useRef, type Ref } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useGameStore } from "@/engine/store";
import { blendRate, restJoints, targetPose, type Joints, type PoseKind } from "./figure/poses";

export type PersonPose = "stand" | "walk" | "crouch" | "down" | "run" | "aim" | "talk" | "sit" | "handshake" | "getIn";
export type PersonRole = "boss" | "soldier" | "associate";
export type PersonWeapon = "pistol" | "tommy";

interface Props {
  position: [number, number, number];
  /** Yaw. 0 faces +Z. */
  rot?: number;
  pose?: PersonPose;
  /** Coat colour, usually the family colour. */
  color?: string;
  gun?: boolean;
  weapon?: PersonWeapon;
  /** Swing the arms and legs. */
  moving?: boolean;
  /** Boss: longer coat, wider hat, a cigar. Soldier: fedora, and a gun when asked. Associate: cap or bare head. */
  role?: PersonRole;
  /** World point the head and chest turn toward; an aiming man points the gun at it. */
  lookAt?: THREE.Vector3 | [number, number, number];
  /** Recoil while aiming. */
  firing?: boolean;
  /** Same seed, same face, coat shade and habits. */
  seed?: number;
  /** Tip of the barrel, for muzzle flashes. */
  muzzleRef?: Ref<THREE.Object3D>;
}

const SKINS = ["#c9a183", "#b98d6c", "#d8b394", "#a87b5a", "#c49a7a", "#e0bfa0"];
const TIES = ["#6a2a2a", "#2a3a5a", "#3a3a2a", "#5a4a2a", "#202024", "#4a2a4a"];
const HAIR = ["#1a1612", "#2a2018", "#3a2e22", "#4a4038", "#141414"];

const M = {
  shirt: new THREE.MeshStandardMaterial({ color: "#d4ccbe", roughness: 0.9 }),
  trouser: new THREE.MeshStandardMaterial({ color: "#16181e", roughness: 0.9 }),
  shoe: new THREE.MeshStandardMaterial({ color: "#0b0b0d", roughness: 0.45, metalness: 0.1 }),
  hat: new THREE.MeshStandardMaterial({ color: "#121216", roughness: 0.75 }),
  gun: new THREE.MeshStandardMaterial({ color: "#26262a", roughness: 0.35, metalness: 0.65 }),
  wood: new THREE.MeshStandardMaterial({ color: "#4a2e1a", roughness: 0.6 }),
  eye: new THREE.MeshStandardMaterial({ color: "#141010", roughness: 0.3 }),
  brow: new THREE.MeshStandardMaterial({ color: "#2a2018", roughness: 0.9 }),
  lip: new THREE.MeshStandardMaterial({ color: "#7a4a3e", roughness: 0.7 }),
  cigar: new THREE.MeshStandardMaterial({ color: "#5a3a22", roughness: 0.8 }),
  ember: new THREE.MeshStandardMaterial({ color: "#ff8a3a", emissive: "#ff6a1a", emissiveIntensity: 2.2 }),
};

interface Geos {
  torso: THREE.BufferGeometry;
  shoulders: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  skirt: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  upper: THREE.BufferGeometry;
  fore: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  brow: THREE.BufferGeometry;
  nose: THREE.BufferGeometry;
  mouth: THREE.BufferGeometry;
  lapel: THREE.BufferGeometry;
  shirt: THREE.BufferGeometry;
  tie: THREE.BufferGeometry;
  brim: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  band: THREE.BufferGeometry;
  capTop: THREE.BufferGeometry;
  capBill: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  cigar: THREE.BufferGeometry;
  tip: THREE.BufferGeometry;
  box: THREE.BufferGeometry;
  drum: THREE.BufferGeometry;
}

const geoCache: Partial<Record<"low" | "full", Geos>> = {};

function geos(low: boolean): Geos {
  const key = low ? "low" : "full";
  const hit = geoCache[key];
  if (hit) return hit;
  const cap = low ? 3 : 6;
  const rad = low ? 6 : 10;
  const g: Geos = {
    torso: new THREE.CapsuleGeometry(0.105, 0.17, cap, rad),
    shoulders: new THREE.CapsuleGeometry(0.052, 0.2, cap, rad).rotateZ(Math.PI / 2),
    pelvis: new THREE.CapsuleGeometry(0.07, 0.09, cap, rad).rotateZ(Math.PI / 2),
    skirt: new THREE.CylinderGeometry(0.058, 0.07, 1, rad),
    tail: new THREE.CylinderGeometry(0.1, 0.125, 1, rad, 1, true, Math.PI * 0.55, Math.PI * 0.9),
    thigh: new THREE.CapsuleGeometry(0.043, 0.15, cap, rad),
    shin: new THREE.CapsuleGeometry(0.036, 0.15, cap, rad),
    shoe: new THREE.BoxGeometry(0.074, 0.04, 0.13),
    upper: new THREE.CapsuleGeometry(0.035, 0.11, cap, rad),
    fore: new THREE.CapsuleGeometry(0.03, 0.1, cap, rad),
    hand: new THREE.SphereGeometry(0.029, rad, rad - 2),
    neck: new THREE.CylinderGeometry(0.032, 0.037, 0.05, rad),
    head: new THREE.SphereGeometry(0.072, low ? 10 : 16, low ? 8 : 12),
    eye: new THREE.SphereGeometry(0.0095, 6, 4),
    ear: new THREE.SphereGeometry(0.016, 6, 4),
    brow: new THREE.BoxGeometry(0.03, 0.007, 0.01),
    nose: new THREE.BoxGeometry(0.015, 0.026, 0.022),
    mouth: new THREE.BoxGeometry(0.03, 0.006, 0.006),
    lapel: new THREE.BoxGeometry(0.042, 0.17, 0.012),
    shirt: new THREE.BoxGeometry(0.06, 0.15, 0.01),
    tie: new THREE.BoxGeometry(0.022, 0.13, 0.012),
    brim: new THREE.CylinderGeometry(1, 1, 0.01, low ? 10 : 18),
    crown: new THREE.CylinderGeometry(0.056, 0.07, 1, low ? 8 : 14),
    band: new THREE.CylinderGeometry(0.0712, 0.0712, 0.014, low ? 8 : 14),
    capTop: new THREE.SphereGeometry(0.08, low ? 8 : 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    capBill: new THREE.BoxGeometry(0.1, 0.008, 0.06),
    hair: new THREE.SphereGeometry(0.076, low ? 8 : 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    cigar: new THREE.CylinderGeometry(0.007, 0.007, 0.06, 6).rotateX(Math.PI / 2),
    tip: new THREE.SphereGeometry(0.008, 6, 4),
    box: new THREE.BoxGeometry(1, 1, 1),
    drum: new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12).rotateZ(Math.PI / 2),
  };
  geoCache[key] = g;
  return g;
}

function seededRandom(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poseKind(pose: PersonPose, moving: boolean): PoseKind {
  if (pose === "down") return "down";
  if (pose === "crouch" || pose === "aim" || pose === "talk" || pose === "sit" || pose === "handshake" || pose === "getIn") {
    return pose;
  }
  if (moving) return pose === "run" ? "run" : "walk";
  return "idle";
}

const HIP = 0.5;
const HAT_REST = 1.02;

/** One figure for the street and the reels, on a small skeleton with blended poses. */
export default function Person({
  position,
  rot = 0,
  pose = "stand",
  color = "#1a1c22",
  gun = false,
  weapon,
  moving = false,
  role = "soldier",
  lookAt,
  firing = false,
  seed,
  muzzleRef,
}: Props) {
  const low = useGameStore((s) => s.settings.graphics === "low");
  const g = geos(low);
  const boss = role === "boss";
  const armed = gun ? (weapon ?? "pistol") : null;

  const look = useMemo(() => {
    const rand = seededRandom(seed ?? Math.floor(Math.random() * 1e9));
    const coat = new THREE.Color(color).lerp(new THREE.Color("#000000"), rand() * 0.18);
    return {
      gait: rand() * Math.PI * 2,
      habit: rand(),
      scale: 0.95 + rand() * 0.1,
      coat: new THREE.MeshStandardMaterial({ color: coat, roughness: 0.82, side: THREE.DoubleSide }),
      skin: new THREE.MeshStandardMaterial({ color: SKINS[Math.floor(rand() * SKINS.length)]!, roughness: 0.6 }),
      tie: new THREE.MeshStandardMaterial({ color: TIES[Math.floor(rand() * TIES.length)]!, roughness: 0.5 }),
      band: new THREE.MeshStandardMaterial({ color: boss ? "#3a3a40" : TIES[Math.floor(rand() * TIES.length)]!, roughness: 0.5 }),
      hair: new THREE.MeshStandardMaterial({ color: HAIR[Math.floor(rand() * HAIR.length)]!, roughness: 0.95 }),
      cap: rand() < 0.5,
    };
  }, [color, seed, boss]);

  useEffect(
    () => () => {
      look.coat.dispose();
      look.skin.dispose();
      look.tie.dispose();
      look.band.dispose();
      look.hair.dispose();
    },
    [look],
  );

  const root = useRef<THREE.Group>(null);
  const fall = useRef<THREE.Group>(null);
  const hips = useRef<THREE.Group>(null);
  const spine = useRef<THREE.Group>(null);
  const neck = useRef<THREE.Group>(null);
  const lArm = useRef<THREE.Group>(null);
  const rArm = useRef<THREE.Group>(null);
  const lFore = useRef<THREE.Group>(null);
  const rFore = useRef<THREE.Group>(null);
  const lThigh = useRef<THREE.Group>(null);
  const rThigh = useRef<THREE.Group>(null);
  const lShin = useRef<THREE.Group>(null);
  const rShin = useRef<THREE.Group>(null);
  const lFoot = useRef<THREE.Group>(null);
  const rFoot = useRef<THREE.Group>(null);
  const lSkirt = useRef<THREE.Group>(null);
  const rSkirt = useRef<THREE.Group>(null);
  const tail = useRef<THREE.Group>(null);
  const hat = useRef<THREE.Group>(null);
  const fallenHat = useRef<THREE.Group>(null);

  const joints = useRef<Joints>(restJoints());
  const target = useRef<Joints>(restJoints());
  const hitAt = useRef<number | null>(null);
  const bornDown = useRef(pose === "down");
  const hatDrop = useRef(pose === "down" ? 1 : 0);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(0.05, delta);
    const t = clock.elapsedTime;
    const kind = poseKind(pose, moving);
    if (kind === "down" && hitAt.current === null) hitAt.current = bornDown.current ? t - 2 : t;
    if (kind !== "down") {
      hitAt.current = null;
      hatDrop.current = 0;
    }
    const since = hitAt.current === null ? 0 : t - hitAt.current;

    const tg = targetPose(
      kind,
      { t, gait: look.gait, seed: look.habit, armed: !!armed, since, firing },
      target.current,
    );

    if (lookAt && root.current && kind !== "down") {
      if (Array.isArray(lookAt)) tmp.set(lookAt[0], lookAt[1], lookAt[2]);
      else tmp.copy(lookAt);
      root.current.worldToLocal(tmp);
      const yaw = THREE.MathUtils.clamp(Math.atan2(tmp.x, tmp.z), -1.4, 1.4);
      const pitch = THREE.MathUtils.clamp(Math.atan2(tmp.y - 0.85, Math.hypot(tmp.x, tmp.z)), -0.7, 0.7);
      if (kind === "aim") {
        tg.spineY += yaw * 0.85;
        tg.neckY += yaw * 0.15;
        tg.rShoulderX -= pitch;
        tg.lShoulderX -= pitch;
      } else {
        tg.spineY += yaw * 0.35;
        tg.neckY = tg.neckY * 0.2 + yaw * 0.6;
        tg.neckX -= pitch * 0.5;
      }
    }

    const j = joints.current;
    const rate = blendRate(kind);
    if (bornDown.current && kind === "down" && since > 1.9) {
      Object.assign(j, tg);
      bornDown.current = false;
    } else {
      for (const k in tg) {
        const key = k as keyof Joints;
        j[key] = THREE.MathUtils.damp(j[key], tg[key], rate, dt);
      }
    }

    if (fall.current) {
      fall.current.position.set(0, HIP - j.fallDrop, -j.fallBack);
      fall.current.rotation.x = j.fallPitch;
    }
    hips.current?.position.set(0, HIP + j.hipY, 0);
    hips.current?.rotation.set(j.hipX, 0, j.hipZ);
    spine.current?.rotation.set(j.spineX, j.spineY, j.spineZ);
    neck.current?.rotation.set(j.neckX, j.neckY, 0);
    lArm.current?.rotation.set(j.lShoulderX, 0, j.lShoulderZ);
    rArm.current?.rotation.set(j.rShoulderX, j.rShoulderY, j.rShoulderZ);
    if (lFore.current) lFore.current.rotation.x = j.lElbow;
    if (rFore.current) rFore.current.rotation.x = j.rElbow;
    lThigh.current?.rotation.set(j.lThigh, 0, j.lThighZ);
    rThigh.current?.rotation.set(j.rThigh, 0, j.rThighZ);
    if (lShin.current) lShin.current.rotation.x = j.lKnee;
    if (rShin.current) rShin.current.rotation.x = j.rKnee;
    if (lFoot.current) lFoot.current.rotation.x = j.lAnkle - j.lThigh - j.lKnee * 0.4;
    if (rFoot.current) rFoot.current.rotation.x = j.rAnkle - j.rThigh - j.rKnee * 0.4;
    if (lSkirt.current) lSkirt.current.rotation.x = Math.min(0.1, j.lThigh * 0.55);
    if (rSkirt.current) rSkirt.current.rotation.x = Math.min(0.1, j.rThigh * 0.55);
    if (tail.current) tail.current.rotation.x = 0.04 + j.tail;

    const hatOff = kind === "down" && since > 0.18;
    if (hat.current) hat.current.visible = role !== "associate" && !hatOff;
    if (fallenHat.current) {
      if (hatOff) hatDrop.current = Math.min(1, hatDrop.current + dt * 3.2);
      const d = hatDrop.current;
      fallenHat.current.visible = role !== "associate" && d > 0.01;
      fallenHat.current.position.set(0.25 * d, HAT_REST * (1 - d) + 0.02 * d, -0.55 * d);
      fallenHat.current.rotation.set(0, d * 1.3, d * (Math.PI / 2));
    }
  });

  const coatLen = boss ? 0.36 : 0.28;
  const width = boss ? 1.14 : 1;

  return (
    <group ref={root} position={position} rotation={[0, rot, 0]} scale={look.scale}>
      <group ref={fall} position={[0, HIP, 0]}>
        <group position={[0, -HIP, 0]}>
          <group ref={hips} position={[0, HIP, 0]}>
            <mesh geometry={g.pelvis} material={M.trouser} position={[0, -0.01, 0]} scale={[width, 1, 0.75]} castShadow />
            {/* Coat skirt: two front panels that follow the legs, a back vent that flares. */}
            <group ref={lSkirt} position={[-0.058 * width, 0.04, 0.005]}>
              <mesh geometry={g.skirt} material={look.coat} position={[0, -coatLen / 2, 0.01]} scale={[width, coatLen, 1.2]} castShadow />
            </group>
            <group ref={rSkirt} position={[0.058 * width, 0.04, 0.005]}>
              <mesh geometry={g.skirt} material={look.coat} position={[0, -coatLen / 2, 0.01]} scale={[width, coatLen, 1.2]} castShadow />
            </group>
            <group ref={tail} position={[0, 0.03, 0]}>
              <mesh geometry={g.tail} material={look.coat} position={[0, -coatLen * 0.45, 0]} scale={[width, coatLen * 0.9, 0.8]} castShadow />
            </group>
            <Leg side={-1} g={g} thighRef={lThigh} shinRef={lShin} footRef={lFoot} />
            <Leg side={1} g={g} thighRef={rThigh} shinRef={rShin} footRef={rFoot} />

            <group ref={spine} position={[0, 0.03, 0]}>
              <mesh geometry={g.torso} material={look.coat} position={[0, 0.17, 0]} scale={[width, 1, 0.72]} castShadow />
              <mesh geometry={g.shoulders} material={look.coat} position={[0, 0.305, 0]} scale={[width, 1, 0.78]} castShadow />
              <mesh geometry={g.shirt} material={M.shirt} position={[0, 0.25, 0.073]} />
              <mesh geometry={g.tie} material={look.tie} position={[0, 0.235, 0.08]} />
              <mesh geometry={g.lapel} material={look.coat} position={[-0.04, 0.24, 0.078]} rotation={[0.05, 0, 0.3]} />
              <mesh geometry={g.lapel} material={look.coat} position={[0.04, 0.24, 0.078]} rotation={[0.05, 0, -0.3]} />

              <group ref={neck} position={[0, 0.355, 0]}>
                <mesh geometry={g.neck} material={look.skin} position={[0, 0.02, 0]} />
                <group position={[0, 0.1, 0.005]}>
                  <mesh geometry={g.head} material={look.skin} scale={[0.92, 1.05, 0.96]} castShadow receiveShadow />
                  <Face g={g} skin={look.skin} />
                  {boss && (
                    <group position={[0.022, -0.032, 0.085]} rotation={[0.15, 0.25, 0]}>
                      <mesh geometry={g.cigar} material={M.cigar} />
                      <mesh geometry={g.tip} material={M.ember} position={[0, 0, 0.03]} />
                    </group>
                  )}
                  {role === "associate" ? (
                    look.cap ? (
                      <group position={[0, 0.03, 0]}>
                        <mesh geometry={g.capTop} material={look.hair} scale={[1, 0.55, 1.05]} castShadow />
                        <mesh geometry={g.capBill} material={look.hair} position={[0, 0.004, 0.085]} rotation={[0.18, 0, 0]} />
                      </group>
                    ) : (
                      <mesh geometry={g.hair} material={look.hair} position={[0, 0.006, -0.006]} scale={[0.97, 1.02, 1]} />
                    )
                  ) : (
                    <group ref={hat} position={[0, 0.04, 0]} rotation={[-0.06, 0, 0]}>
                      <Fedora g={g} boss={boss} band={look.band} />
                    </group>
                  )}
                </group>
              </group>

              <Arm side={-1} g={g} coat={look.coat} skin={look.skin} width={width} upperRef={lArm} foreRef={lFore} />
              <Arm
                side={1}
                g={g}
                coat={look.coat}
                skin={look.skin}
                width={width}
                upperRef={rArm}
                foreRef={rFore}
                weapon={armed}
                muzzleRef={muzzleRef}
              />
            </group>
          </group>
        </group>
      </group>
      {role !== "associate" && (
        <group ref={fallenHat} visible={false}>
          <Fedora g={g} boss={boss} band={look.band} />
        </group>
      )}
    </group>
  );
}

function Face({ g, skin }: { g: Geos; skin: THREE.Material }) {
  return (
    <group>
      <mesh geometry={g.eye} material={M.eye} position={[-0.025, 0.012, 0.063]} />
      <mesh geometry={g.eye} material={M.eye} position={[0.025, 0.012, 0.063]} />
      <mesh geometry={g.brow} material={M.brow} position={[-0.025, 0.03, 0.066]} rotation={[0, 0, 0.12]} />
      <mesh geometry={g.brow} material={M.brow} position={[0.025, 0.03, 0.066]} rotation={[0, 0, -0.12]} />
      <mesh geometry={g.nose} material={skin} position={[0, -0.002, 0.071]} rotation={[-0.2, 0, 0]} />
      <mesh geometry={g.mouth} material={M.lip} position={[0, -0.032, 0.064]} />
      <mesh geometry={g.ear} material={skin} position={[-0.066, 0.002, 0]} scale={[0.5, 1, 0.8]} />
      <mesh geometry={g.ear} material={skin} position={[0.066, 0.002, 0]} scale={[0.5, 1, 0.8]} />
    </group>
  );
}

function Fedora({ g, boss, band }: { g: Geos; boss: boolean; band: THREE.Material }) {
  const brim = boss ? 0.128 : 0.115;
  const crown = boss ? 0.085 : 0.07;
  return (
    <group>
      <mesh geometry={g.brim} material={M.hat} scale={[brim, 1, brim * 1.05]} castShadow />
      <mesh geometry={g.crown} material={M.hat} position={[0, crown / 2 + 0.004, 0]} scale={[1, crown, 1.08]} castShadow />
      <mesh geometry={g.band} material={band} position={[0, 0.013, 0]} scale={[1, 1, 1.08]} />
    </group>
  );
}

function Leg({
  side,
  g,
  thighRef,
  shinRef,
  footRef,
}: {
  side: -1 | 1;
  g: Geos;
  thighRef: Ref<THREE.Group>;
  shinRef: Ref<THREE.Group>;
  footRef: Ref<THREE.Group>;
}) {
  return (
    <group ref={thighRef} position={[side * 0.064, -0.02, 0]}>
      <mesh geometry={g.thigh} material={M.trouser} position={[0, -0.115, 0]} castShadow />
      <group ref={shinRef} position={[0, -0.23, 0]}>
        <mesh geometry={g.shin} material={M.trouser} position={[0, -0.11, 0]} castShadow />
        <group ref={footRef} position={[0, -0.235, 0]}>
          <mesh geometry={g.shoe} material={M.shoe} position={[0, -0.006, 0.03]} castShadow />
        </group>
      </group>
    </group>
  );
}

function Arm({
  side,
  g,
  coat,
  skin,
  width,
  upperRef,
  foreRef,
  weapon = null,
  muzzleRef,
}: {
  side: -1 | 1;
  g: Geos;
  coat: THREE.Material;
  skin: THREE.Material;
  width: number;
  upperRef: Ref<THREE.Group>;
  foreRef: Ref<THREE.Group>;
  weapon?: PersonWeapon | null;
  muzzleRef?: Ref<THREE.Object3D>;
}) {
  return (
    <group ref={upperRef} position={[side * 0.14 * width, 0.31, 0]}>
      <mesh geometry={g.upper} material={coat} position={[0, -0.085, 0]} castShadow />
      <group ref={foreRef} position={[0, -0.17, 0]}>
        <mesh geometry={g.fore} material={coat} position={[0, -0.075, 0]} castShadow />
        <mesh geometry={g.hand} material={skin} position={[0, -0.165, 0.004]} scale={[0.9, 1.1, 1]} />
        {weapon === "pistol" && (
          <group position={[0, -0.17, 0.02]}>
            <mesh geometry={g.box} material={M.gun} position={[0, 0.005, -0.01]} rotation={[0.3, 0, 0]} scale={[0.022, 0.05, 0.034]} />
            <mesh geometry={g.box} material={M.gun} position={[0, -0.055, 0.012]} scale={[0.022, 0.12, 0.026]} />
            <object3D ref={muzzleRef} position={[0, -0.12, 0.012]} />
          </group>
        )}
        {weapon === "tommy" && (
          <group position={[0, -0.17, 0.02]}>
            <mesh geometry={g.box} material={M.wood} position={[0, 0.08, -0.005]} scale={[0.03, 0.15, 0.04]} />
            <mesh geometry={g.box} material={M.gun} position={[0, -0.09, 0.012]} scale={[0.03, 0.22, 0.034]} />
            <mesh geometry={g.box} material={M.gun} position={[0, -0.25, 0.012]} scale={[0.018, 0.12, 0.018]} />
            <mesh geometry={g.drum} material={M.gun} position={[0, -0.04, 0.05]} />
            <mesh geometry={g.box} material={M.wood} position={[0, -0.17, 0.035]} scale={[0.026, 0.06, 0.03]} />
            <object3D ref={muzzleRef} position={[0, -0.31, 0.012]} />
          </group>
        )}
      </group>
    </group>
  );
}
