import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { nearestRoadBlock } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX } from "@/types/game";
import { SedanFleet } from "./Sedan";

interface Props {
  layout: CityLayout;
  controlsRef: MutableRefObject<{ enabled?: boolean; target: THREE.Vector3; update: () => void } | null>;
}

const DRIVE = { depart: 0.4, travel: 1.8, arrive: 1.2 };
const DRIVE_TOTAL = DRIVE.depart + DRIVE.travel + DRIVE.arrive;

function buildCurve(layout: CityLayout, path: string[] | null, fallback: THREE.Vector3): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (const tid of path ?? []) {
    const center = layout.centers.find((c) => c.territoryId === tid);
    if (!center) continue;
    const road = nearestRoadBlock(layout, center.worldX, center.worldZ);
    pts.push(new THREE.Vector3(road?.worldX ?? center.worldX, 0.15, road?.worldZ ?? center.worldZ));
  }
  if (pts.length === 0) pts.push(fallback.clone());
  if (pts.length === 1) pts.push(pts[0]!.clone().add(new THREE.Vector3(2, 0, 0)));
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
}

function place(group: THREE.Group | null, pos: THREE.Vector3, look: THREE.Vector3) {
  if (!group) return;
  group.visible = true;
  group.position.copy(pos);
  group.lookAt(look.x, pos.y, look.z);
}

