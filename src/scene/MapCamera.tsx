import { useEffect, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { useMapView } from "@/engine/mapView";

interface Props {
  layout: CityLayout;
  controlsRef: MutableRefObject<any>;
}

const FLY_DURATION = 0.9;
const OVERVIEW_DIST_NEAR = 75;
const OVERVIEW_DIST_FAR = 110;
const OVERVIEW_POLAR = 0.12;
const NORMAL_FOG_NEAR = 42;
const NORMAL_FOG_FAR = 130;
const OVERVIEW_FOG_NEAR = 120;
const OVERVIEW_FOG_FAR = 260;
const MAX_DISTANCE = 150;
const POLAR_BAND = 0.1;
const POLAR_MIN_CLAMP = 0.05;
const POLAR_MAX_CLAMP = 1.2;

/** Distance (camera→target) → target polar angle. Piecewise linear control points. */
const POLAR_CURVE: Array<[number, number]> = [
  [12, 1.15],
  [45, 0.75],
  [75, 0.45],
  [110, 0.12],
];

interface FlyAnim {
  start: THREE.Vector3;
  startTarget: THREE.Vector3;
  end: THREE.Vector3;
  endTarget: THREE.Vector3;
  t0: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function polarForDistance(dist: number): number {
  if (dist <= POLAR_CURVE[0][0]) return POLAR_CURVE[0][1];
  for (let i = 1; i < POLAR_CURVE.length; i++) {
    const [d0, p0] = POLAR_CURVE[i - 1];
    const [d1, p1] = POLAR_CURVE[i];
    if (dist <= d1) {
      const t = (dist - d0) / (d1 - d0);
      return lerp(p0, p1, t);
    }
  }
  return POLAR_CURVE[POLAR_CURVE.length - 1][1];
}

function fitOverviewHeight(layout: CityLayout, camera: THREE.PerspectiveCamera): number {
  const fovRad = (camera.fov * Math.PI) / 180;
  const halfV = Math.tan(fovRad / 2);
  const aspect = Math.max(0.5, camera.aspect || 1);
  const byDepth = layout.depth / 2 / halfV;
  const byWidth = layout.width / 2 / (halfV * aspect);
  return Math.min(MAX_DISTANCE, Math.max(95, 1.08 * Math.max(byDepth, byWidth)));
}

/** Animates the camera + controls target toward the selected district when flyToTerritoryId changes.
 *  Also drives overview polar/fog blend from zoom distance and Overview-button fly-to. */
export default function MapCamera({ layout, controlsRef }: Props) {
  const flyToTerritoryId = useGameStore((s) => s.flyToTerritoryId);
  const flyToNonce = useGameStore((s) => s.flyToNonce);
    const flyToFocus = useGameStore((s) => s.flyToFocus);
    const clearFlyTo = useGameStore((s) => s.clearFlyTo);
  const cinematicPlaying = useGameStore(
    (s) =>
      (s.cinematicQueue.length > 0 && !s.pendingHitResult) || s.sitdownPhase != null,
  );
  const overviewNonce = useMapView((s) => s.overviewNonce);
  const setOverview = useMapView((s) => s.setOverview);
  const { camera, invalidate, scene } = useThree();

  const animRef = useRef<FlyAnim | null>(null);
  const savedViewRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const lastBlendRef = useRef(-1);
  const lastOverviewRef = useRef(false);
  const lastCloseRef = useRef(false);
  const lastOverviewNonceRef = useRef(overviewNonce);

  useEffect(() => {
    if (!flyToTerritoryId || cinematicPlaying) return;
    const center = layout.centers.find((c) => c.territoryId === flyToTerritoryId);
    if (!center) {
      clearFlyTo();
      return;
    }
    const controls = controlsRef.current;
    const currentTarget: THREE.Vector3 = controls ? controls.target.clone() : new THREE.Vector3();
    const offset = camera.position.clone().sub(currentTarget);
    const endTarget = flyToFocus
      ? new THREE.Vector3(flyToFocus.x, 0, flyToFocus.z)
      : new THREE.Vector3(center.worldX, 0, center.worldZ);
    const desiredLen = flyToFocus
      ? flyToFocus.distance
      : Math.max(18, Math.min(42, offset.length() || 28));
    const end = endTarget
      .clone()
      .add(
        offset.length() > 0.1
          ? offset.normalize().multiplyScalar(desiredLen)
          : new THREE.Vector3(0, desiredLen * 0.75, desiredLen * 0.65),
      );

    animRef.current = {
      start: camera.position.clone(),
      startTarget: currentTarget,
      end,
      endTarget,
      t0: performance.now(),
    };
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToTerritoryId, flyToNonce, flyToFocus, cinematicPlaying]);

  useEffect(() => {
    if (overviewNonce === lastOverviewNonceRef.current) return;
    lastOverviewNonceRef.current = overviewNonce;
    if (cinematicPlaying) return;

    const controls = controlsRef.current;
    if (!controls) return;

    const persp = camera as THREE.PerspectiveCamera;
    const currentTarget = controls.target.clone();
    const inOverview = useMapView.getState().overview;

    if (inOverview) {
      const restore = savedViewRef.current ?? {
        position: new THREE.Vector3(0, 34, 30),
        target: new THREE.Vector3(0, 0, 0),
      };
      animRef.current = {
        start: camera.position.clone(),
        startTarget: currentTarget,
        end: restore.position.clone(),
        endTarget: restore.target.clone(),
        t0: performance.now(),
      };
      savedViewRef.current = null;
    } else {
      savedViewRef.current = {
        position: camera.position.clone(),
        target: currentTarget.clone(),
      };
      const H = fitOverviewHeight(layout, persp);
      const endTarget = new THREE.Vector3(0, 0, 0);
      const end = new THREE.Vector3(0, H, H * Math.tan(OVERVIEW_POLAR));
      animRef.current = {
        start: camera.position.clone(),
        startTarget: currentTarget,
        end,
        endTarget,
        t0: performance.now(),
      };
    }
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewNonce, cinematicPlaying]);

  useFrame(() => {
    if (cinematicPlaying) {
      animRef.current = null;
      return;
    }

    const controls = controlsRef.current;
    const anim = animRef.current;
    if (anim) {
      const elapsed = (performance.now() - anim.t0) / 1000;
      const t = Math.min(1, elapsed / FLY_DURATION);
      const ease = 1 - Math.pow(1 - t, 3);

      camera.position.lerpVectors(anim.start, anim.end, ease);
      if (controls) {
        controls.target.lerpVectors(anim.startTarget, anim.endTarget, ease);
        controls.update();
      }
      invalidate();

      if (t >= 1) {
        animRef.current = null;
        if (flyToTerritoryId) clearFlyTo();
      }
    }

    if (!controls) return;

    const dist = camera.position.distanceTo(controls.target);
    const k = smoothstep(OVERVIEW_DIST_NEAR, OVERVIEW_DIST_FAR, dist);

    const targetPolar = polarForDistance(dist);
    controls.minPolarAngle = Math.max(POLAR_MIN_CLAMP, targetPolar - POLAR_BAND);
    controls.maxPolarAngle = Math.min(POLAR_MAX_CLAMP, targetPolar + POLAR_BAND);
    controls.update();

    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = lerp(NORMAL_FOG_NEAR, OVERVIEW_FOG_NEAR, k);
      fog.far = lerp(NORMAL_FOG_FAR, OVERVIEW_FOG_FAR, k);
    }

    const overview = k > 0.5;
    const close = dist < 22;
    if (
      Math.abs(k - lastBlendRef.current) > 0.01 ||
      overview !== lastOverviewRef.current ||
      close !== lastCloseRef.current
    ) {
      lastBlendRef.current = k;
      lastOverviewRef.current = overview;
      lastCloseRef.current = close;
      setOverview(overview, k, close);
    }
  });

  return null;
}
