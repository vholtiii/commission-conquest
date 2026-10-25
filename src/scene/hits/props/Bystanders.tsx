import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import Person from "@/scene/Person";

interface Props {
  at: [number, number, number];
  facing: number;
  /** They turn and run once the first shot goes off. */
  flee: boolean;
}

const SPOTS: [number, number][] = [
  [1.7, 0.55],
  [-1.4, 0.9],
  [2.2, -0.35],
];

const COATS = ["#3a342c", "#4a3a2e", "#2e3238"];

/** Two or three people on the pavement who were not part of the job. */
export default function Bystanders({ at, facing, flee }: Props) {
  const groups = [useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const started = useRef<number | null>(null);
  const side = useMemo(() => new THREE.Vector3(-Math.cos(facing), 0, Math.sin(facing)), [facing]);
  const away = useMemo(() => new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), [facing]);
  const focus = useMemo(() => new THREE.Vector3(at[0], 0.9, at[2]).addScaledVector(away, -1.2), [at, away]);
  const homes = useMemo(
    () =>
      SPOTS.map(([along, out]) =>
        new THREE.Vector3(at[0], 0, at[2]).addScaledVector(side, along).addScaledVector(away, out),
      ),
    [at, side, away],
  );

  useFrame(({ clock, camera }) => {
    if (!flee) started.current = null;
    else if (started.current === null) started.current = clock.elapsedTime;
    const k = started.current === null ? 0 : Math.min(1, (clock.elapsedTime - started.current) / 1.5);
    homes.forEach((home, i) => {
      const g = groups[i]!.current;
      if (!g) return;
      g.position.copy(home).addScaledVector(side, k * (3.2 + i * 0.6));
      g.rotation.y = flee ? facing + Math.PI / 2 : facing;
      // Nobody in the story; a head at the lens would fill half the frame.
      const dx = camera.position.x - g.position.x;
      const dz = camera.position.z - g.position.z;
      g.visible = dx * dx + dz * dz > 1.6 * 1.6;
    });
  });

  return (
    <group>
      {homes.map((_, i) => (
        <group key={i} ref={groups[i]}>
          <Person
            position={[0, 0, 0]}
            pose={flee ? "run" : "stand"}
            moving={flee}
            role="associate"
            color={COATS[i % COATS.length]}
            seed={Math.round(at[0] * 97 + at[2] * 31) + i * 7919}
            lookAt={flee ? undefined : focus}
          />
        </group>
      ))}
    </group>
  );
}
