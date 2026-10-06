import { useMemo } from "react";
import { Line } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { MAP_STATUS } from "@/types/game";

type Props = { layout: CityLayout };
type Pt = [number, number, number];

const Y = 0.45;

/** Dotted road across the district centres on a path. */
function DottedRoad({ points, color }: { points: Pt[]; color: string }) {
  if (points.length < 2) return null;
  return (
    <Line
      points={points}
      color={color}
      lineWidth={4}
      transparent
      opacity={0.95}
      dashed
      dashScale={1}
      dashSize={0.22}
      gapSize={0.3}
    />
  );
}

/** Stop the dashes short of the arrow so the head reads as the end. */
function stopBeforeArrow(points: Pt[]): Pt[] {
  const prev = points[points.length - 2];
  const end = points[points.length - 1];
  if (!prev || !end) return points;
  const dx = end[0] - prev[0];
  const dz = end[2] - prev[2];
  const len = Math.hypot(dx, dz) || 1;
  const gap = Math.min(3.2, len * 0.42);
  const trimmed: Pt = [end[0] - (dx / len) * gap, end[1], end[2] - (dz / len) * gap];
  return [...points.slice(0, -1), trimmed];
}

/** Small disc where the truck starts. */
function StartCap({ x, z, color }: { x: number; z: number; color: string }) {
  return (
    <mesh position={[x, 0.2, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5}>
      <ringGeometry args={[1.15, 1.55, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} depthWrite={false} />
    </mesh>
  );
}

/** Arrowhead at the destination, aimed along the last hop. */
function DestinationArrow({
  from,
  to,
  color,
}: {
  from: Pt;
  to: Pt;
  color: string;
}) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return null;
  const yaw = Math.atan2(dx, dz);
  return (
    <group position={[to[0], 3.4, to[2]]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0, -0.9]} rotation={[Math.PI / 2, 0, 0]} renderOrder={6}>
        <coneGeometry args={[0.85, 1.8, 3]} />
        <meshBasicMaterial color={color} transparent opacity={1} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

function DirectedRoad({ points, color }: { points: Pt[]; color: string }) {
  if (points.length < 2) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  return (
    <group>
      <DottedRoad points={stopBeforeArrow(points)} color={color} />
      <StartCap x={start[0]} z={start[2]} color={color} />
      <DestinationArrow from={prev} to={end} color={color} />
    </group>
  );
}

/**
 * One liquor road at a time. A route being planned wins over a standing
 * route you had traced. The ring is the warehouse; the arrow is the stop.
 */
export default function SupplyRouteOverlay({ layout }: Props) {
  const focusId = useGameStore((s) => s.supplyRouteFocusId);
  const preview = useGameStore((s) => s.supplyRoutePreview);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const hitPlaying = useGameStore((s) => s.cinematicQueue.length > 0);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);

  const centerById = useMemo(
    () => new Map(layout.centers.map((c) => [c.territoryId, c])),
    [layout],
  );
  const toPoints = (path: string[]) =>
    path
      .map((tid) => centerById.get(tid))
      .filter(Boolean)
      .map((c) => [c!.worldX, Y, c!.worldZ] as Pt);

  if (hitPlaying || sitdownPhase) return null;

  const previewRoad = preview
    ? preview.options.find((o) => o.id === preview.chosenId) ?? preview.options[0]
    : undefined;
  const focused = !preview && focusId ? supplyRoutes.find((r) => r.id === focusId) : undefined;
  const path = previewRoad?.path ?? focused?.path;
  if (!path) return null;
  const pts = toPoints(path);
  if (pts.length < 2) return null;

  return (
    <group>
      <DirectedRoad points={pts} color={MAP_STATUS.supplyRoute} />
    </group>
  );
}
