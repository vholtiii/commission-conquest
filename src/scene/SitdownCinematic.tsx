import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { nearestRoadBlock } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type SitdownCinematic as SitdownReel } from "@/types/game";
import {
  burst,
  doorSlam,
  engine,
  footsteps,
  glass,
  murmur,
  mutedShot,
  rainBed,
  siren,
  stopAll,
  tyreSqueal,
} from "@/audio/sfx";
import { ReelSedan } from "./ReelSedan";
import Person from "./Person";
import { moveCam } from "./hits/cameraRig";
import { reelRain } from "./hits/reelLook";
import ReelAtmosphere from "./hits/props/ReelAtmosphere";
import Headlamps from "./hits/props/Headlamps";
import MuzzleFlash from "./hits/props/MuzzleFlash";
import GlassShards from "./hits/props/GlassShards";
import Smoke from "./hits/props/Smoke";
import { PoliceLights } from "./hits/props/PoliceLights";

interface Props {
  layout: CityLayout;
  controlsRef: MutableRefObject<{ enabled?: boolean; target: THREE.Vector3; update: () => void } | null>;
}

const DRIVE = { depart: 0.4, travel: 1.8, arrive: 1.2 };
const DRIVE_TOTAL = DRIVE.depart + DRIVE.travel + DRIVE.arrive;
const EXIT_TOTAL = 3.2;

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
  const aim = look.clone();
  if (aim.distanceToSquared(pos) < 0.04) aim.add(new THREE.Vector3(1, 0, 0));
  group.lookAt(aim.x, pos.y, aim.z);
}

function hide(group: THREE.Group | null) {
  if (group) group.visible = false;
}

function chase(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update: () => void } | null,
  pos: THREE.Vector3,
  ahead: THREE.Vector3,
  dt: number,
) {
  const dir = ahead.clone().sub(pos);
  if (dir.lengthSq() < 0.04) dir.set(1, 0, 0);
  dir.normalize();
  const back = pos.clone().addScaledVector(dir, -3.4);
  back.y = 1.55;
  const look = pos.clone();
  look.y = 0.55;
  moveCam(camera, controls, back, look, 0.16, dt);
}

/** The sedan's nose is +X in car space; the rig's +Z points down the road. */
const CAR_YAW = -Math.PI / 2;

