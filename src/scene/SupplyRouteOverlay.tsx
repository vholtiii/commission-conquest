import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from "three";
import { BLOCK_SIZE, racketBlockFor, type CityLayout } from "@/engine/cityLayout";
import { streetRoute } from "@/engine/streetRoute";
import { useGameStore } from "@/engine/store";
import { MAP_STATUS, type Racket, type Territory } from "@/types/game";

type Props = { layout: CityLayout };
type Pt = [number, number, number];

type Seg = { ax: number; az: number; bx: number; bz: number; len: number; yaw: number; start: number };

/** Just above the asphalt, like a GPS stroke painted on the street. */
const Y = 0.2;
const CASE_W = 0.9;
const STROKE_W = 0.52;
const DASH = 2.35;
const GAP = 1.85;
const PERIOD = DASH + GAP;
/** World units per second. Dashes march toward the stop. */
const SPEED = 7.5;

function polylineSegs(points: Pt[]): { segs: Seg[]; total: number } {
  const segs: Seg[] = [];
  let start = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 0.02) continue;
    segs.push({
      ax: a[0],
      az: a[2],
      bx: b[0],
      bz: b[2],
      len,
      yaw: Math.atan2(dx, dz),
      start,
    });
    start += len;
  }
  return { segs, total: start };
}

function collectDashes(segs: Seg[], offset: number, y: number) {
  const out: Array<{ x: number; z: number; y: number; len: number; yaw: number }> = [];
  for (const seg of segs) {
    const segEnd = seg.start + seg.len;
    let cursor = seg.start - ((seg.start - offset) % PERIOD);
    if (cursor > seg.start) cursor -= PERIOD;
    for (let s = cursor; s < segEnd; s += PERIOD) {
      const a = Math.max(s, seg.start);
      const b = Math.min(s + DASH, segEnd);
      const len = b - a;
      if (len < 0.08) continue;
      const mid = (a + b) / 2;
      const t = seg.len <= 0 ? 0 : (mid - seg.start) / seg.len;
      out.push({
        x: seg.ax + (seg.bx - seg.ax) * t,
        z: seg.az + (seg.bz - seg.az) * t,
        y,
        len,
        yaw: seg.yaw,
      });
    }
  }
  return out;
}

