import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { nearestRoadBlock } from "@/engine/cityLayout";
import type { HitApproach, HitCinematic, HitOutcome } from "@/types/game";
import { useGameStore } from "@/engine/store";

interface Props {
  layout: CityLayout;
  controlsRef: MutableRefObject<{ enabled?: boolean; target: THREE.Vector3; update: () => void } | null>;
}

const PHASE = {
  depart: 0.4,
  travel: 2.0,
  strike: 0.8,
  getaway: 0.6,
} as const;

const TOTAL = PHASE.depart + PHASE.travel + PHASE.strike + PHASE.getaway;

type PhaseName = "depart" | "travel" | "strike" | "getaway" | "done";

function phaseAt(t: number): PhaseName {
  if (t < PHASE.depart) return "depart";
  if (t < PHASE.depart + PHASE.travel) return "travel";
  if (t < PHASE.depart + PHASE.travel + PHASE.strike) return "strike";
  if (t < TOTAL) return "getaway";
  return "done";
}

function travelProgress(t: number): number {
  if (t <= PHASE.depart) return 0;
  if (t >= PHASE.depart + PHASE.travel) return 1;
  return (t - PHASE.depart) / PHASE.travel;
}

function failureOutcome(outcome: HitOutcome): boolean {
  return (
    outcome === "botched_wounded" ||
    outcome === "botched_arrested" ||
    outcome === "botched_killed" ||
    outcome === "target_escaped"
  );
}

function ProceduralSedan({
  groupRef,
  headlights = true,
}: {
  groupRef: React.RefObject<THREE.Group | null>;
  headlights?: boolean;
}) {
  return (
    <group ref={groupRef} visible={false}>
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[1.1, 0.35, 0.55]} />
        <meshStandardMaterial color="#1c1c1e" metalness={0.45} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.52, 0]}>
        <boxGeometry args={[0.65, 0.28, 0.5]} />
        <meshStandardMaterial color="#2a2a2e" roughness={0.5} />
      </mesh>
      {[
        [-0.35, 0.12, 0.28],
        [0.35, 0.12, 0.28],
        [-0.35, 0.12, -0.28],
        [0.35, 0.12, -0.28],
      ].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.1, 0.1, 0.08, 10]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      ))}
      {headlights && (
        <>
          <mesh position={[0.52, 0.28, 0.16]}>
            <boxGeometry args={[0.06, 0.08, 0.1]} />
            <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={2} />
          </mesh>
          <mesh position={[0.52, 0.28, -0.16]}>
            <boxGeometry args={[0.06, 0.08, 0.1]} />
            <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={2} />
          </mesh>
          <spotLight
            position={[0.7, 0.35, 0]}
            angle={0.45}
            penumbra={0.4}
            intensity={2.2}
            distance={12}
            color="#ffe9a8"
            castShadow={false}
          />
        </>
      )}
    </group>
  );
}

function buildCurve(layout: CityLayout, path: string[]): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (const tid of path) {
    const center = layout.centers.find((c) => c.territoryId === tid);
    if (!center) continue;
    const road = nearestRoadBlock(layout, center.worldX, center.worldZ);
    pts.push(new THREE.Vector3(road?.worldX ?? center.worldX, 0.15, road?.worldZ ?? center.worldZ));
  }
  if (pts.length === 1) {
    pts.push(pts[0]!.clone().add(new THREE.Vector3(2, 0, 0)));
  }
  if (pts.length === 0) {
    pts.push(new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(2, 0.15, 0));
  }
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
}

function strikeColor(approach: HitApproach): string {
  switch (approach) {
    case "car_bomb":
      return "#ff6b2d";
    case "drive_by":
      return "#ffd27a";
    case "sitdown_betrayal":
      return "#9b59b6";
    default:
      return "#ffb347";
  }
}

