import { useEffect, useMemo, useRef } from "react";
import { Html, Instances, Instance } from "@react-three/drei";
import * as THREE from "three";
import {
  BLOCK_SIZE,
  ROAD_GAP,
  blockKey,
  type CityLayout,
} from "@/engine/cityLayout";
import { useMapView } from "@/engine/mapView";
import { boroughColor } from "@/data/boroughs";
import type { Territory } from "@/types/game";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const PITCH = BLOCK_SIZE + ROAD_GAP;
const FILL_Y = 0.4;
const BOUNDARY_WIDTH = 0.28;
const BOUNDARY_COLOR = "#e8e2d0";
const FILL_OPACITY = 0.42;

interface FillCell {
  x: number;
  z: number;
}

interface BoroughLabel {
  name: string;
  x: number;
  z: number;
}

function buildBoundaryGeometry(
  edges: Array<{ x0: number; z0: number; x1: number; z1: number }>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const halfW = BOUNDARY_WIDTH / 2;

  for (const e of edges) {
    const dx = e.x1 - e.x0;
    const dz = e.z1 - e.z0;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * halfW;
    const pz = (dx / len) * halfW;

    const base = positions.length / 3;
    positions.push(e.x0 + px, 0, e.z0 + pz);
    positions.push(e.x0 - px, 0, e.z0 - pz);
    positions.push(e.x1 - px, 0, e.z1 - pz);
    positions.push(e.x1 + px, 0, e.z1 + pz);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function BoroughFillGroup({
  color,
  cells,
  blend,
}: {
  color: string;
  cells: FillCell[];
  blend: number;
}) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  useEffect(() => {
    if (matRef.current) matRef.current.opacity = FILL_OPACITY * blend;
  }, [blend]);

  if (cells.length === 0) return null;

  return (
    <Instances limit={cells.length} range={cells.length} renderOrder={15}>
      <planeGeometry args={[PITCH, PITCH]} />
      <meshBasicMaterial
        ref={matRef}
        color={color}
        transparent
        opacity={FILL_OPACITY * blend}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
      {cells.map((f, i) => (
        <Instance
          key={i}
          position={[f.x, FILL_Y, f.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
      ))}
    </Instances>
  );
}

export default function BoroughOverlay({ layout, territories }: Props) {
  const blend = useMapView((s) => s.blend);
  const boundaryMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const byId = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);

  const { fillsByBorough, boundaryGeo, labels } = useMemo(() => {
    const fillsByBorough = new Map<string, FillCell[]>();
    const boroughOf = new Map<string, string | null>();
    const blockByKey = new Map<string, (typeof layout.blocks)[0]>();

    for (const b of layout.blocks) {
      blockByKey.set(blockKey(b.gx, b.gz), b);
      if (!b.territoryId) {
        boroughOf.set(blockKey(b.gx, b.gz), null);
        continue;
      }
      const t = byId.get(b.territoryId);
      const borough = t?.borough ?? null;
      boroughOf.set(blockKey(b.gx, b.gz), borough);
      if (borough) {
        const list = fillsByBorough.get(borough) ?? [];
        list.push({ x: b.worldX, z: b.worldZ });
        fillsByBorough.set(borough, list);
      }
    }

    const edges: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];
    for (const b of layout.blocks) {
      const boro = boroughOf.get(blockKey(b.gx, b.gz));
      if (!boro) continue;

      const right = blockByKey.get(blockKey(b.gx + 1, b.gz));
      if (right) {
        const rb = boroughOf.get(blockKey(right.gx, right.gz));
        if (rb && rb !== boro) {
          const midX = (b.worldX + right.worldX) / 2;
          const half = PITCH / 2;
          edges.push({
            x0: midX,
            z0: b.worldZ - half,
            x1: midX,
            z1: b.worldZ + half,
          });
        }
      }

      const down = blockByKey.get(blockKey(b.gx, b.gz + 1));
      if (down) {
        const db = boroughOf.get(blockKey(down.gx, down.gz));
        if (db && db !== boro) {
          const midZ = (b.worldZ + down.worldZ) / 2;
          const half = PITCH / 2;
          edges.push({
            x0: b.worldX - half,
            z0: midZ,
            x1: b.worldX + half,
            z1: midZ,
          });
        }
      }
    }

    const sums = new Map<string, { sx: number; sz: number; n: number }>();
    for (const b of layout.blocks) {
      const boro = boroughOf.get(blockKey(b.gx, b.gz));
      if (!boro) continue;
      const s = sums.get(boro) ?? { sx: 0, sz: 0, n: 0 };
      s.sx += b.worldX;
      s.sz += b.worldZ;
      s.n += 1;
      sums.set(boro, s);
    }
    const labels: BoroughLabel[] = [];
    for (const [name, s] of sums) {
      labels.push({ name, x: s.sx / s.n, z: s.sz / s.n });
    }

    return {
      fillsByBorough,
      boundaryGeo: buildBoundaryGeometry(edges),
      labels,
    };
  }, [layout, byId]);

  useEffect(() => {
    return () => {
      boundaryGeo.dispose();
    };
  }, [boundaryGeo]);

  useEffect(() => {
    if (boundaryMatRef.current) boundaryMatRef.current.opacity = 0.7 * blend;
  }, [blend]);

  if (blend <= 0.01) return null;

  return (
    <group>
      {[...fillsByBorough.entries()].map(([name, cells]) => (
        <BoroughFillGroup
          key={name}
          color={boroughColor(name)}
          cells={cells}
          blend={blend}
        />
      ))}

      <mesh
        geometry={boundaryGeo}
        position={[0, FILL_Y + 0.02, 0]}
        renderOrder={16}
      >
        <meshBasicMaterial
          ref={boundaryMatRef}
          color={BOUNDARY_COLOR}
          transparent
          opacity={0.7 * blend}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {labels.map((l) => (
        <Html
          key={l.name}
          position={[l.x, FILL_Y + 0.05, l.z]}
          center
          occlude={false}
          zIndexRange={[3, 1]}
          style={{ pointerEvents: "none", opacity: blend }}
        >
          <div
            className="select-none whitespace-nowrap text-[15px] font-ui font-bold uppercase tracking-[0.25em]"
            style={{
              color: "rgba(243, 239, 228, 0.75)",
              textShadow: "0 1px 4px rgba(0,0,0,0.85), 0 0 12px rgba(0,0,0,0.5)",
            }}
          >
            {l.name}
          </div>
        </Html>
      ))}
    </group>
  );
}