function growPool(group: Group, count: number, width: number, color: string) {
  while (group.children.length < count) {
    const mesh = new Mesh(new PlaneGeometry(width, 1), new MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      side: 2,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 4;
    group.add(mesh);
  }
}

function paintPool(
  group: Group | null,
  dashes: Array<{ x: number; z: number; y: number; len: number; yaw: number }>,
  width: number,
  color: string,
) {
  if (!group) return;
  growPool(group, dashes.length, width, color);
  for (let i = 0; i < group.children.length; i++) {
    const mesh = group.children[i] as Mesh;
    const slot = dashes[i];
    mesh.visible = !!slot;
    if (!slot) continue;
    mesh.position.set(slot.x, slot.y, slot.z);
    mesh.rotation.set(-Math.PI / 2, 0, slot.yaw);
    mesh.scale.set(1, slot.len, 1);
    const mat = mesh.material as MeshBasicMaterial;
    mat.color.set(color);
  }
}

function disposePool(group: Group | null) {
  if (!group) return;
  for (const child of [...group.children]) {
    const mesh = child as Mesh;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    group.remove(mesh);
  }
}

function MarchingDashes({ points, color }: { points: Pt[]; color: string }) {
  const caseRef = useRef<Group>(null);
  const strokeRef = useRef<Group>(null);
  const { segs } = useMemo(() => polylineSegs(points), [points]);
  const y = points[0]?.[1] ?? Y;

  useLayoutEffect(() => {
    const caseGroup = caseRef.current;
    const strokeGroup = strokeRef.current;
    return () => {
      disposePool(caseGroup);
      disposePool(strokeGroup);
    };
  }, [segs]);

  useFrame(({ clock }) => {
    const offset = (clock.elapsedTime * SPEED) % PERIOD;
    paintPool(caseRef.current, collectDashes(segs, offset, y), CASE_W, "#1a1024");
    paintPool(strokeRef.current, collectDashes(segs, offset, y + 0.04), STROKE_W, color);
  });

  return (
    <group>
      <group ref={caseRef} />
      <group ref={strokeRef} />
    </group>
  );
}

const MARK_Y = 0.24;
const MARK_HALF = BLOCK_SIZE * 0.85;
const SQUARE_DASH = 0.55;
const SQUARE_GAP = 0.32;
const SQUARE_W = 0.22;

function frozen(r: Racket, turn: number) {
  return (r.frozenUntil ?? 0) > turn;
}

function siteOf(t: Territory, r: Racket) {
  const i = t.rackets.indexOf(r);
  return typeof r.siteIndex === "number" ? r.siteIndex : i;
}

function pickSource(t: Territory | undefined, turn: number): Racket | undefined {
  if (!t) return undefined;
  return (
    t.rackets.find((r) => r.type === "warehouse" && !frozen(r, turn)) ??
    t.rackets.find((r) => r.type === "still" || r.type === "brewery")
  );
}

function pickDest(t: Territory | undefined): Racket | undefined {
  if (!t) return undefined;
  return t.rackets.find((r) => r.type === "speakeasy") ?? t.rackets.find((r) => r.type === "warehouse");
}

function racketWorld(layout: CityLayout, t: Territory | undefined, r: Racket | undefined) {
  if (!t || !r) return null;
  const block = racketBlockFor(layout, t.id, siteOf(t, r));
  if (!block) return null;
  return { x: block.worldX, z: block.worldZ };
}

function DashedSquare({ x, z, color }: { x: number; z: number; color: string }) {
  const half = MARK_HALF;
  const sides: Array<{ cx: number; cz: number; len: number; yaw: number }> = [
    { cx: x, cz: z - half, len: half * 2, yaw: Math.PI / 2 },
    { cx: x + half, cz: z, len: half * 2, yaw: 0 },
    { cx: x, cz: z + half, len: half * 2, yaw: Math.PI / 2 },
    { cx: x - half, cz: z, len: half * 2, yaw: 0 },
  ];
  const marks: Array<{ x: number; z: number; len: number; yaw: number }> = [];
  for (const side of sides) {
    const period = SQUARE_DASH + SQUARE_GAP;
    for (let s = SQUARE_GAP * 0.5; s < side.len - 0.05; s += period) {
      const len = Math.min(SQUARE_DASH, side.len - s - 0.05);
      if (len < 0.12) continue;
      const t = (s + len / 2) / side.len - 0.5;
      const alongX = Math.sin(side.yaw);
      const alongZ = Math.cos(side.yaw);
      marks.push({
        x: side.cx + alongX * t * side.len,
        z: side.cz + alongZ * t * side.len,
        len,
        yaw: side.yaw,
      });
    }
  }
  return (
    <group>
      {marks.map((m, i) => (
        <mesh
          key={i}
          position={[m.x, MARK_Y, m.z]}
          rotation={[-Math.PI / 2, 0, m.yaw]}
          renderOrder={5}
        >
          <planeGeometry args={[SQUARE_W, m.len]} />
          <meshBasicMaterial color={color} depthTest={false} depthWrite={false} side={2} />
        </mesh>
      ))}
    </group>
  );
}

function DestCircle({ x, z, color }: { x: number; z: number; color: string }) {
  const r = MARK_HALF;
  return (
    <mesh position={[x, MARK_Y, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5}>
      <ringGeometry args={[r - 0.16, r, 48]} />
      <meshBasicMaterial color={color} depthTest={false} depthWrite={false} side={2} />
    </mesh>
  );
}

/** Stop the stroke short of the arrow so the head reads as the end. */
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

function DirectedRoad({
  points,
  color,
  start,
  stop,
}: {
  points: Pt[];
  color: string;
  start: { x: number; z: number } | null;
  stop: { x: number; z: number } | null;
}) {
  if (points.length < 2) return null;
  const end = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  return (
    <group>
      <MarchingDashes points={stopBeforeArrow(points)} color={color} />
      {start && <DashedSquare x={start.x} z={start.z} color={color} />}
      {stop && <DestCircle x={stop.x} z={stop.z} color={color} />}
      <DestinationArrow from={prev} to={end} color={color} />
    </group>
  );
}

/**
 * Liquor roads on the map. A route being planned wins. Otherwise the Rackets
 * Routes tab draws every road it has switched on, and the Warehouse panel
 * draws the one route you clicked. Dashed square on the warehouse, circle on
 * the speakeasy, arrow at the street stop.
 */
export default function SupplyRouteOverlay({ layout }: Props) {
  const focusId = useGameStore((s) => s.supplyRouteFocusId);
  const shownIds = useGameStore((s) => s.shownSupplyRouteIds);
  const preview = useGameStore((s) => s.supplyRoutePreview);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const routes = useGameStore((s) => s.routes);
  const territories = useGameStore((s) => s.territories);
  const turn = useGameStore((s) => s.turn);
  const hitPlaying = useGameStore((s) => s.cinematicQueue.length > 0);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);

  const districtPaths = useMemo(() => {
    const previewRoad = preview
      ? (preview.options.find((o) => o.id === preview.chosenId) ?? preview.options[0])
      : undefined;
    const paths: string[][] = [];
    if (previewRoad) {
      paths.push(previewRoad.path);
    } else if (shownIds) {
      const byId = new Map<string, string[]>();
      for (const route of supplyRoutes) byId.set(route.id, route.path);
      for (const route of routes) byId.set(route.id, route.path);
      for (const id of shownIds) {
        const path = byId.get(id);
        if (path) paths.push(path);
      }
    } else if (focusId) {
      const path = supplyRoutes.find((r) => r.id === focusId)?.path;
      if (path) paths.push(path);
    }
    return paths;
  }, [preview, shownIds, supplyRoutes, routes, focusId]);

  const roads = useMemo(
    () =>
      districtPaths
        .map((path, i) => {
          const street = streetRoute(layout, path);
          const points = street.map((p) => [p.x, Y + i * 0.05, p.z] as Pt);
          const src = territories.find((t) => t.id === path[0]);
          const dest = territories.find((t) => t.id === path[path.length - 1]);
          return {
            points,
            key: path.join(">") + i,
            start: racketWorld(layout, src, pickSource(src, turn)),
            stop: racketWorld(layout, dest, pickDest(dest)),
          };
        })
        .filter((road) => road.points.length >= 2),
    [districtPaths, layout, territories, turn],
  );

  if (hitPlaying || sitdownPhase) return null;
  if (roads.length === 0) return null;

  return (
    <group>
      {roads.map((road) => (
        <DirectedRoad
          key={road.key}
          points={road.points}
          color={MAP_STATUS.supplyRoute}
          start={road.start}
          stop={road.stop}
        />
      ))}
    </group>
  );
}
