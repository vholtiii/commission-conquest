import { useMemo } from "react";
import { Html } from "@react-three/drei";
import { Crown } from "lucide-react";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { familyHq, resolveCrewLocation } from "@/engine/crewLocation";
import { isCrewVisible, normalizeIntel } from "@/engine/intel";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { FamilyName, Territory } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS } from "@/types/game";
import { makeSquareRingGeometry } from "./DistrictOverlay";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const TILE = 7.6;

function makeHatchGeometry(size: number, stripes = 5): THREE.ShapeGeometry {
  const shapes: THREE.Shape[] = [];
  const half = size / 2;
  const step = size / (stripes + 1);
  const thick = 0.22;
  for (let i = 1; i <= stripes; i++) {
    const s = new THREE.Shape();
    // Diagonal bands across the square (local XY before rotation to XZ)
    const o = -half + i * step;
    s.moveTo(-half, o - thick);
    s.lineTo(half, o + size * 0.55 - thick);
    s.lineTo(half, o + size * 0.55 + thick);
    s.lineTo(-half, o + thick);
    s.closePath();
    shapes.push(s);
  }
  return new THREE.ShapeGeometry(shapes);
}

function makeDashedRingGeometry(size: number, segments = 8): THREE.ShapeGeometry {
  const shapes: THREE.Shape[] = [];
  const half = size / 2;
  const outer = half;
  const inner = half - 0.28;
  const gap = 0.18;
  // Top / bottom / left / right mid-segments (simplified dashed look)
  const edges: Array<[number, number, number, number]> = [
    [-outer + gap, outer, outer - gap, outer],
    [-outer + gap, -outer, outer - gap, -outer],
    [-outer, -outer + gap, -outer, outer - gap],
    [outer, -outer + gap, outer, outer - gap],
  ];
  // Also add corner stubs for more "dashed" feel
  const corners: Array<[number, number, number, number]> = [
    [-outer, outer - 0.9, -outer, outer],
    [-outer, outer, -outer + 0.9, outer],
    [outer - 0.9, outer, outer, outer],
    [outer, outer, outer, outer - 0.9],
    [-outer, -outer, -outer, -outer + 0.9],
    [-outer, -outer, -outer + 0.9, -outer],
    [outer - 0.9, -outer, outer, -outer],
    [outer, -outer, outer, -outer + 0.9],
  ];
  void segments;
  for (const [x0, z0, x1, z1] of [...edges, ...corners]) {
    const s = new THREE.Shape();
    const dx = Math.sign(x1 - x0) || 0;
    const dz = Math.sign(z1 - z0) || 0;
    const t = 0.22;
    if (Math.abs(x1 - x0) > Math.abs(z1 - z0)) {
      // horizontal
      const y = z0;
      const xa = Math.min(x0, x1);
      const xb = Math.max(x0, x1);
      s.moveTo(xa, y - t);
      s.lineTo(xb, y - t);
      s.lineTo(xb, y + t);
      s.lineTo(xa, y + t);
    } else {
      const x = x0;
      const za = Math.min(z0, z1);
      const zb = Math.max(z0, z1);
      s.moveTo(x - t, za);
      s.lineTo(x + t, za);
      s.lineTo(x + t, zb);
      s.lineTo(x - t, zb);
    }
    void dx;
    void dz;
    void inner;
    s.closePath();
    shapes.push(s);
  }
  return new THREE.ShapeGeometry(shapes);
}

interface CrownInfo {
  family: FamilyName;
  label: string;
  isPlayer: boolean;
}