/** Two families drive up, get out, and leave by how the table ended. The card stays in the UI. */
export default function SitdownCinematic({ layout, controlsRef }: Props) {
  const cinematic = useGameStore((s) =>
    s.sitdownPhase ? (s.sitdownCinematicQueue?.[0] ?? null) : null,
  );
  const phase = useGameStore((s) => s.sitdownPhase);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const { camera, invalidate } = useThree();
  const controls = useThree((s) => s.controls as unknown as { target: THREE.Vector3; update: () => void } | null);
  const playerRef = useRef<THREE.Group>(null);
  const rivalRef = useRef<THREE.Group>(null);
  const playerBoss = useRef<THREE.Group>(null);
  const playerMen = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const rivalBoss = useRef<THREE.Group>(null);
  const rivalMen = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const doorman = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const tableClock = useRef(0);
  const opened = useRef(false);
  const finished = useRef(false);
  const squealed = useRef(false);
  const lastPhase = useRef<string | null>(null);

  const venue = useMemo(() => {
    if (!cinematic) return new THREE.Vector3();
    const center = layout.centers.find((c) => c.territoryId === cinematic.venueTerritoryId);
    const x = center?.worldX ?? 0;
    const z = center?.worldZ ?? 0;
    const road = nearestRoadBlock(layout, x, z);
    return new THREE.Vector3(road?.worldX ?? x, 0, road?.worldZ ?? z);
  }, [cinematic?.sitdownId, layout]);

  const door = useMemo(() => {
    if (!cinematic) return venue.clone();
    const center = layout.centers.find((c) => c.territoryId === cinematic.venueTerritoryId);
    const toward = new THREE.Vector3((center?.worldX ?? venue.x) - venue.x, 0, (center?.worldZ ?? venue.z) - venue.z);
    if (toward.lengthSq() < 0.04) toward.set(0, 0, 1);
    return venue.clone().add(toward.normalize().multiplyScalar(2.3));
  }, [cinematic?.sitdownId, layout, venue]);

  const playerCurve = useMemo(
    () => buildCurve(layout, cinematic?.playerPath ?? null, venue),
    [layout, cinematic?.sitdownId, cinematic?.playerPath, venue],
  );
  const rivalCurve = useMemo(
    () => buildCurve(layout, cinematic?.rivalPath ?? null, venue),
    [layout, cinematic?.sitdownId, cinematic?.rivalPath, venue],
  );

  const playerPark = useMemo(() => venue.clone().add(new THREE.Vector3(1.6, 0, 0.5)), [venue]);
  const rivalPark = useMemo(() => venue.clone().add(new THREE.Vector3(-1.6, 0, -0.35)), [venue]);

  useEffect(() => {
    clock.current = 0;
    tableClock.current = 0;
    opened.current = false;
    finished.current = false;
    squealed.current = false;
    lastPhase.current = null;
  }, [cinematic?.sitdownId, phase]);

  useEffect(() => {
    const controlsNode = controlsRef.current as {
      enabled?: boolean;
      minDistance?: number;
      maxPolarAngle?: number;
      minPolarAngle?: number;
    } | null;
    const limits = controlsNode
      ? {
          minDistance: controlsNode.minDistance,
          maxPolarAngle: controlsNode.maxPolarAngle,
          minPolarAngle: controlsNode.minPolarAngle,
        }
      : null;
    if (controlsNode && cinematic) {
      controlsNode.enabled = false;
      controlsNode.minDistance = 0.4;
      controlsNode.minPolarAngle = 0.05;
      controlsNode.maxPolarAngle = Math.PI / 2.02;
    }
    return () => {
      const back = controlsRef.current as typeof controlsNode;
      if (!back) return;
      back.enabled = true;
      if (limits) {
        back.minDistance = limits.minDistance;
        back.maxPolarAngle = limits.maxPolarAngle;
        back.minPolarAngle = limits.minPolarAngle;
      }
    };
  }, [cinematic?.sitdownId, controlsRef, cinematic]);

  useEffect(() => {
    return () => stopAll();
  }, [cinematic?.sitdownId]);

  useEffect(() => {
    if (phase !== "drive" || !cinematic) return;
    const id = window.setTimeout(() => {
      if (!opened.current) useGameStore.getState().openSitdownTable();
    }, DRIVE_TOTAL * 1000 + 400);
    return () => window.clearTimeout(id);
  }, [phase, cinematic?.sitdownId]);

  useEffect(() => {
    if (phase !== "exit" || !cinematic) return;
    const id = window.setTimeout(() => {
      if (!finished.current) useGameStore.getState().completeSitdownCinematic();
    }, EXIT_TOTAL * 1000 + 200);
    return () => window.clearTimeout(id);
  }, [phase, cinematic?.sitdownId]);

  useFrame((_, dt) => {
    if (!cinematic || !phase) return;
    const step = Math.min(0.05, dt);
    const outcome = cinematic.outcome;

    if (lastPhase.current !== phase) {
      lastPhase.current = phase;
      const rain = reelRain(useGameStore.getState().date.month);
      window.dispatchEvent(new CustomEvent("sitdown-cinematic-phase", { detail: { phase } }));
      if (phase === "drive") {
        rainBed(DRIVE_TOTAL + 40, rain);
        engine(2.2);
      }
      if (phase === "table") murmur(40);
      if (phase === "exit") {
        stopAll();
        rainBed(EXIT_TOTAL, rain);
        doorSlam();
        footsteps(5, 0.32);
        if (outcome === "betrayed") {
          mutedShot();
          window.setTimeout(() => mutedShot(), 340);
          glass();
        }
        if (outcome === "trap") {
          burst(4, 0.1);
          siren(2.2);
        }
      }
    }

    const playerHasPath = (cinematic.playerPath?.length ?? 0) > 1;
    const rivalHasPath = (cinematic.rivalPath?.length ?? 0) > 1;

    if (phase === "drive") {
      clock.current += step;
      const t = clock.current;
      const travelT = DRIVE.depart + DRIVE.travel;
      const u = t < DRIVE.depart ? 0 : t < travelT ? (t - DRIVE.depart) / DRIVE.travel : 1;
      const arriveK = t < travelT ? 0 : Math.min(1, (t - travelT) / DRIVE.arrive);
      // Off the route and into the space: a braking curve, not a jump cut.
      const park = 1 - (1 - arriveK) * (1 - arriveK);
      const ride = Math.min(0.92, u * 0.92);
      const playerAt = playerHasPath ? playerCurve.getPointAt(ride) : playerPark.clone();
      const rivalAt = rivalHasPath ? rivalCurve.getPointAt(ride) : rivalPark.clone();
      const playerAhead = playerHasPath ? playerCurve.getPointAt(Math.min(1, ride + 0.08)) : door;
      const rivalAhead = rivalHasPath ? rivalCurve.getPointAt(Math.min(1, ride + 0.08)) : door;
      const parkedPlayer = u >= 1 ? playerAt.lerp(playerPark, park) : playerAt;
      const parkedRival = u >= 1 ? rivalAt.lerp(rivalPark, park) : rivalAt;
      place(playerRef.current, parkedPlayer, u >= 1 ? playerAhead.clone().lerp(door, park) : playerAhead);
      place(rivalRef.current, parkedRival, u >= 1 ? rivalAhead.clone().lerp(door, park) : rivalAhead);

      stageParty(arriveK, 0, outcome, false);
      if (u < 0.4 && playerHasPath) chase(camera, controls, parkedPlayer, playerCurve.getPointAt(Math.min(1, ride + 0.12)), step);
      else if (u < 0.68 && rivalHasPath) chase(camera, controls, parkedRival, rivalCurve.getPointAt(Math.min(1, ride + 0.12)), step);
      else {
        const eye = venue.clone().add(new THREE.Vector3(6.2, 3.1, 6.2));
        moveCam(camera, controls, eye, door, 0.12, step);
      }

      if (t >= DRIVE_TOTAL && !opened.current) {
        opened.current = true;
        doorSlam();
        footsteps(6, 0.36);
        useGameStore.getState().openSitdownTable();
      }
    }

    if (phase === "table") {
      tableClock.current += step;
      place(playerRef.current, playerPark, door);
      place(rivalRef.current, rivalPark, door);
      stageParty(1, 0, outcome, true);
      const dist = 8.2 - Math.min(2.2, tableClock.current * 0.12);
      const eye = venue.clone().add(new THREE.Vector3(dist * 0.72, 2.5, dist * 0.72));
      moveCam(camera, controls, eye, door, 0.06, step);
    }

    if (phase === "exit") {
      clock.current += step;
      const k = Math.min(1, clock.current / EXIT_TOTAL);
      const violent = outcome === "betrayed" || outcome === "trap";
      const leave = outcome === "handshake" ? Math.max(0, (k - 0.5) / 0.5) : violent ? 0 : k;
      // Pulls away from a stop: slow first, then gone.
      const go = leave * leave;
      const playerOff = playerPark.clone().add(new THREE.Vector3(-7.5 * go, 0, 0.4 * go));
      const rivalOff = rivalPark.clone().add(new THREE.Vector3(7.5 * go, 0, -0.3 * go));
      place(playerRef.current, playerOff, playerOff.clone().add(new THREE.Vector3(-1, 0, 0)));
      place(rivalRef.current, outcome === "handshake" ? rivalOff : rivalPark, door);
      stageParty(1, k, outcome, false);
      if ((outcome === "walk" || outcome === "handshake" || outcome === "aborted") && k > 0.45 && !squealed.current) {
        squealed.current = true;
        tyreSqueal();
        engine(1.6);
      }
      const eye = venue.clone().add(new THREE.Vector3(6.4 - k, 2.8, 6.4));
      moveCam(camera, controls, eye, door, 0.1, step);
      if (k >= 1 && !finished.current) {
        finished.current = true;
        useGameStore.getState().completeSitdownCinematic();
      }
    }
    invalidate();
  });

  function stageParty(arriveK: number, exitK: number, outcome: SitdownReel["outcome"], inside: boolean) {
    const violent = outcome === "betrayed" || outcome === "trap";
    const show = arriveK > 0.04;
    const side = new THREE.Vector3(0.7, 0, 0.15);

    const playerBossAt = playerPark.clone().lerp(door, inside ? 1 : phase === "exit" ? exitBoss(exitK, outcome, true) : arriveK);
    const rivalBossAt = rivalPark.clone().lerp(door, inside ? 1 : phase === "exit" ? exitBoss(exitK, outcome, false) : arriveK);
    if (!show || inside || (phase === "exit" && violent)) {
      hide(playerBoss.current);
      hide(rivalBoss.current);
    } else if (phase === "exit" && (outcome === "walk" || outcome === "aborted") && exitK > 0.55) {
      hide(playerBoss.current);
      place(rivalBoss.current, rivalBossAt, door);
    } else if (phase === "exit" && outcome === "handshake" && exitK > 0.55) {
      hide(playerBoss.current);
      hide(rivalBoss.current);
    } else {
      place(playerBoss.current, playerBossAt, outcome === "handshake" && phase === "exit" ? rivalBossAt : door);
      place(rivalBoss.current, rivalBossAt, outcome === "handshake" && phase === "exit" ? playerBossAt : door);
    }

    playerMen.forEach((ref, i) => {
      const home = playerPark.clone().addScaledVector(side, i === 0 ? 1 : -0.6);
      const at = violent && phase === "exit" ? home.clone().add(new THREE.Vector3(-4 * exitK, 0, 1.2 * exitK)) : home;
      if (!show) hide(ref.current);
      else place(ref.current, at, door);
    });
    rivalMen.forEach((ref, i) => {
      const home = rivalPark.clone().addScaledVector(side, i === 0 ? -1 : 0.55);
      const run = violent && phase === "exit" && outcome === "trap";
      const at = run ? home.clone().add(new THREE.Vector3(4 * exitK, 0, -1.2 * exitK)) : home;
      if (!show) hide(ref.current);
      else if (violent && phase === "exit" && outcome === "betrayed" && exitK > 0.15) hide(ref.current);
      else place(ref.current, at, door);
    });

    if (show) place(doorman.current, door.clone().add(new THREE.Vector3(0.55, 0, 0.15)), venue);
    else hide(doorman.current);
  }

  if (!cinematic || !phase) return null;
  const playerColor = FAMILY_HEX[playerFamily] ?? "#1c1c1e";
  const rivalColor = FAMILY_HEX[cinematic.family] ?? "#3a2a22";
  const violent = cinematic.outcome === "betrayed" || cinematic.outcome === "trap";
  const lampsOn = phase === "drive";
  const glow = violent && phase === "exit" ? 0.05 : phase === "drive" ? 0.35 : 0.9;
  const facing = Math.atan2(door.x - venue.x, door.z - venue.z);

  return (
    <group>
      <ReelAtmosphere center={venue} facing={facing} amount={reelRain(useGameStore.getState().date.month)} />
      <group ref={playerRef}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: CAR_YAW, color: playerColor, lamps: lampsOn }]} />
        {lampsOn && <Headlamps cars={[{ x: 0, z: 0, rot: CAR_YAW }]} />}
      </group>
      <group ref={rivalRef}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: CAR_YAW, color: rivalColor, lamps: lampsOn }]} />
        {lampsOn && <Headlamps cars={[{ x: 0, z: 0, rot: CAR_YAW }]} />}
      </group>
      <mesh position={[door.x, 2.15, door.z]}>
        <boxGeometry args={[1.5, 1.05, 0.12]} />
        <meshStandardMaterial color="#c9a06a" emissive="#e0b070" emissiveIntensity={glow} roughness={0.35} />
      </mesh>
      <pointLight position={[door.x, 1.4, door.z]} color="#ffb060" intensity={glow * 2.6} distance={7} />
      <group ref={playerBoss}>
        <Person position={[0, 0, 0]} role="boss" color={playerColor} pose={phase === "exit" && cinematic.outcome === "walk" ? "run" : "walk"} moving={phase !== "table"} />
      </group>
      {playerMen.map((ref, i) => (
        <group key={`p${i}`} ref={ref}>
          <Person position={[0, 0, 0]} role="soldier" gun={violent && phase === "exit"} color={playerColor} pose={violent && phase === "exit" ? "run" : "stand"} moving={violent && phase === "exit"} />
        </group>
      ))}
      <group ref={rivalBoss}>
        <Person position={[0, 0, 0]} role="boss" color={rivalColor} pose="walk" moving={phase === "drive" || (phase === "exit" && cinematic.outcome === "handshake")} />
      </group>
      {rivalMen.map((ref, i) => (
        <group key={`r${i}`} ref={ref}>
          <Person position={[0, 0, 0]} role="soldier" gun={violent && phase === "exit"} color={rivalColor} pose={cinematic.outcome === "trap" && phase === "exit" ? "run" : "stand"} moving={cinematic.outcome === "trap" && phase === "exit"} />
        </group>
      ))}
      <group ref={doorman}>
        <Person position={[0, 0, 0]} role="associate" color="#2a2420" pose="stand" />
      </group>
      <MuzzleFlash
        active={violent && phase === "exit"}
        from={[door.x, 1.5, door.z]}
        to={[venue.x, 1.2, venue.z]}
        shots={cinematic.outcome === "trap" ? 4 : 2}
      />
      <GlassShards active={violent && phase === "exit"} at={[door.x, 1.6, door.z]} />
      <Smoke
        active={phase === "exit" && (cinematic.outcome === "walk" || cinematic.outcome === "handshake" || cinematic.outcome === "aborted")}
        at={[playerPark.x, 0.2, playerPark.z]}
        loop
        size={0.7}
      />
      <PoliceLights active={cinematic.outcome === "trap" && phase === "exit"} at={[venue.x + 2.2, 0.4, venue.z]} />
    </group>
  );
}

function exitBoss(k: number, outcome: SitdownReel["outcome"], player: boolean): number {
  if (outcome === "handshake") return 1 - Math.min(1, k / 0.5) * 0.6;
  if ((outcome === "walk" || outcome === "aborted") && player) return 1 - Math.min(1, k / 0.45);
  return 1;
}
