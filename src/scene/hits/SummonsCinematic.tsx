import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { SedanFleet, type SedanSpec } from "@/scene/Sedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { coverageShot, moveCam, type Coverage } from "./cameraRig";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/**
 * One of your own is called in. His car pulls up, he walks to the door, a
 * single shot comes from the back room, and someone else drives his car away.
 */
export default function SummonsCinematic({ cinematic, site, phase, local, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const color = paint(cinematic.targetFamily);

  const door = site.building.clone().add(
    new THREE.Vector3(Math.sin(site.facing) * 1.05, 0, Math.cos(site.facing) * 1.05),
  );

  // The car arrives along the road, then is driven off.
  const arrive = phase === "call" ? 0 : phase === "drive" ? local : 1;
  const depart = phase === "drive_off" ? local : 0;
  const along = site.road.clone();
  const approach = site.road.clone().add(new THREE.Vector3(-Math.cos(site.facing) * 6, 0, Math.sin(site.facing) * 6));
  const away = site.road.clone().add(new THREE.Vector3(Math.cos(site.facing) * 8, 0, -Math.sin(site.facing) * 8));
  const carAt = depart > 0 ? along.clone().lerp(away, depart) : approach.clone().lerp(along, arrive);

  const cars: SedanSpec[] = [
    { x: carAt.x, z: carAt.z, rot: site.facing + (depart > 0 ? Math.PI : 0), color, lamps: phase === "drive" || phase === "drive_off" },
  ];

  // He walks from the car to the door, then he's inside.
  const walking = phase === "drive";
  const manAt = walking ? carAt.clone().lerp(door, Math.max(0, local - 0.3) / 0.7) : door;
  const showMan = phase === "drive" || phase === "call";

  const glow = phase === "back_room" ? 1 - local * 0.7 : phase === "drive_off" ? 0.1 : 0.85;

  useFrame(() => {
    const coverage: Coverage =
      phase === "call" || phase === "drive" ? "wide" : phase === "back_room" ? "close" : "pull";
    const shot = coverageShot(phase === "drive" ? manAt : door, site.facing, coverage);
    moveCam(camera, controls, shot.pos, shot.look, phase === "back_room" ? 0.5 : 0.1);
    if (phase === "back_room") shake.current = Math.max(shake.current, 0.05);
  });

  const inside: [number, number, number] = [site.building.x, 1.1, site.building.z];

  return (
    <group>
      <SedanFleet cars={cars} />
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      {showMan && (
        <Goon
          position={[manAt.x, 0, manAt.z]}
          rot={site.facing + Math.PI}
          pose="walk"
          moving={walking}
          role="soldier"
          color={color}
        />
      )}
      {phase === "drive_off" && (
        <Goon position={[carAt.x, 0, carAt.z]} rot={site.facing} pose="walk" moving role="associate" color="#0b0b0d" />
      )}
      <MuzzleFlash
        active={phase === "back_room"}
        from={inside}
        to={[door.x, 0.8, door.z]}
        shots={1}
      />
    </group>
  );
}
