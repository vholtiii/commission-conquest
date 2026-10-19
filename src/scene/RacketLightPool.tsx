import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { racketBlockFor, type CityLayout } from "@/engine/cityLayout";
import { FAMILY_HEX, type Territory } from "@/types/game";

const POOL = 6;

interface Site {
  x: number;
  y: number;
  z: number;
  color: string;
}

/**
 * A fixed handful of lights, retargeted at the nearest racket blocks.
 * The count never changes, so building a racket does not recompile shaders.
 */
export default function RacketLightPool({
  layout,
  territories,
}: {
  layout: CityLayout;
  territories: Territory[];
}) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null;
  const acc = useRef(1);

  const sites = useMemo(() => {
    const out: Site[] = [];
    for (const t of territories) {
      if (!t.discovered) continue;
      t.rackets.forEach((r, i) => {
        if (r.type === "safehouse") return;
        const site = typeof r.siteIndex === "number" ? r.siteIndex : i;
        const block = racketBlockFor(layout, t.id, site);
        if (!block) return;
        const low = block.kind !== "building";
        const height = low ? 1.3 + r.level * 0.3 : 2.6 + r.level * 0.9;
        out.push({
          x: block.worldX,
          y: (r.type === "still" || r.type === "warehouse" ? height * 0.35 : height + 0.55),
          z: block.worldZ,
          color: t.owner ? FAMILY_HEX[t.owner] : "#e8c27a",
        });
      });
    }
    return out;
  }, [layout, territories]);

  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.3) return;
    acc.current = 0;
    const tx = controls?.target?.x ?? camera.position.x;
    const tz = controls?.target?.z ?? camera.position.z;
    const ranked = sites
      .map((s) => ({ s, d: (s.x - tx) * (s.x - tx) + (s.z - tz) * (s.z - tz) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL; i++) {
      const light = lights.current[i];
      const pick = ranked[i];
      if (!light) continue;
      if (!pick) {
        light.intensity = 0;
        continue;
      }
      light.position.set(pick.s.x, pick.s.y, pick.s.z);
      light.color.set(pick.s.color);
      light.intensity = 1.15;
      light.distance = 8;
    }
  });

  return (
    <group>
      {Array.from({ length: POOL }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => {
            lights.current[i] = el;
          }}
          intensity={0}
          distance={8}
          decay={2}
        />
      ))}
    </group>
  );
}
