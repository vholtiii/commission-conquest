import { useMemo } from "react";
import { Line } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { MAP_STATUS } from "@/types/game";

type Props = { layout: CityLayout };

const Y = 0.45;

/** Dotted road across the district centres on a path. */
function DottedRoad({
  points,
  color,
  emphasis,
}: {
  points: [number, number, number][];
  color: string;
  emphasis: boolean;
}) {
  if (points.length < 2) return null;
  return (
    <Line
      points={points}
      color={color}
      lineWidth={emphasis ? 2.6 : 1.4}
      transparent
      opacity={emphasis ? 0.95 : 0.55}
      dashed
      dashScale={1}
      dashSize={emphasis ? 0.22 : 0.18}
      gapSize={emphasis ? 0.3 : 0.32}
    />
  );
}

/** Small disc at each end of the drawn road. */
function EndCap({ x, z, color }: { x: number; z: number; color: string }) {
  return (
    <mesh position={[x, Y - 0.02, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.42, 0.6, 24]} />
      <meshBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} />
    </mesh>
  );
}

/**
 * Supply-route drawing. A standing route clicked in the Warehouse panel is
 * drawn as a dotted purple road; while a new route is being planned every
 * candidate road is drawn dotted grey with the chosen one in purple.
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
      .map((c) => [c!.worldX, Y, c!.worldZ] as [number, number, number]);

  if (hitPlaying || sitdownPhase) return null;

  const focused = focusId ? supplyRoutes.find((r) => r.id === focusId) : undefined;

  return (
    <group>
      {focused && (() => {
        const pts = toPoints(focused.path);
        if (pts.length < 2) return null;
        const a = pts[0]!;
        const b = pts[pts.length - 1]!;
        return (
          <group key={focused.id}>
            <DottedRoad points={pts} color={MAP_STATUS.supplyRoute} emphasis />
            <EndCap x={a[0]} z={a[2]} color={MAP_STATUS.supplyRoute} />
            <EndCap x={b[0]} z={b[2]} color={MAP_STATUS.supplyRoute} />
          </group>
        );
      })()}

      {preview &&
        preview.options
          // Draw the chosen road last so it sits on top of the grey ones.
          .slice()
          .sort((a, b) => Number(a.id === preview.chosenId) - Number(b.id === preview.chosenId))
          .map((o) => {
            const chosen = o.id === preview.chosenId;
            const pts = toPoints(o.path);
            if (pts.length < 2) return null;
            const a = pts[0]!;
            const b = pts[pts.length - 1]!;
            const color = chosen ? MAP_STATUS.supplyRoute : MAP_STATUS.supplyOption;
            return (
              <group key={o.id}>
                <DottedRoad points={pts} color={color} emphasis={chosen} />
                {chosen && (
                  <>
                    <EndCap x={a[0]} z={a[2]} color={color} />
                    <EndCap x={b[0]} z={b[2]} color={color} />
                  </>
                )}
              </group>
            );
          })}
    </group>
  );
}
