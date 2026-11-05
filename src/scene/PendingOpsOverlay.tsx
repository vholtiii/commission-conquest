import { useEffect, useMemo, useRef } from "react";
import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Mesh } from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { FAMILY_HEX, MAP_STATUS, type Operation } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { resolveCrewTerritoryId } from "@/engine/crewLocation";
import { districtShapes } from "./districtShapes";

function isCommissionJob(op: Operation): boolean {
  return op.intent === "commission" || !!op.errandId;
}

interface Props {
  layout: CityLayout;
}

function makeSquareRingGeometry(outer: number, inner: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const o = outer / 2;
  shape.moveTo(-o, -o);
  shape.lineTo(o, -o);
  shape.lineTo(o, o);
  shape.lineTo(-o, o);
  shape.closePath();
  const hole = new THREE.Path();
  const i = inner / 2;
  hole.moveTo(-i, -i);
  hole.lineTo(-i, i);
  hole.lineTo(i, i);
  hole.lineTo(i, -i);
  hole.closePath();
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape);
}

/** Crosshair ticks — pending / planned hit only (magenta, never a family color). */
function makeReticleTicksGeometry(size: number, len: number, thick: number): THREE.ShapeGeometry {
  const h = size / 2;
  const shapes: THREE.Shape[] = [];
  const mk = (x: number, z: number, w: number, d: number) => {
    const s = new THREE.Shape();
    s.moveTo(x - w / 2, z - d / 2);
    s.lineTo(x + w / 2, z - d / 2);
    s.lineTo(x + w / 2, z + d / 2);
    s.lineTo(x - w / 2, z + d / 2);
    s.closePath();
    shapes.push(s);
  };
  mk(0, -h, thick, len);
  mk(0, h, thick, len);
  mk(-h, 0, len, thick);
  mk(h, 0, len, thick);
  return new THREE.ShapeGeometry(shapes);
}

function PulsingHitReticle({
  cx,
  cz,
  color,
  intensity = 1,
}: {
  cx: number;
  cz: number;
  color: string;
  intensity?: number;
}) {
  const ringRef = useRef<Mesh>(null);
  const tickRef = useRef<Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const geo = useMemo(() => makeSquareRingGeometry(7.7, 6.85), []);
  const ticks = useMemo(() => makeReticleTicksGeometry(7.7, 1.4, 0.3), []);

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const t = clock.getElapsedTime();
    const speed = 5 + intensity;
    const pulse = 1 + Math.sin(t * speed) * 0.06 * intensity;
    ringRef.current.scale.setScalar(pulse);
    const mat = ringRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = (0.45 + Math.abs(Math.sin(t * speed)) * 0.4) * intensity;
    if (tickRef.current) {
      tickRef.current.scale.setScalar(1 + Math.sin(t * speed + Math.PI) * 0.1);
      (tickRef.current.material as THREE.MeshBasicMaterial).opacity =
        (0.55 + Math.abs(Math.sin(t * speed)) * 0.35) * intensity;
    }
    invalidate();
  });

  return (
    <group position={[cx, 0.055, cz]}>
      <mesh ref={ringRef} geometry={geo} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.75}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh ref={tickRef} geometry={ticks} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.9}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

const COMMISSION_GREY = "#8a9098";

