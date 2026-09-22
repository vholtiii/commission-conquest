import { useMemo } from "react";
import { Html } from "@react-three/drei";
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
  /** Vertical corridor (avenue) — rotate label. */
  vertical: boolean;
}

/** Place sparse labels along road corridors; skip water and dense intersections. */
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
    for (const gz of [8, 18, 28]) {
      if (gz % 4 === 0) continue; // skip cross-street intersections
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
    for (const gx of [10, 22, 34]) {
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
 * Subtle mid-zoom street names along the procedural grid.
 * Fades out as the borough/strategic overlay takes over.
 */
export default function StreetLabels({ layout }: Props) {
  const blend = useMapView((s) => s.blend);
  const labels = useMemo(() => buildStreetLabels(layout), [layout]);

  // Visible while close/mid; fade as borough overview takes over
  if (blend >= 0.7) return null;
  const opacity = 0.85 * (1 - blend / 0.7);

  return (
    <group>
      {labels.map((l) => (
        <Html
          key={l.id}
          position={[l.x, 0.08, l.z]}
          center
          occlude={false}
          zIndexRange={[2, 0]}
          style={{ pointerEvents: "none", opacity }}
        >
          <div
            className="select-none whitespace-nowrap font-ui text-[11px] font-semibold tracking-[0.14em] uppercase"
            style={{
              color: "rgba(236, 230, 214, 0.92)",
              textShadow:
                "0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.7)",
              transform: l.vertical ? "rotate(-90deg)" : undefined,
            }}
          >
            {l.name}
          </div>
        </Html>
      ))}
    </group>
  );
}
