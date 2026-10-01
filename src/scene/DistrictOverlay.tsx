import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Mesh } from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import type { Territory } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { useMapView } from "@/engine/mapView";
import { lotTier } from "@/engine/territoryValue";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

let hatchTexture: THREE.Texture | null = null;

/**
 * Thin diagonal lines on a transparent ground — the survey-map mark for an
 * unclaimed empty lot, so it reads as "open ground, nobody's" rather than a
 * district that simply hasn't been built up yet.
 */
function getHatchTexture(): THREE.Texture {
  if (hatchTexture) return hatchTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(226, 230, 236, 0.9)";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  const step = 16;
  // Lines running bottom-left → top-right, wrapped so the tile repeats seamlessly.
  for (let d = -size; d < size * 2; d += step) {
    ctx.beginPath();
    ctx.moveTo(d, size);
    ctx.lineTo(d + size, 0);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  hatchTexture = tex;
  return tex;
}

/** Flat square ring (outer square with square hole) for area outlines / pulses. */
export function makeSquareRingGeometry(outer: number, inner: number): THREE.ShapeGeometry {
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

/**
 * Four L-shaped corner brackets — vendetta "marked" turf.
 * Cyan (not a family color) so it never reads as ownership or a hit.
 */
function makeCornerBracketGeometry(size: number, arm: number, thick: number): THREE.ShapeGeometry {
  const h = size / 2;
  const shapes: THREE.Shape[] = [];
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  for (const [sx, sz] of corners) {
    const s = new THREE.Shape();
    const x0 = sx * h;
    const z0 = sz * h;
    s.moveTo(x0, z0);
    s.lineTo(x0 - sx * arm, z0);
    s.lineTo(x0 - sx * arm, z0 - sz * thick);
    s.lineTo(x0 - sx * thick, z0 - sz * thick);
    s.lineTo(x0 - sx * thick, z0 - sz * arm);
    s.lineTo(x0, z0 - sz * arm);
    s.closePath();
    shapes.push(s);
  }
  return new THREE.ShapeGeometry(shapes);
}

function DistrictSquare({ territory, cx, cz }: { territory: Territory; cx: number; cz: number }) {
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const selectedId = useGameStore((s) => s.selectedTerritoryId);
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const vendettas = useGameStore((s) => s.vendettas);
  const invalidate = useThree((s) => s.invalidate);

  const pulseRef = useRef<Mesh>(null);
  const flashRef = useRef<Mesh>(null);

  const isSelected = selectedId === territory.id && !selectedCrewId;
  const isVendetta = !!territory.owner && vendettas.includes(territory.owner);
  const unclaimed = !territory.owner;
  const openLot = unclaimed && lotTier(territory) === "empty";
  const baseColor = territory.owner ? FAMILY_HEX[territory.owner] : MAP_STATUS.neutral;
  const size = 7.2;
  const hatch = useMemo(() => (openLot ? getHatchTexture() : null), [openLot]);

  const outlineGeo = useMemo(() => makeSquareRingGeometry(size, size - 0.4), [size]);
  const pulseGeo = useMemo(() => makeSquareRingGeometry(size + 1.1, size + 0.25), [size]);
  const vendettaGeo = useMemo(() => makeCornerBracketGeometry(size + 1.8, 2.1, 0.48), [size]);

  useFrame(({ clock }) => {
    if (isSelected && pulseRef.current) {
      const t = clock.getElapsedTime();
      const pulse = 1 + Math.sin(t * 3.2) * 0.12;
      pulseRef.current.scale.setScalar(pulse);
      const mat = pulseRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.45 + Math.abs(Math.sin(t * 3.2)) * 0.35;
      invalidate();
    }
    if (isVendetta && flashRef.current) {
      // Slow breathe, no scale: "marked feud", not "incoming hit"
      const t = clock.getElapsedTime();
      const mat = flashRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + (Math.sin(t * 1.4) + 1) * 0.18;
      invalidate();
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Family-colored ownership glow — the primary "who owns this" signal */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={unclaimed ? 0.12 : 0.32}
          depthWrite={false}
        />
      </mesh>

      <mesh
        geometry={outlineGeo}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.035, 0]}
      >
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={unclaimed ? 0.35 : 0.75}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Unclaimed empty lot: faint diagonal hatching over the open ground */}
      {hatch && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.034, 0]}>
          <planeGeometry args={[size - 0.5, size - 0.5]} />
          <meshBasicMaterial
            map={hatch}
            color="#dfe4ea"
            transparent
            opacity={0.22}
            depthWrite={false}
          />
        </mesh>
      )}

      {unclaimed &&
        [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ].map(([sx, sz], i) => (
          <mesh
            key={i}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[(sx * size) / 2 - sx * 0.35, 0.036, (sz * size) / 2 - sz * 0.35]}
          >
            <planeGeometry args={[0.7, 0.7]} />
            <meshBasicMaterial color="#9aa0a8" transparent opacity={0.35} depthWrite={false} />
          </mesh>
        ))}

      {isSelected && (
        <mesh
          ref={pulseRef}
          geometry={pulseGeo}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.04, 0]}
        >
          <meshBasicMaterial
            color={unclaimed ? "#c5cad3" : "#ffffff"}
            transparent
            opacity={0.65}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Vendetta: cyan corner brackets only — never fills the square */}
      {isVendetta && (
        <mesh
          ref={flashRef}
          geometry={vendettaGeo}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.048, 0]}
        >
          <meshBasicMaterial
            color={MAP_STATUS.vendetta}
            transparent
            opacity={0.85}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          selectTerritory(territory.id);
        }}
      >
        <planeGeometry args={[size + 1, size + 1]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}

