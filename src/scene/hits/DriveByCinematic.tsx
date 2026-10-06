import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { SedanFleet, type SedanSpec } from "@/scene/Sedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { coverageShot, moveCam, type Coverage } from "./cameraRig";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Sedan rolls the route, slows at the storefront, and sprays — or stalls. */
export default function DriveByCinematic({ cinematic, site, phase, local, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  // Somebody else's job: the sedan and the mark only, no garrison, no escort.
  const witnessed = cinematic.perspective === "witnessed";
  const returnFire =
    !witnessed && cinematic.result.defenders > 0 && (phase === "spray" || phase === "getaway");

  const travel =
    phase === "roll" ? local * 0.72 : phase === "pass" ? 0.72 + local * 0.18 : phase === "spray" ? 0.92 : 0.92;
  const escape = phase === "getaway" && c !== "stall" && !police ? local * 0.08 : 0;
  const t = Math.min(0.999, travel + escape);
  const pos = site.curve.getPointAt(t);
  const tangent = site.curve.getTangentAt(t);
  const rot = Math.atan2(tangent.x, tangent.z);

  const stalled = (c === "stall" || police) && phase === "getaway";
  const cars: SedanSpec[] = [
    {
      x: pos.x,
      z: pos.z,
      rot,
      color: paint(cinematic.attackerFamily),
      lamps: true,
    },
  ];
  if (c === "blocked_lane" && (phase === "pass" || phase === "spray" || phase === "getaway")) {
    cars.push({
      x: site.road.x + 1.6,
      z: site.road.z + 1.2,
      rot: rot + Math.PI / 2,
      color: "#d6c9a8",
      lamps: false,
    });
  }
  if (c === "escort" && !witnessed && phase !== "roll") {
    cars.push({
      x: pos.x - tangent.z * 1.3,
      z: pos.z + tangent.x * 1.3,
      rot,
      color: "#3f1a1e",
      lamps: true,
    });
  }

  const markDown = killed && (phase === "spray" || phase === "getaway");
  const markSpot: [number, number, number] = [
    site.building.x + Math.sin(site.facing) * 1.2,
    0,
    site.building.z + Math.cos(site.facing) * 1.2,
  ];
  const muzzle: [number, number, number] = [pos.x, 0.7, pos.z];

  useFrame(() => {
    const coverage: Coverage =
      phase === "roll" ? "wide" : phase === "pass" ? "medium" : phase === "spray" ? "close" : "pull";
    const focus = phase === "spray" ? new THREE.Vector3(markSpot[0], 0, markSpot[2]) : phase === "pass" ? site.building.clone() : pos.clone();
    const shot = coverageShot(focus, phase === "spray" ? site.facing : rot, coverage);
    moveCam(camera, controls, shot.pos, shot.look, phase === "spray" ? 0.5 : 0.12);
    if (phase === "spray") shake.current = Math.max(shake.current, 0.08);
  });

  return (
    <group>
      <SedanFleet cars={cars} />
      <Goon
        position={markSpot}
        rot={site.facing}
        pose={c === "fruit_cart" && phase !== "roll" ? "crouch" : markDown ? "down" : "stand"}
        role="boss"
        color={paint(cinematic.targetFamily)}
      />
      {c === "fruit_cart" && (
        <mesh position={[markSpot[0] + 0.5, 0.35, markSpot[2]]}>
          <boxGeometry args={[0.7, 0.5, 0.5]} />
          <meshStandardMaterial color="#6a4a28" />
        </mesh>
      )}
      <MuzzleFlash active={phase === "spray"} from={muzzle} to={markSpot} shots={returnFire ? 8 : 5} />
      {returnFire && (
        <MuzzleFlash active={phase === "spray" || phase === "getaway"} from={markSpot} to={muzzle} shots={4} />
      )}
      <GlassShards active={phase === "spray"} at={[site.building.x, 0, site.building.z]} />
      <Smoke active={returnFire && phase === "getaway"} at={[pos.x, 0.4, pos.z]} loop />
      <PoliceLights active={stalled} at={[pos.x, 0.5, pos.z]} />
      <PaddyWagon active={police && phase === "getaway"} x={site.road.x + 2} z={site.road.z - 1.5} rot={rot + Math.PI / 2} />
    </group>
  );
}
