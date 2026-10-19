import { useEffect, useRef } from "react";
import * as THREE from "three";

export interface LampCar {
  x: number;
  z: number;
  rot: number;
  y?: number;
}

/** Two warm pools and a faint cone in front of a reel car. Not used by the street fleet. */
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
          <Lamp key={lz} x={px} y={y} z={pz} fx={fwdX} fz={fwdZ} rot={car.rot} />
        );
      })}
    </group>
  );
}

function Lamp({ x, y, z, fx, fz, rot }: { x: number; y: number; z: number; fx: number; fz: number; rot: number }) {
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
        penumbra={0.55}
        intensity={9}
        distance={11}
        color="#ffd9a0"
      />
      <object3D ref={target} position={[x + fx * 4, y - 0.45, z + fz * 4]} />
      <mesh position={[x + fx * 1.15, y - 0.15, z + fz * 1.15]} rotation={[Math.PI / 2, rot, 0]}>
        <coneGeometry args={[0.5, 2.1, 8, 1, true]} />
        <meshBasicMaterial color="#ffd9a0" transparent opacity={0.07} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
