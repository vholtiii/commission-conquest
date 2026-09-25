import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Instance, Instances, useGLTF } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { hash2 } from "./sceneTheme";
import { SEDAN_PALETTE, SedanFleet, type SedanSpec } from "./Sedan";

interface Props {
  layout: CityLayout;
}

/** Catches useGLTF load failures (missing Kenney assets) and renders the procedural fallback instead. */
class ModelErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // Kenney model pack not present — procedural fallback handles visuals.
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/** Procedural parked sedans + lamp posts, used whenever Kenney GLBs are unavailable. */
function ProceduralProps({ layout }: Props) {
  const { cars, lamps } = useMemo(() => {
    const roadBlocks = layout.blocks.filter((b) => b.kind === "road");
    const cars: SedanSpec[] = [];
    const lamps: { x: number; z: number }[] = [];

    roadBlocks.forEach((b, i) => {
      const r = hash2(b.gx, b.gz, 7);
      if (i % 5 === 0 && r > 0.5) {
        const avenue = b.gx % 4 === 0; // north–south road: park along Z
        const side = hash2(b.gx, b.gz, 11) > 0.5 ? 0.7 : -0.7;
        const flip = hash2(b.gx, b.gz, 13) > 0.5 ? Math.PI : 0;
        cars.push({
          x: b.worldX + (avenue ? side : (r - 0.5) * 0.5),
          z: b.worldZ + (avenue ? (r - 0.5) * 0.5 : side),
          color: SEDAN_PALETTE[Math.floor(r * SEDAN_PALETTE.length)]!,
          rot: (avenue ? Math.PI / 2 : 0) + flip,
        });
      }
      if (b.gx % 8 === 0 && b.gz % 8 === 0) {
        lamps.push({ x: b.worldX + 0.9, z: b.worldZ + 0.9 });
      }
    });

    return { cars, lamps };
  }, [layout]);

  return (
    <group>
      <SedanFleet cars={cars} scale={0.55} />

      <Instances limit={lamps.length || 1} range={lamps.length}>
        <cylinderGeometry args={[0.04, 0.04, 1.6, 6]} />
        <meshStandardMaterial color="#1a1a1a" />
        {lamps.map((l, i) => (
          <Instance key={i} position={[l.x, 0.8, l.z]} />
        ))}
      </Instances>
      <Instances limit={lamps.length || 1} range={lamps.length}>
        <sphereGeometry args={[0.14, 8, 8]} />
        <meshStandardMaterial color="#ffdd99" emissive="#ffcc66" emissiveIntensity={1.2} />
        {lamps.map((l, i) => (
          <Instance key={i} position={[l.x, 1.62, l.z]} />
        ))}
      </Instances>
    </group>
  );
}

/** Attempts to load Kenney City/Car Kit GLBs; throws if missing so the ErrorBoundary can fall back. */
function GltfProps({ layout }: Props) {
  const { scene: carScene } = useGLTF("/models/kenney/car-sedan.glb") as unknown as { scene: import("three").Group };

  const cars = useMemo(() => {
    const roadBlocks = layout.blocks.filter((b) => b.kind === "road");
    return roadBlocks.filter((_, i) => i % 6 === 0);
  }, [layout]);

  return (
    <group>
      {cars.map((b, i) => (
        <primitive key={i} object={carScene.clone()} position={[b.worldX, 0, b.worldZ]} scale={0.5} />
      ))}
    </group>
  );
}

export default function KenneyProps({ layout }: Props) {
  return (
    <ModelErrorBoundary fallback={<ProceduralProps layout={layout} />}>
      <Suspense fallback={null}>
        <GltfProps layout={layout} />
      </Suspense>
    </ModelErrorBoundary>
  );
}
