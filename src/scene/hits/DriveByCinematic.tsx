import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { type SedanSpec } from "@/scene/Sedan";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import MuzzleFlash from "./props/MuzzleFlash";
import GlassShards from "./props/GlassShards";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { bodyThenPull, coverageShot, facingOf, handheld, moveCam, reelSide, type Coverage } from "./cameraRig";
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
  const stalls = c === "stall" || police;

  const rig = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ pos: new THREE.Vector3(), tan: new THREE.Vector3(), focus: new THREE.Vector3() }), []);

  // Where the car sits while the guns are out. Fixed, so the flashes line up.
  const spray = useMemo(() => {
    const pos = site.approach.getPointAt(0.92);
    const rot = headingOf(site.approach.getTangentAt(0.92));
    return { pos, rot };
  }, [site]);

  const stalled = stalls && phase === "getaway";
  const cars: SedanSpec[] = [{ x: 0, z: 0, rot: 0, color: paint(cinematic.attackerFamily), lamps: true }];
  if (c === "escort" && !witnessed && phase !== "roll") {
    cars.push({ x: 0, z: 1.3, rot: 0, color: "#3f1a1e", lamps: true });
  }
  const blockedLane = c === "blocked_lane" && (phase === "pass" || phase === "spray" || phase === "getaway");

  const markDown = killed && (phase === "spray" || phase === "getaway");
  const markSpot: [number, number, number] = [
    site.building.x + Math.sin(site.facing) * 1.2,
    0,
    site.building.z + Math.cos(site.facing) * 1.2,
  ];
  const muzzle: [number, number, number] = [spray.pos.x, 0.7, spray.pos.z];

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

    const side = reelSide(cinematic.operationId);
    const shotOpts = { drift: progress, side };
    let shot;
    if (ph === "getaway" && killed) {
      tmp.focus.set(markSpot[0], 0, markSpot[2]);
      shot = bodyThenPull(tmp.focus, site.facing, lc, shotOpts);
    } else {
      const coverage: Coverage =
        ph === "roll" ? "wide" : ph === "pass" ? "medium" : ph === "spray" ? "close" : "pull";
      if (ph === "spray") tmp.focus.set(markSpot[0], 0, markSpot[2]);
      else if (ph === "pass") tmp.focus.copy(site.building);
      else tmp.focus.copy(tmp.pos);
      // The sedan's own yaw is a quarter turn off this rig. Trail it from behind.
      const trailing = ph === "roll" || ph === "pass" || ph === "getaway";
      const facing = trailing ? facingOf(tmp.tan) + Math.PI : site.facing;
      shot = coverageShot(tmp.focus, facing, coverage, shotOpts);
    }
    const carMoving = ph === "roll" || ph === "pass" || (ph === "getaway" && !stalls);
    moveCam(camera, controls, shot.pos, shot.look, ph === "spray" ? 0.5 : carMoving ? 0.3 : 0.12, dt);
    if (ph === "pass") handheld(camera, 0.01);
    if (ph === "spray") shake.current = Math.max(shake.current, 0.08);
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
      <PaddyWagon
        active={police && phase === "getaway"}
        x={site.road.x + 2}
        z={site.road.z - 1.5}
        rot={spray.rot + Math.PI / 2}
      />
    </group>
  );
}
