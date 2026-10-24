import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import type { LogTone } from "@/types/game";
import { districtShapes } from "./districtShapes";

const DURATION = 2.5;

const TONE_COLOR: Record<LogTone, string> = {
  violence: "#e0413a",
  money: "#e8b84a",
  intel: "#5aa9e6",
  warning: "#f0913a",
};

function ringGeometry(): THREE.RingGeometry {
  return new THREE.RingGeometry(3.4, 4, 48);
}

function rect(x: number, z: number, w: number, d: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x - w / 2, z - d / 2);
  s.lineTo(x + w / 2, z - d / 2);
  s.lineTo(x + w / 2, z + d / 2);
  s.lineTo(x - w / 2, z + d / 2);
  s.closePath();
  return s;
}

function circle(r: number, inner = 0): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  if (inner > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    s.holes.push(hole);
  }
  return s;
}

function iconGeometry(tone: LogTone): THREE.ShapeGeometry {
  switch (tone) {
    case "violence":
      return new THREE.ShapeGeometry([
        circle(1.3, 1.05),
        rect(0, 1.55, 0.22, 0.9),
        rect(0, -1.55, 0.22, 0.9),
        rect(1.55, 0, 0.9, 0.22),
        rect(-1.55, 0, 0.9, 0.22),
      ]);
    case "money":
      return new THREE.ShapeGeometry([circle(1.4, 1.1), circle(0.75)]);
    case "intel": {
      const eye = new THREE.Shape();
      eye.moveTo(-1.8, 0);
      eye.quadraticCurveTo(0, 1.6, 1.8, 0);
      eye.quadraticCurveTo(0, -1.6, -1.8, 0);
      const hole = new THREE.Path();
      hole.moveTo(-1.45, 0);
      hole.quadraticCurveTo(0, -1.2, 1.45, 0);
      hole.quadraticCurveTo(0, 1.2, -1.45, 0);
      eye.holes.push(hole);
      return new THREE.ShapeGeometry([eye, circle(0.5)]);
    }
    case "warning": {
      const tri = new THREE.Shape();
      tri.moveTo(0, 1.7);
      tri.lineTo(1.6, -1.1);
      tri.lineTo(-1.6, -1.1);
      tri.closePath();
      const hole = new THREE.Path();
      hole.moveTo(0, 1.15);
      hole.lineTo(-1.1, -0.8);
      hole.lineTo(1.1, -0.8);
      hole.closePath();
      tri.holes.push(hole);
      return new THREE.ShapeGeometry([tri, rect(0, 0.15, 0.22, 0.75), rect(0, -0.48, 0.22, 0.2)]);
    }
  }
}

/** A tinted ring and icon on the block a digest line pointed at. */
export default function MapPulse({ layout }: { layout: CityLayout }) {
  const pulse = useGameStore((s) => s.mapPulse);
  const clearMapPulse = useGameStore((s) => s.clearMapPulse);
  const invalidate = useThree((s) => s.invalidate);
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const startRef = useRef<number | null>(null);

  const shapes = useMemo(() => districtShapes(layout), [layout]);
  const ring = useMemo(() => ringGeometry(), []);
  const icon = useMemo(() => (pulse ? iconGeometry(pulse.tone) : null), [pulse?.tone]);
  useEffect(() => () => ring.dispose(), [ring]);
  useEffect(() => () => icon?.dispose(), [icon]);

  useEffect(() => {
    startRef.current = null;
    invalidate();
  }, [pulse?.nonce, invalidate]);

  const spot = useMemo(() => {
    if (!pulse) return null;
    const anchor = shapes.get(pulse.territoryId)?.anchor;
    if (anchor) return anchor;
    const center = layout.centers.find((c) => c.territoryId === pulse.territoryId);
    return center ? { x: center.worldX, z: center.worldZ } : null;
  }, [pulse, shapes, layout]);

  useFrame(({ clock }) => {
    if (!pulse || !groupRef.current) return;
    const now = clock.getElapsedTime();
    if (startRef.current === null) startRef.current = now;
    const t = (now - startRef.current) / DURATION;
    if (t >= 1) {
      clearMapPulse();
      return;
    }
    const fade = t < 0.15 ? t / 0.15 : t > 0.7 ? (1 - t) / 0.3 : 1;
    if (ringRef.current) {
      ringRef.current.scale.setScalar(0.7 + t * 0.9);
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85 * fade * (1 - t * 0.5);
    }
    groupRef.current.children.forEach((child) => {
      if (child === ringRef.current) return;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat) mat.opacity = 0.95 * fade;
    });
    groupRef.current.position.y = 0.08 + Math.sin(t * Math.PI) * 0.4;
    invalidate();
  });

  if (!pulse || !spot || !icon) return null;
  const color = TONE_COLOR[pulse.tone];

  return (
    <group ref={groupRef} position={[spot.x, 0.08, spot.z]}>
      <mesh ref={ringRef} geometry={ring} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={icon} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
