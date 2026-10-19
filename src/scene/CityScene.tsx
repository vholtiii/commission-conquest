import { Suspense, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { MapControls, PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { useGameStore } from "@/engine/store";
import { getCityLayout } from "@/engine/cityLayout";
import ProceduralBuildings from "./ProceduralBuildings";
import DistrictOverlay from "./DistrictOverlay";
import Markers from "./Markers";
import HitFx from "./HitFx";
import BuildFx from "./BuildFx";
import KenneyProps from "./KenneyProps";
import MapCamera from "./MapCamera";
import RacketBuildings, { useOccupiedRacketBlocks } from "./RacketBuildings";
import RacketLightPool from "./RacketLightPool";
import PendingOpsOverlay from "./PendingOpsOverlay";
import SitdownOverlay from "./SitdownOverlay";
import SupplyRouteOverlay from "./SupplyRouteOverlay";
import HitCinematic from "./hits/HitCinematic";
import SitdownCinematic from "./SitdownCinematic";
import StrategicOverlay from "./StrategicOverlay";
import BoroughOverlay from "./BoroughOverlay";
import StreetLabels from "./StreetLabels";
import BlockPlumbing from "./BlockPlumbing";
import AmbientTells from "./AmbientTells";
import Atmosphere from "./Atmosphere";
import PostFx from "./PostFx";

/** Canvas wrapper for the city view. Reads territories and crew from the store. */
export default function CityScene() {
  const territories = useGameStore((s) => s.territories);
  const seed = useGameStore((s) => s.seed);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const cinematicPlaying = useGameStore(
    (s) =>
      (s.cinematicQueue.length > 0 && !s.pendingHitResult) || s.sitdownPhase != null,
  );
  const postFx = useGameStore((s) => s.settings.postFx !== false);
  const graphics = useGameStore((s) => s.settings.graphics ?? "auto");
  const [autoLow, setAutoLow] = useState(false);
  const low = graphics === "low" || (graphics === "auto" && autoLow);

  const layout = useMemo(() => getCityLayout(territories, seed), [territories, seed]);
  const occupied = useOccupiedRacketBlocks(layout, territories);

  // Shared with the fly-to camera and the hit reel.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);

  return (
    <div className="absolute inset-0 z-0 h-full w-full">
      <Canvas
        shadows={!low}
        flat={postFx}
        frameloop="always"
        dpr={low ? 1 : [1, 1.75]}
        camera={{ position: [0, 34, 30], fov: 42, near: 0.1, far: 300 }}
        onPointerMissed={(e) => {
          // Only a plain left click on empty ground deselects; a right/middle
          // drag that ends on nothing is the player orbiting the camera.
          if (e.button !== 0) return;
          if (!cinematicPlaying) selectTerritory(null);
        }}
        style={{ width: "100%", height: "100%", display: "block" }}
        className="h-full w-full bg-[#11141a]"
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      >
        <Atmosphere />
        {graphics === "auto" && (
          <PerformanceMonitor
            onDecline={() => setAutoLow(true)}
            onIncline={() => setAutoLow(false)}
            flipflops={3}
            onFallback={() => setAutoLow(true)}
          />
        )}

        <MapControls
          ref={controlsRef}
          makeDefault
          enabled={!cinematicPlaying}
          maxPolarAngle={Math.PI / 3}
          minPolarAngle={Math.PI / 8}
          minDistance={12}
          maxDistance={150}
          enableDamping
          dampingFactor={0.08}
          screenSpacePanning
          enableRotate
          rotateSpeed={0.7}
          // Left-drag pans (Shift/Ctrl+left-drag rotates); right or middle drag orbits; wheel zooms.
          mouseButtons={{
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.ROTATE,
            RIGHT: THREE.MOUSE.ROTATE,
          }}
          touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
        />

        <MapCamera layout={layout} controlsRef={controlsRef} />

        <ProceduralBuildings
          layout={layout}
          seed={seed}
          occupied={occupied}
          territories={territories}
        />
        <RacketBuildings layout={layout} territories={territories} />
        <RacketLightPool layout={layout} territories={territories} />
        <BlockPlumbing layout={layout} territories={territories} />
        <AmbientTells layout={layout} territories={territories} />
        <DistrictOverlay layout={layout} territories={territories} />
        <Markers layout={layout} territories={territories} />
        <StreetLabels layout={layout} />
        <BoroughOverlay layout={layout} territories={territories} />
        <StrategicOverlay layout={layout} territories={territories} />
        <PendingOpsOverlay layout={layout} />
        <SitdownOverlay layout={layout} />
        <SupplyRouteOverlay layout={layout} />
        <HitFx layout={layout} />
        <BuildFx layout={layout} />
        <HitCinematic layout={layout} controlsRef={controlsRef} />
        <SitdownCinematic layout={layout} controlsRef={controlsRef} />
        <Suspense fallback={null}>
          <KenneyProps layout={layout} />
        </Suspense>
        {postFx && <PostFx bloom={!low} />}
      </Canvas>
    </div>
  );
}
