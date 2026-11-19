import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { BLOCK_SIZE, ROAD_GAP, nearestRoadBlock } from "@/engine/cityLayout";
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
import Person, { type PersonPose } from "./Person";
import { ease, facingOf, FOV, spaceFor, trackShot, twoShot, type Shot } from "./hits/cameraRig";
import { playShots, type DirectedShot } from "./hits/director";
import { SITDOWN } from "./hits/shotlists";
import { publishReel, ReelScope, readReel, useInReel } from "./hits/reelClock";
import { useReelCamera } from "./hits/useReelCamera";
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

const DRIVE = { depart: 0.55, travel: 2.8, arrive: 4.2 };
const DRIVE_TOTAL = DRIVE.depart + DRIVE.travel + DRIVE.arrive;
const EXIT_TOTAL = 6.4;
/** Road centre to the front wall: one cell pitch less half the standard footprint. */
const FACE = BLOCK_SIZE + ROAD_GAP - BLOCK_SIZE * 0.43 - 0.02;
/** Seconds the table holds one angle before cutting to the next. */
const TABLE_SHOT = 7.5;
const WINDOW = { w: 1.05, h: 0.62, y: 0.76 };

/** The sedan's nose is +X in car space; the rig's +Z points down the road. */
const CAR_YAW = -Math.PI / 2;

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

const placeAim = new THREE.Vector3();

function place(group: THREE.Object3D | null, pos: THREE.Vector3, look: THREE.Vector3) {
  if (!group) return;
  group.visible = true;
  group.position.copy(pos);
  placeAim.copy(look);
  if (placeAim.distanceToSquared(pos) < 0.0004) return;
  group.lookAt(placeAim.x, pos.y, placeAim.z);
}

function blockSig(b: Blocking): string {
  const cast = CAST.map((w) => {
    const a = b.cast[w];
    return `${a.show ? 1 : 0}${a.pose}${a.moving ? 1 : 0}${a.gun ? 1 : 0}${a.firing ? 1 : 0}${a.look ?? "-"}${a.smoking ? 1 : 0}`;
  }).join("|");
  return `${cast}|${b.silhouettes ? 1 : 0}|${b.insideDown ? 1 : 0}|${b.doorFlash ? 1 : 0}|${b.go[0] > 0 ? 1 : 0}`;
}

/** Gunfire holds the clock so the burst reads, about four fifths of a second on screen. */
function exitScale(outcome: SitdownReel["outcome"], k: number): number {
  if (outcome !== "betrayed" && outcome !== "trap") return 1;
  const at = outcome === "betrayed" ? 0.16 : 0.1;
  const d = Math.abs(k - at);
  if (d < 0.02) return 0.3;
  if (d < 0.055) return 0.3 + ((d - 0.02) / 0.035) * 0.7;
  return 1;
}

function hide(group: THREE.Object3D | null) {
  if (group) group.visible = false;
}

function span(k: number, a: number, b: number): number {
  return Math.min(1, Math.max(0, (k - a) / (b - a)));
}

function bezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  return out
    .copy(a)
    .multiplyScalar(u * u)
    .addScaledVector(b, 2 * u * t)
    .addScaledVector(c, t * t);
}

interface Venue {
  venue: THREE.Vector3;
  /** Road to building, snapped to the grid. */
  toward: THREE.Vector3;
  /** Down the kerb; both cars point this way. */
  along: THREE.Vector3;
  door: THREE.Vector3;
  porch: THREE.Vector3;
  window: THREE.Vector3;
  faceYaw: number;
  park: [THREE.Vector3, THREE.Vector3];
  entry: [THREE.Vector3, THREE.Vector3];
  carDoor: [THREE.Vector3, THREE.Vector3];
  spot: [THREE.Vector3, THREE.Vector3];
  posts: [[THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3]];
  backDoor: [[THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3]];
  doorman: THREE.Vector3;
}

function venueFor(layout: CityLayout, territoryId: string | undefined): Venue {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const cx = center?.worldX ?? 0;
  const cz = center?.worldZ ?? 0;
  const road = nearestRoadBlock(layout, cx, cz);
  const venue = new THREE.Vector3(road?.worldX ?? cx, 0, road?.worldZ ?? cz);
  const raw = new THREE.Vector3(cx - venue.x, 0, cz - venue.z);
  const toward =
    Math.abs(raw.x) >= Math.abs(raw.z)
      ? new THREE.Vector3(Math.sign(raw.x) || 1, 0, 0)
      : new THREE.Vector3(0, 0, Math.sign(raw.z) || 1);
  const along = new THREE.Vector3(-toward.z, 0, toward.x);
  const at = (t: number, a: number, base = venue) => base.clone().addScaledVector(toward, t).addScaledVector(along, a);

  const door = at(FACE, 0);
  const porch = at(FACE - 0.5, 0);
  const park: [THREE.Vector3, THREE.Vector3] = [at(0.5, 1.9), at(0.5, -1.9)];
  const carDoor: [THREE.Vector3, THREE.Vector3] = [at(0.55, 0.15, park[0]), at(0.55, 0.15, park[1])];
  return {
    venue,
    toward,
    along,
    door,
    porch,
    window: at(FACE + 0.01, -1.25),
    faceYaw: Math.atan2(-toward.x, -toward.z),
    park,
    entry: [at(-0.7, -2.4, park[0]), at(-0.7, -2.4, park[1])],
    carDoor,
    spot: [at(0, 0.42, porch), at(0, -0.42, porch)],
    posts: [
      [at(1.12, 0.6, park[0]), at(1.12, -0.55, park[0])],
      [at(1.12, 0.6, park[1]), at(1.12, -0.55, park[1])],
    ],
    backDoor: [
      [at(0.55, -0.55, park[0]), at(0.6, -0.75, park[0])],
      [at(0.55, -0.55, park[1]), at(0.6, -0.75, park[1])],
    ],
    doorman: at(FACE - 0.2, 0.68),
  };
}

