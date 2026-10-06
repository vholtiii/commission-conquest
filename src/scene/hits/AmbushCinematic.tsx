import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { SedanFleet } from "@/scene/Sedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { coverageShot, moveCam, type Coverage } from "./cameraRig";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Shooters wait in the alley, the mark walks in, the flashes come from the dark. */
export default function AmbushCinematic({ cinematic, site, phase, local, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  const freeze = c === "patrol" && (phase === "wait" || phase === "strike");
  // Somebody else's job: shooters and the mark only, nobody else's muscle.
  const witnessed = cinematic.perspective === "witnessed";
  const trap = !witnessed && c === "trap";
  const extra = !witnessed && (c === "rival_muscle" || c === "backup");
  const defenders = !witnessed && cinematic.result.defenders > 0;

  const toRoad = site.road.clone().sub(site.building);
  toRoad.y = 0;
  if (toRoad.lengthSq() < 1e-4) toRoad.set(0, 0, 1);
  toRoad.normalize();
  const side = new THREE.Vector3(-toRoad.z, 0, toRoad.x);
  const alley = site.building.clone().addScaledVector(toRoad, 1.25);
  const shooters = [
    alley.clone().addScaledVector(side, -0.75).addScaledVector(toRoad, -0.2),
    alley.clone().addScaledVector(side, 0.2).addScaledVector(toRoad, 0.4),
    alley.clone().addScaledVector(side, 0.7).addScaledVector(toRoad, -0.45),
  ];
  const walk = cinematic.result.markAbsent ? 0.15 : phase === "wait" ? local * 0.7 : phase === "position" ? 0 : 1;
  const mark = site.road.clone().lerp(alley, walk);
  const markPose = killed && (phase === "strike" || phase === "melt") ? "down" : freeze ? "walk" : "walk";
  const melt = phase === "melt" && !police && !freeze;

  useFrame(() => {
    const coverage: Coverage =
      phase === "position" ? "wide" : phase === "wait" ? "medium" : phase === "strike" ? "close" : "pull";
    const focus = phase === "strike" || phase === "melt" ? mark : alley;
    const shot = coverageShot(focus, site.facing, coverage);
    moveCam(camera, controls, shot.pos, shot.look, phase === "strike" ? 0.5 : 0.12);
    if (phase === "strike" && !freeze) shake.current = Math.max(shake.current, 0.06);
  });

  const from: [number, number, number] = [shooters[1]!.x, 0.7, shooters[1]!.z];
  const to: [number, number, number] = [mark.x, 0.7, mark.z];

  return (
    <group>
      {shooters.map((p, i) => (
        <Goon
          key={i}
          position={[p.x, 0, p.z]}
          rot={site.facing}
          pose={police && phase === "melt" ? "stand" : melt ? "run" : i === 0 ? "crouch" : "stand"}
          moving={melt}
          gun
          role="soldier"
          color={paint(cinematic.attackerFamily)}
        />
      ))}
      {!cinematic.result.markAbsent && (
        <Goon
          position={[mark.x, 0, mark.z]}
          rot={site.facing + Math.PI}
          pose={markPose === "down" ? "down" : "walk"}
          moving={phase === "wait" && !freeze}
          role="boss"
          color={paint(cinematic.targetFamily)}
        />
      )}
      {extra && phase !== "position" && (
        <Goon
          position={[site.road.x + 1.4, 0, site.road.z - 0.6]}
          rot={site.facing + Math.PI}
          gun
          role="soldier"
          color="#3f1a1e"
        />
      )}
      {trap && phase !== "position" && (
        <Goon position={[alley.x - 0.8, 0, alley.z - 0.4]} rot={site.facing} gun role="soldier" color={paint(cinematic.targetFamily)} />
      )}
      <MuzzleFlash active={phase === "strike" && !freeze && !cinematic.result.markAbsent} from={from} to={to} shots={3} />
      {trap && <MuzzleFlash active={phase === "strike"} from={[alley.x - 0.8, 0.7, alley.z - 0.4]} to={from} shots={3} />}
      {(extra || defenders) && phase === "strike" && (
        <MuzzleFlash active from={[site.road.x + 1.4, 0.7, site.road.z - 0.6]} to={from} shots={3} />
      )}
      {phase !== "position" && (
        <SedanFleet
          cars={[{ x: site.road.x + 1.8, z: site.road.z + 1.2, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "melt" }]}
        />
      )}
      {c === "patrol" && phase !== "position" && (
        <pointLight position={[site.road.x, 1.2, site.road.z]} color="#fff3c4" intensity={phase === "wait" ? 2 + local : 1.2} distance={8} />
      )}
      <PoliceLights active={police && phase === "melt"} at={[site.road.x, 0.4, site.road.z]} />
      <PaddyWagon active={police && phase === "melt"} x={site.road.x - 1.5} z={site.road.z + 1.6} rot={site.facing} />
    </group>
  );
}
