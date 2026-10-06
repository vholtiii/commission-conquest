import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { SedanFleet, type SedanSpec } from "@/scene/Sedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { coverageShot, moveCam, type Coverage } from "./cameraRig";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Two cars at the cafe, a warm window, then one muffled shot — or the table flips. */
export default function SitdownBetrayalCinematic({ cinematic, site, phase, local, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  const turnedAway = c === "pat_down" || c === "toast";
  // Somebody else's job: the negotiator and the mark only, no backup in the kitchen.
  const witnessed = cinematic.perspective === "witnessed";
  const shatters = c === "witness" || c === "kitchen_backup" || cinematic.result.outcome === "messy_kill";

  const door = site.building.clone().add(
    new THREE.Vector3(Math.sin(site.facing) * 1.05, 0, Math.cos(site.facing) * 1.05),
  );
  const walkIn = phase === "arrive" ? local : 1;
  const negotiator =
    phase === "walk_out"
      ? door.clone().lerp(site.road, turnedAway || police ? local : local * 0.8)
      : site.road.clone().lerp(door, walkIn);
  const markLeaves = c === "toast" && phase === "walk_out";

  const cars: SedanSpec[] = [
    { x: site.road.x - 1.1, z: site.road.z, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "arrive" },
    { x: site.road.x + 1.1, z: site.road.z + 0.3, rot: site.facing, color: paint(cinematic.targetFamily), lamps: false },
  ];

  const glow = phase === "handshake" && killed ? 1 - local : phase === "walk_out" && killed ? 0.05 : 0.9;

  useFrame(() => {
    const coverage: Coverage =
      phase === "arrive" ? "wide" : phase === "table" ? "medium" : phase === "handshake" ? "close" : "pull";
    const shot = coverageShot(door, site.facing, coverage);
    moveCam(camera, controls, shot.pos, shot.look, phase === "handshake" ? 0.5 : 0.1);
    if (phase === "handshake" && !turnedAway) shake.current = Math.max(shake.current, shatters ? 0.12 : 0.04);
  });

  const inside: [number, number, number] = [site.building.x, 1.1, site.building.z];

  return (
    <group>
      <SedanFleet cars={cars} />
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      <Goon
        position={[negotiator.x, 0, negotiator.z]}
        rot={site.facing + (phase === "walk_out" ? 0 : Math.PI)}
        pose={police && phase === "walk_out" ? "walk" : "walk"}
        moving={phase === "arrive" || phase === "walk_out"}
        role="soldier"
        color={paint(cinematic.attackerFamily)}
      />
      {phase !== "arrive" && !markLeaves && (
        <Goon
          position={[door.x - 0.35, 0, door.z]}
          rot={site.facing}
          pose={killed && phase !== "table" ? "down" : "stand"}
          role="boss"
          color={paint(cinematic.targetFamily)}
        />
      )}
      {markLeaves && (
        <Goon
          position={[door.x + local, 0, door.z + local * 0.4]}
          rot={site.facing}
          pose="walk"
          moving
          role="boss"
          color={paint(cinematic.targetFamily)}
        />
      )}
      {(c === "witness" || c === "kitchen_backup") && !witnessed && phase !== "arrive" && (
        <Goon position={[door.x + 0.7, 0, door.z - 0.2]} rot={site.facing + Math.PI} gun role="soldier" color="#3f1a1e" />
      )}
      <MuzzleFlash
        active={phase === "handshake" && !turnedAway && !cinematic.result.markAbsent}
        from={inside}
        to={[door.x, 0.8, door.z]}
        shots={1}
      />
      <GlassShards active={shatters && phase === "handshake"} at={[site.building.x, 0.4, site.building.z]} />
      <PoliceLights active={police && phase === "walk_out"} at={[site.road.x, 0.5, site.road.z]} />
      <PaddyWagon active={police && phase === "walk_out"} x={site.road.x} z={site.road.z - 2} rot={site.facing + Math.PI / 2} />
    </group>
  );
}
