import { Component, Suspense, useMemo, type ReactNode } from "react";
import { Instance, Instances, useGLTF } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { hash2 } from "./sceneTheme";

interface Props {
  layout: CityLayout;
}

const CAR_COLORS = ["#1c1c1e", "#2b2f36", "#3a1f1f", "#20301f", "#1a1a1a"];

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

/** Simple procedural cars + lamp posts, used whenever Kenney GLBs are unavailable. */
function ProceduralProps({ layout }: Props) {
  const { cars, lamps } = useMemo(() => {
    const roadBlocks = layout.blocks.filter((b) => b.kind === "road");
    const cars: { x: number; z: number; color: string; rot: number }[] = [];
    const lamps: { x: number; z: number }[] = [];

    roadBlocks.forEach((b, i) => {
      const r = hash2(b.gx, b.gz, 7);
      if (i % 5 === 0 && r > 0.5) {
        cars.push({
          x: b.worldX + (r - 0.5) * 0.6,
          z: b.worldZ,
          color: CAR_COLORS[Math.floor(r * CAR_COLORS.length)]!,
          rot: b.gx % 4 === 0 ? 0 : Math.PI / 2,
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
      <Instances limit={cars.length || 1} range={cars.length}>
        <boxGeometry args={[0.9, 0.4, 0.45]} />
        <meshStandardMaterial roughness={0.4} metalness={0.3} />
        {cars.map((c, i) => (
          <Instance key={i} position={[c.x, 0.25, c.z]} rotation={[0, c.rot, 0]} color={c.color} />
        ))}
      </Instances>

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
