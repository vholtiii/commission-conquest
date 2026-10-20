import { useMemo } from "react";
import { Instance, Instances } from "@react-three/drei";
import type { CityLayout } from "@/engine/cityLayout";
import { hash2 } from "./sceneTheme";
import { SEDAN_PALETTE, SedanFleet, type SedanSpec } from "./Sedan";

interface Props {
  layout: CityLayout;
}

/** Procedural parked sedans + lamp posts. Cinematic cars load the Kenney sedan separately. */
function ProceduralProps({ layout }: Props) {
  const { cars, lamps } = useMemo(() => {
    const roadBlocks = layout.blocks.filter((b) => b.kind === "road");
    const cars: SedanSpec[] = [];
    const lamps: { x: number; z: number }[] = [];

    roadBlocks.forEach((b, i) => {
      const r = hash2(b.gx, b.gz, 7);
      if (i % 5 === 0 && r > 0.5) {
        const avenue = b.gx % 4 === 0; // north–south road: park along Z
        // Crew cars take the west kerb of every avenue (see CrewSedans), so
        // street dressing stays on the east side and never ends up under one.
        const side = avenue ? 0.7 : hash2(b.gx, b.gz, 11) > 0.5 ? 0.7 : -0.7;
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

export default function KenneyProps({ layout }: Props) {
  // The Kenney sedan is for the cinematic handful of cars. Street dressing stays
  // instanced so a full map does not become one draw call per parked car.
  return <ProceduralProps layout={layout} />;
}
