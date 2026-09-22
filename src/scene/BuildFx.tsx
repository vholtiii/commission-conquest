import { useEffect, useMemo, useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { useGameStore } from "@/engine/store";

interface Props {
  layout: CityLayout;
}

/** Wait for camera fly-in before the burst starts. */
const DELAY = 0.8;
const DURATION = 1.8;
const SPARKS = 18;

export default function BuildFx({ layout }: Props) {
  const buildFx = useGameStore((s) => s.buildFx);
  const clearBuildFx = useGameStore((s) => s.clearBuildFx);
  const territories = useGameStore((s) => s.territories);
  const invalidate = useThree((s) => s.invalidate);

  const startTime = useRef<number | null>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const floorRefs = useRef<(THREE.Mesh | null)[]>([]);
  const pointsRef = useRef<THREE.Points>(null);
  const dustRef = useRef<THREE.Mesh>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  const kind = buildFx?.kind ?? "build";
  const visual = buildFx ? RACKET_VISUALS[buildFx.type] : null;
  const accent = visual?.emissive ?? "#c9a227";
  const isUpgrade = kind === "upgrade";

  const center = useMemo(() => {
    if (!buildFx) return null;
    const t = territories.find((x) => x.id === buildFx.territoryId);
    const racketIndex = t
      ? Math.max(0, t.rackets.findIndex((r) => r.id === buildFx.racketId))
      : 0;
    const block = racketBlockFor(layout, buildFx.territoryId, racketIndex < 0 ? 0 : racketIndex);
    if (block) return { x: block.worldX, z: block.worldZ };
    const c = layout.centers.find((c) => c.territoryId === buildFx.territoryId);
    return c ? { x: c.worldX, z: c.worldZ } : null;
  }, [buildFx, layout, territories]);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    return geo;
  }, []);

  const velocities = useMemo(() => {
    const arr: THREE.Vector3[] = [];
    for (let i = 0; i < SPARKS; i++) {
      const angle = (i / SPARKS) * Math.PI * 2;
      arr.push(
        new THREE.Vector3(
          Math.cos(angle) * (0.8 + Math.random()),
          1.5 + Math.random() * 2,
          Math.sin(angle) * (0.8 + Math.random()),
        ),
      );
    }
    return arr;
  }, [buildFx?.nonce]);

  useEffect(() => {
    if (buildFx) {
      startTime.current = null;
      invalidate();
    }
  }, [buildFx, invalidate]);

  useFrame(({ clock }) => {
    if (!buildFx || !center) return;
    if (startTime.current === null) startTime.current = clock.getElapsedTime();
    const elapsed = clock.getElapsedTime() - startTime.current;
    invalidate();

    if (elapsed < DELAY) return;

    const t = Math.min(1, (elapsed - DELAY) / DURATION);

    if (ringRef.current) {
      if (isUpgrade) {
        // Double pulse
        const pulse = 0.7 + Math.abs(Math.sin(t * Math.PI * 2)) * 1.6;
        ringRef.current.scale.setScalar(pulse);
        const mat = ringRef.current.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.9 * (1 - t) * (0.55 + Math.abs(Math.sin(t * Math.PI * 2)) * 0.45));
      } else {
        ringRef.current.scale.setScalar(0.4 + t * 3.6);
        const mat = ringRef.current.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.9 - t);
      }
    }

    // Rising floor rings (build only)
    if (!isUpgrade) {
      for (let i = 0; i < 3; i++) {
        const mesh = floorRefs.current[i];
        if (!mesh) continue;
        const localT = Math.max(0, Math.min(1, (t - i * 0.12) / 0.7));
        mesh.position.y = 0.15 + localT * (1.4 + i * 0.85);
        mesh.scale.setScalar(0.6 + localT * 0.5);
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.75 * (1 - localT));
      }
    }

    if (dustRef.current && !isUpgrade) {
      dustRef.current.scale.setScalar(0.5 + t * 2.8);
      const mat = dustRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.35 * (1 - t));
    }

    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < SPARKS; i++) {
      const v = velocities[i]!;
      posAttr.setXYZ(i, v.x * t, 0.3 + v.y * t, v.z * t);
    }
    posAttr.needsUpdate = true;
    if (pointsRef.current) {
      (pointsRef.current.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - t);
    }

    if (chipRef.current && isUpgrade) {
      const y = 2.2 + t * 2.4;
      chipRef.current.style.transform = `translateY(${-y * 12}px)`;
      chipRef.current.style.opacity = String(Math.max(0, 1 - t));
    }

    if (t >= 1) {
      startTime.current = null;
      clearBuildFx();
    }
  });

  if (!buildFx || !center) return null;

  return (
    <group position={[center.x, 0, center.z]}>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
        <ringGeometry args={[0.55, 0.9, 32]} />
        <meshBasicMaterial
          color={isUpgrade ? accent : "#c9a227"}
          transparent
          opacity={0.85}
          depthWrite={false}
        />
      </mesh>

      {!isUpgrade && (
        <>
          {[0, 1, 2].map((i) => (
            <mesh
              key={i}
              ref={(el) => {
                floorRefs.current[i] = el;
              }}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.15, 0]}
            >
              <ringGeometry args={[0.7, 0.95, 24]} />
              <meshBasicMaterial
                color={accent}
                transparent
                opacity={0}
                depthWrite={false}
              />
            </mesh>
          ))}
          <mesh ref={dustRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
            <circleGeometry args={[0.6, 24]} />
            <meshBasicMaterial color="#c9a227" transparent opacity={0.35} depthWrite={false} />
          </mesh>
        </>
      )}

      <points ref={pointsRef} geometry={geometry}>
        <pointsMaterial
          color={isUpgrade ? accent : "#ffd666"}
          size={0.28}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </points>

      {isUpgrade && (
        <Html position={[0, 2.4, 0]} center occlude={false} zIndexRange={[20, 10]}>
          <div
            ref={chipRef}
            className="pointer-events-none select-none rounded-md border border-black/40 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-black shadow"
            style={{ background: `${accent}ee` }}
          >
            Lv {buildFx.level ?? "?"}
          </div>
        </Html>
      )}
    </group>
  );
}