const PAD_SIZE = 1.9;

/**
 * The open build spots on an empty lot: one staked-out pad per free hideout
 * slot, at the exact spot the racket will stand once built. Neutral while the
 * lot is nobody's, family-coloured once it's claimed, gone once it's built on.
 */
function LotPads({ layout, territory }: { layout: CityLayout; territory: Territory }) {
  const hatch = getHatchTexture();
  const ringGeo = useMemo(() => makeSquareRingGeometry(PAD_SIZE, PAD_SIZE - 0.16), []);
  const color = territory.owner ? FAMILY_HEX[territory.owner] : "#dfe4ea";
  const spots = useMemo(() => {
    const out: { x: number; z: number }[] = [];
    const slots = territory.racketSlots ?? 0;
    const taken = new Set(
      territory.rackets.map((r, i) =>
        typeof r.siteIndex === "number" ? r.siteIndex : i,
      ),
    );
    for (let i = 0; i < slots; i++) {
      if (taken.has(i)) continue;
      const b = racketBlockFor(layout, territory.id, i);
      if (b) out.push({ x: b.worldX, z: b.worldZ });
    }
    return out;
  }, [layout, territory.id, territory.rackets, territory.racketSlots]);

  return (
    <group>
      {spots.map((s, i) => (
        <group key={i} position={[s.x, 0, s.z]}>
          <mesh geometry={ringGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.045, 0]}>
            <meshBasicMaterial
              color={color}
              transparent
              opacity={territory.owner ? 0.7 : 0.5}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.042, 0]}>
            <planeGeometry args={[PAD_SIZE - 0.2, PAD_SIZE - 0.2]} />
            <meshBasicMaterial
              map={hatch}
              color={color}
              transparent
              opacity={territory.owner ? 0.35 : 0.3}
              depthWrite={false}
            />
          </mesh>
          {/* survey stakes at the corners */}
          {[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([sx, sz], k) => (
            <mesh key={k} position={[(sx * PAD_SIZE) / 2, 0.22, (sz * PAD_SIZE) / 2]}>
              <boxGeometry args={[0.07, 0.44, 0.07]} />
              <meshStandardMaterial color="#b8a888" roughness={0.9} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

export default function DistrictOverlay({ layout, territories }: Props) {
  const byId = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);
  const overview = useMapView((s) => s.overview);

  return (
    <group>
      {layout.centers.map((c) => {
        const t = byId.get(c.territoryId);
        if (!t) return null;
        return <DistrictSquare key={c.territoryId} territory={t} cx={c.worldX} cz={c.worldZ} />;
      })}
      {!overview &&
        territories.map((t) =>
          t.discovered && lotTier(t) === "empty" ? (
            <LotPads key={`pads-${t.id}`} layout={layout} territory={t} />
          ) : null,
        )}
    </group>
  );
}