function StrategicTile({
  territory,
  cx,
  cz,
  blend,
  crown,
}: {
  territory: Territory;
  cx: number;
  cz: number;
  blend: number;
  crown: CrownInfo | null;
}) {
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const playerFamily = useGameStore((s) => s.playerFamily);

  const outlineGeo = useMemo(() => makeSquareRingGeometry(TILE, TILE - 0.45), []);
  const innerRingGeo = useMemo(() => makeSquareRingGeometry(TILE - 0.9, TILE - 1.2), []);
  const hatchGeo = useMemo(() => makeHatchGeometry(TILE - 0.6), []);
  const dashedGeo = useMemo(() => makeDashedRingGeometry(TILE), []);

  const discovered = territory.discovered;
  const unclaimed = !territory.owner;
  const ownedByPlayer = territory.owner === playerFamily;
  const baseColor = !discovered
    ? "#23262c"
    : territory.owner
      ? FAMILY_HEX[territory.owner]
      : MAP_STATUS.neutral;

  const fillOp = (!discovered ? 0.8 : unclaimed ? 0.22 : 0.55) * blend;
  const ringOp = (!discovered ? 0.55 : unclaimed ? 0.4 : 0.95) * blend;

  return (
    <group position={[cx, 0.5, cz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={20}>
        <planeGeometry args={[TILE, TILE]} />
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={fillOp}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>

      {!discovered ? (
        <mesh geometry={outlineGeo} rotation={[-Math.PI / 2, 0, 0]} renderOrder={21}>
          <meshBasicMaterial
            color="#3a3d44"
            transparent
            opacity={ringOp}
            depthTest={false}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : unclaimed ? (
        <>
          <mesh geometry={hatchGeo} rotation={[-Math.PI / 2, 0, 0]} renderOrder={21}>
            <meshBasicMaterial
              color="#9aa0a8"
              transparent
              opacity={0.35 * blend}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh geometry={dashedGeo} rotation={[-Math.PI / 2, 0, 0]} renderOrder={22}>
            <meshBasicMaterial
              color={MAP_STATUS.neutral}
              transparent
              opacity={0.55 * blend}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      ) : (
        <>
          <mesh geometry={outlineGeo} rotation={[-Math.PI / 2, 0, 0]} renderOrder={21}>
            <meshBasicMaterial
              color={baseColor}
              transparent
              opacity={ringOp}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          {ownedByPlayer && (
            <mesh geometry={innerRingGeo} rotation={[-Math.PI / 2, 0, 0]} renderOrder={22}>
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.6 * blend}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          )}
        </>
      )}

      {discovered && (
        <Html
          position={[0, 0.02, 0]}
          center
          occlude={false}
          zIndexRange={[6, 2]}
          style={{ pointerEvents: "auto", opacity: blend }}
        >
          <button
            type="button"
            className="flex select-none flex-col items-center gap-0.5 border-0 bg-transparent p-0"
            onPointerDown={(e) => {
              e.stopPropagation();
              selectTerritory(territory.id);
            }}
          >
            {crown && (
              <div
                className="mb-0.5 flex items-center gap-1 rounded-full border border-amber-200/80 px-1.5 py-0.5 shadow"
                style={{ background: FAMILY_HEX[crown.family] }}
              >
                <Crown className="h-3 w-3 text-amber-100" />
                <span className="text-[10px] font-ui font-semibold text-white">
                  {crown.label}
                </span>
                {crown.isPlayer && (
                  <span className="rounded bg-black/40 px-1 text-[9px] uppercase tracking-wide text-amber-100">
                    You
                  </span>
                )}
              </div>
            )}
            <span className="whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-ui font-bold text-white">
              {territory.name}
            </span>
            <span
              className="whitespace-nowrap rounded bg-black/55 px-1 py-0.5 text-[9px] font-ui font-medium"
              style={{
                color: territory.owner ? FAMILY_HEX[territory.owner] : "#c5cad3",
              }}
            >
              {territory.owner ?? "Unclaimed"}
            </span>
          </button>
        </Html>
      )}
    </group>
  );
}

export default function StrategicOverlay({ layout, territories }: Props) {
  const blend = useMapView((s) => s.blend);
  const overview = useMapView((s) => s.overview);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);

  const byId = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);

  const crownsByTerritory = useMemo(() => {
    const map = new Map<string, CrownInfo>();
    const locState = {
      crew,
      territories,
      routes,
      operations,
      playerFamily,
      intel: normalizeIntel(intel),
      turn,
    };

    for (const family of ALL_FAMILY_NAMES) {
      const hq = familyHq({ territories }, family);
      if (!hq) continue;
      const boss = crew.find((c) => c.family === family && c.role === "boss" && c.status === "active");
      const isPlayer = family === playerFamily;
      // The crown marks the HQ, which everyone knows. Who's sitting in the
      // chair right now is intel: without it the label is just the family.
      const lastName =
        boss && (isPlayer || isCrewVisible(locState, boss))
          ? boss.name.split(" ").slice(-1)[0]!
          : getFamilyDef(family).boss.split(" ").slice(-1)[0]!;

      let tileId = hq;
      if (isPlayer && boss) {
        const loc = resolveCrewLocation(locState, boss.id);
        if (loc.territoryId) {
          const t = byId.get(loc.territoryId);
          if (t?.discovered) tileId = loc.territoryId;
        }
      }

      // Prefer player crown if two somehow collide (shouldn't)
      const existing = map.get(tileId);
      if (existing && existing.isPlayer && !isPlayer) continue;
      map.set(tileId, { family, label: lastName, isPlayer });
    }
    return map;
  }, [crew, territories, routes, operations, playerFamily, intel, turn, byId]);

  if (blend <= 0.01 && !overview) return null;

  return (
    <group>
      {layout.centers.map((c) => {
        const t = byId.get(c.territoryId);
        if (!t) return null;
        return (
          <StrategicTile
            key={c.territoryId}
            territory={t}
            cx={c.worldX}
            cz={c.worldZ}
            blend={blend}
            crown={crownsByTerritory.get(c.territoryId) ?? null}
          />
        );
      })}
    </group>
  );
}
