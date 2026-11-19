import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, coverageShot, dampAngle, ease, executionShot, FOV, reelSide, twoShot } from "./cameraRig";
import { playShots, type DirectedShot } from "./director";
import { AMBUSH } from "./shotlists";
import { useReelCamera } from "./useReelCamera";
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
  const cam = useReelCamera(site.space, cinematic.operationId, shake);
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
  const muzzle = useRef<THREE.Object3D>(null);
  const tmp = useMemo(
    () => ({ mark: new THREE.Vector3(), at: new THREE.Vector3(), markHead: new THREE.Vector3(), gunman: new THREE.Vector3() }),
    [],
  );
  const side = reelSide(cinematic.operationId);

  const melt = phase === "melt" && !police && !freeze;
  const markDown = killed && (phase === "strike" || phase === "melt");
  const markWalking = phase === "wait" && !absent && (!freeze || local < 0.5);
  const shooting = phase === "strike" && !freeze && !absent;

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;

    // He comes in off the kerb during the wait and is at the alley mouth when the guns go.
    let walk = absent ? 0.15 : ph === "position" ? 0 : 1;
    if (!absent && ph === "wait") walk = freeze ? Math.min(1, lc * 2) * 0.6 : ease(lc);
    else if (!absent && freeze) walk = 0.6;
    tmp.mark.copy(site.road).lerp(stage.alley, walk);
    tmp.markHead.copy(tmp.mark).setY(0.85);
    if (markRef.current) markRef.current.position.copy(tmp.mark);

    const run = ph === "melt" && !police && !freeze ? ease(lc) : 0;
    stage.shooters.forEach((home, i) => {
      const g = shooterRefs[i]!.current;
      if (!g) return;
      tmp.at.copy(home).lerp(stage.doors[i]!, run * 0.92);
      g.position.copy(tmp.at);
      const want = run > 0.02 ? Math.atan2(stage.car.x - tmp.at.x, stage.car.z - tmp.at.z) : site.facing;
      g.rotation.y = dampAngle(g.rotation.y, want, dt, 8);
    });
    tmp.gunman.copy(stage.shooters[1]!).setY(0);

    const range = AMBUSH[ph] ?? AMBUSH.melt;
    const shots: DirectedShot[] = [];
    if (ph === "position") {
      const [alley] = range;
      shots.push({
        id: alley!.id,
        start: alley!.start,
        end: alley!.end,
        frame: () => coverageShot(stage.alley, site.facing, "medium", { side, drift: lc * 0.4, lookY: 0.6 }),
        move: "orbit",
        fov: [FOV.wide, FOV.medium],
        k: 0.12,
      });
    } else if (ph === "wait") {
      const [long] = range;
      shots.push({
        id: long!.id,
        start: long!.start,
        end: long!.end,
        frame: () => coverageShot(tmp.mark, site.facing, "pull", { side, lookY: 0.7 }),
        move: "dollyIn",
        fov: [FOV.close, 22],
        follow: true,
        k: 0.2,
        handheld: 0.01,
        subjects: () => [tmp.mark, tmp.gunman],
      });
    } else if (ph === "strike") {
      const [wide, punch, fall] = range;
      shots.push({
        id: wide!.id,
        start: wide!.start,
        end: wide!.end,
        frame: () => executionShot(tmp.mark, tmp.gunman, side),
        move: "static",
        fov: [FOV.medium, FOV.close],
        transition: "cut",
        k: 0.4,
        subjects: () => [tmp.mark, tmp.gunman],
      });
      shots.push({
        id: punch!.id,
        start: punch!.start,
        end: punch!.end,
        frame: () => executionShot(tmp.mark, tmp.gunman, side),
        move: "dollyIn",
        fov: [FOV.close, FOV.close],
        punch: { at: 0.08, fov: FOV.punch },
        k: 0.45,
        handheld: 0.018,
      });
      shots.push({
        id: fall!.id,
        start: fall!.start,
        end: fall!.end,
        frame: () => executionShot(tmp.mark, tmp.gunman, side),
        move: "dollyOut",
        fov: [FOV.close, FOV.medium],
        k: 0.22,
      });
      if (!freeze) shake.current = Math.max(shake.current, 0.05);
    } else if (killed && !police) {
      const [body, pull] = range;
      shots.push({
        id: body!.id,
        start: body!.start,
        end: body!.end,
        frame: () => bodyThenPull(tmp.mark, site.facing, Math.min(0.55, lc), { drift: progress, side }),
        move: "static",
        fov: [FOV.body, FOV.body],
        k: 0.28,
      });
      shots.push({
        id: pull!.id,
        start: pull!.start,
        end: pull!.end,
        frame: () => bodyThenPull(tmp.mark, site.facing, lc, { drift: progress, side }),
        move: "crane",
        fov: [FOV.body, FOV.pull],
        k: 0.18,
      });
    } else {
      const [body, pull] = range;
      shots.push({
        id: body!.id,
        start: body!.start,
        end: body!.end,
        frame: () => twoShot(tmp.gunman, stage.car, side, { margin: 2.2, height: 1.6 }),
        move: "static",
        fov: [FOV.medium, FOV.wide],
        k: 0.16,
        subjects: () => [tmp.gunman, stage.car],
      });
      shots.push({
        id: pull!.id,
        start: pull!.start,
        end: pull!.end,
        frame: () => twoShot(tmp.gunman, stage.car, side, { margin: 2.6, height: 2.4 }),
        move: "crane",
        fov: [FOV.wide, FOV.pull],
        k: 0.14,
      });
    }
    playShots(cam, shots, lc, dt);
  });

  const from: [number, number, number] = [stage.shooters[1]!.x, 0.7, stage.shooters[1]!.z];
  const to: [number, number, number] = [stage.alley.x, 0.7, stage.alley.z];

  return (
    <group>
      {stage.shooters.map((p, i) => (
        <group key={i} ref={shooterRefs[i]} position={[p.x, 0, p.z]} rotation={[0, site.facing, 0]}>
          <Goon
            position={[0, 0, 0]}
            pose={
              police && phase === "melt"
                ? "stand"
                : melt
                  ? "run"
                  : phase === "strike" && !freeze
                    ? "aim"
                    : i === 0
                      ? "crouch"
                      : "stand"
            }
            moving={melt}
            gun
            weapon={i === 1 ? "tommy" : "pistol"}
            firing={shooting}
            shots={3}
            lookAt={melt ? undefined : tmp.markHead}
            muzzleRef={i === 1 ? muzzle : undefined}
            seed={i * 101 + 7}
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
            hitFrom={markDown ? tmp.gunman : undefined}
            lookAt={phase === "strike" ? tmp.gunman : undefined}
            role="boss"
            seed={53}
            color={paint(cinematic.targetFamily)}
          />
        </group>
      )}
      {extra && phase !== "position" && (
        <Goon
          position={[site.road.x + 1.4, 0, site.road.z - 0.6]}
          rot={site.facing + Math.PI}
          pose={phase === "strike" ? "aim" : "stand"}
          lookAt={tmp.gunman}
          gun
          role="soldier"
          color="#3f1a1e"
        />
      )}
      {trap && phase !== "position" && (
        <Goon
          position={[stage.alley.x - 0.8, 0, stage.alley.z - 0.4]}
          rot={site.facing}
          pose={phase === "strike" ? "aim" : "stand"}
          lookAt={tmp.gunman}
          gun
          role="soldier"
          color={paint(cinematic.targetFamily)}
        />
      )}
      <MuzzleFlash active={shooting} from={from} to={to} fromRef={muzzle} shots={3} />
      {trap && (
        <MuzzleFlash active={phase === "strike"} from={[stage.alley.x - 0.8, 0.7, stage.alley.z - 0.4]} to={from} shots={3} />
      )}
      <MuzzleFlash
        active={(extra || defenders) && phase === "strike"}
        from={[site.road.x + 1.4, 0.7, site.road.z - 0.6]}
        to={from}
        shots={3}
      />
      <group visible={phase !== "position"}>
        <ReelSedan
          cars={[{ x: stage.car.x, z: stage.car.z, rot: site.facing, color: paint(cinematic.attackerFamily), lamps: phase === "melt" }]}
        />
      </group>
      <Headlamps cars={[{ x: stage.car.x, z: stage.car.z, rot: site.facing }]} lit={phase === "melt"} />
      <Bystanders at={[site.road.x, 0, site.road.z]} facing={site.facing} flee={phase === "strike" || phase === "melt"} />
      <Blood active={markDown} at={[stage.alley.x, 0, stage.alley.z]} facing={site.facing + Math.PI} />
      <Smoke active={melt} at={[site.road.x + 1.2, 0.15, site.road.z + 0.8]} loop size={0.65} />
      <pointLight
        position={[site.road.x, 1.2, site.road.z]}
        color="#fff3c4"
        intensity={c === "patrol" && phase !== "position" ? (phase === "wait" ? 2 + local : 1.2) : 0}
        distance={8}
      />
      <PoliceLights active={police && phase === "melt"} at={[site.road.x, 0.4, site.road.z]} />
      <PaddyWagon active={police && phase === "melt"} x={site.road.x - 1.5} z={site.road.z + 1.6} rot={site.facing} />
    </group>
  );
}
