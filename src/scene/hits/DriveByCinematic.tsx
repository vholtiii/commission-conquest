import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { type SedanSpec } from "@/scene/Sedan";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, facingOf, kerbShot, reelSide, trackShot, twoShot } from "./cameraRig";
import { useReelCamera } from "./useReelCamera";
import Headlamps from "./props/Headlamps";
import Blood from "./props/Blood";
import Bystanders from "./props/Bystanders";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Where along the route the sedan is. Rolls in, brakes at the storefront, pulls away. */
function travelAt(phase: string, local: number, stalled: boolean): number {
  const travel =
    phase === "roll" ? local * 0.72 : phase === "pass" ? 0.72 + 0.2 * (1 - (1 - local) * (1 - local)) : 0.92;
  const escape = phase === "getaway" && !stalled ? local * local * 0.08 : 0;
  return Math.min(0.999, travel + escape);
}

/** Yaw for a sedan (nose +X) travelling along `tangent`. */
function headingOf(tangent: THREE.Vector3): number {
  return Math.atan2(-tangent.z, tangent.x);
}

/** Sedan rolls the route, slows at the storefront, and sprays — or stalls. */
export default function DriveByCinematic({ cinematic, site, phase, clock, shake }: SceneProps) {
  const cam = useReelCamera(site.space, cinematic.operationId, shake);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  // Somebody else's job: the sedan and the mark only, no garrison, no escort.
  const witnessed = cinematic.perspective === "witnessed";
  const returnFire =
    !witnessed && cinematic.result.defenders > 0 && (phase === "spray" || phase === "getaway");
  const stalls = c === "stall" || police;

  const rig = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ pos: new THREE.Vector3(), tan: new THREE.Vector3(), carEye: new THREE.Vector3() }), []);
  const barrel = useRef<THREE.Object3D>(null);

  // Where the car sits while the guns are out. Fixed, so the flashes line up.
  const spray = useMemo(() => {
    const pos = site.approach.getPointAt(0.92);
    const rot = headingOf(site.approach.getTangentAt(0.92));
    const mark = new THREE.Vector3(
      site.building.x + Math.sin(site.facing) * 1.2,
      0,
      site.building.z + Math.cos(site.facing) * 1.2,
    );
    // The gunner is out of the door on the kerb side, tommy gun up.
    const gunner = pos.clone().setY(0);
    const toMark = mark.clone().sub(gunner).setY(0);
    if (toMark.lengthSq() > 1e-4) gunner.addScaledVector(toMark.normalize(), 0.7);
    const markHead = mark.clone().setY(0.85);
    return { pos, rot, mark, gunner, markHead };
  }, [site]);

  const stalled = stalls && phase === "getaway";
  const cars: SedanSpec[] = [{ x: 0, z: 0, rot: 0, color: paint(cinematic.attackerFamily), lamps: true }];
  if (c === "escort" && !witnessed && phase !== "roll") {
    cars.push({ x: 0, z: 1.3, rot: 0, color: "#3f1a1e", lamps: true });
  }
  const blockedLane = c === "blocked_lane" && (phase === "pass" || phase === "spray" || phase === "getaway");

  const markDown = killed && (phase === "spray" || phase === "getaway");
  const markSpot: [number, number, number] = [spray.mark.x, 0, spray.mark.z];
  const muzzle: [number, number, number] = [spray.gunner.x, 0.75, spray.gunner.z];
  const gunnerOut = phase === "spray" || stalled;

  useFrame((_, dt) => {
    const { phase: ph, local: lc, progress } = clock.current;
    const t = travelAt(ph, lc, stalls);
    site.approach.getPointAt(t, tmp.pos);
    site.approach.getTangentAt(t, tmp.tan);
    const rot = headingOf(tmp.tan);
    if (rig.current) {
      rig.current.position.set(tmp.pos.x, 0, tmp.pos.z);
      rig.current.rotation.y = rot;
    }

    tmp.carEye.set(tmp.pos.x, 0.7, tmp.pos.z);

    const side = reelSide(cinematic.operationId);
    const travel = facingOf(tmp.tan);
    if (ph === "roll") {
      cam.frame(ph, trackShot(tmp.pos, travel, side, { back: 3.6, height: 1.4 }), { k: 0.3, dt, coverage: "wide", follow: true });
    } else if (ph === "pass") {
      cam.frame(ph, twoShot(tmp.pos, spray.mark, side, { height: 1.6, push: lc * 0.2 }), {
        k: 0.25,
        dt,
        coverage: "medium",
        handheld: 0.012,
        follow: true,
      });
    } else if (ph === "spray") {
      cam.frame(ph, kerbShot(spray.mark, site.facing, spray.gunner, side), { k: 0.5, dt, coverage: "medium", cut: true });
      shake.current = Math.max(shake.current, 0.06);
    } else if (killed) {
      cam.frame(ph, bodyThenPull(spray.mark, site.facing, lc, { drift: progress, side }), {
        k: 0.3,
        dt,
        coverage: lc < 0.6 ? "body" : "pull",
      });
    } else {
      cam.frame(ph, trackShot(tmp.pos, travel, side, { back: 5, height: 2.6 }), { k: stalls ? 0.12 : 0.3, dt, coverage: "pull", follow: true });
    }
  });

  return (
    <group>
      <group ref={rig} position={[spray.pos.x, 0, spray.pos.z]} rotation={[0, spray.rot, 0]}>
        <ReelSedan cars={cars} />
        <Headlamps cars={cars.map((car) => ({ x: car.x, z: car.z, rot: car.rot }))} />
        <Smoke active={returnFire && phase === "getaway"} at={[0, 0.4, 0]} loop />
        <Smoke active={phase === "getaway" && !stalled} at={[-0.9, 0.15, 0]} loop size={0.65} />
        <PoliceLights active={stalled} at={[0, 0.5, 0]} />
      </group>
      {blockedLane && (
        <ReelSedan
          cars={[{ x: site.road.x + 1.6, z: site.road.z + 1.2, rot: spray.rot + Math.PI / 2, color: "#d6c9a8", lamps: false }]}
        />
      )}
      <Bystanders
        at={[site.road.x, 0, site.road.z]}
        facing={site.facing}
        flee={phase === "spray" || phase === "getaway"}
      />
      <Blood active={markDown} at={markSpot} facing={site.facing} />
      <Goon
        position={markSpot}
        rot={site.facing}
        pose={c === "fruit_cart" && phase !== "roll" ? "crouch" : markDown ? "down" : "stand"}
        lookAt={phase === "roll" ? undefined : tmp.carEye}
        role="boss"
        seed={53}
        color={paint(cinematic.targetFamily)}
      />
      {gunnerOut && (
        <Goon
          position={[spray.gunner.x, 0, spray.gunner.z]}
          rot={Math.atan2(spray.mark.x - spray.gunner.x, spray.mark.z - spray.gunner.z)}
          pose={phase === "spray" ? "aim" : "stand"}
          weapon="tommy"
          gun
          firing={phase === "spray"}
          lookAt={stalled ? undefined : spray.markHead}
          muzzleRef={barrel}
          seed={211}
          role="soldier"
          color={paint(cinematic.attackerFamily)}
        />
      )}
      {c === "fruit_cart" && (
        <mesh position={[markSpot[0] + 0.5, 0.35, markSpot[2]]}>
          <boxGeometry args={[0.7, 0.5, 0.5]} />
          <meshStandardMaterial color="#6a4a28" />
        </mesh>
      )}
      <MuzzleFlash active={phase === "spray"} from={muzzle} to={markSpot} fromRef={barrel} shots={returnFire ? 8 : 5} />
      {returnFire && (
        <MuzzleFlash active={phase === "spray" || phase === "getaway"} from={markSpot} to={muzzle} shots={4} />
      )}
      <GlassShards active={phase === "spray"} at={[site.building.x, 0, site.building.z]} />
      <PaddyWagon
        active={police && phase === "getaway"}
        x={site.road.x + 2}
        z={site.road.z - 1.5}
        rot={spray.rot + Math.PI / 2}
      />
    </group>
  );
}