export default function HitCinematic({ layout, controlsRef }: Props) {
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const finishCinematic = useGameStore((s) => s.finishCinematic);
  const { camera, invalidate } = useThree();

  // Pause between multi-hit cinematics while the result card is up
  const current: HitCinematic | null =
    pendingHitResult ? null : (cinematicQueue[0] ?? null);
  const carRef = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const policeA = useRef<THREE.PointLight>(null);
  const policeB = useRef<THREE.PointLight>(null);
  const startTime = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const [phase, setPhase] = useState<PhaseName>("depart");
  const shake = useRef(0);

  const curve = useMemo(
    () => (current ? buildCurve(layout, current.path) : null),
    [current?.operationId, layout],
  );

  const targetCenter = useMemo(() => {
    if (!current) return null;
    return layout.centers.find((c) => c.territoryId === current.targetTerritoryId) ?? null;
  }, [current, layout]);

  useEffect(() => {
    startTime.current = null;
    finishedRef.current = false;
    setPhase("depart");
    shake.current = 0;
    if (controlsRef.current) controlsRef.current.enabled = !current;
    return () => {
      if (controlsRef.current) controlsRef.current.enabled = true;
    };
  }, [current?.operationId, controlsRef]);

  // Expose phase via a custom event for HitCaptions (avoids store churn every frame)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("hit-cinematic-phase", { detail: { phase, cinematic: current } }));
  }, [phase, current]);

  useFrame(({ clock }) => {
    if (!current || !curve) return;
    if (startTime.current === null) startTime.current = clock.getElapsedTime();
    const elapsed = clock.getElapsedTime() - startTime.current;
    const p = phaseAt(elapsed);
    if (p !== phase) setPhase(p);

    const tp = travelProgress(elapsed);
    const pos = curve.getPointAt(Math.min(0.999, Math.max(0, tp)));
    const tangent = curve.getTangentAt(Math.min(0.999, Math.max(0, tp)));

    if (carRef.current) {
      carRef.current.visible = p !== "done";
      carRef.current.position.copy(pos);
      const look = pos.clone().add(tangent);
      carRef.current.lookAt(look.x, pos.y, look.z);

      if (p === "getaway") {
        if (failureOutcome(current.result.outcome)) {
          // stall near target
        } else {
          const extra = ((elapsed - (PHASE.depart + PHASE.travel + PHASE.strike)) / PHASE.getaway) * 0.15;
          const escapeT = Math.min(0.999, tp + extra);
          const ep = curve.getPointAt(escapeT);
          carRef.current.position.copy(ep);
        }
      }
    }

    // Chase camera
    const camTarget = pos.clone();
    camTarget.y = 0;
    const offset = new THREE.Vector3(-tangent.x, 0, -tangent.z).normalize().multiplyScalar(14);
    offset.y = 11;
    if (p === "depart") {
      const origin = curve.getPointAt(0);
      camera.position.lerp(new THREE.Vector3(origin.x + 8, 14, origin.z + 10), 0.08);
      if (controlsRef.current) {
        controlsRef.current.target.lerp(new THREE.Vector3(origin.x, 0, origin.z), 0.08);
        controlsRef.current.update();
      }
    } else if (p === "travel" || p === "getaway") {
      camera.position.lerp(pos.clone().add(offset), 0.12);
      if (controlsRef.current) {
        controlsRef.current.target.lerp(camTarget, 0.12);
        controlsRef.current.update();
      }
    } else if (p === "strike" && targetCenter) {
      const focus = new THREE.Vector3(targetCenter.worldX, 0, targetCenter.worldZ);
      camera.position.lerp(new THREE.Vector3(focus.x + 6, 10, focus.z + 8), 0.15);
      if (controlsRef.current) {
        controlsRef.current.target.lerp(focus, 0.15);
        controlsRef.current.update();
      }
      if (current.approach === "car_bomb") {
        shake.current = 0.15;
      }
    }

    if (shake.current > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake.current;
      camera.position.z += (Math.random() - 0.5) * shake.current;
      shake.current *= 0.9;
    }

    // Strike flash
    if (flashRef.current && targetCenter) {
      flashRef.current.visible = p === "strike";
      if (p === "strike") {
        const localT = (elapsed - PHASE.depart - PHASE.travel) / PHASE.strike;
        const scale =
          current.approach === "car_bomb"
            ? 0.8 + localT * 5
            : current.approach === "drive_by"
              ? 0.3 + Math.sin(localT * 40) * 0.5 + localT
              : 0.5 + localT * 2.2;
        flashRef.current.scale.setScalar(Math.max(0.2, scale));
        const mat = flashRef.current.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 1 - localT * 1.2);
        mat.color.set(strikeColor(current.approach));
      }
    }

    // Police lights on failure getaway
    const showPolice = p === "getaway" && failureOutcome(current.result.outcome);
    if (policeA.current && policeB.current && targetCenter) {
      policeA.current.visible = showPolice;
      policeB.current.visible = showPolice;
      if (showPolice) {
        const blink = Math.sin(elapsed * 18) > 0;
        policeA.current.intensity = blink ? 4 : 0.2;
        policeB.current.intensity = blink ? 0.2 : 4;
      }
    }

    invalidate();

    if (p === "done" && !finishedRef.current) {
      finishedRef.current = true;
      if (controlsRef.current) controlsRef.current.enabled = true;
      finishCinematic();
      startTime.current = null;
    }
  });

  if (!current || !targetCenter) return null;

  return (
    <group>
      <ProceduralSedan groupRef={carRef} />
      <mesh ref={flashRef} position={[targetCenter.worldX, 0.8, targetCenter.worldZ]} visible={false}>
        <sphereGeometry args={[0.7, 12, 12]} />
        <meshBasicMaterial color="#ffb347" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      <pointLight
        ref={policeA}
        position={[targetCenter.worldX - 1.2, 2.5, targetCenter.worldZ]}
        color="#ff2222"
        intensity={0}
        distance={18}
        visible={false}
      />
      <pointLight
        ref={policeB}
        position={[targetCenter.worldX + 1.2, 2.5, targetCenter.worldZ]}
        color="#2244ff"
        intensity={0}
        distance={18}
        visible={false}
      />
    </group>
  );
}

/** Hook for UI captions to track cinematic phase without store writes. */
export function useHitCinematicPhase(): { phase: PhaseName; cinematic: HitCinematic | null } {
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const [phase, setPhase] = useState<PhaseName>("depart");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { phase: PhaseName };
      setPhase(detail.phase);
    };
    window.addEventListener("hit-cinematic-phase", handler);
    return () => window.removeEventListener("hit-cinematic-phase", handler);
  }, []);

  return {
    phase,
    cinematic: pendingHitResult ? null : (cinematicQueue[0] ?? null),
  };
}
