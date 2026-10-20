import { useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { Mesh } from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import type { Territory } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { useMapView } from "@/engine/mapView";
import { lotTier } from "@/engine/territoryValue";
import { districtShapes, getDistrictHatch, getHatchTexture, type DistrictShape as DistrictGeo } from "./districtShapes";

interface Props {
  layout: CityLayout;
  territories: Territory[];
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

/** The district's real footprint: a tint over its cells and a border along the streets. */
function DistrictShape({ territory, shape }: { territory: Territory; shape: DistrictGeo }) {
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
  const hatch = useMemo(() => (openLot ? getDistrictHatch() : null), [openLot]);

  const pick = (e: ThreeEvent<MouseEvent>) => {
    // A drag is navigation. Only a left click that barely moved selects.
    if (e.button !== 0 || e.delta > 6) return;
    e.stopPropagation();
    selectTerritory(territory.id);
  };

  useFrame(({ clock }) => {
    if (isSelected && pulseRef.current) {
      const t = clock.getElapsedTime();
      const mat = pulseRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.45 + Math.abs(Math.sin(t * 3.2)) * 0.35;
      invalidate();
    }
    if (isVendetta && flashRef.current) {
      const t = clock.getElapsedTime();
      const mat = flashRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + (Math.sin(t * 1.4) + 1) * 0.18;
      invalidate();
    }
  });

  return (
    <group>
      <mesh geometry={shape.fill} position={[0, 0.03, 0]} onClick={pick}>
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={unclaimed ? 0.12 : 0.32}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh geometry={shape.border} position={[0, 0.04, 0]}>
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={unclaimed ? 0.35 : 0.75}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {hatch && (
        <mesh geometry={shape.fill} position={[0, 0.035, 0]}>
          <meshBasicMaterial
            map={hatch}
            color="#dfe4ea"
            transparent
            opacity={0.22}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {isSelected && (
        <mesh ref={pulseRef} geometry={shape.border} position={[0, 0.05, 0]}>
          <meshBasicMaterial
            color={unclaimed ? "#c5cad3" : "#ffffff"}
            transparent
            opacity={0.65}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {isVendetta && (
        <mesh ref={flashRef} geometry={shape.border} position={[0, 0.055, 0]}>
          <meshBasicMaterial
            color={MAP_STATUS.vendetta}
            transparent
            opacity={0.85}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
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
  const shapes = useMemo(() => districtShapes(layout), [layout]);
  const byId = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);
  const overview = useMapView((s) => s.overview);

  return (
    <group>
      {layout.centers.map((c) => {
        const t = byId.get(c.territoryId);
        const shape = shapes.get(c.territoryId);
        if (!t || !shape) return null;
        return <DistrictShape key={c.territoryId} territory={t} shape={shape} />;
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
