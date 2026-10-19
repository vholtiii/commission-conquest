import * as THREE from "three";
import { BLOCK_SIZE, ROAD_GAP, type CityBlock, type CityLayout } from "@/engine/cityLayout";

/** One grid cell, road gap included, so neighbouring cells meet with no gap. */
export const CELL_PITCH = BLOCK_SIZE + ROAD_GAP;

const HALF = CELL_PITCH / 2;
const STRIP = 0.22;
/** World units per hatch tile, so the pattern continues across cell edges. */
const UV = 8;

export interface DistrictShape {
  fill: THREE.BufferGeometry;
  /** Outline just inside every edge that meets another district, water, or the map edge. */
  border: THREE.BufferGeometry;
  /** A second outline, one strip further in. The player's districts use it in the overview. */
  inner: THREE.BufferGeometry;
  /** A building cell near the middle of the district. Labels and the hit mark sit here. */
  anchor: { x: number; z: number };
  cellCount: number;
}

const cache = new WeakMap<CityLayout, Map<string, DistrictShape>>();

let hatchTexture: THREE.Texture | null = null;
let districtHatch: THREE.Texture | null = null;

/** Diagonal lines. The small build pads repeat the tile; districts use one tile per UV unit. */
export function getHatchTexture(): THREE.Texture {
  if (hatchTexture) return hatchTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(226, 230, 236, 0.9)";
  ctx.lineWidth = 3;
  ctx.lineCap = "butt";
  const step = 16;
  for (let d = -size; d < size * 2; d += step) {
    ctx.beginPath();
    ctx.moveTo(d, size);
    ctx.lineTo(d + size, 0);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  hatchTexture = tex;
  return tex;
}

/** Same lines, spaced for a whole district so the cells read as one sheet. */
export function getDistrictHatch(): THREE.Texture {
  if (districtHatch) return districtHatch;
  const tex = getHatchTexture().clone();
  tex.repeat.set(1, 1);
  districtHatch = tex;
  return tex;
}

/** One fill and one outline per district. Cached for as long as this layout object lives. */
export function districtShapes(layout: CityLayout): Map<string, DistrictShape> {
  const hit = cache.get(layout);
  if (hit) return hit;
  const built = buildShapes(layout);
  cache.set(layout, built);
  return built;
}

function buildShapes(layout: CityLayout): Map<string, DistrictShape> {
  const at = new Map<string, CityBlock>();
  const groups = new Map<string, CityBlock[]>();
  for (const block of layout.blocks) {
    at.set(`${block.gx},${block.gz}`, block);
    if (!block.territoryId) continue;
    const list = groups.get(block.territoryId);
    if (list) list.push(block);
    else groups.set(block.territoryId, [block]);
  }

  const out = new Map<string, DistrictShape>();
  for (const [id, cells] of groups) {
    out.set(id, shapeFor(cells, at));
  }
  return out;
}

function shapeFor(cells: CityBlock[], at: Map<string, CityBlock>): DistrictShape {
  const fillPos: number[] = [];
  const fillUv: number[] = [];
  const fillIdx: number[] = [];
  const borderPos: number[] = [];
  const borderUv: number[] = [];
  const borderIdx: number[] = [];
  const innerPos: number[] = [];
  const innerUv: number[] = [];
  const innerIdx: number[] = [];

  let sumX = 0;
  let sumZ = 0;
  for (const cell of cells) {
    sumX += cell.worldX;
    sumZ += cell.worldZ;
    const x0 = cell.worldX - HALF;
    const x1 = cell.worldX + HALF;
    const z0 = cell.worldZ - HALF;
    const z1 = cell.worldZ + HALF;
    pushQuad(fillPos, fillUv, fillIdx, x0, z0, x1, z1);

    const edge = (dx: number, dz: number) => {
      const next = at.get(`${cell.gx + dx},${cell.gz + dz}`);
      return !next || next.territoryId !== cell.territoryId;
    };
    if (edge(1, 0)) {
      pushQuad(borderPos, borderUv, borderIdx, x1 - STRIP, z0, x1, z1);
      pushQuad(innerPos, innerUv, innerIdx, x1 - STRIP * 2, z0, x1 - STRIP, z1);
    }
    if (edge(-1, 0)) {
      pushQuad(borderPos, borderUv, borderIdx, x0, z0, x0 + STRIP, z1);
      pushQuad(innerPos, innerUv, innerIdx, x0 + STRIP, z0, x0 + STRIP * 2, z1);
    }
    if (edge(0, 1)) {
      pushQuad(borderPos, borderUv, borderIdx, x0, z1 - STRIP, x1, z1);
      pushQuad(innerPos, innerUv, innerIdx, x0, z1 - STRIP * 2, x1, z1 - STRIP);
    }
    if (edge(0, -1)) {
      pushQuad(borderPos, borderUv, borderIdx, x0, z0, x1, z0 + STRIP);
      pushQuad(innerPos, innerUv, innerIdx, x0, z0 + STRIP, x1, z0 + STRIP * 2);
    }
  }

  const midX = sumX / cells.length;
  const midZ = sumZ / cells.length;
  const buildings = cells.filter((cell) => cell.kind === "building");
  const pool = buildings.length > 0 ? buildings : cells;
  let anchor = pool[0]!;
  let best = Infinity;
  for (const cell of pool) {
    const d = (cell.worldX - midX) ** 2 + (cell.worldZ - midZ) ** 2;
    if (d < best) {
      best = d;
      anchor = cell;
    }
  }

  return {
    fill: geometry(fillPos, fillUv, fillIdx),
    border: geometry(borderPos, borderUv, borderIdx),
    inner: geometry(innerPos, innerUv, innerIdx),
    anchor: { x: anchor.worldX, z: anchor.worldZ },
    cellCount: cells.length,
  };
}

function pushQuad(
  pos: number[],
  uv: number[],
  idx: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
) {
  const base = pos.length / 3;
  pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
  uv.push(x0 / UV, z0 / UV, x1 / UV, z0 / UV, x1 / UV, z1 / UV, x0 / UV, z1 / UV);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function geometry(pos: number[], uv: number[], idx: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