type Who = "pb" | "rb" | "pm0" | "pm1" | "rm0" | "rm1" | "doorman";
const CAST: Who[] = ["pb", "rb", "pm0", "pm1", "rm0", "rm1", "doorman"];
type Target = Who | "door" | "playerCar" | null;

interface Act {
  show: boolean;
  at: THREE.Vector3;
  face: THREE.Vector3;
  pose: PersonPose;
  moving?: boolean;
  gun?: boolean;
  firing?: boolean;
  look?: Target;
  smoking?: boolean;
}

interface Blocking {
  cast: Record<Who, Act>;
  doorOpen: number;
  /** How far each car has pulled away, 0–1. */
  go: [number, number];
  silhouettes: boolean;
  insideDown: boolean;
  windowFlash: boolean;
  doorFlash: boolean;
}

type Beat = "drive" | "table" | "exit";

/**
 * Who stands where and doing what at `k` through a beat. Used every frame for
 * positions, and on a coarse tick for poses, so both always agree.
 */
function direct(beat: Beat, k: number, outcome: SitdownReel["outcome"], v: Venue): Blocking {
  const street = (p: THREE.Vector3) => p.clone().addScaledVector(v.toward, -3);
  const walk = (from: THREE.Vector3, to: THREE.Vector3, t: number): Act => ({
    show: true,
    at: from.clone().lerp(to, ease(t)),
    face: to.clone().addScaledVector(to.clone().sub(from), 0.5),
    pose: "walk",
    moving: t > 0 && t < 1,
  });
  const stand = (at: THREE.Vector3, face: THREE.Vector3, extra?: Partial<Act>): Act => ({
    show: true,
    at: at.clone(),
    face,
    pose: "stand",
    ...extra,
  });
  const gone = (): Act => ({ show: false, at: v.door.clone(), face: v.venue.clone(), pose: "stand" });
  const getIn = (at: THREE.Vector3, car: THREE.Vector3): Act => ({ show: true, at: at.clone(), face: car.clone(), pose: "getIn" });

  const cast = {} as Record<Who, Act>;
  const out: Blocking = {
    cast,
    doorOpen: 0,
    go: [0, 0],
    silhouettes: false,
    insideDown: false,
    windowFlash: false,
    doorFlash: false,
  };
  cast.doorman = stand(v.doorman, street(v.doorman));

  if (beat === "drive") {
    ([0, 1] as const).forEach((i) => {
      const boss: Who = i === 0 ? "pb" : "rb";
      const other: Who = i === 0 ? "rb" : "pb";
      if (k < 0.35) cast[boss] = gone();
      else if (k < 0.5) cast[boss] = getIn(v.carDoor[i], v.park[i]);
      else if (k < 0.85) cast[boss] = walk(v.carDoor[i], v.spot[i], span(k, 0.5, 0.85));
      else cast[boss] = stand(v.spot[i], v.spot[1 - i]!, { pose: "talk", look: other });
      ([0, 1] as const).forEach((j) => {
        const man: Who = `${i === 0 ? "p" : "r"}m${j}` as Who;
        if (k < 0.38) cast[man] = gone();
        else if (k < 0.5) cast[man] = getIn(v.backDoor[i][j], v.park[i]);
        else if (k < 0.72) cast[man] = walk(v.backDoor[i][j], v.posts[i][j], span(k, 0.5, 0.72));
        else cast[man] = stand(v.posts[i][j], street(v.posts[i][j]), { look: boss });
      });
    });
    cast.doorman.look = k > 0.5 ? "pb" : null;
    out.doorOpen = span(k, 0.72, 0.86);
    return out;
  }

  const posted = (i: 0 | 1, j: 0 | 1, extra?: Partial<Act>): Act =>
    stand(v.posts[i][j], street(v.posts[i][j]), extra);
  cast.pm0 = posted(0, 0, { smoking: beat === "table" });
  cast.pm1 = posted(0, 1);
  cast.rm0 = posted(1, 0);
  cast.rm1 = posted(1, 1, { smoking: beat === "table" });
  cast.pb = gone();
  cast.rb = gone();

  if (beat === "table") {
    out.silhouettes = true;
    return out;
  }

  out.doorOpen = span(k, 0, 0.1);
  const intoCar = (i: 0 | 1, from: THREE.Vector3, t0: number, t1: number, t2: number): Act =>
    k < t0 ? gone() : k < t1 ? walk(from, v.carDoor[i], span(k, t0, t1)) : k < t2 ? getIn(v.carDoor[i], v.park[i]) : gone();
  const escortsIn = (i: 0 | 1, t0: number, t1: number, t2: number) => {
    ([0, 1] as const).forEach((j) => {
      const man: Who = `${i === 0 ? "p" : "r"}m${j}` as Who;
      if (k < t0) return;
      cast[man] =
        k < t1
          ? walk(v.posts[i][j], v.backDoor[i][j], span(k, t0, t1))
          : k < t2
            ? getIn(v.backDoor[i][j], v.park[i])
            : gone();
    });
  };

  if (outcome === "handshake") {
    ([0, 1] as const).forEach((i) => {
      const boss: Who = i === 0 ? "pb" : "rb";
      const other: Who = i === 0 ? "rb" : "pb";
      if (k < 0.06) cast[boss] = gone();
      else if (k < 0.22) cast[boss] = walk(v.door, v.spot[i], span(k, 0.06, 0.22));
      else if (k < 0.45) cast[boss] = stand(v.spot[i], v.spot[1 - i]!, { pose: "handshake", look: other });
      else cast[boss] = intoCar(i, v.spot[i], 0.45, 0.7, 0.78);
      escortsIn(i, 0.45, 0.68, 0.76);
    });
    out.go = [span(k, 0.78, 1), span(k, 0.84, 1)];
  } else if (outcome === "walk" || outcome === "aborted") {
    cast.pb = intoCar(0, v.door, 0.05, 0.35, 0.43);
    escortsIn(0, 0.1, 0.33, 0.41);
    cast.rm0.look = "pb";
    cast.rm1.look = "pb";
    cast.doorman.look = "pb";
    out.go = [span(k, 0.43, 1), 0];
  } else if (outcome === "betrayed") {
    out.silhouettes = true;
    out.insideDown = k > 0.08;
    out.windowFlash = k < 0.2;
    const guns = k > 0.12 && k < 0.42;
    cast.pm0 = k < 0.38 ? posted(0, 0, { pose: k > 0.12 ? "aim" : "stand", gun: k > 0.12, firing: guns, look: "door" }) : posted(0, 0, { pose: "down" });
    cast.pm1 =
      k < 0.4
        ? posted(0, 1, { pose: k > 0.12 ? "aim" : "stand", gun: k > 0.12, firing: guns, look: "door" })
        : k < 0.6
          ? { ...walk(v.posts[0][1], v.carDoor[0], span(k, 0.4, 0.6)), pose: "run", gun: true }
          : k < 0.66
            ? getIn(v.carDoor[0], v.park[0])
            : gone();
    const back = k > 0.15 && k < 0.5;
    cast.rm0 = posted(1, 0, { pose: back ? "aim" : "stand", gun: k > 0.15, firing: back, look: k < 0.5 ? "pm0" : "playerCar" });
    cast.rm1 = posted(1, 1, { pose: back ? "aim" : "stand", gun: k > 0.15, firing: back, look: k < 0.5 ? "pm1" : "playerCar" });
    cast.rb = k < 0.55 ? gone() : k < 0.75 ? walk(v.door, v.spot[1], span(k, 0.55, 0.75)) : stand(v.spot[1], v.park[0], { look: "playerCar" });
    cast.doorman = gone();
    out.go = [span(k, 0.66, 1), 0];
  } else {
    // A trap: guns from the door, the boss runs for his car, the other side scatters.
    out.doorFlash = k > 0.05 && k < 0.4;
    cast.pb =
      k < 0.05
        ? gone()
        : k < 0.4
          ? { ...walk(v.door, v.carDoor[0], span(k, 0.05, 0.4)), pose: "run" }
          : k < 0.47
            ? getIn(v.carDoor[0], v.park[0])
            : gone();
    ([0, 1] as const).forEach((j) => {
      const man: Who = `pm${j}` as Who;
      cast[man] =
        k < 0.38
          ? posted(0, j, { pose: k > 0.08 ? "aim" : "stand", gun: true, firing: k > 0.08, look: "door" })
          : k < 0.45
            ? { ...walk(v.posts[0][j], v.backDoor[0][j], span(k, 0.38, 0.45)), pose: "run", gun: true }
            : gone();
      const rival: Who = `rm${j}` as Who;
      const flee = v.posts[1][j].clone().addScaledVector(v.along, -6).addScaledVector(v.toward, -0.4 * j);
      cast[rival] = k < 0.1 ? posted(1, j) : { ...walk(v.posts[1][j], flee, span(k, 0.1, 1)), pose: "run" };
    });
    cast.doorman = gone();
    out.go = [span(k, 0.47, 1), 0];
  }
  return out;
}

