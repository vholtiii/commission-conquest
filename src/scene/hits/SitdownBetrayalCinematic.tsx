import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { type SedanSpec } from "@/scene/Sedan";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, ease, executionShot, frameLerp, kerbShot, reelSide, trackShot, twoShot } from "./cameraRig";
import { useReelCamera } from "./useReelCamera";
import Headlamps from "./props/Headlamps";
import Blood from "./props/Blood";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** The handshake runs this long before the gun comes out. */
const SHAKE_END = 0.35;

/** Two cars at the cafe, a warm window, a handshake, then the pistol — or the table flips. */
export default function SitdownBetrayalCinematic({ cinematic, site, phase, local, clock, shake }: SceneProps) {
  const cam = useReelCamera(site.space, cinematic.operationId, shake);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  const turnedAway = c === "pat_down" || c === "toast";
  // Somebody else's job: the negotiator and the mark only, no backup in the kitchen.
  const witnessed = cinematic.perspective === "witnessed";
  const shatters = c === "witness" || c === "kitchen_backup" || cinematic.result.outcome === "messy_kill";
  const fires = !turnedAway && !cinematic.result.markAbsent;

  const stage = useMemo(() => {
    const kerb = new THREE.Vector3(Math.sin(site.facing), 0, Math.cos(site.facing));
    const door = site.building.clone().addScaledVector(kerb, 1.05);
    const mark = new THREE.Vector3(door.x - 0.35, 0, door.z);
    // Where the negotiator stops: a step off the door, an arm's length from the mark.
    const meet = door.clone().addScaledVector(kerb, 0.45).add(new THREE.Vector3(0.15, 0, 0));
    const markHead = mark.clone().setY(0.85);
    return { door, mark, meet, markHead, faceMark: Math.atan2(mark.x - meet.x, mark.z - meet.z) };
  }, [site]);
  const door = stage.door;

  const negotiatorRef = useRef<THREE.Group>(null);
  const leaverRef = useRef<THREE.Group>(null);
  const barrel = useRef<THREE.Object3D>(null);
  const tmp = useMemo(() => ({ at: new THREE.Vector3(), head: new THREE.Vector3() }), []);

  const markLeaves = c === "toast" && phase === "walk_out";
  const drawn = phase === "handshake" && local >= SHAKE_END && fires;

  const cars: SedanSpec[] = [
    { x: site.road.x - 1.1, z: site.road.z, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "arrive" },
    { x: site.road.x + 1.1, z: site.road.z + 0.3, rot: site.facing, color: paint(cinematic.targetFamily), lamps: false },
  ];

  const glow = phase === "handshake" && killed ? 1 - local : phase === "walk_out" && killed ? 0.05 : 0.9;

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;

    if (ph === "walk_out") tmp.at.copy(stage.meet).lerp(site.road, ease(lc) * (turnedAway || police ? 1 : 0.8));
    else tmp.at.copy(site.road).lerp(stage.meet, ph === "arrive" ? ease(lc) : 1);
    tmp.head.copy(tmp.at).setY(0.88);
    if (negotiatorRef.current) {
      negotiatorRef.current.position.copy(tmp.at);
      // He turns on his heel over a few frames instead of snapping round.
      const want = ph === "walk_out" ? site.facing : ph === "arrive" && lc < 0.85 ? site.facing + Math.PI : stage.faceMark;
      const cur = negotiatorRef.current.rotation.y;
      let diff = want - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      negotiatorRef.current.rotation.y = cur + diff * frameLerp(0.18, dt);
    }
    if (leaverRef.current) {
      leaverRef.current.position.set(door.x + lc, 0, door.z + lc * 0.4);
    }

    const side = reelSide(cinematic.operationId);
    if (ph === "arrive") {
      cam.frame(ph, kerbShot(stage.meet, site.facing, tmp.at, side), { k: 0.15, dt, coverage: "wide", follow: true });
    } else if (ph === "table") {
      cam.frame(ph, twoShot(tmp.at, stage.mark, side, { height: 1.4, push: lc * 0.3 }), {
        k: 0.12,
        dt,
        coverage: "medium",
        handheld: 0.01,
      });
    } else if (ph === "handshake" && (lc < SHAKE_END || !fires)) {
      cam.frame("shake-hands", twoShot(tmp.at, stage.mark, side, { height: 1.2, margin: 1.4, push: 0.2 }), {
        k: 0.3,
        dt,
        coverage: "close",
      });
    } else if (ph === "handshake") {
      cam.frame(ph, executionShot(stage.mark, tmp.at, side), { k: 0.5, dt, coverage: "close", cut: true });
      shake.current = Math.max(shake.current, shatters ? 0.12 : 0.04);
    } else if (killed) {
      cam.frame(ph, bodyThenPull(stage.mark, site.facing, lc, { drift: progress, side }), {
        k: 0.3,
        dt,
        coverage: lc < 0.6 ? "body" : "pull",
      });
    } else {
      cam.frame(ph, trackShot(tmp.at, site.facing, side, { back: 4, height: 2.4 }), { k: 0.12, dt, coverage: "pull", follow: true });
    }
  });

  const negotiatorPose =
    phase === "arrive" || phase === "walk_out"
      ? "walk"
      : phase === "table"
        ? "talk"
        : drawn
          ? "aim"
          : "handshake";
  const markDown = killed && ((drawn && local > SHAKE_END + 0.08) || phase === "walk_out");
  const markPose = markDown
    ? "down"
    : phase === "table"
      ? "talk"
      : phase === "handshake" && !drawn
        ? "handshake"
        : "stand";

  return (
    <group>
      <ReelSedan cars={cars} />
      <Headlamps cars={cars.filter((car) => car.lamps).map((car) => ({ x: car.x, z: car.z, rot: car.rot }))} />
      <pointLight position={[door.x, 1.3, door.z]} color="#ffb060" intensity={glow * 2.2} distance={6} />
      {phase !== "arrive" && (
        <Goon
          position={[door.x + 0.55, 0, door.z + 0.1]}
          rot={site.facing + Math.PI}
          lookAt={tmp.head}
          seed={401}
          role="associate"
          color="#2a2420"
        />
      )}
      <Blood active={killed && markPose === "down"} at={[stage.mark.x, 0, stage.mark.z]} facing={site.facing} />
      <mesh position={[site.building.x, 1.15, site.building.z]}>
        <boxGeometry args={[0.7, 0.45, 0.08]} />
        <meshStandardMaterial color="#e0b070" emissive="#e0b070" emissiveIntensity={glow} />
      </mesh>
      <group ref={negotiatorRef} position={[site.road.x, 0, site.road.z]} rotation={[0, site.facing + Math.PI, 0]}>
        <Goon
          position={[0, 0, 0]}
          pose={negotiatorPose}
          moving={phase === "arrive" || phase === "walk_out"}
          gun={drawn}
          firing={drawn}
          lookAt={phase === "table" || phase === "handshake" ? stage.markHead : undefined}
          muzzleRef={barrel}
          seed={211}
          role="soldier"
          color={paint(cinematic.attackerFamily)}
        />
      </group>
      {phase !== "arrive" && !markLeaves && (
        <Goon
          position={[stage.mark.x, 0, stage.mark.z]}
          rot={site.facing}
          pose={markPose}
          lookAt={markPose === "down" ? undefined : tmp.head}
          seed={53}
          role="boss"
          color={paint(cinematic.targetFamily)}
        />
      )}
      {markLeaves && (
        <group ref={leaverRef} position={[door.x, 0, door.z]}>
          <Goon position={[0, 0, 0]} rot={site.facing} pose="walk" moving seed={53} role="boss" color={paint(cinematic.targetFamily)} />
        </group>
      )}
      {(c === "witness" || c === "kitchen_backup") && !witnessed && phase !== "arrive" && (
        <Goon
          position={[door.x + 0.7, 0, door.z - 0.2]}
          rot={site.facing + Math.PI}
          pose={drawn ? "aim" : "stand"}
          lookAt={tmp.head}
          gun
          role="soldier"
          color="#3f1a1e"
        />
      )}
      <MuzzleFlash
        active={drawn}
        from={[stage.meet.x, 0.8, stage.meet.z]}
        to={[stage.mark.x, 0.8, stage.mark.z]}
        fromRef={barrel}
        shots={shatters ? 3 : 1}
      />
      <GlassShards active={shatters && drawn} at={[site.building.x, 0.4, site.building.z]} />
      <PoliceLights active={police && phase === "walk_out"} at={[site.road.x, 0.5, site.road.z]} />
      <PaddyWagon active={police && phase === "walk_out"} x={site.road.x} z={site.road.z - 2} rot={site.facing + Math.PI / 2} />
    </group>
  );
}
