import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { SedanFleet, type SedanSpec } from "@/scene/Sedan";
import Goon from "./props/Goon";
import Explosion from "./props/Explosion";
import Smoke from "./props/Smoke";
import { PaddyWagon, PoliceLights } from "./props/PoliceLights";
import { moveCam, orbitAround } from "./cameraRig";
import type { SceneProps } from "./sceneProps";

function paint(family: FamilyName): string {
  return FAMILY_HEX[family] ?? "#1c1c1e";
}

/** Parked Packard, a planter, then the blast — or the fuse that doesn't take. */
export default function CarBombCinematic({ cinematic, site, phase, local, shake }: SceneProps) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const c = cinematic.result.complication;
  const killed = cinematic.result.targetDead;
  const police =
    cinematic.result.outcome === "botched_arrested" || cinematic.result.outcome === "botched_killed";
  const fizzle = c === "dud" || c === "rain";
  const blast = phase === "detonate" && !fizzle && c !== "cop_on_fender";
  const messy = cinematic.result.outcome === "messy_kill";

  const carPos = useMemo(() => {
    const toward = site.building.clone().sub(site.road).normalize();
    return site.road.clone().addScaledVector(toward, 0.55);
  }, [site]);

  const planterT =
    phase === "plant" ? local : phase === "abort" ? 1 - local * 0.6 : 1;
  const planter = carPos.clone().add(new THREE.Vector3(Math.sin(site.facing) * (1.3 - planterT * 1.1), 0, Math.cos(site.facing) * (1.3 - planterT * 1.1)));
  const markT = phase === "wait" ? local : phase === "detonate" || phase === "aftermath" ? 1 : 0;
  const mark = site.building.clone().lerp(carPos, Math.min(1, markT * 0.85));

  const flipped = blast || (phase === "aftermath" && killed);
  const lift = flipped ? Math.sin(Math.min(1, phase === "detonate" ? local : 1) * Math.PI) * 1.4 : 0;
  const cars: SedanSpec[] = [
    {
      x: carPos.x,
      z: carPos.z,
      y: lift,
      rot: site.facing,
      pitch: flipped ? local * 1.4 : 0,
      roll: flipped ? 0.4 : 0,
      color: paint(cinematic.targetFamily),
      lamps: false,
    },
  ];
  if (c === "wrong_car") {
    cars.push({
      x: carPos.x + 2.2,
      z: carPos.z + 0.4,
      y: blast ? lift * 0.5 : 0,
      rot: site.facing,
      pitch: blast ? local : 0,
      color: "#d6c9a8",
      lamps: false,
    });
  }

  useFrame(() => {
    const look = carPos.clone();
    look.y = 0.6;
    let pos: THREE.Vector3;
    if (phase === "plant" || phase === "abort") {
      pos = orbitAround(carPos, 5.5, site.facing + 0.6, 2.4);
    } else if (phase === "wait") {
      pos = orbitAround(carPos, 7 - local * 1.5, site.facing + 1.1, 3.2);
    } else {
      pos = orbitAround(carPos, 9, site.facing + 2.2, 5);
    }
    moveCam(camera, controls, pos, look, phase === "detonate" ? 0.2 : 0.08);
    if (blast) shake.current = Math.max(shake.current, messy ? 0.45 : 0.28);
  });

  const showMark = !cinematic.result.markAbsent && phase !== "plant" && c !== "cop_on_fender";
  const markPose = killed && (phase === "detonate" || phase === "aftermath") ? "down" : "walk";
  const blastAt: [number, number, number] =
    c === "wrong_car" ? [carPos.x + 2.2, 0.4, carPos.z + 0.4] : [carPos.x, 0.5, carPos.z];

  return (
    <group>
      <SedanFleet cars={cars} />
      <Goon
        position={[planter.x, 0, planter.z]}
        rot={site.facing + Math.PI}
        pose={phase === "plant" && local > 0.45 && local < 0.75 ? "crouch" : "walk"}
        moving={phase === "plant" || phase === "abort"}
        color={paint(cinematic.attackerFamily)}
      />
      {showMark && (
        <Goon
          position={[mark.x, 0, mark.z]}
          rot={site.facing + Math.PI}
          pose={markPose}
          moving={phase === "wait" && !killed}
          color={paint(cinematic.targetFamily)}
        />
      )}
      {c === "cop_on_fender" && phase !== "plant" && (
        <Goon position={[carPos.x + 0.4, 0, carPos.z + 0.7]} rot={site.facing} color="#1a2740" />
      )}
      <Explosion active={blast} at={blastAt} secondary={messy} />
      <Smoke active={(fizzle && phase === "detonate") || (killed && phase === "aftermath")} at={blastAt} loop={phase === "aftermath"} />
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
