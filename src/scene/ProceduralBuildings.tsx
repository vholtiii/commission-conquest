import { useMemo } from "react";
import * as THREE from "three";
import { Instance, Instances } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { BLOCK_SIZE, blockKey } from "@/engine/cityLayout";
import type { FamilyName, Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  PARK_COLOR,
  ROAD_COLOR,
  WATER_COLOR,
  clamp,
  hash2,
  pickPalette,
} from "./sceneTheme";

function tintTowardFamily(baseHex: string, familyHex: string, amount: number): string {
  const a = new THREE.Color(baseHex);
  const b = new THREE.Color(familyHex);
  return a.lerp(b, amount).getStyle();
}

interface Props {
  layout: CityLayout;
  seed: number;
  occupied?: Set<string>;
  territories: Territory[];
}

/** Builds a small canvas texture with a grid of lit/dark windows. */
function makeWindowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#00000000";
  ctx.clearRect(0, 0, size, size);
  const cols = 4;
  const rows = 6;
  const cellW = size / cols;
  const cellH = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = Math.random() < 0.35;
      ctx.fillStyle = lit ? "rgba(255, 214, 130, 0.9)" : "rgba(20, 22, 26, 0.55)";
      const pad = cellW * 0.18;
      ctx.fillRect(c * cellW + pad, r * cellH + pad, cellW - pad * 2, cellH - pad * 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface BuildingInstanceData {
  key: string;
  x: number;
  z: number;
  height: number;
  color: string;
  roofColor: string;
  rotationY: number;
}

export default function ProceduralBuildings({ layout, seed, occupied, territories }: Props) {
  const windowTex = useMemo(() => makeWindowTexture(), []);
  const playerFamily = useGameStore((s) => s.playerFamily);

  const ownerByTerritory = useMemo(() => {
    const m = new Map<string, FamilyName | null>();
    for (const t of territories) m.set(t.id, t.owner);
    return m;
  }, [territories]);

  const { buildings, roads, water, parks, plates } = useMemo(() => {
    const buildings: BuildingInstanceData[] = [];
    const roads: { x: number; z: number }[] = [];
    const water: { x: number; z: number }[] = [];
    const parks: { x: number; z: number }[] = [];
    const plates: { x: number; z: number; color: string; opacity: number }[] = [];

    for (const b of layout.blocks) {
      if (b.kind === "building") {
        const key = blockKey(b.gx, b.gz);
        if (occupied?.has(key)) continue;

        const r = hash2(b.gx, b.gz, seed);
        const tall = r > 0.97;
        const baseHeight = clamp(b.heightBias * 2.4, 1.0, 4.2);
        const height = tall ? baseHeight + r * 4.5 : baseHeight;
        const brick = pickPalette(b.gx, b.gz, seed);
        const owner = b.territoryId ? ownerByTerritory.get(b.territoryId) ?? null : null;
        // Owned blocks lean toward the family hue so all of a family's turf reads as one color
        const color = owner ? tintTowardFamily(brick, FAMILY_HEX[owner], 0.42) : brick;
        buildings.push({
          key,
          x: b.worldX,
          z: b.worldZ,
          height,
          color,
          roofColor: new THREE.Color(color).multiplyScalar(0.72).getStyle(),
          rotationY: 0,
        });

        if (owner) {
          plates.push({
            x: b.worldX,
            z: b.worldZ,
            color: FAMILY_HEX[owner],
            opacity: owner === playerFamily ? 0.22 : 0.14,
          });
        }
      } else if (b.kind === "road") {
        roads.push({ x: b.worldX, z: b.worldZ });
      } else if (b.kind === "water") {
        water.push({ x: b.worldX, z: b.worldZ });
      } else if (b.kind === "park") {
        parks.push({ x: b.worldX, z: b.worldZ });
      }
    }
    return { buildings, roads, water, parks, plates };
  }, [layout, seed, occupied, ownerByTerritory, playerFamily]);

  const groundSize = BLOCK_SIZE + 0.15;

  return (
    <group>
      {/* Per-block ownership tint — continuous family color across the district */}
      {plates.map((p, i) => (
        <mesh key={`plate-${i}`} position={[p.x, 0.012, p.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[groundSize, groundSize]} />
          <meshBasicMaterial color={p.color} transparent opacity={p.opacity} depthWrite={false} />
        </mesh>
      ))}

      {/* Roads */}
      <Instances limit={roads.length || 1} range={roads.length}>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial color={ROAD_COLOR} roughness={1} />
        {roads.map((c, i) => (
          <Instance
            key={`road-${i}`}
            position={[c.x, 0.01, c.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          />
        ))}
      </Instances>

      {/* Water */}
      <Instances limit={water.length || 1} range={water.length}>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial color={WATER_COLOR} roughness={0.35} metalness={0.15} />
        {water.map((c, i) => (
          <Instance
            key={`water-${i}`}
            position={[c.x, 0, c.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          />
        ))}
      </Instances>

      {/* Parks */}
      <Instances limit={parks.length || 1} range={parks.length}>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial color={PARK_COLOR} roughness={1} />
        {parks.map((c, i) => (
          <Instance
            key={`park-${i}`}
            position={[c.x, 0.01, c.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          />
        ))}
      </Instances>

      {/* Building bodies (windows texture) */}
      <Instances limit={buildings.length || 1} range={buildings.length}>
        <boxGeometry args={[BLOCK_SIZE * 0.86, 1, BLOCK_SIZE * 0.86]} />
        <meshStandardMaterial map={windowTex} roughness={0.85} />
        {buildings.map((b, i) => (
          <Instance
            key={`bld-${b.key}-${i}`}
            position={[b.x, b.height / 2, b.z]}
            scale={[1, b.height, 1]}
            color={b.color}
          />
        ))}
      </Instances>

      {/* Flat roofs */}
      <Instances limit={buildings.length || 1} range={buildings.length}>
        <boxGeometry args={[BLOCK_SIZE * 0.88, 0.12, BLOCK_SIZE * 0.88]} />
        <meshStandardMaterial roughness={0.9} />
        {buildings.map((b, i) => (
          <Instance
            key={`roof-${b.key}-${i}`}
            position={[b.x, b.height + 0.06, b.z]}
            color={b.roofColor}
          />
        ))}
      </Instances>
    </group>
  );
}
