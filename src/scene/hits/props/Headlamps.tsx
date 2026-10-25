import { useEffect, useRef } from "react";
import * as THREE from "three";

export interface LampCar {
  x: number;
  z: number;
  rot: number;
  y?: number;
}

/** Two warm pools of light in front of a reel car. Not used by the street fleet. */
export default function Headlamps({ cars }: { cars: LampCar[] }) {
  return (
    <group>
      {cars.map((car, i) => (
        <Pair key={i} car={car} />
      ))}
    </group>
  );
}

function Pair({ car }: { car: LampCar }) {
  const c = Math.cos(car.rot);
  const s = Math.sin(car.rot);
  const y = (car.y ?? 0) + 0.6;
  const fwdX = c;
  const fwdZ = -s;
  return (
    <group>
      {[0.28, -0.28].map((lz) => {
        const px = car.x + (0.86 * c + lz * s);
        const pz = car.z + (-0.86 * s + lz * c);
        return (
          <Lamp key={lz} x={px} y={y} z={pz} fx={fwdX} fz={fwdZ} />
        );
      })}
    </group>
  );
}

function Lamp({ x, y, z, fx, fz }: { x: number; y: number; z: number; fx: number; fz: number }) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);

  useEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  return (
    <group>
      <spotLight
        ref={light}
        position={[x, y, z]}
        angle={0.42}
        penumbra={0.95}
        intensity={5}
        distance={11}
        color="#ffd9a0"
      />
      <object3D ref={target} position={[x + fx * 4, y - 0.45, z + fz * 4]} />
    </group>
  );
}
