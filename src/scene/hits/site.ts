import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { getDistrictBlocksNearestFirst, nearestRoadBlock } from "@/engine/cityLayout";
import type { HitCinematic } from "@/types/game";

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
}

function pointFor(layout: CityLayout, territoryId: string): THREE.Vector3 {
  const center = layout.centers.find((c) => c.territoryId === territoryId);
  const x = center?.worldX ?? 0;
  const z = center?.worldZ ?? 0;
  const road = nearestRoadBlock(layout, x, z);
  return new THREE.Vector3(road?.worldX ?? x, 0, road?.worldZ ?? z);
}

export function siteFor(layout: CityLayout, cinematic: HitCinematic): HitSite {
  const centerBlock = layout.centers.find((c) => c.territoryId === cinematic.targetTerritoryId);
  const center = new THREE.Vector3(centerBlock?.worldX ?? 0, 0, centerBlock?.worldZ ?? 0);
  const roadBlock = nearestRoadBlock(layout, center.x, center.z);
  const road = new THREE.Vector3(roadBlock?.worldX ?? center.x, 0, roadBlock?.worldZ ?? center.z);
  const buildingBlock = getDistrictBlocksNearestFirst(layout, cinematic.targetTerritoryId)[0];
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

  return {
    road,
    building,
    facing,
    origin: pts[0]!.clone(),
    center,
    curve,
    approach: tailCurve(curve, road),
  };
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
