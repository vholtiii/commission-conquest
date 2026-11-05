import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { racketBlockFor, type CityLayout } from "@/engine/cityLayout";
import { streetRoute } from "@/engine/streetRoute";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import type { Racket, SupplyRoute, Territory } from "@/types/game";

type Props = { layout: CityLayout };
type Pt = { x: number; z: number };

const PARKED: ReadonlySet<string> = new Set([
  "hijacked",
  "no_stock",
  "seized",
  "stopped",
  "no_driver",
  "waiting",
]);

const LAP_S = 18;

function frozen(r: Racket, turn: number) {
  return (r.frozenUntil ?? 0) > turn;
}

function pickSource(t: Territory | undefined, turn: number): Racket | undefined {
  if (!t) return undefined;
  return (
    t.rackets.find((r) => r.type === "warehouse" && !frozen(r, turn)) ??
    t.rackets.find((r) => r.type === "still" || r.type === "brewery")
  );
}

function barnSpot(layout: CityLayout, t: Territory | undefined, turn: number): Pt | null {
  const r = pickSource(t, turn);
  if (!t || !r) return null;
  const site = typeof r.siteIndex === "number" ? r.siteIndex : t.rackets.indexOf(r);
  const block = racketBlockFor(layout, t.id, site);
  if (!block) return null;
  return { x: block.worldX, z: block.worldZ };
}

function Wheel({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0.18, z]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.18, 0.12, 12]} />
        <meshStandardMaterial color="#1a1816" roughness={0.95} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.13, 8]} />
        <meshStandardMaterial color="#8a7a5a" roughness={0.55} metalness={0.2} />
      </mesh>
    </group>
  );
}

function BoxTruck({ lamps }: { lamps: boolean }) {
  return (
    <group>
      <mesh position={[-0.55, 0.52, 0]} castShadow>
        <boxGeometry args={[1.15, 0.72, 0.78]} />
        <meshStandardMaterial color="#6b4a2e" roughness={0.7} />
      </mesh>
      <mesh position={[0.72, 0.72, 0]} castShadow>
        <boxGeometry args={[1.35, 1.05, 0.86]} />
        <meshStandardMaterial color="#5a3d24" roughness={0.75} />
      </mesh>
      <mesh position={[-0.95, 0.65, 0.32]} visible={lamps}>
        <boxGeometry args={[0.08, 0.08, 0.1]} />
        <meshBasicMaterial color="#f3e2a8" />
      </mesh>
      <mesh position={[-0.95, 0.65, -0.32]} visible={lamps}>
        <boxGeometry args={[0.08, 0.08, 0.1]} />
        <meshBasicMaterial color="#f3e2a8" />
      </mesh>
      <Wheel x={-0.7} z={0.44} />
      <Wheel x={-0.7} z={-0.44} />
      <Wheel x={0.85} z={0.48} />
      <Wheel x={0.85} z={-0.48} />
    </group>
  );
}

function along(points: Pt[], t: number): { x: number; z: number; yaw: number } | null {
  if (points.length < 2) return null;
  let total = 0;
  const lens: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    lens.push(len);
    total += len;
  }
  if (total <= 0.01) return { x: points[0]!.x, z: points[0]!.z, yaw: 0 };
  let walk = ((t % 1) + 1) % 1 * total;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = lens[i]!;
    if (walk > len && i < points.length - 2) {
      walk -= len;
      continue;
    }
    const u = len <= 0 ? 0 : walk / len;
    return {
      x: a.x + (b.x - a.x) * u,
      z: a.z + (b.z - a.z) * u,
      yaw: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  return { x: last.x, z: last.z, yaw: Math.atan2(last.x - prev.x, last.z - prev.z) };
}

function RollingTruck({ points }: { points: Pt[] }) {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    const pose = along(points, clock.elapsedTime / LAP_S);
    if (!pose || !ref.current) return;
    ref.current.position.set(pose.x, 0, pose.z);
    ref.current.rotation.y = pose.yaw + Math.PI / 2;
  });
  return (
    <group ref={ref} name="route-truck">
      <BoxTruck lamps />
    </group>
  );
}

function ParkedTruck({ at }: { at: Pt }) {
  return (
    <group name="route-truck" position={[at.x, 0, at.z]}>
      <BoxTruck lamps={false} />
    </group>
  );
}

function truckFor(route: SupplyRoute, layout: CityLayout, territories: Territory[], turn: number) {
  const parked = !!route.last && PARKED.has(route.last.outcome);
  const src = territories.find((t) => t.id === (route.sourceTerritoryId ?? route.path[0]));
  if (parked) {
    const at = barnSpot(layout, src, turn);
    if (!at) return null;
    return { id: route.id, parked: true as const, at };
  }
  const street = streetRoute(layout, route.path);
  if (street.length < 2) return null;
  return { id: route.id, parked: false as const, points: street.map((p) => ({ x: p.x, z: p.z })) };
}

export default function RouteTrucks({ layout }: Props) {
  const overview = useMapView((s) => s.overview);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const territories = useGameStore((s) => s.territories);
  const turn = useGameStore((s) => s.turn);
  const hitPlaying = useGameStore((s) => s.cinematicQueue.length > 0);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);

  const jobs = useMemo(
    () =>
      supplyRoutes
        .filter((r) => r.status === "active" || r.status === "suspended")
        .map((r) => truckFor(r, layout, territories, turn))
        .filter((j): j is NonNullable<typeof j> => !!j),
    [supplyRoutes, layout, territories, turn],
  );

  if (overview || hitPlaying || sitdownPhase) return null;
  if (jobs.length === 0) return null;

  return (
    <group>
      {jobs.map((job) =>
        job.parked ? (
          <ParkedTruck key={job.id} at={job.at} />
        ) : (
          <RollingTruck key={job.id} points={job.points} />
        ),
      )}
    </group>
  );
}
