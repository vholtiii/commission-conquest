import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CityBlock, CityLayout, DistrictCenter } from "@/engine/cityLayout";
import { resolveCrewLocation, type LocationState } from "@/engine/crewLocation";
import { isBossCarVisible } from "@/engine/intel";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { CrewMember, CrewRole, FamilyName, IntelState, Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";
import { SedanFleet, type SedanSpec } from "./Sedan";

/**
 * Every made man's car, parked nose-north on the west kerb of the avenue
 * nearest wherever he is this week. Move a man and his car drives there: down
 * the avenue, across a street, up the next avenue, lamps on, then parks.
 *
 * Rank decides the paint. The boss rides black with the family colour and a
 * halo; the underboss and consigliere ride black too, a shade quieter; capos
 * silver; soldiers brown; the hitman blacked out with nothing that shines.
 * Associates take the streetcar.
 */

export const BOSS_CAR_SCALE = 0.95;
const CREW_CAR_SCALE = 0.85;
/** Cars per district. A second row sits a step off the kerb so a dinner fits. */
const KERB_SLOTS = 16;
const KERB_ROW = 8;
/** Distance from an avenue's centreline to its west kerb. */
const WEST_KERB = 0.7;
/** Nose-to-nose spacing along the kerb. */
const KERB_PITCH = 1.95;
/** Parked facing north (−Z). */
const PARKED_ROT = Math.PI / 2;
/** Cruising speed, world units per second. */
const DRIVE_SPEED = 13;
const DRIVE_MIN_S = 1.1;
const DRIVE_MAX_S = 3.4;

const RANK: Record<CrewRole, number> = {
  boss: 0,
  underboss: 1,
  consigliere: 2,
  capo: 3,
  soldier: 4,
  hitman: 5,
  associate: 9,
};

interface Spot {
  x: number;
  z: number;
}

export interface CrewCar {
  /** Crew id; keys the car across renders so a move can animate. */
  id: string;
  territoryId: string;
  spot: Spot;
  spec: SedanSpec;
  flair: boolean;
  /** Lamps come on for the drive. A blacked-out car keeps them off. */
  drivesDark: boolean;
}

function dim(hex: string, amount = 0.45): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color("#000000"), amount);
  return `#${c.getHexString()}`;
}

/** Paint, scale and trim for a man of this rank. `null` means he has no car. */
function carFor(member: CrewMember): Omit<SedanSpec, "x" | "z" | "rot"> | null {
  const family = FAMILY_HEX[member.family];
  switch (member.role) {
    case "boss":
      return { color: "#0b0b0d", accent: family, scale: BOSS_CAR_SCALE, lamps: false };
    case "underboss":
    case "consigliere":
      return { color: "#0b0b0d", accent: dim(family), scale: CREW_CAR_SCALE, lamps: false };
    case "capo":
      return { color: "#b9bcc4", accent: family, scale: CREW_CAR_SCALE, lamps: false };
    case "soldier":
      return { color: "#4a3a26", scale: CREW_CAR_SCALE, lamps: false };
    case "hitman":
      return { color: "#08080a", scale: CREW_CAR_SCALE, lamps: false, frills: false };
    default:
      return null;
  }
}

/** The west kerb of the nearest north–south avenue to a point. */
function nearestAvenue(layout: CityLayout, cx: number, cz: number): Spot {
  let best: CityBlock | null = null;
  let bestD = Infinity;
  for (const block of layout.blocks) {
    if (block.kind !== "road" || block.gx % 4 !== 0) continue;
    const dx = block.worldX - cx;
    const dz = block.worldZ - cz;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = block;
    }
  }
  if (!best) return { x: cx - WEST_KERB, z: cz };
  return { x: best.worldX - WEST_KERB, z: best.worldZ };
}

/** World Z of every east–west street, for routing a drive. */
function streetRows(layout: CityLayout): number[] {
  const rows = new Set<number>();
  for (const block of layout.blocks) {
    if (block.kind === "road" && block.gz % 4 === 0) rows.add(block.worldZ);
  }
  return [...rows].sort((a, b) => a - b);
}

/** Slot `n` along the kerb: at the centre, then one south, one north, two south… A second row steps west. */
function kerbOffset(n: number): { x: number; z: number } {
  const row = Math.floor(n / KERB_ROW);
  const i = n % KERB_ROW;
  const step = Math.ceil(i / 2);
  return {
    x: -row * 1.15,
    z: (i % 2 === 1 ? step : -step) * KERB_PITCH,
  };
}

function tooClose(a: Spot, b: Spot): boolean {
  return Math.abs(a.x - b.x) < KERB_PITCH * 0.5 && Math.abs(a.z - b.z) < KERB_PITCH * 0.9;
}

/**
 * The nth kerb slot for a district, walked further along the avenue if
 * another district's row already parked there. Two cars never share a spot.
 */
