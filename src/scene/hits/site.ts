import * as THREE from "three";
import type { CityBlock, CityLayout } from "@/engine/cityLayout";
import { getDistrictBlocksNearestFirst, nearestRoadBlock } from "@/engine/cityLayout";
import type { HitCinematic, Territory } from "@/types/game";
import { spaceFor, type Space } from "./cameraRig";

export interface HitSite {
  /** Kerb the strike plays on. */
  road: THREE.Vector3;
  /** Mark's building, nearest block to the district centre. */
  building: THREE.Vector3;
  /** Yaw that faces the building front toward the road. */
  facing: number;
  origin: THREE.Vector3;
  center: THREE.Vector3;
  curve: THREE.CatmullRomCurve3;
  /** The last 14 world units of `curve`, ending at the kerb. The drive-by uses this. */
  approach: THREE.CatmullRomCurve3;
  /** Buildings the camera must stay out of and see past. */
  space: Space;
  isClear: (p: THREE.Vector3) => boolean;
}

function pointFor(layout: CityLayout, territoryId: string): THREE.Vector3 {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const x = center?.worldX ?? 0;
  const z = center?.worldZ ?? 0;
  const road = nearestRoadBlock(layout, x, z);
  return new THREE.Vector3(road?.worldX ?? x, 0, road?.worldZ ?? z);
}

export function siteFor(layout: CityLayout, cinematic: HitCinematic, territories: readonly Territory[] = []): HitSite {
  const centerBlock = layout.centers.find((c) => c.territoryId === cinematic.targetTerritoryId);
  const center = new THREE.Vector3(centerBlock?.worldX ?? 0, 0, centerBlock?.worldZ ?? 0);
  const front = streetFront(layout, cinematic.targetTerritoryId);
  const roadBlock = front?.road ?? nearestRoadBlock(layout, center.x, center.z);
  const road = new THREE.Vector3(roadBlock?.worldX ?? center.x, 0, roadBlock?.worldZ ?? center.z);
  const buildingBlock = front?.building ?? getDistrictBlocksNearestFirst(layout, cinematic.targetTerritoryId)[0];
  const building = new THREE.Vector3(
    buildingBlock?.worldX ?? center.x,
    0,
    buildingBlock?.worldZ ?? center.z,
  );
  const facing = Math.atan2(road.x - building.x, road.z - building.z);

  const pts: THREE.Vector3[] = [];
  for (const tid of cinematic.path) pts.push(pointFor(layout, tid));
  if (pts.length === 0) pts.push(road.clone(), road.clone().add(new THREE.Vector3(2, 0, 0)));
  if (pts.length === 1) pts.push(road.clone());
  pts[pts.length - 1] = road.clone();
  const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
  const space = spaceFor(layout, territories);

  return {
    road,
    building,
    facing,
    origin: pts[0]!.clone(),
    center,
    curve,
    approach: tailCurve(curve, road),
    space,
    isClear: space.isClear,
  };
}

/**
 * The district building nearest the centre that has a road cell right outside it.
 * The centre block is often buried inside a solid run of buildings, where the
 * scene would play in the crack between two walls and no camera could see it.
 */
function streetFront(layout: CityLayout, territoryId: string): { building: CityBlock; road: CityBlock } | null {
  const cells = new Map<number, CityBlock>();
  for (const b of layout.blocks) cells.set(b.gz * 1000 + b.gx, b);
  const candidates = getDistrictBlocksNearestFirst(layout, territoryId).slice(0, 16);
  for (const b of candidates) {
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const n = cells.get((b.gz + dz) * 1000 + b.gx + dx);
      if (n?.kind === "road") return { building: b, road: n };
    }
  }
  return null;
}

/** The last `keep` world units of a path, rebuilt so it still ends on `end`. */
function tailCurve(full: THREE.CatmullRomCurve3, end: THREE.Vector3, keep = 14): THREE.CatmullRomCurve3 {
  const length = full.getLength();
  const span = Math.min(keep, length);
  const start = length - span;
  const steps = 8;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = length < 1e-4 ? 0 : (start + (span * i) / steps) / length;
    pts.push(full.getPointAt(Math.min(1, u)));
  }
  pts[pts.length - 1] = end.clone();
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
}
