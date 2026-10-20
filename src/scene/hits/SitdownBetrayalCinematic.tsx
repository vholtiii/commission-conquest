import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { type SedanSpec } from "@/scene/Sedan";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, coverageShot, ease, frameLerp, handheld, moveCam, reelSide } from "./cameraRig";
import Headlamps from "./props/Headlamps";
import Blood from "./props/Blood";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Two cars at the cafe, a warm window, then one muffled shot — or the table flips. */
export default function SitdownBetrayalCinematic({ cinematic, site, phase, local, clock, shake }: SceneProps) {
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

  const door = useMemo(
    () => site.building.clone().add(new THREE.Vector3(Math.sin(site.facing) * 1.05, 0, Math.cos(site.facing) * 1.05)),
    [site],
  );
  const negotiatorRef = useRef<THREE.Group>(null);
  const leaverRef = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ at: new THREE.Vector3() }), []);

  const markLeaves = c === "toast" && phase === "walk_out";

  const cars: SedanSpec[] = [
    { x: site.road.x - 1.1, z: site.road.z, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "arrive" },
    { x: site.road.x + 1.1, z: site.road.z + 0.3, rot: site.facing, color: paint(cinematic.targetFamily), lamps: false },
  ];

  const glow = phase === "handshake" && killed ? 1 - local : phase === "walk_out" && killed ? 0.05 : 0.9;

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;

    if (negotiatorRef.current) {
      if (ph === "walk_out") tmp.at.copy(door).lerp(site.road, ease(lc) * (turnedAway || police ? 1 : 0.8));
      else tmp.at.copy(site.road).lerp(door, ph === "arrive" ? ease(lc) : 1);
      negotiatorRef.current.position.copy(tmp.at);
      // He turns on his heel over a few frames instead of snapping round.
      const want = ph === "walk_out" ? site.facing : site.facing + Math.PI;
      const cur = negotiatorRef.current.rotation.y;
      let diff = want - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      negotiatorRef.current.rotation.y = cur + diff * frameLerp(0.18, dt);
    }
    if (leaverRef.current) {
      leaverRef.current.position.set(door.x + lc, 0, door.z + lc * 0.4);
    }

    const shotOpts = { drift: progress, side: reelSide(cinematic.operationId) };
    const shot =
      ph === "walk_out" && killed
        ? bodyThenPull(door, site.facing, lc, shotOpts)
        : coverageShot(
            door,
            site.facing,
            ph === "arrive" ? "wide" : ph === "table" ? "medium" : ph === "handshake" ? "close" : "pull",
            shotOpts,
          );
    const k = ph === "handshake" ? 0.5 : ph === "walk_out" && killed ? 0.3 : 0.1;
    moveCam(camera, controls, shot.pos, shot.look, k, dt);
    if (ph === "table") handheld(camera, 0.01);
    if (ph === "handshake" && !turnedAway) shake.current = Math.max(shake.current, shatters ? 0.12 : 0.04);
  });

  const inside: [number, number, number] = [site.building.x, 1.1, site.building.z];

  return (
    <group>
      <ReelSedan cars={cars} />
      <Headlamps cars={cars.filter((car) => car.lamps).map((car) => ({ x: car.x, z: car.z, rot: car.rot }))} />
      <pointLight position={[door.x, 1.3, door.z]} color="#ffb060" intensity={glow * 2.2} distance={6} />
      {phase !== "arrive" && (
        <Goon position={[door.x + 0.55, 0, door.z + 0.1]} rot={site.facing + Math.PI} role="associate" color="#2a2420" />
      )}
      <Blood
        active={killed && phase !== "arrive" && phase !== "table"}
        at={[door.x - 0.35, 0, door.z]}
        facing={site.facing}
      />
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      <group ref={negotiatorRef} position={[site.road.x, 0, site.road.z]} rotation={[0, site.facing + Math.PI, 0]}>
        <Goon
          position={[0, 0, 0]}
          pose="walk"
          moving={phase === "arrive" || phase === "walk_out"}
          role="soldier"
          color={paint(cinematic.attackerFamily)}
        />
      </group>
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
        <group ref={leaverRef} position={[door.x, 0, door.z]}>
          <Goon position={[0, 0, 0]} rot={site.facing} pose="walk" moving role="boss" color={paint(cinematic.targetFamily)} />
        </group>
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