/** Two family sedans drive to the venue, park, then leave when the table breaks. */
export default function SitdownCinematic({ layout, controlsRef }: Props) {
  const cinematic = useGameStore((s) =>
    s.sitdownPhase ? (s.sitdownCinematicQueue?.[0] ?? null) : null,
  );
  const phase = useGameStore((s) => s.sitdownPhase);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const { camera, invalidate } = useThree();
  const playerRef = useRef<THREE.Group>(null);
  const rivalRef = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const opened = useRef(false);
  const finished = useRef(false);
  const announced = useRef("");

  const venue = useMemo(() => {
    if (!cinematic) return new THREE.Vector3();
    const center = layout.centers.find((c) => c.territoryId === cinematic.venueTerritoryId);
    const road = center ? nearestRoadBlock(layout, center.worldX, center.worldZ) : null;
    return new THREE.Vector3(road?.worldX ?? center?.worldX ?? 0, 0.15, road?.worldZ ?? center?.worldZ ?? 0);
  }, [cinematic, layout]);

  const curves = useMemo(() => {
    if (!cinematic) return null;
    return {
      player: buildCurve(layout, cinematic.playerPath, venue),
      rival: buildCurve(layout, cinematic.rivalPath, venue),
    };
  }, [cinematic, layout, venue]);

  useEffect(() => {
    clock.current = 0;
    opened.current = false;
    finished.current = false;
    announced.current = "";
    // Frames can stall when the tab is in the background. The table and the
    // result card still have to arrive.
    if (phase === "drive") {
      const id = window.setTimeout(() => {
        if (opened.current) return;
        opened.current = true;
        useGameStore.getState().openSitdownTable();
      }, DRIVE_TOTAL * 1000);
      return () => window.clearTimeout(id);
    }
    if (phase === "exit") {
      const id = window.setTimeout(() => {
        if (finished.current) return;
        finished.current = true;
        useGameStore.getState().completeSitdownCinematic();
      }, 800);
      return () => window.clearTimeout(id);
    }
  }, [cinematic?.sitdownId, phase]);

  useFrame((_, dt) => {
    if (!cinematic || !phase || !curves || !playerFamily) return;
    const step = Math.min(dt, 0.05);
    const playerPark = venue.clone().add(new THREE.Vector3(-1.3, 0, 0));
    const rivalPark = venue.clone().add(new THREE.Vector3(1.3, 0, 0));

    const announce = (name: string) => {
      if (announced.current === name) return;
      announced.current = name;
      window.dispatchEvent(new CustomEvent("sitdown-cinematic-phase", { detail: { phase: name, cinematic } }));
    };

    if (phase === "table") {
      place(playerRef.current, playerPark, rivalPark);
      place(rivalRef.current, rivalPark, playerPark);
      announce("table");
      return;
    }

    if (phase === "drive") {
      clock.current += step;
      const t = clock.current;
      const travelT = DRIVE.depart + DRIVE.travel;
      const u = t <= DRIVE.depart ? 0 : t >= travelT ? 1 : (t - DRIVE.depart) / DRIVE.travel;
      const name = t < DRIVE.depart ? "depart" : t < travelT ? "travel" : "arrive";
      announce(name);
      const move = (group: THREE.Group | null, curve: THREE.CatmullRomCurve3, park: THREE.Vector3, other: THREE.Vector3, hasPath: boolean) => {
        if (!hasPath || u >= 1) {
          const k = Math.min(1, Math.max(0, (t - travelT) / DRIVE.arrive));
          const from = hasPath ? curve.getPoint(1) : park;
          place(group, from.clone().lerp(park, k), other);
          return;
        }
        const pos = curve.getPoint(u);
        const ahead = curve.getPoint(Math.min(1, u + 0.02));
        place(group, pos, ahead);
      };
      move(playerRef.current, curves.player, playerPark, rivalPark, !!cinematic.playerPath);
      move(rivalRef.current, curves.rival, rivalPark, playerPark, !!cinematic.rivalPath);
      const controls = controlsRef.current;
      const mid = playerRef.current && rivalRef.current
        ? playerRef.current.position.clone().add(rivalRef.current.position).multiplyScalar(0.5)
        : venue.clone();
      if (controls) {
        controls.target.lerp(mid, 0.12);
        camera.position.lerp(mid.clone().add(new THREE.Vector3(14, 11, 14)), 0.06);
        controls.update();
      }
      invalidate();
      if (t >= DRIVE_TOTAL && !opened.current) {
        opened.current = true;
        useGameStore.getState().openSitdownTable();
      }
      return;
    }

    if (phase === "exit") {
      clock.current += step;
      announce("exit");
      const k = Math.min(1, clock.current / 0.8);
      const violent = cinematic.outcome === "betrayed" || cinematic.outcome === "trap";
      if (!violent) {
        const playerSpeed = cinematic.outcome === "walk" ? 6 : 3;
        place(
          playerRef.current,
          playerPark.clone().add(new THREE.Vector3(-playerSpeed * k, 0, 0)),
          playerPark.clone().add(new THREE.Vector3(-8, 0, 0)),
        );
        if (cinematic.outcome !== "walk") {
          place(
            rivalRef.current,
            rivalPark.clone().add(new THREE.Vector3(3 * k, 0, 0)),
            rivalPark.clone().add(new THREE.Vector3(8, 0, 0)),
          );
        } else {
          place(rivalRef.current, rivalPark, playerPark);
        }
      }
      invalidate();
      if (k >= 1 && !finished.current) {
        finished.current = true;
        useGameStore.getState().completeSitdownCinematic();
      }
    }
  });

  if (!cinematic || !phase || !playerFamily) return null;
  const violent = cinematic.outcome === "betrayed" || cinematic.outcome === "trap";
  const lampsOn = phase === "drive";
  const windowOn = phase === "table" || (phase === "exit" && cinematic.outcome === "handshake");

  return (
    <group>
      <BossCar groupRef={playerRef} color={FAMILY_HEX[playerFamily]} lamps={lampsOn} />
      <BossCar groupRef={rivalRef} color={FAMILY_HEX[cinematic.family]} lamps={lampsOn} />
      {windowOn && (
        <mesh position={[venue.x, 2.4, venue.z]}>
          <planeGeometry args={[1.4, 0.9]} />
          <meshStandardMaterial color="#ffb060" emissive="#ff9a3c" emissiveIntensity={1.6} side={THREE.DoubleSide} />
        </mesh>
      )}
      {phase === "exit" && violent && (
        <>
          <mesh position={[venue.x, 1.2, venue.z]}>
            <sphereGeometry args={[1.6, 12, 12]} />
            <meshBasicMaterial color={cinematic.outcome === "trap" ? "#ff6b2d" : "#c9a0ff"} transparent opacity={0.45} />
          </mesh>
          <pointLight position={[venue.x + 2, 3, venue.z]} color="#3d7eff" intensity={8} distance={18} />
          <pointLight position={[venue.x - 2, 3, venue.z + 1]} color="#ff2a2a" intensity={8} distance={18} />
        </>
      )}
    </group>
  );
}

function BossCar({
  groupRef,
  color,
  lamps,
}: {
  groupRef: MutableRefObject<THREE.Group | null>;
  color: string;
  lamps: boolean;
}) {
  return (
    <group ref={groupRef} visible={false}>
      <group rotation={[0, -Math.PI / 2, 0]}>
        <SedanFleet cars={[{ x: 0, z: 0, rot: 0, color, accent: color, lamps }]} scale={0.85} castShadow />
      </group>
    </group>
  );
}
