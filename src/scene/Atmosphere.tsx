import { memo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useGameStore } from "@/engine/store";
import { seasonPalette, type SeasonLook } from "./sceneTheme";

const SETTLE_SECONDS = 0.45;

/**
 * Seasonal sun, sky, and fog colour. Fog near/far stay with MapCamera.
 * Memoized so a turn's React render does not snap the light props back.
 */
function Atmosphere() {
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const { scene, gl } = useThree();
  const snapped = useRef(false);
  const keyRef = useRef("");
  const targetRef = useRef<SeasonLook>(seasonPalette({ month: 1, day: 1 }));

  useFrame((_, dt) => {
    const date = useGameStore.getState().date;
    const key = `${date.year}-${date.month}-${date.day}`;
    if (key !== keyRef.current) {
      keyRef.current = key;
      targetRef.current = seasonPalette(date);
    }
    const target = targetRef.current;
    const k = snapped.current ? 1 - Math.exp(-dt / SETTLE_SECONDS) : 1;
    snapped.current = true;

    const bg = scene.background;
    if (bg instanceof THREE.Color) {
      bg.lerp(target.background, k);
      gl.setClearColor(bg);
    }
    if (fogRef.current) fogRef.current.color.lerp(target.fog, k);
    if (hemiRef.current) {
      hemiRef.current.color.lerp(target.skyColor, k);
      hemiRef.current.groundColor.lerp(target.groundColor, k);
    }
    if (ambRef.current) {
      ambRef.current.intensity += (target.ambient - ambRef.current.intensity) * k;
    }
    if (sunRef.current) {
      sunRef.current.color.lerp(target.sunColor, k);
      sunRef.current.intensity += (target.sunIntensity - sunRef.current.intensity) * k;
      const y = sunRef.current.position.y + (target.sunElevation - sunRef.current.position.y) * k;
      sunRef.current.position.set(30, y, 20);
    }
  });

  return (
    <>
      <color attach="background" args={["#11141a"]} />
      <fog ref={fogRef} attach="fog" args={["#11141a", 42, 130]} />
      <hemisphereLight ref={hemiRef} args={["#cbd7e8", "#241d16", 0.55]} />
      <ambientLight ref={ambRef} intensity={0.22} />
      <directionalLight
        ref={sunRef}
        position={[30, 45, 20]}
        intensity={1.35}
        color="#ffd9a8"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={150}
      />
    </>
  );
}

export default memo(Atmosphere);
