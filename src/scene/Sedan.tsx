import { useMemo } from "react";
import * as THREE from "three";
import { Instance, Instances } from "@react-three/drei";

/**
 * A late-'20s sedan built from a handful of primitives: long hood, upright
 * cabin, running boards, fendered whitewalls, chrome grille and bumpers, a
 * spare on the back. Every part is instanced once per car so a street full of
 * them costs ~20 draw calls total.
 *
 * Car-local space: the car faces +X, sits on y=0, is ~1.9 long at scale 1.
 */

export interface SedanSpec {
  x: number;
  z: number;
  /** Ground or roof height. Defaults to street level. */
  y?: number;
  /** Yaw in radians. 0 faces +X, PI/2 faces -Z. */
  rot: number;
  /** Pitch, used when a blast flips a car. */
  pitch?: number;
  /** Roll, used when a blast flips a car. */
  roll?: number;
  /** Body paint. */
  color: string;
  /** Pinstripe + hood ornament. Defaults to the body colour (invisible). */
  accent?: string;
  /** Overrides the fleet scale for this car. */
  scale?: number;
  /** Headlamps. Off once the car is parked. */
  lamps?: boolean;
  /**
   * Chrome grille, bumpers and whitewall hubs. `false` strips them for a
   * blacked-out car: black hubs, no shine.
   */
  frills?: boolean;
}

/** Period paint: black dominates, with the occasional green, maroon, navy or cream. */
export const SEDAN_PALETTE = [
  "#0c0c0e",
  "#0c0c0e",
  "#101012",
  "#1e3428",
  "#3f1a1e",
  "#1a2740",
  "#4a3a26",
  "#d6c9a8",
];

type Paint = "body" | "trim" | "glass" | "chrome" | "tire" | "whitewall" | "lamp" | "accent";

interface Part {
  geom: THREE.BufferGeometry;
  offset: [number, number, number];
  paint: Paint;
  /** Only on dressed cars (`frills` true) or only on stripped ones. */
  only?: "frills" | "plain";
}

function makeParts(): Part[] {
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const wheelZ = (r: number, h: number) =>
    new THREE.CylinderGeometry(r, r, h, 14).rotateX(Math.PI / 2);
  const wheelX = (r: number, h: number) =>
    new THREE.CylinderGeometry(r, r, h, 14).rotateZ(Math.PI / 2);

  const parts: Part[] = [
    { geom: box(1.9, 0.06, 0.9), offset: [0, 0.2, 0], paint: "trim" },
    { geom: box(1.55, 0.3, 0.72), offset: [-0.02, 0.42, 0], paint: "body" },
    { geom: box(0.6, 0.2, 0.6), offset: [0.52, 0.66, 0], paint: "body" },
    { geom: box(0.1, 0.34, 0.66), offset: [0.2, 0.74, 0], paint: "body" },
    { geom: box(0.72, 0.3, 0.64), offset: [-0.22, 0.78, 0], paint: "glass" },
    { geom: box(0.82, 0.06, 0.72), offset: [-0.22, 0.96, 0], paint: "body" },
    { geom: box(0.3, 0.22, 0.66), offset: [-0.72, 0.64, 0], paint: "body" },
    { geom: box(0.06, 0.32, 0.5), offset: [0.83, 0.5, 0], paint: "chrome", only: "frills" },
    { geom: box(0.06, 0.06, 0.86), offset: [0.95, 0.3, 0], paint: "chrome", only: "frills" },
    { geom: box(0.06, 0.06, 0.86), offset: [-0.95, 0.3, 0], paint: "chrome", only: "frills" },
    // a stripped car still has a grille — just painted like the body
    { geom: box(0.06, 0.32, 0.5), offset: [0.83, 0.5, 0], paint: "body", only: "plain" },
    { geom: wheelX(0.17, 0.1), offset: [-0.92, 0.55, 0], paint: "tire" },
    { geom: box(1.5, 0.07, 0.76), offset: [-0.02, 0.5, 0], paint: "accent" },
    { geom: box(0.84, 0.03, 0.74), offset: [-0.22, 0.99, 0], paint: "accent" },
    { geom: box(0.05, 0.16, 0.05), offset: [0.75, 0.84, 0], paint: "accent" },
  ];

  const lamp = new THREE.SphereGeometry(0.075, 10, 8);
  parts.push({ geom: lamp, offset: [0.86, 0.6, 0.28], paint: "lamp" });
  parts.push({ geom: lamp, offset: [0.86, 0.6, -0.28], paint: "lamp" });

  const fender = wheelZ(0.22, 0.14);
  const tire = wheelZ(0.18, 0.1);
  const hub = wheelZ(0.1, 0.11);
  for (const sx of [-0.62, 0.62]) {
    for (const sz of [-0.4, 0.4]) {
      parts.push({ geom: fender, offset: [sx, 0.36, sz], paint: "body" });
      parts.push({ geom: tire, offset: [sx, 0.18, sz * 1.05], paint: "tire" });
      parts.push({ geom: hub, offset: [sx, 0.18, sz * 1.05], paint: "whitewall", only: "frills" });
      parts.push({ geom: hub, offset: [sx, 0.18, sz * 1.05], paint: "trim", only: "plain" });
    }
  }
  return parts;
}

