import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { coverageShot, ease, facingOf, kerbShot, reelSide, trackShot } from "./cameraRig";
import { useReelCamera } from "./useReelCamera";
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
  const cam = useReelCamera(site.space, cinematic.operationId, shake);
  const color = paint(cinematic.targetFamily);

  const stage = useMemo(() => {
    const kerb = new THREE.Vector3(Math.sin(site.facing), 0, Math.cos(site.facing));
    const door = site.building.clone().addScaledVector(kerb, 1.05);
    // The car comes along the road (its nose direction) and leaves the same way.
    const fwd = new THREE.Vector3(Math.cos(site.facing), 0, -Math.sin(site.facing));
    const approach = site.road.clone().addScaledVector(fwd, -6);
    const away = site.road.clone().addScaledVector(fwd, 8);
    const manStart = site.road.clone().addScaledVector(kerb, -0.55);
    const doorman = new THREE.Vector3(door.x + 0.45, 0, door.z - 0.15);
    const doormanHead = doorman.clone().setY(0.9);
    return { door, approach, away, manStart, doorman, doormanHead, heading: facingOf(fwd) };
  }, [site]);

  const carRig = useRef<THREE.Group>(null);
  const manRef = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ car: new THREE.Vector3(), man: new THREE.Vector3(), manHead: new THREE.Vector3() }), []);

  const lampsOn = phase === "drive" || phase === "drive_off";
  const walking = phase === "drive" && local > 0.4;
  // He steps out once the car has stopped at the kerb.
  const showMan = phase === "drive" && local >= 0.38;

  useFrame((_, dt) => {
    const { phase: ph, local: lc } = clock.current;

    if (ph === "drive_off") tmp.car.copy(site.road).lerp(stage.away, lc * lc);
    else {
      const arrive = ph === "call" ? 0 : ph === "drive" ? 1 - Math.pow(1 - Math.min(1, lc / 0.45), 2) : 1;
      tmp.car.copy(stage.approach).lerp(site.road, arrive);
    }
    if (carRig.current) carRig.current.position.copy(tmp.car);

    const manK = ph === "drive" ? ease(Math.max(0, (lc - 0.4) / 0.6)) : ph === "call" ? 0 : 1;
    tmp.man.copy(stage.manStart).lerp(stage.door, manK);
    tmp.manHead.copy(tmp.man).setY(0.9);
    if (manRef.current) manRef.current.position.copy(tmp.man);

    const side = reelSide(cinematic.operationId);
    if (ph === "call") {
      cam.frame(ph, coverageShot(stage.door, site.facing, "wide", { side, drift: lc * 0.3 }), { k: 0.08, dt, coverage: "wide" });
    } else if (ph === "drive" && lc < 0.4) {
      cam.frame("car", trackShot(tmp.car, stage.heading, side, { back: 3.4, height: 1.3 }), { k: 0.25, dt, coverage: "wide", follow: true });
    } else if (ph === "drive") {
      // From the pavement, so his own car is not filling the foreground.
      cam.frame("walk", kerbShot(stage.door, site.facing, tmp.man, side), {
        k: 0.18,
        dt,
        coverage: "medium",
        handheld: 0.008,
        follow: true,
      });
    } else if (ph === "back_room") {
      cam.frame(ph, kerbShot(stage.door, site.facing, stage.doorman, -side), { k: 0.5, dt, coverage: "close", cut: true });
      shake.current = Math.max(shake.current, 0.05);
    } else {
      cam.frame(ph, trackShot(tmp.car, stage.heading, side, { back: 4.5, height: 2.4 }), { k: 0.15, dt, coverage: "pull", follow: true });
    }
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
        <Goon
          position={[stage.doorman.x, 0, stage.doorman.z]}
          rot={site.facing + Math.PI}
          pose={phase === "drive" && local > 0.85 ? "talk" : "stand"}
          lookAt={showMan ? tmp.manHead : undefined}
          seed={401}
          role="associate"
          color="#2a2420"
        />
      )}
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      {showMan && (
        <group ref={manRef} position={[stage.manStart.x, 0, stage.manStart.z]}>
          <Goon
            position={[0, 0, 0]}
            rot={site.facing + Math.PI}
            pose={local < 0.44 ? "getIn" : "walk"}
            moving={walking}
            lookAt={local > 0.6 ? stage.doormanHead : undefined}
            seed={53}
            role="soldier"
            color={color}
          />
        </group>
      )}
      <MuzzleFlash active={phase === "back_room"} from={inside} to={[door.x, 0.8, door.z]} shots={1} />
    </group>
  );
}
