import { useMemo } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Crown } from "lucide-react";
import type { CityLayout } from "@/engine/cityLayout";
import { familyHq, resolveCrewLocation } from "@/engine/crewLocation";
import { isCrewVisible, normalizeIntel } from "@/engine/intel";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import type { FamilyName, Territory } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS } from "@/types/game";
import { districtShapes, getDistrictHatch, type DistrictShape } from "./districtShapes";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

/** The wash is paint. The district plate underneath takes the click. */
function ignoreRaycast() {
  return null;
}

interface CrownInfo {
  family: FamilyName;
  label: string;
  isPlayer: boolean;
}

function StrategicTile({
  territory,
  shape,
  blend,
  crown,
}: {
  territory: Territory;
  shape: DistrictShape;
  blend: number;
  crown: CrownInfo | null;
}) {
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const hatch = useMemo(() => (territory.discovered && !territory.owner ? getDistrictHatch() : null), [territory.discovered, territory.owner]);

  const discovered = territory.discovered;
  const unclaimed = !territory.owner;
  const ownedByPlayer = territory.owner === playerFamily;
  const baseColor = !discovered
    ? "#23262c"
    : territory.owner
      ? FAMILY_HEX[territory.owner]
      : MAP_STATUS.neutral;
  const borderColor = !discovered ? "#3a3d44" : unclaimed ? MAP_STATUS.neutral : baseColor;

  const fillOp = (!discovered ? 0.8 : unclaimed ? 0.22 : 0.55) * blend;
  const ringOp = (!discovered ? 0.55 : unclaimed ? 0.4 : 0.95) * blend;

  return (
    <group position={[0, 0.5, 0]} raycast={() => null}>
      <mesh raycast={ignoreRaycast} geometry={shape.fill} renderOrder={20}>
        <meshBasicMaterial
          color={baseColor}
          transparent
          opacity={fillOp}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {hatch && (
        <mesh raycast={ignoreRaycast} geometry={shape.fill} position={[0, 0.002, 0]} renderOrder={21}>
          <meshBasicMaterial
            map={hatch}
            color="#9aa0a8"
            transparent
            opacity={0.35 * blend}
            depthTest={false}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <mesh raycast={ignoreRaycast} geometry={shape.border} position={[0, 0.004, 0]} renderOrder={22}>
        <meshBasicMaterial
          color={borderColor}
          transparent
          opacity={ringOp}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {ownedByPlayer && (
        <mesh raycast={ignoreRaycast} geometry={shape.inner} position={[0, 0.006, 0]} renderOrder={23}>
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

      {discovered && (
        <Html
          position={[shape.anchor.x, 0.02, shape.anchor.z]}
          center
          occlude={false}
          zIndexRange={[6, 2]}
          style={{ pointerEvents: blend > 0.05 ? "auto" : "none", opacity: blend }}
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
  const shapes = useMemo(() => districtShapes(layout), [layout]);
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
        const shape = shapes.get(c.territoryId);
        if (!t || !shape) return null;
        return (
          <StrategicTile
            key={c.territoryId}
            territory={t}
            shape={shape}
            blend={blend}
            crown={crownsByTerritory.get(c.territoryId) ?? null}
          />
        );
      })}
    </group>
  );
}
