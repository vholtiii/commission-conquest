import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Instance, Instances, Text } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { BLOCK_SIZE, GRID_W, ROAD_GAP, blockKey } from "@/engine/cityLayout";
import type { FamilyName, Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  asphaltTexture,
  intersectionTexture,
  parkTexture,
  sidewalkTexture,
  waterNormalTexture,
} from "./groundTextures";
import { WATER_COLOR, clamp, hash2, pickPalette } from "./sceneTheme";

const WINDOW_VARIANTS = 4;
const WATER_NORMAL_SCALE = new THREE.Vector2(0.25, 0.25);
const PITCH = BLOCK_SIZE + ROAD_GAP;
/** A 3x3 block of cells plus the gaps out to the road edge on every side. */
const SLAB_SIZE = 4 * PITCH - BLOCK_SIZE;
const ROAD_FLAT: [number, number, number] = [-Math.PI / 2, 0, 0];
const WATER_Y = -0.06;

interface RiverSheet {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

interface ShoreEdge {
  id: string;
  x: number;
  z: number;
  /** Long axis of the deck follows the shore. */
  rot: number;
  crane: boolean;
  craneRot: number;
  sign: boolean;
  signX: number;
  signZ: number;
  signRot: number;
}

function cellKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

/** Greedy rectangles over a set of "gx,gz" keys. */
function coverCells(keys: string[]): { gx0: number; gx1: number; gz0: number; gz1: number }[] {
  const remaining = new Set(keys);
  const rects: { gx0: number; gx1: number; gz0: number; gz1: number }[] = [];
  const ordered = [...remaining]
    .map((key) => {
      const [gx, gz] = key.split(",").map(Number);
      return { gx: gx!, gz: gz! };
    })
    .sort((a, b) => a.gz - b.gz || a.gx - b.gx);
  for (const start of ordered) {
    if (!remaining.has(cellKey(start.gx, start.gz))) continue;
    let gx1 = start.gx;
    while (remaining.has(cellKey(gx1 + 1, start.gz))) gx1++;
    let gz1 = start.gz;
    for (;;) {
      let row = true;
      for (let gx = start.gx; gx <= gx1; gx++) {
        if (!remaining.has(cellKey(gx, gz1 + 1))) {
          row = false;
          break;
        }
      }
      if (!row) break;
      gz1++;
    }
    for (let gz = start.gz; gz <= gz1; gz++) {
      for (let gx = start.gx; gx <= gx1; gx++) remaining.delete(cellKey(gx, gz));
    }
    rects.push({ gx0: start.gx, gx1, gz0: start.gz, gz1 });
  }
  return rects;
}

/** West river, east river, and the south harbor, each as one or two solid sheets. */
function riverSheets(layout: CityLayout): RiverSheet[] {
  const west: string[] = [];
  const east: string[] = [];
  const south: string[] = [];
  for (const b of layout.blocks) {
    if (b.kind !== "water") continue;
    const key = cellKey(b.gx, b.gz);
    if (b.gx <= 2) west.push(key);
    else if (b.gx >= GRID_W - 3) east.push(key);
    else south.push(key);
  }
  const sheets: RiverSheet[] = [];
  const emit = (name: string, keys: string[]) => {
    for (const rect of coverCells(keys)) {
      const x0 = rect.gx0 * PITCH - layout.width / 2;
      const x1 = (rect.gx1 + 1) * PITCH - layout.width / 2;
      const z0 = rect.gz0 * PITCH - layout.depth / 2;
      const z1 = (rect.gz1 + 1) * PITCH - layout.depth / 2;
      sheets.push({
        id: `${name}-${rect.gx0}-${rect.gz0}`,
        x: (x0 + x1) / 2,
        z: (z0 + z1) / 2,
        w: x1 - x0,
        d: z1 - z0,
      });
    }
  };
  emit("west", west);
  emit("east", east);
  emit("south", south);
  return sheets;
}

const SHORE_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A deck segment on every water-facing cell of a docks district, plus one crane and sign. */
function shoreEdges(layout: CityLayout, territories: Territory[]): ShoreEdge[] {
  const docks = new Set(territories.filter((t) => t.feature === "docks").map((t) => t.id));
  if (docks.size === 0) return [];
  const waterAt = new Map(
    layout.blocks.filter((b) => b.kind === "water").map((b) => [cellKey(b.gx, b.gz), b] as const),
  );
  const byDistrict = new Map<
    string,
    { x: number; z: number; dx: number; dz: number; bx: number; bz: number }[]
  >();
  for (const b of layout.blocks) {
    if (b.kind !== "building" || !b.territoryId || !docks.has(b.territoryId)) continue;
    for (const [dx, dz] of SHORE_DIRS) {
      const w = waterAt.get(cellKey(b.gx + dx, b.gz + dz));
      if (!w) continue;
      const nudge = BLOCK_SIZE * 0.22;
      const list = byDistrict.get(b.territoryId) ?? [];
      list.push({
        x: w.worldX - dx * nudge,
        z: w.worldZ - dz * nudge,
        dx,
        dz,
        bx: b.worldX,
        bz: b.worldZ,
      });
      byDistrict.set(b.territoryId, list);
      break;
    }
  }
  const edges: ShoreEdge[] = [];
  for (const [districtId, cells] of byDistrict) {
    const mid = cells[Math.floor(cells.length / 2)];
    cells.forEach((cell, i) => {
      const alongZ = cell.dx !== 0;
      edges.push({
        id: `${districtId}-${i}`,
        x: cell.x,
        z: cell.z,
        rot: alongZ ? Math.PI / 2 : 0,
        crane: cell === mid,
        craneRot: Math.atan2(cell.dx, cell.dz),
        sign: cell === mid,
        signX: cell.bx - cell.dx * BLOCK_SIZE * 0.62,
        signZ: cell.bz - cell.dz * BLOCK_SIZE * 0.62,
        signRot: Math.atan2(-cell.dx, -cell.dz),
      });
    });
  }
  return edges;
}

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

interface WindowMaps {
  albedo: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

function finishTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

/** Seeded facade + lit-pane mask. Instance color tints the albedo only. */
function makeWindowTextureSet(seed: number, count: number): WindowMaps[] {
  const variants: WindowMaps[] = [];
  for (let v = 0; v < count; v++) {
    const size = 128;
    const albedoCanvas = document.createElement("canvas");
    const emissiveCanvas = document.createElement("canvas");
    albedoCanvas.width = emissiveCanvas.width = size;
    albedoCanvas.height = emissiveCanvas.height = size;
    const albedo = albedoCanvas.getContext("2d")!;
    const emissive = emissiveCanvas.getContext("2d")!;

    albedo.fillStyle = "#d4d0c8";
    albedo.fillRect(0, 0, size, size);
    emissive.fillStyle = "#000000";
    emissive.fillRect(0, 0, size, size);

    const cols = 4;
    const rows = 6;
    const cellW = size / cols;
    const cellH = size / rows;
    const pad = cellW * (0.16 + v * 0.025);
    // Most panes stay dark; only a scattered few are lit so the block reads as night.
    const litAt = 0.8 + (v % 2) * 0.06;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = hash2(c + v * 13, r + 3, seed + v * 97 + 101) > litAt;
        const x = c * cellW + pad;
        const y = r * cellH + pad;
        const w = cellW - pad * 2;
        const h = cellH - pad * 2;
        albedo.fillStyle = lit ? "#f4efe6" : "#14161c";
        albedo.fillRect(x, y, w, h);
        if (lit) {
          emissive.fillStyle = "#ffffff";
          emissive.fillRect(x, y, w, h);
        }
      }
    }

