import { useMemo } from "react";
import { Text } from "@react-three/drei";
import {
  GRID_H,
  GRID_W,
  type CityLayout,
} from "@/engine/cityLayout";
import { useMapView } from "@/engine/mapView";
import { avenueName, streetName } from "@/data/streets";

interface Props {
  layout: CityLayout;
}

interface StreetLabel {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Vertical corridor (avenue) — text runs along Z. */
  vertical: boolean;
}

/** Road paint: pale cream, a touch transparent so the asphalt grain shows through. */
const PAINT = "#e9dfc4";
const PAINT_EDGE = "#1a1814";
const AVENUE_ROWS = [6, 14, 22, 30];
const STREET_COLS = [6, 14, 22, 30, 38];
const FLAT_X: [number, number, number] = [-Math.PI / 2, 0, 0];
const FLAT_Z: [number, number, number] = [-Math.PI / 2, 0, Math.PI / 2];

/** Place sparse labels along road corridors; skip water and intersections. */
function buildStreetLabels(layout: CityLayout): StreetLabel[] {
  const byKey = new Map(
    layout.blocks.map((b) => [`${b.gx},${b.gz}`, b] as const),
  );

  const labels: StreetLabel[] = [];

  const isUsableRoad = (gx: number, gz: number) => {
    const b = byKey.get(`${gx},${gz}`);
    return !!b && b.kind === "road";
  };

  // Avenues (N–S): gx % 4 === 0
  for (let gx = 4; gx < GRID_W - 2; gx += 4) {
    const corridor = gx / 4;
    for (const gz of AVENUE_ROWS) {
      if (gz % 4 === 0) continue;
      if (!isUsableRoad(gx, gz)) continue;
      const b = byKey.get(`${gx},${gz}`)!;
      labels.push({
        id: `ave-${gx}-${gz}`,
        name: avenueName(corridor),
        x: b.worldX,
        z: b.worldZ,
        vertical: true,
      });
    }
  }

  // Streets (E–W): gz % 4 === 0
  for (let gz = 4; gz < GRID_H - 2; gz += 4) {
    const corridor = gz / 4;
    for (const gx of STREET_COLS) {
      if (gx % 4 === 0) continue;
      if (!isUsableRoad(gx, gz)) continue;
      const b = byKey.get(`${gx},${gz}`)!;
      labels.push({
        id: `st-${gx}-${gz}`,
        name: streetName(corridor),
        x: b.worldX,
        z: b.worldZ,
        vertical: false,
      });
    }
  }

  return labels;
}

/**
 * Street names stencilled onto the asphalt like road paint. They sit in the
 * scene, so they take the same light, fog, and grain as the road, and fade
 * out as the borough overview takes over.
 */
export default function StreetLabels({ layout }: Props) {
  const blend = useMapView((s) => s.blend);
  const labels = useMemo(() => buildStreetLabels(layout), [layout]);

  if (blend >= 0.7) return null;
  const opacity = 0.92 * (1 - blend / 0.7);

  return (
    <group>
      {labels.map((l) => (
        <Text
          key={l.id}
          position={[l.x, 0.035, l.z]}
          rotation={l.vertical ? FLAT_Z : FLAT_X}
          fontSize={0.78}
          letterSpacing={0.12}
          anchorX="center"
          anchorY="middle"
          color={PAINT}
          fillOpacity={opacity}
          outlineWidth={0.03}
          outlineColor={PAINT_EDGE}
          outlineOpacity={opacity * 0.9}
          depthOffset={-2}
          renderOrder={2}
          material-toneMapped={false}
          material-depthWrite={false}
        >
          {l.name.toUpperCase()}
        </Text>
      ))}
    </group>
  );
}
