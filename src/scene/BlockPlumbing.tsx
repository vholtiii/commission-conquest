import { useMemo, useRef, useState } from "react";
import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import { hasSafehouse } from "@/engine/economy";
import { makeManagerLookup, planFeedSpeakeasy, warehouseManagerMods } from "@/engine/liquor";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import type { Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

function Figure({
  position,
  color,
}: {
  position: [number, number, number];
  color: string;
}) {
  return (
    <group position={position}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.22, 0.45, 0.16]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.68, 0]}>
        <boxGeometry args={[0.16, 0.16, 0.16]} />
        <meshStandardMaterial color="#d7c4a8" />
      </mesh>
    </group>
  );
}

function pathPoints(
  path: string[],
  centerById: Map<string, { worldX: number; worldZ: number }>,
  y: number,
): [number, number, number][] {
  return path
    .map((id) => centerById.get(id))
    .filter((c): c is { worldX: number; worldZ: number } => !!c)
    .map((c) => [c.worldX, y, c.worldZ]);
}

/** District center nearest the orbit target. Updates as the camera pans while close. */
function useNearestTerritoryId(layout: CityLayout, enabled: boolean): string | null {
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null;
  const [id, setId] = useState<string | null>(null);
  const last = useRef<string | null>(null);

  useFrame(() => {
    if (!enabled) {
      if (last.current !== null) {
        last.current = null;
        setId(null);
      }
      return;
    }
    const target = controls?.target;
    if (!target) return;
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const c of layout.centers) {
      const d = (c.worldX - target.x) ** 2 + (c.worldZ - target.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestId = c.territoryId;
      }
    }
    if (bestId !== last.current) {
      last.current = bestId;
      setId(bestId);
    }
  });

  return enabled ? id : null;
}

/** Close-camera read of the one district under the lens: routes, manager, safehouse. */
export default function BlockPlumbing({ layout, territories }: Props) {
  const close = useMapView((s) => s.close);
  const overview = useMapView((s) => s.overview);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const routes = useGameStore((s) => s.routes);
  const turn = useGameStore((s) => s.turn);
  const nearestId = useNearestTerritoryId(layout, close && !overview);

  const territory = territories.find((t) => t.id === nearestId) ?? null;
  const owned =
    !!territory &&
    !!playerFamily &&
    territory.discovered &&
    territory.owner === playerFamily;

  const centerById = useMemo(
    () => new Map(layout.centers.map((c) => [c.territoryId, c])),
    [layout.centers],
  );

  const feed = useMemo(() => {
    if (!owned || !territory) return null;
    const plan = planFeedSpeakeasy(
      { territories, crew, playerFamily, turn },
      territory.id,
    );
    return plan.ok ? plan.path : null;
  }, [owned, territory, territories, crew, playerFamily, turn]);

  if (!owned || !territory || !playerFamily) return null;

  const center = centerById.get(territory.id);
  const lookup = makeManagerLookup(crew, playerFamily);
  const color = FAMILY_HEX[playerFamily];
  const liveRoutes = routes.filter(
    (r) => r.status === "active" && r.path.includes(territory.id),
  );

  return (
    <group>
      {liveRoutes.map((route) => {
        const points = pathPoints(route.path, centerById, 0.55);
        if (points.length < 2) return null;
        return (
          <Line
            key={route.id}
            points={points}
            color={FAMILY_HEX[route.family]}
            lineWidth={3}
          />
        );
      })}

      {feed && feed.length >= 2 && (
        <Line
          points={pathPoints(feed, centerById, 0.7)}
          color="#c9a227"
          lineWidth={1.5}
          dashed
          dashScale={2}
          dashSize={0.45}
          gapSize={0.3}
        />
      )}

      {territory.rackets.map((racket) => {
        if (racket.type !== "warehouse") return null;
        if (!warehouseManagerMods(lookup(racket)).managed) return null;
        const site =
          typeof racket.siteIndex === "number"
            ? racket.siteIndex
            : territory.rackets.indexOf(racket);
        const block = racketBlockFor(layout, territory.id, site);
        if (!block) return null;
        return (
          <Figure
            key={racket.id}
            position={[block.worldX, 0, block.worldZ + 0.85]}
            color={color}
          />
        );
      })}

      {center && hasSafehouse(territory, turn) && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[center.worldX, 0.06, center.worldZ]}
        >
          <ringGeometry args={[3.1, 3.55, 40]} />
          <meshBasicMaterial
            color="#5E6770"
            transparent
            opacity={0.5}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}
