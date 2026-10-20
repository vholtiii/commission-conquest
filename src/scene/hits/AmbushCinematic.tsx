import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, coverageShot, ease, handheld, moveCam, reelSide } from "./cameraRig";
import Headlamps from "./props/Headlamps";
import Blood from "./props/Blood";
import Bystanders from "./props/Bystanders";
import Smoke from "./props/Smoke";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Shooters wait in the alley, the mark walks in, the flashes come from the dark. */
export default function AmbushCinematic({ cinematic, site, phase, local, clock, shake }: SceneProps) {
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
  const absent = cinematic.result.markAbsent;

  const stage = useMemo(() => {
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
    const car = new THREE.Vector3(site.road.x + 1.8, 0, site.road.z + 1.2);
    // Where each man ends up when they break for the car.
    const doors = shooters.map((_, i) => car.clone().add(new THREE.Vector3(-0.9 + i * 0.5, 0, 0.9 - i * 0.3)));
    return { alley, shooters, car, doors };
  }, [site]);

  const markRef = useRef<THREE.Group>(null);
  const shooterRefs = [useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const tmp = useMemo(() => ({ mark: new THREE.Vector3(), at: new THREE.Vector3() }), []);

  const melt = phase === "melt" && !police && !freeze;
  const markDown = killed && (phase === "strike" || phase === "melt");
  const markWalking = phase === "wait" && !absent && (!freeze || local < 0.5);

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;

    // He comes in off the kerb during the wait and is at the alley mouth when the guns go.
    let walk = absent ? 0.15 : ph === "position" ? 0 : 1;
    if (!absent && ph === "wait") walk = freeze ? Math.min(1, lc * 2) * 0.6 : lc;
    else if (!absent && freeze) walk = 0.6;
    tmp.mark.copy(site.road).lerp(stage.alley, walk);
    if (markRef.current) markRef.current.position.copy(tmp.mark);

    const run = ph === "melt" && !police && !freeze ? ease(lc) : 0;
    stage.shooters.forEach((home, i) => {
      const g = shooterRefs[i]!.current;
      if (!g) return;
      tmp.at.copy(home).lerp(stage.doors[i]!, run * 0.92);
      g.position.copy(tmp.at);
      if (run > 0.02) {
        const dx = stage.car.x - tmp.at.x;
        const dz = stage.car.z - tmp.at.z;
        g.rotation.y = Math.atan2(dx, dz);
      } else {
        g.rotation.y = site.facing;
      }
    });

    const shotOpts = { drift: progress, side: reelSide(cinematic.operationId) };
    const focus = ph === "strike" || ph === "melt" ? tmp.mark : stage.alley;
    const shot =
      ph === "melt" && killed && !police
        ? bodyThenPull(focus, site.facing, lc, shotOpts)
        : coverageShot(
            focus,
            site.facing,
            ph === "position" ? "wide" : ph === "wait" ? "medium" : ph === "strike" ? "close" : "pull",
            shotOpts,
          );
    const k = ph === "strike" ? 0.5 : ph === "wait" ? 0.25 : 0.12;
    moveCam(camera, controls, shot.pos, shot.look, k, dt);
    if (ph === "wait") handheld(camera, 0.01);
    if (ph === "strike" && !freeze) shake.current = Math.max(shake.current, 0.06);
  });

  const from: [number, number, number] = [stage.shooters[1]!.x, 0.7, stage.shooters[1]!.z];
  const to: [number, number, number] = [stage.alley.x, 0.7, stage.alley.z];

  return (
    <group>
      {stage.shooters.map((p, i) => (
        <group key={i} ref={shooterRefs[i]} position={[p.x, 0, p.z]} rotation={[0, site.facing, 0]}>
          <Goon
            position={[0, 0, 0]}
            pose={police && phase === "melt" ? "stand" : melt ? "run" : i === 0 ? "crouch" : "stand"}
            moving={melt}
            gun
            role="soldier"
            color={paint(cinematic.attackerFamily)}
          />
        </group>
      ))}
      {!absent && (
        <group ref={markRef} position={[site.road.x, 0, site.road.z]}>
          <Goon
            position={[0, 0, 0]}
            rot={site.facing + Math.PI}
            pose={markDown ? "down" : "walk"}
            moving={markWalking}
            role="boss"
            color={paint(cinematic.targetFamily)}
          />
        </group>
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
        <Goon
          position={[stage.alley.x - 0.8, 0, stage.alley.z - 0.4]}
          rot={site.facing}
          gun
          role="soldier"
          color={paint(cinematic.targetFamily)}
        />
      )}
      <MuzzleFlash active={phase === "strike" && !freeze && !absent} from={from} to={to} shots={3} />
      {trap && (
        <MuzzleFlash active={phase === "strike"} from={[stage.alley.x - 0.8, 0.7, stage.alley.z - 0.4]} to={from} shots={3} />
      )}
      {(extra || defenders) && phase === "strike" && (
        <MuzzleFlash active from={[site.road.x + 1.4, 0.7, site.road.z - 0.6]} to={from} shots={3} />
      )}
      {phase !== "position" && (
        <ReelSedan
          cars={[{ x: stage.car.x, z: stage.car.z, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "melt" }]}
        />
      )}
      {phase === "melt" && <Headlamps cars={[{ x: stage.car.x, z: stage.car.z, rot: site.facing }]} />}
      <Bystanders at={[site.road.x, 0, site.road.z]} facing={site.facing} flee={phase === "strike" || phase === "melt"} />
      <Blood active={markDown} at={[stage.alley.x, 0, stage.alley.z]} facing={site.facing + Math.PI} />
      <Smoke active={melt} at={[site.road.x + 1.2, 0.15, site.road.z + 0.8]} loop size={0.65} />
      {c === "patrol" && phase !== "position" && (
        <pointLight
          position={[site.road.x, 1.2, site.road.z]}
          color="#fff3c4"
          intensity={phase === "wait" ? 2 + local : 1.2}
          distance={8}
        />
      )}
      <PoliceLights active={police && phase === "melt"} at={[site.road.x, 0.4, site.road.z]} />
      <PaddyWagon active={police && phase === "melt"} x={site.road.x - 1.5} z={site.road.z + 1.6} rot={site.facing} />
    </group>
  );
}