/** When the tyres bite on the way out. */
function squealAt(outcome: SitdownReel["outcome"]): number {
  if (outcome === "handshake") return 0.78;
  if (outcome === "betrayed") return 0.66;
  if (outcome === "trap") return 0.47;
  return 0.43;
}

/** A lit cigarette at the mouth that draws brighter every few seconds. */
function Ember({ seed }: { seed: number }) {
  const low = useGameStore((s) => s.settings.graphics === "low");
  const inReel = useInReel();
  const light = useRef<THREE.PointLight>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const t = inReel ? (readReel()?.time ?? clock.elapsedTime) : clock.elapsedTime;
    const draw = Math.pow(Math.max(0, Math.sin(t * 0.6 + seed)), 10);
    const f = 0.6 + 0.2 * Math.sin(t * 13 + seed * 3) + draw * 1.4;
    if (light.current) light.current.intensity = f * 0.4;
    if (mat.current) mat.current.color.setRGB(1.4 * f, (0.32 + draw * 0.25) * f, 0.06);
  });
  return (
    <group position={[0.03, 0.955, 0.125]}>
      <mesh position={[0, 0, -0.022]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.005, 0.005, 0.045, 5]} />
        <meshBasicMaterial color="#e8e2d4" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.008, 6, 5]} />
        <meshBasicMaterial ref={mat} color="#ff6a1a" toneMapped={false} />
      </mesh>
      {!low && <pointLight ref={light} color="#ff7a2a" distance={1.1} intensity={0.3} decay={2} />}
    </group>
  );
}