function freeKerbSpot(kerb: Spot, nth: number, taken: Spot[]): Spot | null {
  for (let n = nth; n < nth + KERB_SLOTS * 3; n++) {
    const off = kerbOffset(n);
    const spot = { x: kerb.x + off.x, z: kerb.z + off.z };
    if (!taken.some((t) => tooClose(t, spot))) return spot;
  }
  return null;
}

function nearestRow(rows: number[], z: number): number {
  let best = rows[0] ?? z;
  for (const r of rows) if (Math.abs(r - z) < Math.abs(best - z)) best = r;
  return best;
}

export function crewSedans(
  locState: LocationState & { intel: IntelState; turn: number },
  byId: Map<string, Territory>,
  centerById: Map<string, DistrictCenter>,
  layout: CityLayout,
  hidden?: Set<FamilyName>,
): CrewCar[] {
  const candidates: { member: CrewMember; territoryId: string; body: Omit<SedanSpec, "x" | "z" | "rot"> }[] = [];

  for (const member of locState.crew) {
    if (member.status !== "active") continue;
    if (hidden?.has(member.family)) continue;
    const isBoss = member.role === "boss";
    // Rivals show only the boss's car, and only where you'd know to look.
    if (member.family !== locState.playerFamily && !isBoss) continue;
    const body = carFor(member);
    if (!body) continue;
    const loc = resolveCrewLocation(locState, member.id);
    if (!loc.territoryId) continue;
    const here = byId.get(loc.territoryId);
    if (!here?.discovered || !centerById.has(loc.territoryId)) continue;
    if (isBoss && !isBossCarVisible(locState, member)) continue;
    candidates.push({ member, territoryId: loc.territoryId, body });
  }

  // Bosses first in the row, then by rank; ties keep a stable order so a car
  // doesn't swap slots week to week.
  candidates.sort((a, b) => {
    const fa = ALL_FAMILY_NAMES.indexOf(a.member.family);
    const fb = ALL_FAMILY_NAMES.indexOf(b.member.family);
    return (
      RANK[a.member.role] - RANK[b.member.role] || fa - fb || a.member.id.localeCompare(b.member.id)
    );
  });

  const parkedAt = new Map<string, number>();
  const taken: Spot[] = [];
  const cars: CrewCar[] = [];
  for (const { member, territoryId, body } of candidates) {
    const nth = parkedAt.get(territoryId) ?? 0;
    if (nth >= KERB_SLOTS) continue;
    const center = centerById.get(territoryId)!;
    const kerb = nearestAvenue(layout, center.worldX, center.worldZ);
    const spot = freeKerbSpot(kerb, nth, taken);
    if (!spot) continue;
    parkedAt.set(territoryId, nth + 1);
    taken.push(spot);
    cars.push({
      id: member.id,
      territoryId,
      spot,
      spec: { ...body, x: spot.x, z: spot.z, rot: PARKED_ROT },
      flair: member.role === "boss",
      drivesDark: member.role === "hitman",
    });
  }
  return cars;
}

/**
 * What makes the boss's car read as *the* boss's car: a slow-breathing halo in
 * the family colour on the asphalt under it, a pennant on the front fender,
 * and a low coloured glow so it pops at night even from a few blocks up.
 * Rendered in car-local space so it can ride along on a drive.
 */
function BossFlair({ accent, scale }: { accent: string; scale: number }) {
  const halo = useRef<THREE.MeshBasicMaterial>(null);
  const light = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.8);
    if (halo.current) halo.current.opacity = 0.22 + pulse * 0.2;
    if (light.current) light.current.intensity = 1.6 + pulse * 1.0;
  });

  return (
    <group scale={scale}>
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.42, 40]} />
        <meshBasicMaterial ref={halo} color={accent} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.1, 40]} />
        <meshBasicMaterial color={accent} transparent opacity={0.08} depthWrite={false} />
      </mesh>

      {/* pennant on the right front fender */}
      <mesh position={[0.66, 0.9, 0.36]}>
        <cylinderGeometry args={[0.018, 0.018, 0.6, 6]} />
        <meshStandardMaterial color="#c9ccd1" metalness={0.9} roughness={0.3} />
      </mesh>
      <mesh position={[0.52, 1.12, 0.36]}>
        <boxGeometry args={[0.3, 0.16, 0.02]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.9} />
      </mesh>

      {/* running lights along the running boards */}
      {[0.44, -0.44].map((z) => (
        <mesh key={z} position={[-0.02, 0.23, z]}>
          <boxGeometry args={[1.5, 0.03, 0.03]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.4} />
        </mesh>
      ))}

      <pointLight ref={light} position={[0, 1.3, 0]} color={accent} intensity={2} distance={5.5} decay={2} />
    </group>
  );
}

interface Drive {
  car: CrewCar;
  /** Waypoints, start to finish. */
  path: Spot[];
  /** Cumulative distance at each waypoint. */
  marks: number[];
  seconds: number;
}

