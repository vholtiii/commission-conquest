import {
  BLOCK_SIZE,
  ROAD_GAP,
  nearestRoadBlock,
  type CityBlock,
  type CityLayout,
} from "./cityLayout";

export interface StreetPoint {
  x: number;
  z: number;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Walk at most this many water cells to hop a river on the same avenue or street. */
const BRIDGE_MAX = 6;
/** Corner radius, under half a block so the elbow stays on the intersection. */
const FILLET = Math.min(BLOCK_SIZE, ROAD_GAP + BLOCK_SIZE) * 0.38;
const FILLET_STEPS = 5;
/** An intersection this close (in cells) to the nearest road wins the anchor. */
const INTERSECT_CELLS = 2;

interface RoadGraph {
  byKey: Map<string, CityBlock>;
  at: (gx: number, gz: number) => CityBlock | undefined;
  neighbors: (gx: number, gz: number) => Array<{ gx: number; gz: number; cost: number }>;
}

const graphCache = new WeakMap<CityLayout, RoadGraph>();

function keyOf(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

function roadGraph(layout: CityLayout): RoadGraph {
  const hit = graphCache.get(layout);
  if (hit) return hit;

  const byKey = new Map<string, CityBlock>();
  const all = new Map<string, CityBlock>();
  for (const b of layout.blocks) {
    all.set(keyOf(b.gx, b.gz), b);
    if (b.kind === "road") byKey.set(keyOf(b.gx, b.gz), b);
  }
  const at = (gx: number, gz: number) => byKey.get(keyOf(gx, gz));
  const cellAt = (gx: number, gz: number) => all.get(keyOf(gx, gz));

  const neighbors = (gx: number, gz: number) => {
    const out: Array<{ gx: number; gz: number; cost: number }> = [];
    for (const [dx, dz] of DIRS) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (at(nx, nz)) {
        out.push({ gx: nx, gz: nz, cost: 1 });
        continue;
      }
      for (let step = 2; step <= BRIDGE_MAX + 1; step++) {
        const bx = gx + dx * step;
        const bz = gz + dz * step;
        if (at(bx, bz)) {
          let waterOnly = true;
          for (let k = 1; k < step; k++) {
            const mid = cellAt(gx + dx * k, gz + dz * k);
            if (!mid || mid.kind !== "water") {
              waterOnly = false;
              break;
            }
          }
          if (waterOnly) out.push({ gx: bx, gz: bz, cost: step });
          break;
        }
        const mid = cellAt(bx, bz);
        if (!mid || mid.kind !== "water") break;
      }
    }
    return out;
  };

  const graph = { byKey, at, neighbors };
  graphCache.set(layout, graph);
  return graph;
}

/** Road cell a district's pin sits on. Prefers a nearby intersection. */
export function districtAnchor(layout: CityLayout, territoryId: string): CityBlock | null {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const roads = layout.blocks.filter((b) => b.kind === "road" && b.territoryId === territoryId);
  const pick = (pool: CityBlock[], cx: number, cz: number) =>
    pool.reduce((best, b) => {
      const db = (b.worldX - cx) ** 2 + (b.worldZ - cz) ** 2;
      const da = (best.worldX - cx) ** 2 + (best.worldZ - cz) ** 2;
      return db < da ? b : best;
    });

  if (roads.length > 0) {
    const cx = center?.worldX ?? roads[0]!.worldX;
    const cz = center?.worldZ ?? roads[0]!.worldZ;
    const nearest = pick(roads, cx, cz);
    const xings = roads.filter((b) => b.gx % 4 === 0 && b.gz % 4 === 0);
    const close = xings.filter(
      (b) => Math.abs(b.gx - nearest.gx) + Math.abs(b.gz - nearest.gz) <= INTERSECT_CELLS,
    );
    if (close.length > 0) return pick(close, cx, cz);
    return nearest;
  }
  if (center) return nearestRoadBlock(layout, center.worldX, center.worldZ);
  return nearestRoadBlock(layout, 0, 0);
}

function heuristic(a: CityBlock, b: CityBlock): number {
  return Math.abs(a.gx - b.gx) + Math.abs(a.gz - b.gz);
}

function walk(graph: RoadGraph, from: CityBlock, to: CityBlock): CityBlock[] | null {
  if (from.gx === to.gx && from.gz === to.gz) return [from];
  const start = keyOf(from.gx, from.gz);
  const goal = keyOf(to.gx, to.gz);
  const open: Array<{ key: string; f: number }> = [{ key: start, f: heuristic(from, to) }];
  const came = new Map<string, string>();
  const gScore = new Map<string, number>([[start, 0]]);

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[best]!.f) best = i;
    const cur = open.splice(best, 1)[0]!;
    if (cur.key === goal) {
      const keys = [cur.key];
      let k = cur.key;
      while (came.has(k)) {
        k = came.get(k)!;
        keys.unshift(k);
      }
      return keys.map((key) => graph.byKey.get(key)!);
    }
    const [cx, cz] = cur.key.split(",").map(Number) as [number, number];
    const gCur = gScore.get(cur.key) ?? Infinity;
    for (const n of graph.neighbors(cx, cz)) {
      const nk = keyOf(n.gx, n.gz);
      const tentative = gCur + n.cost;
      if (tentative >= (gScore.get(nk) ?? Infinity)) continue;
      came.set(nk, cur.key);
      gScore.set(nk, tentative);
      const node = graph.at(n.gx, n.gz);
      const f = tentative + (node ? heuristic(node, to) : 0);
      const existing = open.find((o) => o.key === nk);
      if (existing) existing.f = f;
      else open.push({ key: nk, f });
    }
  }
  return null;
}