/** Grey ring plus the family that took the table's job. */
function PulsingCommissionMark({
  cx,
  cz,
  familyColor,
}: {
  cx: number;
  cz: number;
  familyColor: string;
}) {
  const greyRef = useRef<Mesh>(null);
  const familyRef = useRef<Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const greyGeo = useMemo(() => new THREE.RingGeometry(3.55, 4.2, 48), []);
  const familyGeo = useMemo(() => new THREE.RingGeometry(2.5, 3.25, 48), []);
  useEffect(() => {
    return () => {
      greyGeo.dispose();
      familyGeo.dispose();
    };
  }, [greyGeo, familyGeo]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 1 + Math.sin(t * 3.4) * 0.1;
    const fade = 0.38 + Math.abs(Math.sin(t * 3.4)) * 0.5;
    if (greyRef.current) {
      greyRef.current.scale.setScalar(pulse);
      (greyRef.current.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
    }
    if (familyRef.current) {
      familyRef.current.scale.setScalar(pulse);
      (familyRef.current.material as THREE.MeshBasicMaterial).opacity = fade;
    }
    invalidate();
  });

  return (
    <group position={[cx, 0.07, cz]}>
      <mesh ref={greyRef} geometry={greyGeo} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          color={COMMISSION_GREY}
          transparent
          opacity={0.7}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh ref={familyRef} geometry={familyGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <meshBasicMaterial
          color={familyColor}
          transparent
          opacity={0.85}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

export default function PendingOpsOverlay({ layout }: Props) {
  const operations = useGameStore((s) => s.operations);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const commissionErrand = useGameStore((s) => s.commissionErrand);
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const hitTargetPreviewId = useGameStore((s) => s.hitTargetPreviewId);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const routes = useGameStore((s) => s.routes);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);

  const shapes = useMemo(() => districtShapes(layout), [layout]);
  const centerById = useMemo(
    () => new Map(layout.centers.map((c) => [c.territoryId, c])),
    [layout],
  );
  const spot = (id: string) => {
    const anchor = shapes.get(id)?.anchor;
    if (anchor) return anchor;
    const center = centerById.get(id);
    return center ? { x: center.worldX, z: center.worldZ } : null;
  };

  if (cinematicQueue.length > 0) return null;

  const pending = operations.filter(
    (o) => !o.resolved && o.family === playerFamily && o.kind === "hit" && !isCommissionJob(o),
  );
  const pendingTargetIds = new Set(pending.map((o) => o.targetTerritoryId));
  const commissionJobs = operations.filter(
    (o) =>
      !o.resolved &&
      o.family === playerFamily &&
      (o.kind === "hit" || o.kind === "surveillance") &&
      isCommissionJob(o),
  );
  const commissionMarks = [...new Map(commissionJobs.map((o) => [o.targetTerritoryId, o])).values()];
  const acceptor = commissionErrand?.carrier ?? playerFamily;

  // Planner preview: aim ring on the district of the selected mark (if not already a pending hit)
  let previewTerritoryId: string | null = null;
  if (hitTargetPreviewId) {
    previewTerritoryId =
      resolveCrewTerritoryId(
        { crew, territories, routes, operations, playerFamily },
        hitTargetPreviewId,
      ) ?? selectedTerritoryId;
  }
  if (previewTerritoryId && pendingTargetIds.has(previewTerritoryId)) {
    previewTerritoryId = null;
  }

  return (
    <group>
      {commissionMarks.map((op) => {
        const at = spot(op.targetTerritoryId);
        if (!at || !acceptor) return null;
        return (
          <PulsingCommissionMark
            key={`commission_${op.id}`}
            cx={at.x}
            cz={at.z}
            familyColor={FAMILY_HEX[acceptor]}
          />
        );
      })}
      {pending.map((op) => {
        const originId = op.originTerritoryId;
        const target = spot(op.targetTerritoryId);
        if (!target) return null;

        const origin = originId ? spot(originId) : null;
        const points: [number, number, number][] = [];
        if (origin) {
          points.push([origin.x, 0.5, origin.z]);
        }
        points.push([target.x, 0.5, target.z]);

        return (
          <group key={op.id}>
            {points.length >= 2 && (
              <Line
                points={points}
                color={MAP_STATUS.hitPending}
                lineWidth={2.2}
                dashed
                dashScale={1.5}
                dashSize={0.55}
                gapSize={0.35}
              />
            )}
            <PulsingHitReticle
              cx={target.x}
              cz={target.z}
              color={MAP_STATUS.hitPending}
              intensity={1}
            />
          </group>
        );
      })}

      {previewTerritoryId &&
        (() => {
          const c = spot(previewTerritoryId!);
          if (!c) return null;
          return (
            <PulsingHitReticle
              key="hit-preview"
              cx={c.x}
              cz={c.z}
              color={MAP_STATUS.hitPreview}
              intensity={0.75}
            />
          );
        })()}
    </group>
  );
}