function PaintMaterial({ paint }: { paint: Paint }) {
  switch (paint) {
    case "glass":
      return <meshStandardMaterial color="#3b4a5c" metalness={0.6} roughness={0.15} />;
    case "chrome":
      return <meshStandardMaterial color="#b8bcc2" metalness={0.9} roughness={0.25} />;
    case "tire":
      return <meshStandardMaterial color="#0e0e10" roughness={0.9} />;
    case "whitewall":
      return <meshStandardMaterial color="#d9d3c5" roughness={0.7} />;
    case "trim":
      return <meshStandardMaterial color="#141416" metalness={0.3} roughness={0.6} />;
    case "lamp":
      return (
        <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={0.8} />
      );
    default:
      // body / accent: coloured per instance
      return <meshStandardMaterial metalness={0.45} roughness={0.35} />;
  }
}

const PER_INSTANCE: Paint[] = ["body", "accent"];

function colorFor(paint: Paint, car: SedanSpec): string | undefined {
  if (paint === "body") return car.color;
  if (paint === "accent") return car.accent ?? car.color;
  return undefined;
}

interface FleetProps {
  cars: SedanSpec[];
  scale?: number;
  castShadow?: boolean;
}

export function SedanFleet({ cars, scale = 1, castShadow = false }: FleetProps) {
  const parts = useMemo(makeParts, []);
  if (cars.length === 0) return null;

  return (
    <group key={cars.length}>
      {parts.map((part, pi) => (
        <Instances
          key={pi}
          geometry={part.geom}
          limit={cars.length}
          range={cars.length}
          castShadow={castShadow}
        >
          <PaintMaterial paint={part.paint} />
          {cars.map((car, ci) => {
            if (part.paint === "lamp" && car.lamps === false) return null;
            if (part.only === "frills" && car.frills === false) return null;
            if (part.only === "plain" && car.frills !== false) return null;
            const [ox, oy, oz] = part.offset;
            const s_ = car.scale ?? scale;
            const c = Math.cos(car.rot);
            const s = Math.sin(car.rot);
            const x = car.x + (ox * c + oz * s) * s_;
            const z = car.z + (-ox * s + oz * c) * s_;
            const color = PER_INSTANCE.includes(part.paint) ? colorFor(part.paint, car) : undefined;
            return (
              <Instance
                key={ci}
                position={[x, (car.y ?? 0) + oy * s_, z]}
                rotation={[car.pitch ?? 0, car.rot, car.roll ?? 0]}
                scale={s_}
                color={color}
              />
            );
          })}
        </Instances>
      ))}
    </group>
  );
}