function hop(graph: RoadGraph, from: CityBlock, to: CityBlock): CityBlock[] {
  return walk(graph, from, to) ?? [from, to];
}

/** Drop cells that sit on a straight avenue or street between two others. */
export function collapseStreetCells(cells: CityBlock[], keep?: Set<string>): CityBlock[] {
  if (cells.length <= 2) return cells;
  const out: CityBlock[] = [cells[0]!];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = cells[i]!;
    const c = cells[i + 1]!;
    const colinear = (a.gx === b.gx && b.gx === c.gx) || (a.gz === b.gz && b.gz === c.gz);
    if (!colinear || keep?.has(keyOf(b.gx, b.gz))) out.push(b);
  }
  out.push(cells[cells.length - 1]!);
  return out;
}

function filletCorners(cells: CityBlock[], keep: Set<string>): StreetPoint[] {
  if (cells.length === 0) return [];
  if (cells.length === 1) return [{ x: cells[0]!.worldX, z: cells[0]!.worldZ }];

  const pts: StreetPoint[] = [{ x: cells[0]!.worldX, z: cells[0]!.worldZ }];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = cells[i - 1]!;
    const b = cells[i]!;
    const c = cells[i + 1]!;
    if (keep.has(keyOf(b.gx, b.gz))) {
      pts.push({ x: b.worldX, z: b.worldZ });
      continue;
    }
    const inLen = Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ);
    const outLen = Math.hypot(c.worldX - b.worldX, c.worldZ - b.worldZ);
    if (inLen < 0.01 || outLen < 0.01) {
      pts.push({ x: b.worldX, z: b.worldZ });
      continue;
    }
    const ux = (b.worldX - a.worldX) / inLen;
    const uz = (b.worldZ - a.worldZ) / inLen;
    const vx = (c.worldX - b.worldX) / outLen;
    const vz = (c.worldZ - b.worldZ) / outLen;
    const r = Math.min(FILLET, inLen * 0.45, outLen * 0.45);
    const turn = ux * vz - uz * vx;
    if (r < 0.15 || Math.abs(turn) < 0.05) {
      pts.push({ x: b.worldX, z: b.worldZ });
      continue;
    }
    const sx = b.worldX - ux * r;
    const sz = b.worldZ - uz * r;
    const ex = b.worldX + vx * r;
    const ez = b.worldZ + vz * r;
    const cx = b.worldX - ux * r + vx * r;
    const cz = b.worldZ - uz * r + vz * r;
    let a0 = Math.atan2(sz - cz, sx - cx);
    let a1 = Math.atan2(ez - cz, ex - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    for (let s = 0; s <= FILLET_STEPS; s++) {
      const ang = a0 + (da * s) / FILLET_STEPS;
      pts.push({ x: cx + r * Math.cos(ang), z: cz + r * Math.sin(ang) });
    }
  }
  const last = cells[cells.length - 1]!;
  pts.push({ x: last.worldX, z: last.worldZ });
  return pts;
}

function dropDupes(cells: CityBlock[]): CityBlock[] {
  const out: CityBlock[] = [];
  for (const c of cells) {
    const prev = out[out.length - 1];
    if (prev && prev.gx === c.gx && prev.gz === c.gz) continue;
    out.push(c);
  }
  return out;
}

function collectAnchors(layout: CityLayout, territoryIds: string[]): CityBlock[] {
  return territoryIds
    .map((id) => districtAnchor(layout, id))
    .filter((b): b is CityBlock => !!b);
}

/** Road cells, collapsed to corners, that a supply path follows. */
export function streetRouteCells(layout: CityLayout, territoryIds: string[]): CityBlock[] {
  const anchors = collectAnchors(layout, territoryIds);
  if (anchors.length === 0) return [];
  const graph = roadGraph(layout);
  const cells: CityBlock[] = [anchors[0]!];
  for (let i = 1; i < anchors.length; i++) {
    const next = hop(graph, cells[cells.length - 1]!, anchors[i]!);
    cells.push(...next.slice(1));
  }
  const keep = new Set(anchors.map((a) => keyOf(a.gx, a.gz)));
  return collapseStreetCells(dropDupes(cells), keep);
}

/**
 * World polyline along the avenues and streets that visit each district
 * on a supply path, corners rounded like a GPS stroke.
 */
export function streetRoute(layout: CityLayout, territoryIds: string[]): StreetPoint[] {
  const anchors = collectAnchors(layout, territoryIds);
  const keep = new Set(anchors.map((a) => keyOf(a.gx, a.gz)));
  return filletCorners(streetRouteCells(layout, territoryIds), keep);
}