/** Down the avenue, along a street, up the next avenue. */
function planDrive(from: Spot, car: CrewCar, rows: number[]): Drive {
  const to = car.spot;
  const path: Spot[] = [from];
  if (Math.abs(from.x - to.x) > 0.01) {
    const zMid = nearestRow(rows, (from.z + to.z) / 2);
    path.push({ x: from.x, z: zMid }, { x: to.x, z: zMid });
  }
  path.push(to);
  const marks = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    marks.push(marks[i - 1] + Math.hypot(dx, dz));
  }
  const length = marks[marks.length - 1];
  const seconds = Math.min(DRIVE_MAX_S, Math.max(DRIVE_MIN_S, length / DRIVE_SPEED));
  return { car, path, marks, seconds };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** One car on the move. Calls `onArrive` once it has parked. */
function DrivingSedan({ drive, onArrive }: { drive: Drive; onArrive: (id: string) => void }) {
  const group = useRef<THREE.Group>(null);
  const started = useRef<number | null>(null);
  const done = useRef(false);
  const { car, path, marks, seconds } = drive;
  const total = marks[marks.length - 1];

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g || done.current) return;
    if (started.current === null) started.current = clock.elapsedTime;
    const t = Math.min(1, (clock.elapsedTime - started.current) / seconds);
    const dist = easeInOut(t) * total;

    let i = 1;
    while (i < marks.length - 1 && marks[i] < dist) i++;
    const a = path[i - 1];
    const b = path[i];
    const seg = marks[i] - marks[i - 1];
    const u = seg > 0 ? (dist - marks[i - 1]) / seg : 1;
    g.position.set(a.x + (b.x - a.x) * u, 0, a.z + (b.z - a.z) * u);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.001) g.rotation.y = Math.atan2(-dz, dx);

    if (t >= 1) {
      g.position.set(car.spot.x, 0, car.spot.z);
      g.rotation.y = PARKED_ROT;
      done.current = true;
      onArrive(car.id);
    }
  });

  const local: SedanSpec = { ...car.spec, x: 0, z: 0, rot: 0, lamps: !car.drivesDark };
  return (
    <group ref={group} position={[path[0].x, 0, path[0].z]} rotation={[0, PARKED_ROT, 0]}>
      <SedanFleet cars={[local]} castShadow />
      {car.flair && <BossFlair accent={car.spec.accent ?? "#ffffff"} scale={car.spec.scale ?? BOSS_CAR_SCALE} />}
    </group>
  );
}

interface Props {
  cars: CrewCar[];
  layout: CityLayout;
}

/**
 * Parked cars share one instanced fleet. A car whose district changed since
 * the last render is pulled out, driven to its new kerb, then parked again.
 */
export default function CrewSedans({ cars, layout }: Props) {
  const rows = useMemo(() => streetRows(layout), [layout]);
  const prev = useRef<Map<string, { territoryId: string; spot: Spot }> | null>(null);
  const [drives, setDrives] = useState<Map<string, Drive>>(() => new Map());

  useEffect(() => {
    const next = new Map<string, { territoryId: string; spot: Spot }>();
    for (const car of cars) next.set(car.id, { territoryId: car.territoryId, spot: car.spot });
    const before = prev.current;
    prev.current = next;
    if (!before) return;

    const fresh: Drive[] = [];
    for (const car of cars) {
      const was = before.get(car.id);
      if (!was || was.territoryId === car.territoryId) continue;
      fresh.push(planDrive(was.spot, car, rows));
    }
    if (fresh.length === 0) return;
    setDrives((d) => {
      const m = new Map(d);
      for (const drive of fresh) {
        // Re-routed mid-drive: start from wherever the last drive was headed.
        const inFlight = m.get(drive.car.id);
        m.set(drive.car.id, inFlight ? planDrive(inFlight.car.spot, drive.car, rows) : drive);
      }
      return m;
    });
  }, [cars, rows]);

  // Drop drives for cars that vanished (jailed, dead, hidden for a cinematic).
  useEffect(() => {
    if (drives.size === 0) return;
    const ids = new Set(cars.map((c) => c.id));
    if ([...drives.keys()].every((id) => ids.has(id))) return;
    setDrives((d) => {
      const m = new Map(d);
      for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
      return m;
    });
  }, [cars, drives]);

  const parked = cars.filter((c) => !drives.has(c.id));
  const arrive = (id: string) =>
    setDrives((d) => {
      if (!d.has(id)) return d;
      const m = new Map(d);
      m.delete(id);
      return m;
    });

  return (
    <group>
      <SedanFleet cars={parked.map((c) => c.spec)} castShadow />
      {parked
        .filter((c) => c.flair)
        .map((c) => (
          <group key={c.id} position={[c.spot.x, 0, c.spot.z]} rotation={[0, PARKED_ROT, 0]}>
            <BossFlair accent={c.spec.accent ?? "#ffffff"} scale={c.spec.scale ?? BOSS_CAR_SCALE} />
          </group>
        ))}
      {[...drives.values()].map((drive) => (
        <DrivingSedan key={drive.car.id} drive={drive} onArrive={arrive} />
      ))}
    </group>
  );
}