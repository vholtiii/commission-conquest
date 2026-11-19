import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import Explosion from "./props/Explosion";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { coverageShot, dampAngle, ease, FOV, kerbShot, reelSide, twoShot } from "./cameraRig";
import { playShots, type DirectedShot } from "./director";
import { CAR_BOMB } from "./shotlists";
import { useReelCamera } from "./useReelCamera";
import Blood from "./props/Blood";
import Bystanders from "./props/Bystanders";
import Fire from "./props/Fire";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** A spot down the pavement, clear of the blast, or across the street if the pavement is a wall. */
function watchPost(
  car: THREE.Vector3,
  away: THREE.Vector3,
  kerb: THREE.Vector3,
  isClear: (p: THREE.Vector3) => boolean,
): THREE.Vector3 {
  const spot = new THREE.Vector3();
  const tries: Array<[THREE.Vector3, number, THREE.Vector3, number]> = [
    [away, -6, kerb, 0.35],
    [away, -6, kerb, -0.8],
    [away, -4.5, kerb, 0.9],
    [away, -7.5, kerb, 0],
    [kerb, 5.5, away, 0],
  ];
  for (const [dir, dist, other, extra] of tries) {
    spot.copy(car).addScaledVector(dir, dist).addScaledVector(other, extra).setY(0);
    if (isClear(spot)) return spot.clone();
  }
  return car.clone().addScaledVector(kerb, 5.5).setY(0);
}

/** Just behind the watcher, looking down his line of sight at the car. */
function overShoulder(man: THREE.Vector3, car: THREE.Vector3): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const toCar = car.clone().sub(man);
  toCar.y = 0;
  if (toCar.lengthSq() < 1e-4) toCar.set(1, 0, 0);
  toCar.normalize();
  const flank = new THREE.Vector3(toCar.z, 0, -toCar.x);
  const pos = man.clone().addScaledVector(toCar, -1.15).addScaledVector(flank, 0.45);
  pos.y = 1.55;
  const look = car.clone();
  look.y = 0.55;
  return { pos, look };
}

/** How far the planter stands from the car, along the line to the kerb, over the reel. */
function planterDistance(phase: string, local: number): number {
  if (phase === "plant") {
    if (local < 0.45) return 1.3 - 1.1 * (local / 0.45);
    if (local < 0.75) return 0.2;
    return 0.2 + ((local - 0.75) / 0.25) * 1.0;
  }
  if (phase === "wait") return 1.2 + local * 1.3;
  if (phase === "abort") return 1.2 + local * 1.0;
  return 2.5;
}

/** A thrown car: up, over, and down onto its side, where it stays. */
function flip(k: number): { y: number; pitch: number; roll: number } {
  const arc = Math.sin(Math.min(1, k) * Math.PI);
  return { y: arc * 1.4 + k * 0.12, pitch: arc * 1.1 + k * 0.35, roll: ease(k) * 0.5 };
}

