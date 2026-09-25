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

  return {
    road,
    building,
    facing,
    origin: pts[0]!.clone(),
    center,
    curve: new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25),
  };
}
