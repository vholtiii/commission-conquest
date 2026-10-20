import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { coverageShot, ease, moveCam, reelSide, type Coverage } from "./cameraRig";
import Headlamps from "./props/Headlamps";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/**
 * One of your own is called in. His car pulls up, he walks to the door, a
 * single shot comes from the back room, and someone else drives his car away.
 */
export default function SummonsCinematic({ cinematic, site, phase, local, clock, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const color = paint(cinematic.targetFamily);

  const stage = useMemo(() => {
    const kerb = new THREE.Vector3(Math.sin(site.facing), 0, Math.cos(site.facing));
    const door = site.building.clone().addScaledVector(kerb, 1.05);
    // The car comes along the road (its nose direction) and leaves the same way.
    const fwd = new THREE.Vector3(Math.cos(site.facing), 0, -Math.sin(site.facing));
    const approach = site.road.clone().addScaledVector(fwd, -6);
    const away = site.road.clone().addScaledVector(fwd, 8);
    const manStart = site.road.clone().addScaledVector(kerb, -0.55);
    return { door, approach, away, manStart };
  }, [site]);

  const carRig = useRef<THREE.Group>(null);
  const manRef = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ car: new THREE.Vector3(), man: new THREE.Vector3(), eye: new THREE.Vector3() }), []);

  const lampsOn = phase === "drive" || phase === "drive_off";
  const walking = phase === "drive" && local > 0.4;
  // He steps out once the car has stopped at the kerb.
  const showMan = phase === "drive" && local >= 0.38;

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;

    if (ph === "drive_off") tmp.car.copy(site.road).lerp(stage.away, lc * lc);
    else {
      const arrive = ph === "call" ? 0 : ph === "drive" ? 1 - Math.pow(1 - Math.min(1, lc / 0.45), 2) : 1;
      tmp.car.copy(stage.approach).lerp(site.road, arrive);
    }
    if (carRig.current) carRig.current.position.copy(tmp.car);

    const manK = ph === "drive" ? ease(Math.max(0, (lc - 0.4) / 0.6)) : ph === "call" ? 0 : 1;
    tmp.man.copy(stage.manStart).lerp(stage.door, manK);
    if (manRef.current) manRef.current.position.copy(tmp.man);

    if (ph === "drive") {
      tmp.eye.set(
        tmp.man.x - Math.sin(site.facing) * 1.6,
        1.55,
        tmp.man.z - Math.cos(site.facing) * 1.6,
      );
      moveCam(camera, controls, tmp.eye, stage.door, 0.18, dt);
      return;
    }
    const coverage: Coverage = ph === "call" ? "wide" : ph === "back_room" ? "close" : "pull";
    const shot = coverageShot(stage.door, site.facing, coverage, {
      drift: progress,
      side: reelSide(cinematic.operationId),
    });
    moveCam(camera, controls, shot.pos, shot.look, ph === "back_room" ? 0.5 : 0.1, dt);
    if (ph === "back_room") shake.current = Math.max(shake.current, 0.05);
  });

  const glow = phase === "back_room" ? 1 - local * 0.7 : phase === "drive_off" ? 0.1 : 0.85;
  const inside: [number, number, number] = [site.building.x, 1.1, site.building.z];
  const door = stage.door;

  return (
    <group>
      <group ref={carRig} position={[stage.approach.x, 0, stage.approach.z]} rotation={[0, site.facing, 0]}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: 0, color, lamps: lampsOn }]} />
        {lampsOn && <Headlamps cars={[{ x: 0, z: 0, rot: 0 }]} />}
      </group>
      <pointLight position={[door.x, 1.3, door.z]} color="#ffb060" intensity={glow * 2.4} distance={6} />
      {phase !== "call" && (
        <Goon position={[door.x + 0.45, 0, door.z - 0.15]} rot={site.facing + Math.PI} role="associate" color="#2a2420" />
      )}
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      {showMan && (
        <group ref={manRef} position={[stage.manStart.x, 0, stage.manStart.z]}>
          <Goon position={[0, 0, 0]} rot={site.facing + Math.PI} pose="walk" moving={walking} role="soldier" color={color} />
        </group>
      )}
      <MuzzleFlash active={phase === "back_room"} from={inside} to={[door.x, 0.8, door.z]} shots={1} />
    </group>
  );
}