/** Parked Packard, a planter, then the blast — or the fuse that doesn't take. */
export default function CarBombCinematic({ cinematic, site, phase, local, clock, shake }: SceneProps) {
  const cam = useReelCamera(site.space, cinematic.operationId, shake);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const absent = cinematic.result.markAbsent;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  const fizzle = c === "dud" || c === "rain";
  // The plant only plays when the bomb never goes off. Every other reel opens on the stakeout.
  const staked = !absent && c !== "cop_on_fender";
  // The detonate beat only exists when the mark showed and nobody called it off.
  const blown = !fizzle && c !== "cop_on_fender" && !absent;
  const blast = phase === "detonate" && blown;
  const messy = cinematic.result.outcome === "messy_kill";

  const stage = useMemo(() => {
    const toward = site.building.clone().sub(site.road).normalize();
    const carPos = site.road.clone().addScaledVector(toward, 0.55);
    const kerb = new THREE.Vector3(Math.sin(site.facing), 0, Math.cos(site.facing));
    const wrongCar = carPos.clone().add(new THREE.Vector3(2.2, 0, 0.4));
    const markEnd = site.building.clone().lerp(carPos, 0.85);
    // Along the pavement: he stands between the car and the wall, so straight away from the car is into the bricks.
    const away = new THREE.Vector3(kerb.z, 0, -kerb.x);
    const landing = markEnd.clone().addScaledVector(away, 1.4);
    const carEye = carPos.clone().setY(0.45);
    const cop = new THREE.Vector3(carPos.x + 0.4, 0, carPos.z + 0.7);
    const post = watchPost(carPos, away, kerb, site.isClear);
    return { carPos, kerb, wrongCar, markEnd, away, landing, carEye, cop, post };
  }, [site]);

  const carRig = useRef<THREE.Group>(null);
  const wrongRig = useRef<THREE.Group>(null);
  const planterRef = useRef<THREE.Group>(null);
  const markRef = useRef<THREE.Group>(null);
  const lastDist = useRef(1.3);
  const tmp = useMemo(() => ({ mark: new THREE.Vector3(), at: new THREE.Vector3(), planterHead: new THREE.Vector3() }), []);

  useFrame((_, dt) => {
    const { phase: ph, local: lc } = clock.current;

    // The car.
    const wreck = ph === "detonate" && blown ? flip(lc) : ph === "aftermath" && blown ? flip(1) : null;
    if (carRig.current) {
      carRig.current.position.set(stage.carPos.x, wreck?.y ?? 0, stage.carPos.z);
      carRig.current.rotation.set(wreck?.pitch ?? 0, site.facing, wreck?.roll ?? 0);
    }
    if (wrongRig.current) {
      const w = wreck ? { y: wreck.y * 0.5, pitch: wreck.pitch * 0.55 } : { y: 0, pitch: 0 };
      wrongRig.current.position.set(stage.wrongCar.x, w.y, stage.wrongCar.z);
      wrongRig.current.rotation.set(w.pitch, site.facing, 0);
    }

    // A staked reel: he is already down the block, and only walks off once it is over.
    // A plant reel: he walks in, kneels, and walks back to the kerb.
    if (staked) {
      const leaving = ph === "aftermath" && !police;
      tmp.at.copy(stage.post).addScaledVector(stage.away, leaving ? -ease(lc) * 4 : 0);
      if (planterRef.current) {
        planterRef.current.position.copy(tmp.at);
        const want = leaving
          ? Math.atan2(-stage.away.x, -stage.away.z)
          : Math.atan2(stage.carPos.x - tmp.at.x, stage.carPos.z - tmp.at.z);
        planterRef.current.rotation.y = dampAngle(planterRef.current.rotation.y, want, dt, 8);
      }
    } else {
      const dist = planterDistance(ph, lc);
      if (planterRef.current) {
        tmp.at.copy(stage.carPos).addScaledVector(stage.kerb, dist);
        planterRef.current.position.copy(tmp.at);
        const leaving = dist >= lastDist.current - 1e-4;
        const want = leaving && dist > 0.25 ? site.facing : site.facing + Math.PI;
        planterRef.current.rotation.y = dampAngle(planterRef.current.rotation.y, want, dt, 8);
      }
      lastDist.current = dist;
    }
    tmp.planterHead.copy(tmp.at).setY(0.85);

    // The mark comes out of the building toward his car. A kill throws him clear of the blast.
    const thrown = killed && (ph === "detonate" || ph === "aftermath");
    if (thrown) {
      const k = ph === "aftermath" ? 1 : Math.min(1, lc / 0.5);
      tmp.mark.copy(stage.markEnd).addScaledVector(stage.away, k * 1.4);
      tmp.mark.y = Math.sin(k * Math.PI) * 0.8;
    } else {
      const markT = ph === "wait" ? ease(lc) : ph === "detonate" || ph === "aftermath" ? 1 : 0;
      tmp.mark.copy(site.building).lerp(stage.carPos, Math.min(1, markT * 0.85));
      tmp.mark.y = 0;
    }
    if (markRef.current) markRef.current.position.copy(tmp.mark);

    const side = reelSide(cinematic.operationId);
    const range = CAR_BOMB[ph] ?? CAR_BOMB.aftermath;
    const shots: DirectedShot[] = [];
    if (ph === "stakeout") {
      const [car, watch, door] = range;
      shots.push({
        id: car!.id,
        start: car!.start,
        end: car!.end,
        frame: () => coverageShot(stage.carPos, site.facing, "medium", { side, lookY: 0.5 }),
        move: "dollyIn",
        fov: [FOV.establish, FOV.wide],
        k: 0.14,
      });
      shots.push({
        id: watch!.id,
        start: watch!.start,
        end: watch!.end,
        frame: () => overShoulder(tmp.at, stage.carPos),
        move: "dollyIn",
        fov: [FOV.close, FOV.punch],
        transition: "cut",
        k: 0.22,
        focus: () => stage.carPos.clone().setY(0.55),
      });
      shots.push({
        id: door!.id,
        start: door!.start,
        end: door!.end,
        frame: () => twoShot(site.building, stage.carPos, side, { height: 1.35 }),
        move: "dollyIn",
        fov: [FOV.medium, FOV.wide],
        k: 0.16,
        subjects: () => [site.building, stage.carPos],
      });
    } else if (ph === "plant") {
      const [walk, kneel, leave] = range;
      shots.push({
        id: walk!.id,
        start: walk!.start,
        end: walk!.end,
        frame: () => twoShot(tmp.at, stage.carPos, side, { height: 1.35, margin: 2.6 }),
        move: "dollyIn",
        fov: [FOV.establish, FOV.medium],
        follow: true,
        k: 0.16,
        subjects: () => [tmp.at, stage.carPos],
      });
      shots.push({
        id: kneel!.id,
        start: kneel!.start,
        end: kneel!.end,
        frame: () => twoShot(tmp.at, stage.carPos, side, { height: 0.95, margin: 1.4, push: 0.15 }),
        move: "push",
        fov: [FOV.medium, FOV.close],
        transition: "cut",
        k: 0.3,
      });
      shots.push({
        id: leave!.id,
        start: leave!.start,
        end: leave!.end,
        frame: () => twoShot(tmp.at, stage.carPos, side, { height: 1.4, margin: 2.2 }),
        move: "dollyOut",
        fov: [FOV.close, FOV.wide],
        follow: true,
        k: 0.18,
      });
    } else if (ph === "abort") {
      const [two, close] = range;
      shots.push({
        id: two!.id,
        start: two!.start,
        end: two!.end,
        frame: () => twoShot(tmp.at, stage.cop, side, { height: 1.5, margin: 2 }),
        move: "static",
        fov: [FOV.wide, FOV.medium],
        follow: true,
        k: 0.16,
        subjects: () => [tmp.at, stage.cop],
      });
      shots.push({
        id: close!.id,
        start: close!.start,
        end: close!.end,
        frame: () => twoShot(tmp.at, stage.cop, side, { height: 1.2, margin: 1.3 }),
        move: "dollyIn",
        fov: [FOV.medium, FOV.close],
        k: 0.22,
      });
    } else if (ph === "wait") {
      const [push] = range;
      const focus = absent ? tmp.at : tmp.mark;
      shots.push({
        id: push!.id,
        start: push!.start,
        end: push!.end,
        frame: () =>
          absent
            ? twoShot(tmp.at, stage.carPos, side, { height: 1.5 })
            : twoShot(tmp.mark, stage.carPos, side, { height: 1.35, push: lc * 0.2 }),
        move: "push",
        fov: [FOV.wide, FOV.close],
        follow: true,
        handheld: 0.01,
        k: 0.2,
        focus: () => focus.clone().setY(0.8),
        subjects: () => (absent ? [tmp.at, stage.carPos] : [tmp.mark, stage.carPos]),
      });
    } else if (ph === "detonate") {
      const [wide, punch, hold] = range;
      const framing = () =>
        blown
          ? twoShot(stage.markEnd, stage.carPos, side, { margin: 2.8, height: 1.7 })
          : coverageShot(stage.carPos, site.facing, "close", { side });
      shots.push({
        id: wide!.id,
        start: wide!.start,
        end: wide!.end,
        frame: framing,
        move: "static",
        fov: [blown ? FOV.wide : FOV.medium, blown ? FOV.medium : FOV.close],
        transition: "cut",
        k: 0.4,
        subjects: () => [stage.markEnd, stage.carPos],
      });
      shots.push({
        id: punch!.id,
        start: punch!.start,
        end: punch!.end,
        frame: framing,
        move: "dollyIn",
        fov: [FOV.close, FOV.close],
        punch: blown ? { at: 0.1, fov: FOV.punch } : undefined,
        k: 0.5,
        handheld: blown ? 0.02 : 0.008,
      });
      shots.push({
        id: hold!.id,
        start: hold!.start,
        end: hold!.end,
        frame: framing,
        move: "dollyOut",
        fov: [FOV.close, FOV.medium],
        k: 0.2,
      });
      if (blown) shake.current = Math.max(shake.current, messy ? 0.36 : 0.22);
    } else if (killed) {
      const [body, crane] = range;
      shots.push({
        id: body!.id,
        start: body!.start,
        end: body!.end,
        frame: () => kerbShot(stage.landing, site.facing, stage.carPos, 1),
        move: "static",
        fov: [FOV.body, FOV.body],
        k: 0.28,
      });
      shots.push({
        id: crane!.id,
        start: crane!.start,
        end: crane!.end,
        frame: () => kerbShot(stage.landing, site.facing, stage.carPos, 1),
        move: "crane",
        fov: [FOV.body, FOV.pull],
        k: 0.16,
      });
    } else if (staked) {
      const [body, crane] = range;
      const withHim = () => [stage.carPos, tmp.mark, tmp.at];
      shots.push({
        id: body!.id,
        start: body!.start,
        end: body!.end,
        frame: () => twoShot(stage.carPos, tmp.mark, side, { margin: 2.4, height: 1.8 }),
        move: "static",
        fov: [FOV.medium, FOV.wide],
        k: 0.16,
        subjects: withHim,
      });
      shots.push({
        id: crane!.id,
        start: crane!.start,
        end: crane!.end,
        frame: () => twoShot(stage.carPos, tmp.mark, side, { margin: 3.0, height: 2.6 }),
        move: "crane",
        fov: [FOV.wide, FOV.pull],
        k: 0.12,
        subjects: withHim,
      });
    } else {
      const [body, crane] = range;
      shots.push({
        id: body!.id,
        start: body!.start,
        end: body!.end,
        frame: () => twoShot(stage.carPos, tmp.at, side, { margin: 2.6, height: 2.2 }),
        move: "static",
        fov: [FOV.medium, FOV.wide],
        follow: true,
        k: 0.14,
      });
      shots.push({
        id: crane!.id,
        start: crane!.start,
        end: crane!.end,
        frame: () => twoShot(stage.carPos, tmp.at, side, { margin: 3.2, height: 3.2 }),
        move: "crane",
        fov: [FOV.wide, FOV.pull],
        k: 0.12,
      });
    }
    playShots(cam, shots, lc, dt);
  });

  const showMark = !absent && phase !== "plant" && phase !== "stakeout" && c !== "cop_on_fender";
  const landed = killed && ((phase === "detonate" && local >= 0.5) || phase === "aftermath");
  const markPose = landed ? "down" : "walk";
  const planterLeaving = staked && phase === "aftermath" && !police;
  const planterPose = staked
    ? planterLeaving
      ? "walk"
      : "stand"
    : phase === "plant" && local > 0.45 && local < 0.75
      ? "crouch"
      : phase === "detonate" || phase === "aftermath"
        ? "stand"
        : "walk";
  const planterMoving = planterPose === "walk";
  const blastAt: [number, number, number] =
    c === "wrong_car" ? [stage.wrongCar.x, 0.4, stage.wrongCar.z] : [stage.carPos.x, 0.5, stage.carPos.z];
  const burning = blast ? local > 0.2 : phase === "aftermath" && blown;

  return (
    <group>
      <group ref={carRig} position={[stage.carPos.x, 0, stage.carPos.z]} rotation={[0, site.facing, 0]}>
        <ReelSedan attitude={false} cars={[{ x: 0, z: 0, rot: 0, color: paint(cinematic.targetFamily), lamps: false }]} />
      </group>
      {c === "wrong_car" && (
        <group ref={wrongRig} position={[stage.wrongCar.x, 0, stage.wrongCar.z]} rotation={[0, site.facing, 0]}>
          <ReelSedan attitude={false} cars={[{ x: 0, z: 0, rot: 0, color: "#d6c9a8", lamps: false }]} />
        </group>
      )}
      <group
        ref={planterRef}
        position={
          staked
            ? [stage.post.x, 0, stage.post.z]
            : [stage.carPos.x + stage.kerb.x * 1.3, 0, stage.carPos.z + stage.kerb.z * 1.3]
        }
      >
        <Goon
          position={[0, 0, 0]}
          pose={planterPose}
          moving={planterMoving}
          lookAt={planterPose === "walk" ? undefined : stage.carEye}
          seed={311}
          role="soldier"
          color={paint(cinematic.attackerFamily)}
        />
      </group>
      {(!absent && c !== "cop_on_fender") && (
        <group ref={markRef} visible={showMark} position={[site.building.x, 0, site.building.z]}>
          <Goon
            position={[0, 0, 0]}
            rot={site.facing}
            pose={markPose}
            moving={phase === "wait"}
            hitFrom={landed ? stage.carPos : undefined}
            lookAt={phase === "wait" ? stage.carEye : undefined}
            seed={53}
            role="boss"
            color={paint(cinematic.targetFamily)}
          />
        </group>
      )}
      {c === "cop_on_fender" && (
        <group visible={phase !== "plant"}>
          <Goon position={[stage.cop.x, 0, stage.cop.z]} rot={site.facing} lookAt={tmp.planterHead} color="#1a2740" />
        </group>
      )}
      <Bystanders at={[site.road.x, 0, site.road.z]} facing={site.facing} flee={blast || (phase === "aftermath" && blown)} />
      <Blood
        active={killed && ((phase === "detonate" && local >= 0.5) || phase === "aftermath")}
        at={[stage.landing.x, 0, stage.landing.z]}
        facing={site.facing}
      />
      <Explosion active={blast} at={blastAt} secondary={messy} />
      <Fire active={burning} at={blastAt} />
      <Smoke active={fizzle && phase === "detonate"} at={blastAt} />
      <PoliceLights active={police && phase === "aftermath"} at={[site.road.x, 0.4, site.road.z]} />
      <PaddyWagon
        active={police && phase === "aftermath"}
        x={site.road.x + 2.4}
        z={site.road.z}
        rot={site.facing + Math.PI / 2}
      />
    </group>
  );
}