/** Everything under it drawn flat black, cut to the window so nothing hangs below the sill. */
function Silhouette({ material, children }: { material: THREE.Material; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    g.current?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = material;
      m.castShadow = false;
    });
  });
  return <group ref={g}>{children}</group>;
}

/** Two families drive up, get out, and leave by how the table ended. The card stays in the UI. */
export default function SitdownCinematic({ layout, controlsRef }: Props) {
  const cinematic = useGameStore((s) =>
    s.sitdownPhase ? (s.sitdownCinematicQueue?.[0] ?? null) : null,
  );
  const phase = useGameStore((s) => s.sitdownPhase);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const { gl, invalidate } = useThree();
  const cam = useReelCamera(
    useMemo(() => spaceFor(layout, useGameStore.getState().territories), [layout, cinematic?.sitdownId]),
    cinematic?.sitdownId ?? "",
  );
  const playerRef = useRef<THREE.Group>(null);
  const rivalRef = useRef<THREE.Group>(null);
  const refs = {
    pb: useRef<THREE.Group>(null),
    rb: useRef<THREE.Group>(null),
    pm0: useRef<THREE.Group>(null),
    pm1: useRef<THREE.Group>(null),
    rm0: useRef<THREE.Group>(null),
    rm1: useRef<THREE.Group>(null),
    doorman: useRef<THREE.Group>(null),
  } satisfies Record<Who, MutableRefObject<THREE.Group | null>>;
  const muzzles = {
    pm0: useRef<THREE.Object3D>(null),
    pm1: useRef<THREE.Object3D>(null),
    rm0: useRef<THREE.Object3D>(null),
    rm1: useRef<THREE.Object3D>(null),
  };
  const doorLeaf = useRef<THREE.Group>(null);
  const windowGlow = useRef<THREE.MeshStandardMaterial>(null);
  const windowLight = useRef<THREE.PointLight>(null);
  const clock = useRef(0);
  const tableClock = useRef(0);
  const opened = useRef(false);
  const finished = useRef(false);
  const squealed = useRef(false);
  const lastPhase = useRef<string | null>(null);
  const animTime = useRef(0);
  const shown = useRef<{ sig: string; block: Blocking; lamps: boolean } | null>(null);
  const [rev, setRev] = useState(0);
  const scratch = useMemo(
    () => ({
      playerAt: new THREE.Vector3(),
      rivalAt: new THREE.Vector3(),
      next: new THREE.Vector3(),
      aim: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      doorPos: new THREE.Vector3(),
      doorLook: new THREE.Vector3(),
    }),
    [],
  );

  const v = useMemo(() => venueFor(layout, cinematic?.venueTerritoryId), [cinematic?.sitdownId, layout]);
  const heads = useMemo(() => {
    const m = {} as Record<Who | "door" | "playerCar", THREE.Vector3>;
    for (const w of CAST) m[w] = new THREE.Vector3();
    m.door = v.door.clone().setY(0.9);
    m.playerCar = v.park[0].clone().setY(0.5);
    return m;
  }, [v]);

  const playerCurve = useMemo(
    () => buildCurve(layout, cinematic?.playerPath ?? null, v.park[0]),
    [layout, cinematic?.sitdownId, cinematic?.playerPath, v],
  );
  const rivalCurve = useMemo(
    () => buildCurve(layout, cinematic?.rivalPath ?? null, v.park[1]),
    [layout, cinematic?.sitdownId, cinematic?.rivalPath, v],
  );

  const shadowMat = useMemo(() => {
    const top = v.window.y + WINDOW.y + WINDOW.h / 2;
    const bottom = v.window.y + WINDOW.y - WINDOW.h / 2;
    return new THREE.MeshBasicMaterial({
      color: "#07060a",
      clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottom), new THREE.Plane(new THREE.Vector3(0, -1, 0), top)],
    });
  }, [v]);

  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);

  useEffect(() => () => shadowMat.dispose(), [shadowMat]);

  useEffect(() => {
    clock.current = 0;
    tableClock.current = 0;
    opened.current = false;
    finished.current = false;
    squealed.current = false;
    lastPhase.current = null;
    animTime.current = 0;
    shown.current = null;
    publishReel(null);
    setRev(0);
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
    }, EXIT_TOTAL * 1600 + 400);
    return () => window.clearTimeout(id);
  }, [phase, cinematic?.sitdownId]);

  /** Which side of the line from `a` to `b` is the street. */
  const streetSide = (a: THREE.Vector3, b: THREE.Vector3): number => {
    const d = b.clone().sub(a);
    return -d.z * v.toward.x + d.x * v.toward.z > 0 ? -1 : 1;
  };

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

    const nose = v.along;
    const heading = facingOf(nose);
    const playerAt = scratch.playerAt;
    const rivalAt = scratch.rivalAt;
    let beatK = 0;
    let driveU = 1;
    let scale = 1;

    if (phase === "drive") {
      clock.current += step;
      const t = clock.current;
      const travelT = DRIVE.depart + DRIVE.travel;
      driveU = t < DRIVE.depart ? 0 : t < travelT ? (t - DRIVE.depart) / DRIVE.travel : 1;
      beatK = t < travelT ? 0 : Math.min(1, (t - travelT) / DRIVE.arrive);
      const ride = Math.min(0.92, driveU * 0.92);
      const s = 1 - Math.pow(1 - span(beatK, 0, 0.35), 2);
      const curves = [playerCurve, rivalCurve];
      const paths = [(cinematic.playerPath?.length ?? 0) > 1, (cinematic.rivalPath?.length ?? 0) > 1];
      [playerAt, rivalAt].forEach((at, i) => {
        const curve = curves[i]!;
        const end = scratch.next;
        if (paths[i]) curve.getPointAt(0.92, end);
        else end.copy(v.park[i]!).addScaledVector(nose, -7);
        const group = i === 0 ? playerRef.current : rivalRef.current;
        if (driveU < 1) {
          if (paths[i]) curve.getPointAt(ride, at);
          else at.copy(end);
          if (paths[i]) curve.getPointAt(Math.min(1, ride + 0.08), scratch.aim);
          else scratch.aim.copy(v.park[i]!);
          place(group, at, scratch.aim);
        } else {
          // Off the route and in against the kerb, braking the whole way.
          bezier(end, v.entry[i]!, v.park[i]!, s, at);
          if (s >= 0.99) scratch.aim.copy(at).add(nose);
          else bezier(end, v.entry[i]!, v.park[i]!, Math.min(1, s + 0.02), scratch.aim).multiplyScalar(2).sub(at);
          place(group, at, scratch.aim);
        }
      });
      if (t >= DRIVE_TOTAL && !opened.current) {
        opened.current = true;
        doorSlam();
        footsteps(6, 0.36);
        useGameStore.getState().openSitdownTable();
      }
    } else if (phase === "table") {
      tableClock.current += step;
      playerAt.copy(v.park[0]);
      rivalAt.copy(v.park[1]);
    } else {
      scale = exitScale(outcome, Math.min(1, clock.current / EXIT_TOTAL));
      clock.current += step * scale;
      beatK = Math.min(1, clock.current / EXIT_TOTAL);
    }
    animTime.current += step * scale;
    publishReel({
      time: animTime.current,
      dt: step * scale,
      scale,
      phase,
      local: beatK,
      progress: beatK,
    });

    const beat: Beat = phase === "drive" ? "drive" : phase === "table" ? "table" : "exit";
    const b = direct(beat, beatK, outcome, v);

    if (phase !== "drive") {
      [playerAt, rivalAt].forEach((at, i) => {
        const go = b.go[i]!;
        at.copy(v.park[i]!).addScaledVector(nose, 9 * go * go);
        place(i === 0 ? playerRef.current : rivalRef.current, at, scratch.aim.copy(at).add(nose));
      });
    }
    heads.playerCar.copy(playerAt).setY(0.5);

    for (const w of CAST) {
      const act = b.cast[w];
      if (act.show) place(refs[w].current, act.at, act.face);
      else hide(refs[w].current);
      heads[w].copy(act.at).setY(act.pose === "down" ? 0.15 : 0.92);
    }
    if (doorLeaf.current) doorLeaf.current.rotation.y = 1.35 * ease(b.doorOpen);

    const violent = outcome === "betrayed" || outcome === "trap";
    const glow = violent && phase === "exit" ? Math.max(0.12, 1 - beatK * 3) : phase === "drive" ? 0.6 : 0.95;
    const flash = b.windowFlash ? (Math.sin(clock.current * 70) > 0.2 ? 4 : 0.6) : 0;
    if (windowGlow.current) windowGlow.current.emissiveIntensity = glow * 1.5 + flash;
    if (windowLight.current) windowLight.current.intensity = glow * 1.6 + flash * 1.5;

    const lampsNow = phase === "drive" || (phase === "exit" && beatK > 0.13);
    const sig = `${phase}|${lampsNow ? 1 : 0}|${blockSig(b)}`;
    if (!shown.current || shown.current.sig !== sig) {
      shown.current = { sig, block: b, lamps: lampsNow };
      setRev((n) => n + 1);
    }

    // Camera.
    const pb = b.cast.pb.at;
    const rb = b.cast.rb.at;
    // The cars park along the kerb and the escorts crowd the step, so the clear
    // look at the street is from above the door, over their hats, on the far
    // side from his car so he never walks through the lens.
    const doorSide = scratch.aim.copy(v.carDoor[0]).sub(v.door).dot(v.along) > 0 ? -1 : 1;
    const fromDoor = (target: THREE.Vector3): Shot => {
      scratch.doorPos.copy(v.door).addScaledVector(v.toward, -0.9).addScaledVector(v.along, 2.8 * doorSide).setY(2.1);
      scratch.doorLook.copy(target).setY(0.6);
      return { pos: scratch.doorPos, look: scratch.doorLook };
    };
    const shots: DirectedShot[] = [];
    if (phase === "drive") {
      const paths = [(cinematic.playerPath?.length ?? 0) > 1, (cinematic.rivalPath?.length ?? 0) > 1];
      const chase = (at: THREE.Vector3, curve: THREE.CatmullRomCurve3): Shot => {
        const tan = curve.getTangentAt(Math.min(0.999, driveU * 0.92));
        return trackShot(at, facingOf(tan), 1, { back: 3.6, height: 1.35 });
      };
      if (driveU < 0.9 && (paths[0] || paths[1])) {
        const [p, r] = SITDOWN["drive-chase"]!;
        shots.push({
          id: p!.id,
          start: p!.start,
          end: p!.end,
          frame: () => chase(paths[0] ? playerAt : rivalAt, paths[0] ? playerCurve : rivalCurve),
          move: "track",
          fov: [FOV.establish, FOV.wide],
          follow: true,
          k: 0.3,
        });
        shots.push({
          id: r!.id,
          start: r!.start,
          end: r!.end,
          frame: () => chase(paths[1] ? rivalAt : playerAt, paths[1] ? rivalCurve : playerCurve),
          move: "track",
          fov: [FOV.wide, FOV.medium],
          follow: true,
          k: 0.3,
          transition: "cut",
        });
        playShots(cam, shots, driveU / 0.9, step);
      } else {
        const [arrive, walk, meet] = SITDOWN["drive-arrive"]!;
        shots.push({
          id: arrive!.id,
          start: arrive!.start,
          end: arrive!.end,
          frame: () => twoShot(v.park[0], v.park[1], streetSide(v.park[0], v.park[1]), { height: 2.0, margin: 1.8 }),
          move: "dollyIn",
          fov: [FOV.establish, FOV.wide],
          k: 0.14,
        });
        shots.push({
          id: walk!.id,
          start: walk!.start,
          end: walk!.end,
          frame: () => fromDoor(pb),
          move: "dollyIn",
          fov: [FOV.wide, FOV.medium],
          handheld: 0.008,
          k: 0.18,
        });
        shots.push({
          id: meet!.id,
          start: meet!.start,
          end: meet!.end,
          frame: () => twoShot(pb, rb, streetSide(pb, rb), { height: 1.3, margin: 0.9 }),
          move: "push",
          fov: [FOV.medium, FOV.close],
          transition: "cut",
          k: 0.3,
        });
        playShots(cam, shots, beatK, step);
      }
    } else if (phase === "table") {
      const cycle = TABLE_SHOT * 3;
      const local = (tableClock.current % cycle) / cycle;
      const [street, windowShot, post] = SITDOWN.table;
      const push = (tableClock.current % TABLE_SHOT) / TABLE_SHOT;
      shots.push({
        id: street!.id,
        start: street!.start,
        end: street!.end,
        frame: () => twoShot(v.park[0], v.park[1], streetSide(v.park[0], v.park[1]), { height: 1.8, push: push * 0.15 }),
        move: "dollyIn",
        fov: [FOV.wide, FOV.medium],
        k: 0.12,
      });
      shots.push({
        id: windowShot!.id,
        start: windowShot!.start,
        end: windowShot!.end,
        frame: () => {
          scratch.doorPos.copy(v.window).addScaledVector(v.toward, -(3.4 - 1.2 * push)).addScaledVector(v.along, 0.5).setY(1.05);
          scratch.doorLook.copy(v.window).setY(WINDOW.y);
          return { pos: scratch.doorPos, look: scratch.doorLook };
        },
        move: "dollyIn",
        fov: [FOV.medium, FOV.close],
        k: 0.12,
      });
      shots.push({
        id: post!.id,
        start: post!.start,
        end: post!.end,
        frame: () => twoShot(v.posts[0][0], v.door, streetSide(v.posts[0][0], v.door), { height: 1.15, margin: 0.9 }),
        move: "static",
        fov: [FOV.medium, FOV.close],
        handheld: 0.008,
        k: 0.12,
      });
      playShots(cam, shots, local, step);
    } else {
      const sq = squealAt(outcome);
      const away = () => trackShot(playerAt, heading, -1, { back: 4.2, height: 2.1 });
      const listKey =
        outcome === "handshake" ? "exit-handshake" : outcome === "betrayed" ? "exit-betrayed" : outcome === "trap" ? "exit-trap" : "exit-leave";
      const [a, c, d] = SITDOWN[listKey]!;
      if (outcome === "handshake") {
        shots.push({
          id: a!.id,
          start: a!.start,
          end: a!.end,
          frame: () => twoShot(pb, rb, streetSide(pb, rb), { height: 1.25, margin: 0.8 }),
          move: "dollyIn",
          fov: [FOV.medium, FOV.close],
          k: 0.26,
        });
        shots.push({
          id: c!.id,
          start: c!.start,
          end: c!.end,
          frame: () => twoShot(v.park[0], v.park[1], streetSide(v.park[0], v.park[1]), { height: 1.6 }),
          move: "static",
          fov: [FOV.medium, FOV.wide],
          k: 0.16,
        });
        shots.push({
          id: d!.id,
          start: d!.start,
          end: d!.end,
          frame: away,
          move: "crane",
          fov: [FOV.wide, FOV.pull],
          follow: true,
          k: 0.2,
        });
      } else if (outcome === "betrayed") {
        shots.push({
          id: a!.id,
          start: a!.start,
          end: a!.end,
          frame: () => {
            scratch.doorPos.copy(v.window).addScaledVector(v.toward, -2.2).addScaledVector(v.along, 0.4).setY(1.0);
            scratch.doorLook.copy(v.window).setY(WINDOW.y);
            return { pos: scratch.doorPos, look: scratch.doorLook };
          },
          move: "dollyIn",
          fov: [FOV.medium, FOV.close],
          transition: "cut",
          k: 0.35,
        });
        shots.push({
          id: c!.id,
          start: c!.start,
          end: c!.end,
          frame: () => fromDoor(scratch.mid.copy(b.cast.pm0.at).lerp(b.cast.rm0.at, 0.5)),
          move: "static",
          fov: [FOV.close, FOV.close],
          punch: { at: 0.2, fov: FOV.punch },
          handheld: 0.016,
          k: 0.4,
        });
        shots.push({
          id: d!.id,
          start: d!.start,
          end: d!.end,
          frame: () => twoShot(v.door, playerAt, streetSide(v.door, playerAt), { margin: 2.4, height: 2.4 }),
          move: "crane",
          fov: [FOV.medium, FOV.pull],
          k: 0.16,
        });
      } else {
        shots.push({
          id: a!.id,
          start: a!.start,
          end: a!.end,
          frame: () => fromDoor(b.cast.pb.show ? pb : v.carDoor[0]),
          move: "dollyIn",
          fov: [FOV.medium, outcome === "trap" ? FOV.close : FOV.medium],
          punch: outcome === "trap" ? { at: 0.18, fov: FOV.punch } : undefined,
          handheld: outcome === "trap" ? 0.016 : 0.006,
          k: 0.24,
        });
        shots.push({
          id: c!.id,
          start: c!.start,
          end: c!.end,
          frame: away,
          move: "crane",
          fov: [FOV.wide, FOV.pull],
          follow: true,
          k: 0.18,
        });
      }
      playShots(cam, shots, beatK, step);

      if (beatK > sq && !squealed.current) {
        squealed.current = true;
        tyreSqueal();
        engine(1.6);
      }
      if (beatK >= 1 && !finished.current) {
        finished.current = true;
        useGameStore.getState().completeSitdownCinematic();
      }
    }
    invalidate();
  });

  if (!cinematic || !phase) return null;
  const outcome = cinematic.outcome;
  const playerColor = FAMILY_HEX[playerFamily] ?? "#1c1c1e";
  const rivalColor = FAMILY_HEX[cinematic.family] ?? "#3a2a22";
  const violent = outcome === "betrayed" || outcome === "trap";
  const beat: Beat = phase === "drive" ? "drive" : phase === "table" ? "table" : "exit";
  // `rev` re-renders only when a pose, a gun, or the lamps actually change.
  void rev;
  const picture = shown.current ?? {
    sig: "",
    lamps: phase === "drive",
    block: direct(beat, 0, outcome, v),
  };
  const lampsOn = picture.lamps;
  const b = picture.block;
  const facing = facingOf(v.toward);
  const colorOf = (w: Who) => (w === "doorman" ? "#2a2420" : w[0] === "p" ? playerColor : rivalColor);
  const roleOf = (w: Who) => (w === "pb" || w === "rb" ? "boss" : w === "doorman" ? "associate" : "soldier");

  return (
    <ReelScope>
    <group>
      <ReelAtmosphere center={v.venue} facing={facing} amount={reelRain(useGameStore.getState().date.month)} />
      <group ref={playerRef} position={v.park[0]}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: CAR_YAW, color: playerColor, lamps: lampsOn }]} />
        <Headlamps cars={[{ x: 0, z: 0, rot: CAR_YAW }]} lit={lampsOn} />
      </group>
      <group ref={rivalRef} position={v.park[1]}>
        <ReelSedan cars={[{ x: 0, z: 0, rot: CAR_YAW, color: rivalColor, lamps: lampsOn && phase === "drive" }]} />
        <Headlamps cars={[{ x: 0, z: 0, rot: CAR_YAW }]} lit={lampsOn && phase === "drive"} />
      </group>

      {/* The door: frame, a warm room behind, a leaf that swings out to the street. */}
      <group position={v.door} rotation={[0, v.faceYaw, 0]}>
        <mesh position={[0, 0.58, 0.004]}>
          <planeGeometry args={[0.6, 1.16]} />
          <meshStandardMaterial color="#3a2414" emissive="#e0a060" emissiveIntensity={0.9} />
        </mesh>
        <mesh position={[0, 1.2, 0.03]}>
          <boxGeometry args={[0.76, 0.08, 0.06]} />
          <meshStandardMaterial color="#20160e" roughness={0.8} />
        </mesh>
        {[-0.34, 0.34].map((x) => (
          <mesh key={x} position={[x, 0.6, 0.03]}>
            <boxGeometry args={[0.06, 1.2, 0.06]} />
            <meshStandardMaterial color="#20160e" roughness={0.8} />
          </mesh>
        ))}
        <group ref={doorLeaf} position={[0.3, 0, 0.03]}>
          <mesh position={[-0.3, 0.58, 0]} castShadow>
            <boxGeometry args={[0.6, 1.16, 0.04]} />
            <meshStandardMaterial color="#3b2616" roughness={0.6} />
          </mesh>
          <mesh position={[-0.3, 0.85, 0.022]}>
            <planeGeometry args={[0.36, 0.32]} />
            <meshStandardMaterial color="#c9a06a" emissive="#e0b070" emissiveIntensity={0.7} />
          </mesh>
        </group>
        <mesh position={[0, 1.36, 0.12]}>
          <sphereGeometry args={[0.05, 8, 6]} />
          <meshBasicMaterial color="#ffd9a0" toneMapped={false} />
        </mesh>
        <pointLight position={[0, 1.3, 0.45]} color="#ffb060" intensity={1.8} distance={5} />
      </group>

      {/* The window: backlit, with the two men at the table in it. */}
      <group position={v.window} rotation={[0, v.faceYaw, 0]}>
        <mesh position={[0, WINDOW.y, 0]}>
          <boxGeometry args={[WINDOW.w + 0.1, WINDOW.h + 0.1, 0.05]} />
          <meshStandardMaterial color="#1c140e" roughness={0.8} />
        </mesh>
        <mesh position={[0, WINDOW.y, 0.028]}>
          <planeGeometry args={[WINDOW.w, WINDOW.h]} />
          <meshStandardMaterial ref={windowGlow} color="#5a3a1c" emissive="#f0b468" emissiveIntensity={1.4} />
        </mesh>
        {b.silhouettes && (
          <group position={[0, 0, 0.06]} scale={[1, 1, 0.08]}>
            <Silhouette material={shadowMat}>
              <Person position={[-0.27, 0, 0]} rot={Math.PI / 2} pose={b.insideDown ? "down" : "sit"} role="boss" seed={7} />
              <Person position={[0.27, 0, 0]} rot={-Math.PI / 2} pose="sit" role="boss" seed={19} />
              <mesh position={[0, 0.44, 0]}>
                <boxGeometry args={[0.32, 0.035, 0.3]} />
              </mesh>
              <mesh position={[0.02, 0.5, 0]}>
                <cylinderGeometry args={[0.02, 0.02, 0.09, 6]} />
              </mesh>
            </Silhouette>
          </group>
        )}
        <mesh position={[0, WINDOW.y, 0.1]}>
          <planeGeometry args={[WINDOW.w, WINDOW.h]} />
          <meshStandardMaterial color="#9fb4c8" transparent opacity={0.12} roughness={0.05} metalness={0.6} depthWrite={false} />
        </mesh>
        <pointLight ref={windowLight} position={[0, 0.85, 0.6]} color="#ffb060" intensity={1.4} distance={4.5} />
      </group>

      {CAST.map((w) => {
        const act = b.cast[w];
        const gunner = w === "pm0" || w === "pm1" || w === "rm0" || w === "rm1";
        return (
          <group key={w} ref={refs[w]} visible={false}>
            <Person
              position={[0, 0, 0]}
              role={roleOf(w)}
              color={colorOf(w)}
              pose={act.pose}
              moving={act.moving}
              gun={act.gun}
              firing={act.firing}
              lookAt={act.look ? heads[act.look] : undefined}
              muzzleRef={gunner ? muzzles[w] : undefined}
              shots={gunner ? 3 : undefined}
              seed={CAST.indexOf(w) * 37 + 11}
            />
            {act.smoking && <Ember seed={CAST.indexOf(w)} />}
          </group>
        );
      })}

      {(["pm0", "pm1", "rm0", "rm1"] as const).map((w) => {
        const act = b.cast[w];
        const target = act.look ? heads[act.look] : v.door;
        return (
          <MuzzleFlash
            key={w}
            active={!!act.firing}
            from={[act.at.x, 0.8, act.at.z]}
            to={[target.x, 0.8, target.z]}
            fromRef={muzzles[w]}
            shots={3}
          />
        );
      })}
      <MuzzleFlash
        active={b.doorFlash}
        from={[v.door.x, 0.9, v.door.z]}
        to={[v.carDoor[0].x, 0.8, v.carDoor[0].z]}
        shots={4}
      />
      <GlassShards active={violent && phase === "exit" && outcome === "betrayed"} at={[v.window.x, WINDOW.y, v.window.z]} />
      <Smoke
        active={phase === "exit" && b.go[0] > 0}
        at={[v.park[0].x, 0.2, v.park[0].z]}
        loop
        size={0.7}
      />
      <PoliceLights active={outcome === "trap" && phase === "exit"} at={[v.venue.x - v.along.x * 4, 0.4, v.venue.z - v.along.z * 4]} />
    </group>
    </ReelScope>
  );
}
