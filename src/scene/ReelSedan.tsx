import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { SedanFleet, type SedanSpec } from "./Sedan";

/** Kenney Car Kit sedan. Length is along +Z; reels face +X and are ~1.9 long. */
const SEDAN_URL = "/models/kenney/car-sedan.glb";
const MODEL_LENGTH = 2.55;
const TARGET_LENGTH = 1.9;
const FIT_SCALE = TARGET_LENGTH / MODEL_LENGTH;
const FIT_YAW = Math.PI / 2;
/** Headlamp glow on the nose, in car space, since the kit paints its lamps into the texture. */
const LAMP_X = 0.93;
const LAMP_Y = 0.46;
const LAMP_Z = [0.33, -0.33];

interface FleetProps {
  cars: SedanSpec[];
  scale?: number;
  castShadow?: boolean;
}

class ModelErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function dress(source: THREE.Object3D, car: SedanSpec, castShadow: boolean): THREE.Object3D {
  const root = source.clone(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = castShadow;
    const name = `${mesh.name} ${mesh.parent?.name ?? ""}`.toLowerCase();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const body = name.includes("body");
    const next = list.map((mat) => {
      const copy = mat.clone();
      const standard = copy instanceof THREE.MeshStandardMaterial;
      if (body && "color" in copy && copy.color instanceof THREE.Color) {
        copy.color.set(car.color);
      }
      if (car.frills === false && standard && (name.includes("chrome") || name.includes("trim") || copy.metalness > 0.35)) {
        copy.color.lerp(new THREE.Color(car.color), 0.7);
        copy.metalness = Math.min(copy.metalness, 0.12);
        copy.roughness = Math.max(copy.roughness, 0.72);
      }
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
  });
  return root;
}

function GltfSedans({ cars, scale = 1, castShadow = false }: FleetProps) {
  const { scene } = useGLTF(SEDAN_URL);
  // Paint and trim decide the clone. Positions change every frame and lamps
  // flick on mid-reel; neither may rebuild the models.
  const look = cars.map((car) => `${car.color}|${car.frills !== false}`).join(";");
  const models = useMemo(
    () => cars.map((car) => dress(scene, car, castShadow)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, look, castShadow],
  );

  // The kit has no separate lamp meshes, but hide them if a swapped-in model does.
  const lamps = cars.map((car) => (car.lamps !== false ? "1" : "0")).join("");
  useEffect(() => {
    models.forEach((root, i) => {
      const on = cars[i]?.lamps !== false;
      root.traverse((obj) => {
        const n = `${obj.name} ${obj.parent?.name ?? ""}`.toLowerCase();
        if ((obj as THREE.Mesh).isMesh && (n.includes("lamp") || n.includes("light"))) obj.visible = on;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, lamps]);

  useEffect(() => {
    return () => {
      for (const root of models) {
        root.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of list) mat.dispose();
        });
      }
    };
  }, [models]);

  return (
    <group>
      {cars.map((car, i) => {
        const model = models[i];
        if (!model) return null;
        const s = car.scale ?? scale;
        return (
          <group
            key={i}
            position={[car.x, car.y ?? 0, car.z]}
            rotation={[car.pitch ?? 0, car.rot, car.roll ?? 0]}
            scale={s}
          >
            <group rotation={[0, FIT_YAW, 0]} scale={FIT_SCALE}>
              <primitive object={model} />
            </group>
            {car.lamps !== false &&
              LAMP_Z.map((lz) => (
                <mesh key={lz} position={[LAMP_X, LAMP_Y, lz]}>
                  <sphereGeometry args={[0.055, 8, 6]} />
                  <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={1.4} />
                </mesh>
              ))}
          </group>
        );
      })}
    </group>
  );
}

/** Cinematic cars. Kenney sedan when the file is present, procedural fleet otherwise. */
export function ReelSedan(props: FleetProps) {
  if (props.cars.length === 0) return null;
  return (
    <ModelErrorBoundary fallback={<SedanFleet {...props} />}>
      <Suspense fallback={<SedanFleet {...props} />}>
        <GltfSedans {...props} />
      </Suspense>
    </ModelErrorBoundary>
  );
}

useGLTF.preload(SEDAN_URL);
