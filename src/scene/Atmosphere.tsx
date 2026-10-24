import { memo, useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useGameStore } from "@/engine/store";
import { useReelLook } from "./hits/reelLook";
import {
  TIER_SHADOW_MAP,
  seasonPalette,
  type GraphicsTier,
  type SeasonLook,
} from "./sceneTheme";

const SETTLE_SECONDS = 0.45;
export const FOG_DENSITY = 0.009;
const SUN_OFFSET_X = 30;
const SUN_OFFSET_Z = 20;
/** Half-width of the sun's shadow box when zoomed in and in overview. */
const SHADOW_HALF_NEAR = 28;
const SHADOW_HALF_FAR = 70;
const SHADOW_DIST_NEAR = 18;
const SHADOW_DIST_FAR = 110;

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Seasonal sun, sky, and fog colour. Fog density stays with MapCamera.
 * The sun's shadow box follows the orbit target and shrinks as the camera
 * closes in, so the shadow map is spent where the player is looking.
 * Memoized so a turn's React render does not snap the light props back.
 */
function Atmosphere({ tier }: { tier: GraphicsTier }) {
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const fogRef = useRef<THREE.FogExp2>(null);
  const { scene, gl } = useThree();
  const snapped = useRef(false);
  const keyRef = useRef("");
  const targetRef = useRef<SeasonLook>(seasonPalette({ month: 1, day: 1 }));
  const night = useRef(0);
  const grade = useReelLook((s) => s.grade);
  const scratch = useRef({
    offset: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    focus: new THREE.Vector3(),
  });

  const mapSize = TIER_SHADOW_MAP[tier];
  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    sun.shadow.mapSize.set(mapSize, mapSize);
    // The renderer only allocates the shadow target once; drop it so the new size takes.
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }, [mapSize]);

  useFrame((state, dt) => {
    const date = useGameStore.getState().date;
    const key = `${date.year}-${date.month}-${date.day}`;
    if (key !== keyRef.current) {
      keyRef.current = key;
      targetRef.current = seasonPalette(date);
    }
    const target = targetRef.current;
    const k = snapped.current ? 1 - Math.exp(-dt / SETTLE_SECONDS) : 1;
    snapped.current = true;
    night.current += (grade - night.current) * (1 - Math.exp(-dt / 0.6));
    const dim = 1 - night.current * 0.7;

    const bg = scene.background;
    if (bg instanceof THREE.Color) {
      bg.lerp(target.background, k);
      gl.setClearColor(bg);
    }
    if (fogRef.current) fogRef.current.color.lerp(target.horizon, k);
    if (hemiRef.current) {
      hemiRef.current.color.lerp(target.skyColor, k);
      hemiRef.current.groundColor.lerp(target.groundColor, k);
    }
    if (ambRef.current) {
      ambRef.current.intensity += (target.ambient * dim - ambRef.current.intensity) * k;
    }
    const sun = sunRef.current;
    if (!sun) return;
    sun.color.lerp(target.sunColor, k);
    sun.intensity += (target.sunIntensity * dim - sun.intensity) * k;

    const s = scratch.current;
    s.offset.set(SUN_OFFSET_X, s.offset.y + (target.sunElevation - s.offset.y) * k, SUN_OFFSET_Z);

    const controls = state.controls as unknown as { target?: THREE.Vector3 } | null;
    const focus = controls?.target ?? ORIGIN;
    const dist = state.camera.position.distanceTo(focus);
    const blend = smoothstep(SHADOW_DIST_NEAR, SHADOW_DIST_FAR, dist);
    const half = Math.round((SHADOW_HALF_NEAR + (SHADOW_HALF_FAR - SHADOW_HALF_NEAR) * blend) / 2) * 2;
    const cam = sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    }

    // Move the shadow box in whole texels so panning does not make edges crawl.
    const texel = (2 * half) / sun.shadow.mapSize.x;
    s.forward.copy(s.offset).negate().normalize();
    s.right.crossVectors(s.forward, UP).normalize();
    s.up.crossVectors(s.right, s.forward);
    const a = focus.dot(s.right);
    const b = focus.dot(s.up);
    s.focus
      .set(focus.x, 0, focus.z)
      .addScaledVector(s.right, Math.round(a / texel) * texel - a)
      .addScaledVector(s.up, Math.round(b / texel) * texel - b);
    sun.target.position.copy(s.focus);
    sun.target.updateMatrixWorld();
    sun.position.copy(s.focus).add(s.offset);
  });

  return (
    <>
      <color attach="background" args={["#22262e"]} />
      <fogExp2 ref={fogRef} attach="fog" args={["#4a5260", FOG_DENSITY]} />
      <hemisphereLight ref={hemiRef} args={["#cbd7e8", "#241d16", 0.55]} />
      <ambientLight ref={ambRef} intensity={0.22} />
      <directionalLight
        ref={sunRef}
        position={[30, 45, 20]}
        intensity={1.35}
        color="#ffd9a8"
        castShadow
        shadow-mapSize-width={mapSize}
        shadow-mapSize-height={mapSize}
        shadow-camera-left={-SHADOW_HALF_NEAR}
        shadow-camera-right={SHADOW_HALF_NEAR}
        shadow-camera-top={SHADOW_HALF_NEAR}
        shadow-camera-bottom={-SHADOW_HALF_NEAR}
        shadow-camera-near={1}
        shadow-camera-far={150}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
    </>
  );
}

export default memo(Atmosphere);
