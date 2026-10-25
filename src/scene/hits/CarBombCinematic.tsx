import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { ReelSedan } from "@/scene/ReelSedan";
import Goon from "./props/Goon";
import Explosion from "./props/Explosion";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { coverageShot, ease, kerbShot, reelSide, twoShot } from "./cameraRig";
import { useReelCamera } from "./useReelCamera";
import Blood from "./props/Blood";
import Bystanders from "./props/Bystanders";
import Fire from "./props/Fire";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
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
    return { carPos, kerb, wrongCar, markEnd, away, landing, carEye, cop };
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

    // The planter walks in, kneels, and walks back to the kerb.
    const dist = planterDistance(ph, lc);
    if (planterRef.current) {
      tmp.at.copy(stage.carPos).addScaledVector(stage.kerb, dist);
      planterRef.current.position.copy(tmp.at);
      const leaving = dist >= lastDist.current - 1e-4;
      planterRef.current.rotation.y = leaving && dist > 0.25 ? site.facing : site.facing + Math.PI;
    }
    lastDist.current = dist;
    tmp.planterHead.copy(stage.carPos).addScaledVector(stage.kerb, dist).setY(0.85);

    // The mark comes out of the building toward his car. A kill throws him clear of the blast.
    const thrown = killed && (ph === "detonate" || ph === "aftermath");
    if (thrown) {
      const k = ph === "aftermath" ? 1 : Math.min(1, lc / 0.5);
      tmp.mark.copy(stage.markEnd).addScaledVector(stage.away, k * 1.4);
      tmp.mark.y = Math.sin(k * Math.PI) * 0.8;
    } else {
      const markT = ph === "wait" ? lc : ph === "detonate" || ph === "aftermath" ? 1 : 0;
      tmp.mark.copy(site.building).lerp(stage.carPos, Math.min(1, markT * 0.85));
      tmp.mark.y = 0;
    }
    if (markRef.current) markRef.current.position.copy(tmp.mark);

    const side = reelSide(cinematic.operationId);
    if (ph === "plant") {
      cam.frame(ph, twoShot(tmp.at, stage.carPos, side, { height: 1.2, margin: 2.8, push: lc * 0.1 }), {
        k: 0.1,
        dt,
        coverage: "wide",
        follow: true,
      });
    } else if (ph === "abort") {
      cam.frame(ph, twoShot(tmp.at, stage.cop, side, { height: 1.3, margin: 1.8 }), { k: 0.12, dt, coverage: "wide", follow: true });
    } else if (ph === "wait") {
      const shot = absent ? twoShot(tmp.at, stage.carPos, side) : twoShot(tmp.mark, stage.carPos, side, { push: lc * 0.25 });
      cam.frame(ph, shot, { k: 0.15, dt, coverage: "medium", handheld: 0.012, follow: true });
    } else if (ph === "detonate") {
      // Wide enough to hold the whole blast, cut in hard on the first frame.
      const shot = blown
        ? twoShot(stage.markEnd, stage.carPos, side, { margin: 2.6, height: 1.6 })
        : coverageShot(stage.carPos, site.facing, "close", { side });
      cam.frame(ph, shot, { k: 0.5, dt, coverage: blown ? "medium" : "close", cut: true });
      if (blown) shake.current = Math.max(shake.current, messy ? 0.36 : 0.22);
    } else if (killed) {
      // From further down the pavement, past the body, so the wreck sits behind him and not in front of the lens.
      cam.frame(ph, kerbShot(stage.landing, site.facing, stage.carPos, 1), { k: 0.3, dt, coverage: "body" });
    } else {
      cam.frame(ph, twoShot(stage.carPos, tmp.at, side, { margin: 3, height: 3 }), { k: 0.1, dt, coverage: "pull", follow: true });
    }
  });

  const showMark = !absent && phase !== "plant" && c !== "cop_on_fender";
  const landed = killed && ((phase === "detonate" && local >= 0.5) || phase === "aftermath");
  const markPose = landed ? "down" : "walk";
  const planterPose =
    phase === "plant" && local > 0.45 && local < 0.75 ? "crouch" : phase === "detonate" || phase === "aftermath" ? "stand" : "walk";
  const planterMoving = planterPose === "walk";
  const blastAt: [number, number, number] =
    c === "wrong_car" ? [stage.wrongCar.x, 0.4, stage.wrongCar.z] : [stage.carPos.x, 0.5, stage.carPos.z];
  const burning = blast ? local > 0.2 : phase === "aftermath" && blown;

  return (
    <group>
      <group ref={carRig} position={[stage.carPos.x, 0, stage.carPos.z]} rotation={[0, site.facing, 0]}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: 0, color: paint(cinematic.targetFamily), lamps: false }]} />
      </group>
      {c === "wrong_car" && (
        <group ref={wrongRig} position={[stage.wrongCar.x, 0, stage.wrongCar.z]} rotation={[0, site.facing, 0]}>
          <ReelSedan cars={[{ x: 0, z: 0, rot: 0, color: "#d6c9a8", lamps: false }]} />
        </group>
      )}
      <group ref={planterRef} position={[stage.carPos.x + stage.kerb.x * 1.3, 0, stage.carPos.z + stage.kerb.z * 1.3]}>
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
      {showMark && (
        <group ref={markRef} position={[site.building.x, 0, site.building.z]}>
          <Goon
            position={[0, 0, 0]}
            rot={site.facing}
            pose={markPose}
            moving={phase === "wait"}
            lookAt={phase === "wait" ? stage.carEye : undefined}
            seed={53}
            role="boss"
            color={paint(cinematic.targetFamily)}
          />
        </group>
      )}
      {c === "cop_on_fender" && phase !== "plant" && (
        <Goon position={[stage.cop.x, 0, stage.cop.z]} rot={site.facing} lookAt={tmp.planterHead} color="#1a2740" />
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