    variants.push({
      albedo: finishTexture(albedoCanvas, true),
      emissive: finishTexture(emissiveCanvas, false),
    });
  }
  return variants;
}

function RiverSheet({ sheet, material }: { sheet: RiverSheet; material: THREE.MeshStandardMaterial }) {
  const geo = useRef<THREE.PlaneGeometry>(null);
  useLayoutEffect(() => {
    geo.current?.computeTangents();
  }, [sheet.w, sheet.d]);
  return (
    <mesh position={[sheet.x, WATER_Y, sheet.z]} rotation={ROAD_FLAT} material={material}>
      <planeGeometry ref={geo} args={[sheet.w, sheet.d]} />
    </mesh>
  );
}

interface BuildingInstanceData {
  key: string;
  x: number;
  z: number;
  height: number;
  color: string;
  roofColor: string;
  variant: number;
}

export default function ProceduralBuildings({ layout, seed, occupied, territories }: Props) {
  const windowSets = useMemo(() => makeWindowTextureSet(seed, WINDOW_VARIANTS), [seed]);
  const asphalt = useMemo(() => asphaltTexture("z"), []);
  const asphaltX = useMemo(() => asphaltTexture("x"), []);
  const crossing = useMemo(() => intersectionTexture(), []);
  const sidewalk = useMemo(() => sidewalkTexture(), []);
  const parksTex = useMemo(() => parkTexture(), []);
  const waterNormal = useMemo(() => {
    const tex = waterNormalTexture();
    tex.repeat.set(10, 8);
    return tex;
  }, []);
  const waterMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: WATER_COLOR,
        normalMap: waterNormal,
        normalScale: WATER_NORMAL_SCALE,
        roughness: 0.22,
        metalness: 0.25,
      }),
    [waterNormal],
  );
  const playerFamily = useGameStore((s) => s.playerFamily);

  useEffect(() => {
    return () => {
      for (const set of windowSets) {
        set.albedo.dispose();
        set.emissive.dispose();
      }
    };
  }, [windowSets]);

  useEffect(() => {
    return () => {
      asphalt.dispose();
      asphaltX.dispose();
      crossing.dispose();
      sidewalk.dispose();
      parksTex.dispose();
      waterNormal.dispose();
      waterMat.dispose();
    };
  }, [asphalt, asphaltX, crossing, sidewalk, parksTex, waterNormal, waterMat]);

  useFrame((_, dt) => {
    waterNormal.offset.x += dt * 0.015;
    waterNormal.offset.y += dt * 0.008;
  });

  const ownerByTerritory = useMemo(() => {
    const m = new Map<string, FamilyName | null>();
    for (const t of territories) m.set(t.id, t.owner);
    return m;
  }, [territories]);

  const rivers = useMemo(() => riverSheets(layout), [layout]);
  const shores = useMemo(() => shoreEdges(layout, territories), [layout, territories]);

  const { buildings, avenues, streets, crossings, parks, plates, slabs, pavers } = useMemo(() => {
    const buildings: BuildingInstanceData[] = [];
    const avenues: { x: number; z: number }[] = [];
    const streets: { x: number; z: number }[] = [];
    const crossings: { x: number; z: number }[] = [];
    const parks: { x: number; z: number }[] = [];
    const plates: { x: number; z: number; color: string; opacity: number }[] = [];
    // One pavement slab per 3x3 block, keyed by the block's grid quadrant.
    // Blocks that touch water get per-cell pavement instead so the slab
    // never paves over the river.
    const groups = new Map<
      string,
      { x: number; z: number; wet: boolean; cells: { x: number; z: number }[] }
    >();
    for (const b of layout.blocks) {
      if (b.kind === "road") continue;
      const bx = Math.floor(b.gx / 4);
      const bz = Math.floor(b.gz / 4);
      const key = `${bx}-${bz}`;
      let g = groups.get(key);
      if (!g) {
        // Centre of the block is the middle cell (gx = 4*bx + 2).
        g = {
          x: b.worldX + (4 * bx + 2 - b.gx) * PITCH,
          z: b.worldZ + (4 * bz + 2 - b.gz) * PITCH,
          wet: false,
          cells: [],
        };
        groups.set(key, g);
      }
      if (b.kind === "water") g.wet = true;
      else g.cells.push({ x: b.worldX, z: b.worldZ });
    }
    const slabs: { x: number; z: number }[] = [];
    const pavers: { x: number; z: number }[] = [];
    for (const g of groups.values()) {
      if (g.cells.length === 0) continue;
      if (g.wet) pavers.push(...g.cells);
      else slabs.push({ x: g.x, z: g.z });
    }

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
        const color = owner ? tintTowardFamily(brick, FAMILY_HEX[owner], 0.42) : brick;
        buildings.push({
          key,
          x: b.worldX,
          z: b.worldZ,
          height,
          color,
          roofColor: new THREE.Color(color).multiplyScalar(0.72).getStyle(),
          variant: Math.floor(hash2(b.gx, b.gz, seed + 7) * WINDOW_VARIANTS) % WINDOW_VARIANTS,
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
        const onAvenue = b.gx % 4 === 0;
        const onStreet = b.gz % 4 === 0;
        const cell = { x: b.worldX, z: b.worldZ };
        if (onAvenue && onStreet) crossings.push(cell);
        else if (onAvenue) avenues.push(cell);
        else streets.push(cell);
      } else if (b.kind === "park") {
        parks.push({ x: b.worldX, z: b.worldZ });
      }
    }
    return { buildings, avenues, streets, crossings, parks, plates, slabs, pavers };
  }, [layout, seed, occupied, ownerByTerritory, playerFamily]);

  const byVariant = useMemo(() => {
    const groups: BuildingInstanceData[][] = Array.from({ length: WINDOW_VARIANTS }, () => []);
    for (const b of buildings) groups[b.variant]!.push(b);
    return groups;
  }, [buildings]);

  const groundSize = BLOCK_SIZE + 0.15;
  // Road cells are exactly one block wide; the pavement slab fills the gaps.
  const roadSize = BLOCK_SIZE + ROAD_GAP;
  // Ownership tint spans the gap between cells so a block tints as one piece.
  const plateSize = PITCH;

  return (
    <group>
      <Instances limit={slabs.length || 1} range={slabs.length}>
        <planeGeometry args={[SLAB_SIZE, SLAB_SIZE]} />
        <meshStandardMaterial map={sidewalk} color="#ffffff" roughness={0.95} />
        {slabs.map((s, i) => (
          <Instance key={`slab-${i}`} position={[s.x, 0.004, s.z]} rotation={ROAD_FLAT} />
        ))}
      </Instances>

      <Instances limit={pavers.length || 1} range={pavers.length}>
        <planeGeometry args={[PITCH, PITCH]} />
        <meshStandardMaterial color="#6d675c" roughness={0.95} />
        {pavers.map((p, i) => (
          <Instance key={`paver-${i}`} position={[p.x, 0.004, p.z]} rotation={ROAD_FLAT} />
        ))}
      </Instances>

      {plates.map((p, i) => (
        <mesh key={`plate-${i}`} position={[p.x, 0.012, p.z]} rotation={ROAD_FLAT}>
          <planeGeometry args={[plateSize, plateSize]} />
          <meshBasicMaterial color={p.color} transparent opacity={p.opacity} depthWrite={false} />
        </mesh>
      ))}

      <Instances limit={avenues.length || 1} range={avenues.length}>
        <planeGeometry args={[roadSize, roadSize]} />
        <meshStandardMaterial map={asphalt} color="#ffffff" roughness={1} />
        {avenues.map((c, i) => (
          <Instance key={`ave-${i}`} position={[c.x, 0.01, c.z]} rotation={ROAD_FLAT} />
        ))}
      </Instances>

      <Instances limit={streets.length || 1} range={streets.length}>
        <planeGeometry args={[roadSize, roadSize]} />
        <meshStandardMaterial map={asphaltX} color="#ffffff" roughness={1} />
        {streets.map((c, i) => (
          <Instance key={`st-${i}`} position={[c.x, 0.01, c.z]} rotation={ROAD_FLAT} />
        ))}
      </Instances>

      <Instances limit={crossings.length || 1} range={crossings.length}>
        <planeGeometry args={[roadSize, roadSize]} />
        <meshStandardMaterial map={crossing} color="#ffffff" roughness={1} />
        {crossings.map((c, i) => (
          <Instance key={`x-${i}`} position={[c.x, 0.01, c.z]} rotation={ROAD_FLAT} />
        ))}
      </Instances>

      {rivers.map((sheet) => (
        <RiverSheet key={sheet.id} sheet={sheet} material={waterMat} />
      ))}

      {shores.map((edge) => (
        <group key={edge.id}>
          <group position={[edge.x, 0.16, edge.z]} rotation={[0, edge.rot, 0]}>
            <mesh>
              <boxGeometry args={[PITCH * 0.96, 0.14, 0.72]} />
              <meshStandardMaterial color="#6b5344" roughness={0.9} />
            </mesh>
            <mesh position={[-PITCH * 0.32, -0.28, 0]}>
              <boxGeometry args={[0.1, 0.5, 0.1]} />
              <meshStandardMaterial color="#3a322c" roughness={0.95} />
            </mesh>
            <mesh position={[PITCH * 0.32, -0.28, 0]}>
              <boxGeometry args={[0.1, 0.5, 0.1]} />
              <meshStandardMaterial color="#3a322c" roughness={0.95} />
            </mesh>
          </group>
          {edge.crane && (
            <group position={[edge.x, 0.28, edge.z]} rotation={[0, edge.craneRot, 0]}>
              <mesh position={[0, 1.15, 0.15]}>
                <boxGeometry args={[0.12, 2.2, 0.12]} />
                <meshStandardMaterial color="#3e424a" metalness={0.4} roughness={0.5} />
              </mesh>
              <mesh position={[0, 2.2, 0.7]}>
                <boxGeometry args={[0.08, 0.08, 1.15]} />
                <meshStandardMaterial color="#8a6a32" metalness={0.3} roughness={0.6} />
              </mesh>
            </group>
          )}
          {edge.sign && (
            <group position={[edge.signX, 1.85, edge.signZ]} rotation={[0, edge.signRot, 0]}>
              <mesh>
                <boxGeometry args={[1.85, 0.46, 0.08]} />
                <meshStandardMaterial color="#1c2836" roughness={0.7} />
              </mesh>
              <Text
                position={[0, 0, 0.05]}
                fontSize={0.24}
                letterSpacing={0.08}
                anchorX="center"
                anchorY="middle"
                color="#f0e2b6"
              >
                DOCKS
              </Text>
            </group>
          )}
        </group>
      ))}

      <Instances limit={parks.length || 1} range={parks.length}>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial map={parksTex} color="#ffffff" roughness={1} />
        {parks.map((c, i) => (
          <Instance
            key={`park-${i}`}
            position={[c.x, 0.01, c.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          />
        ))}
      </Instances>

      {byVariant.map((group, v) =>
        group.length === 0 ? null : (
          <Instances key={`win-${v}`} limit={group.length} range={group.length}>
            <boxGeometry args={[BLOCK_SIZE * 0.86, 1, BLOCK_SIZE * 0.86]} />
            <meshStandardMaterial
              map={windowSets[v]!.albedo}
              emissiveMap={windowSets[v]!.emissive}
              emissive="#ffd27a"
              emissiveIntensity={1.8}
              roughness={0.85}
            />
            {group.map((b, i) => (
              <Instance
                key={`bld-${b.key}-${i}`}
                position={[b.x, b.height / 2, b.z]}
                scale={[1, b.height, 1]}
                color={b.color}
              />
            ))}
          </Instances>
        ),
      )}

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
