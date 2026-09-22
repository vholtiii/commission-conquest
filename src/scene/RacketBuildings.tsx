import { useEffect, useMemo, useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { blockKey, racketBlockFor } from "@/engine/cityLayout";
import { racketFreshness } from "@/engine/economy";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import type { RacketType, Territory } from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import { useGameStore } from "@/engine/store";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const RISE_DELAY = 0.8;
const RISE_DURATION = 0.9;

const WOOD = "#3d2b1c";
const WOOD_DARK = "#2a1d14";
const BLACKOUT = "#07080a";

/** Two boarded, blacked-out windows on the roof and the front, plus a shut door. */
function HideoutFront({
  width,
  height,
  depth,
  kind,
}: {
  width: number;
  height: number;
  depth: number;
  kind: "still" | "warehouse" | "safehouse";
}) {
  const z = depth / 2 + 0.045;
  const winY = height * 0.62;
  const span = width * 0.26;
  const winW = Math.min(width * 0.32, 0.7);
  const winD = Math.min(depth * 0.55, 0.85);
  const winH = Math.min(height * 0.28, 0.42);
  const doorH = Math.min(height * 0.42, 0.7);

  return (
    <group>
      {[-span, span].map((x) => (
        <group key={`roof-${x}`} position={[x, height + 0.08, 0]}>
          <mesh>
            <boxGeometry args={[winW + 0.12, 0.04, winD + 0.12]} />
            <meshStandardMaterial color="#6b5a46" roughness={0.9} />
          </mesh>
          <mesh position={[0, 0.035, 0]}>
            <boxGeometry args={[winW, 0.05, winD]} />
            <meshStandardMaterial color={BLACKOUT} roughness={1} metalness={0} />
          </mesh>
          <mesh position={[0, 0.07, 0]}>
            <boxGeometry args={[winW + 0.08, 0.035, 0.07]} />
            <meshStandardMaterial color={WOOD} roughness={0.95} />
          </mesh>
          <mesh position={[0, 0.09, 0]} rotation={[0, 0.55, 0]}>
            <boxGeometry args={[0.06, 0.03, winD + 0.06]} />
            <meshStandardMaterial color={WOOD_DARK} roughness={0.95} />
          </mesh>
        </group>
      ))}

      {[-span, span].map((x) => (
        <group key={`wall-${x}`} position={[x, winY, z]}>
          <mesh>
            <boxGeometry args={[winW * 0.7, winH, 0.05]} />
            <meshStandardMaterial color={BLACKOUT} roughness={1} metalness={0} />
          </mesh>
          <mesh position={[0, 0.02, 0.035]}>
            <boxGeometry args={[winW * 0.7 + 0.1, 0.055, 0.03]} />
            <meshStandardMaterial color={WOOD} roughness={0.95} />
          </mesh>
          <mesh position={[0, -0.02, 0.05]} rotation={[0, 0, 0.85]}>
            <boxGeometry args={[winW * 0.65, 0.04, 0.025]} />
            <meshStandardMaterial color={WOOD_DARK} roughness={0.95} />
          </mesh>
          <mesh position={[0, winH * 0.12, 0.06]}>
            <boxGeometry args={[0.04, 0.03, 0.02]} />
            <meshStandardMaterial
              color="#c4783a"
              emissive="#c4783a"
              emissiveIntensity={0.45}
            />
          </mesh>
        </group>
      ))}

      <mesh position={[0, doorH / 2 + 0.02, z]}>
        <boxGeometry args={[0.38, doorH, 0.04]} />
        <meshStandardMaterial color="#100e0c" roughness={0.9} />
      </mesh>
      <mesh position={[0, doorH * 0.55, z + 0.03]}>
        <boxGeometry args={[0.46, 0.05, 0.025]} />
        <meshStandardMaterial color={WOOD} roughness={0.95} />
      </mesh>

      {kind === "still" && (
        <mesh position={[width * 0.32, height + 0.28, 0]}>
          <boxGeometry args={[0.14, 0.56, 0.14]} />
          <meshStandardMaterial color="#2a2e32" roughness={0.55} metalness={0.45} />
        </mesh>
      )}
      {kind === "warehouse" && (
        <mesh position={[width / 2 + 0.22, 0.2, depth * 0.15]} castShadow>
          <boxGeometry args={[0.38, 0.38, 0.38]} />
          <meshStandardMaterial color="#4a3824" roughness={0.92} />
        </mesh>
      )}
      {kind === "safehouse" && (
        <mesh position={[0, height + 0.04, 0]}>
          <boxGeometry args={[width + 0.15, 0.08, depth + 0.15]} />
          <meshStandardMaterial color="#1a1c18" roughness={1} />
        </mesh>
      )}

      <mesh position={[0, height + 0.02, 0]}>
        <boxGeometry args={[width + 0.08, 0.06, depth + 0.08]} />
        <meshStandardMaterial color="#16181a" roughness={0.95} />
      </mesh>
    </group>
  );
}

/** Lit shopfront: pale cornice, two glowing roof windows, awning, and one type marker. */
function Storefront({
  type,
  width,
  height,
  depth,
  color,
  emissive,
}: {
  type: RacketType;
  width: number;
  height: number;
  depth: number;
  color: string;
  emissive: string;
}) {
  const span = width * 0.22;
  const pane = Math.min(width * 0.2, 0.4);

  return (
    <group>
      <mesh position={[0, height + 0.03, 0]}>
        <boxGeometry args={[width + 0.08, 0.05, depth + 0.08]} />
        <meshStandardMaterial color="#e4ddd2" roughness={0.55} />
      </mesh>
      {[-span, span].map((x) => (
        <group key={x} position={[x, height + 0.07, 0]}>
          <mesh>
            <boxGeometry args={[pane + 0.1, 0.03, pane * 0.85]} />
            <meshStandardMaterial color="#f3efe8" roughness={0.45} />
          </mesh>
          <mesh position={[0, 0.03, 0]}>
            <boxGeometry args={[pane, 0.035, pane * 0.62]} />
            <meshStandardMaterial color={emissive} emissive={emissive} emissiveIntensity={0.7} roughness={0.35} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, height * 0.48, depth / 2 + 0.14]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[width * 0.82, 0.045, 0.32]} />
        <meshStandardMaterial color={color} roughness={0.55} />
      </mesh>
      <mesh position={[0, height * 0.28, depth / 2 + 0.04]}>
        <boxGeometry args={[0.34, Math.min(height * 0.4, 0.7), 0.04]} />
        <meshStandardMaterial color="#2c241c" roughness={0.75} />
      </mesh>
      <StorefrontMark type={type} width={width} height={height} depth={depth} emissive={emissive} />
    </group>
  );
}

function StorefrontMark({
  type,
  width,
  height,
  depth,
  emissive,
}: {
  type: RacketType;
  width: number;
  height: number;
  depth: number;
  emissive: string;
}) {
  const y = height + 0.16;
  if (type === "brewery") {
    return (
      <mesh position={[0, y + 0.1, -depth * 0.15]}>
        <boxGeometry args={[0.42, 0.36, 0.42]} />
        <meshStandardMaterial color="#b87333" roughness={0.4} metalness={0.55} />
      </mesh>
    );
  }
  if (type === "speakeasy") {
    return (
      <mesh position={[0, y, depth * 0.2]}>
        <boxGeometry args={[width * 0.7, 0.06, 0.1]} />
        <meshStandardMaterial color={emissive} emissive={emissive} emissiveIntensity={0.9} />
      </mesh>
    );
  }
  if (type === "gambling") {
    return (
      <mesh position={[0, y, 0]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.28, 0.06, 0.28]} />
        <meshStandardMaterial color="#f4f1ea" emissive="#f4f1ea" emissiveIntensity={0.25} />
      </mesh>
    );
  }
  if (type === "brothel") {
    return (
      <group position={[width * 0.28, y, depth * 0.1]}>
        <mesh position={[0, -0.08, 0]}>
          <boxGeometry args={[0.06, 0.16, 0.06]} />
          <meshStandardMaterial color="#2a2428" />
        </mesh>
        <mesh>
          <boxGeometry args={[0.16, 0.16, 0.16]} />
          <meshStandardMaterial color={emissive} emissive={emissive} emissiveIntensity={1.1} />
        </mesh>
      </group>
    );
  }
  if (type === "loan_shark") {
    return (
      <group position={[-width * 0.22, y, 0]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0, i * 0.06, 0]}>
            <boxGeometry args={[0.34 - i * 0.04, 0.05, 0.16]} />
            <meshStandardMaterial color="#e2b340" emissive="#e2b340" emissiveIntensity={0.25} metalness={0.6} roughness={0.35} />
          </mesh>
        ))}
      </group>
    );
  }
  if (type === "laundromat") {
    return (
      <mesh position={[width * 0.22, y, 0]}>
        <boxGeometry args={[0.28, 0.28, 0.28]} />
        <meshStandardMaterial color="#f7f7f5" roughness={0.35} metalness={0.2} />
      </mesh>
    );
  }
  if (type === "barber") {
    return (
      <group position={[width / 2 + 0.08, height * 0.55, depth / 2]}>
        {["#c23b3b", "#f4f1ea", "#2a4e8a"].map((c, i) => (
          <mesh key={c} position={[0, i * 0.16, 0]}>
            <boxGeometry args={[0.1, 0.16, 0.1]} />
            <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.2} />
          </mesh>
        ))}
      </group>
    );
  }
  if (type === "restaurant") {
    return (
      <mesh position={[width * 0.3, y + 0.08, -depth * 0.15]}>
        <boxGeometry args={[0.16, 0.32, 0.16]} />
        <meshStandardMaterial color="#6a4030" roughness={0.8} />
      </mesh>
    );
  }
  if (type === "trucking") {
    return (
      <mesh position={[width / 2 + 0.28, 0.22, 0]} castShadow>
        <boxGeometry args={[0.5, 0.4, 0.7]} />
        <meshStandardMaterial color="#5d6b5d" roughness={0.7} />
      </mesh>
    );
  }
  if (type === "deli") {
    return (
      <mesh position={[width * 0.3, 0.16, depth / 2 + 0.2]}>
        <boxGeometry args={[0.28, 0.28, 0.28]} />
        <meshStandardMaterial color="#6a8f4e" roughness={0.8} />
      </mesh>
    );
  }
  return null;
}

function tintToward(base: string, toward: string, amount: number): string {
  const a = new THREE.Color(base);
  const b = new THREE.Color(toward);
  return a.lerp(b, amount).getStyle();
}

function makeSquareRingGeometry(outer: number, inner: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const o = outer / 2;
  shape.moveTo(-o, -o);
  shape.lineTo(o, -o);
  shape.lineTo(o, o);
  shape.lineTo(-o, o);
  shape.closePath();

  const hole = new THREE.Path();
  const i = inner / 2;
  hole.moveTo(-i, -i);
  hole.lineTo(-i, i);
  hole.lineTo(i, i);
  hole.lineTo(i, -i);
  hole.closePath();
  shape.holes.push(hole);

  return new THREE.ShapeGeometry(shape);
}

function RacketBuilding({
  territory,
  racketIndex,
  layout,
  isPlayerOwned,
  turn,
}: {
  territory: Territory;
  racketIndex: number;
  layout: CityLayout;
  isPlayerOwned: boolean;
  turn: number;
}) {
  const racket = territory.rackets[racketIndex]!;
  const block = racketBlockFor(layout, territory.id, racketIndex);
  const invalidate = useThree((s) => s.invalidate);

  const groupRef = useRef<THREE.Group>(null);
  const neonRef = useRef<THREE.MeshStandardMaterial>(null);
  const roofRef = useRef<THREE.MeshStandardMaterial>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  const riseStart = useRef<number | null>(null);
  const riseDone = useRef(false);
  const popStart = useRef<number | null>(null);
  const popArmed = useRef(false);
  const lastUpgradeStamp = useRef<number | undefined>(undefined);

  const freshness = isPlayerOwned ? racketFreshness(racket, turn) : null;
  const visual = RACKET_VISUALS[racket.type];
  const lowProfile = !!block && block.kind !== "building";
  const height = lowProfile ? 1.3 + racket.level * 0.3 : 2.6 + racket.level * 0.9;
  const footprint: [number, number] = lowProfile ? [2.4, 1.6] : [2.0, 2.0];
  const glow = 0.35 + racket.level * 0.15;
  const hideout =
    racket.type === "still" || racket.type === "warehouse" || racket.type === "safehouse";
  const bodyColor = hideout
    ? tintToward("#12110e", visual.color, 0.18)
    : tintToward("#3a3c40", visual.color, 0.62);
  const Icon = visual.Icon;
  const haloGeo = useMemo(() => makeSquareRingGeometry(2.8, 2.15), []);

  // Arm rise once when this building is newly built this turn
  useEffect(() => {
    if (freshness === "new" && !riseDone.current && isPlayerOwned) {
      riseStart.current = null; // latch on first frame
      if (groupRef.current) groupRef.current.scale.set(1, 0.05, 1);
      invalidate();
    }
  }, [freshness, isPlayerOwned, invalidate]);

  // Arm pop when upgraded this turn (once per upgradedTurn stamp)
  useEffect(() => {
    if (
      freshness === "upgraded" &&
      isPlayerOwned &&
      racket.upgradedTurn !== lastUpgradeStamp.current
    ) {
      lastUpgradeStamp.current = racket.upgradedTurn;
      popArmed.current = true;
      invalidate();
    }
  }, [freshness, isPlayerOwned, racket.upgradedTurn, invalidate]);

  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g || !block) return;
    let animating = false;
    const now = clock.getElapsedTime();

    // Rise
    if (freshness === "new" && !riseDone.current) {
      if (riseStart.current === null) riseStart.current = now;
      const elapsed = now - riseStart.current;
      if (elapsed < RISE_DELAY) {
        g.scale.set(1, 0.05, 1);
        animating = true;
      } else {
        const t = Math.min(1, (elapsed - RISE_DELAY) / RISE_DURATION);
        const ease = 1 - Math.pow(1 - t, 3);
        g.scale.set(1, 0.05 + ease * 0.95, 1);
        animating = t < 1;
        if (t >= 1) {
          riseDone.current = true;
          riseStart.current = null;
          g.scale.set(1, 1, 1);
        }
      }
    }

    // Pop
    if (popArmed.current) {
      popStart.current = now;
      popArmed.current = false;
    }
    if (popStart.current !== null) {
      const t = Math.min(1, (now - popStart.current) / 0.5);
      const pop = t < 0.35 ? 1 + (t / 0.35) * 0.18 : 1.18 - ((t - 0.35) / 0.65) * 0.18;
      if (riseDone.current || freshness !== "new") {
        g.scale.setScalar(pop);
      }
      const flash = 1 + (1 - t) * 1.5;
      if (neonRef.current) neonRef.current.emissiveIntensity = glow * flash;
      if (roofRef.current) roofRef.current.emissiveIntensity = glow * 1.4 * flash;
      animating = t < 1;
      if (t >= 1) {
        popStart.current = null;
        if (riseDone.current || freshness !== "new") g.scale.set(1, 1, 1);
        if (neonRef.current) neonRef.current.emissiveIntensity = glow;
        if (roofRef.current) roofRef.current.emissiveIntensity = glow * 1.4;
      }
    }

    // Halo pulse
    if (haloRef.current && freshness) {
      const pulse = 1 + Math.sin(now * 2.4) * 0.08;
      haloRef.current.scale.setScalar(pulse);
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.45 + Math.abs(Math.sin(now * 2.4)) * 0.35;
      animating = true;
    }

    if (animating) invalidate();
  });

  if (!block) return null;

  const bandCount = racket.level;
  const bandGap = (height - 0.8) / Math.max(1, bandCount);

  return (
    <group ref={groupRef} position={[block.worldX, 0, block.worldZ]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <boxGeometry args={[footprint[0], height, footprint[1]]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} metalness={0.15} />
      </mesh>

      {hideout ? (
        <HideoutFront
          width={footprint[0]}
          height={height}
          depth={footprint[1]}
          kind={racket.type === "warehouse" || racket.type === "safehouse" ? racket.type : "still"}
        />
      ) : (
        <Storefront
          type={racket.type}
          width={footprint[0]}
          height={height}
          depth={footprint[1]}
          color={visual.color}
          emissive={visual.emissive}
        />
      )}

      {!lowProfile &&
        !hideout &&
        Array.from({ length: bandCount }).map((_, i) => (
          <mesh key={i} position={[0, 0.5 + i * bandGap + 0.09, 1.02]}>
            <boxGeometry args={[1.6, 0.18, 0.06]} />
            <meshStandardMaterial
              color={visual.emissive}
              emissive={visual.emissive}
              emissiveIntensity={0.55 + i * 0.1}
              roughness={0.35}
            />
          </mesh>
        ))}

      {!hideout && (
        <mesh position={[0, lowProfile ? height * 0.72 : height * 0.55, footprint[1] / 2 + 0.03]}>
          <boxGeometry args={[lowProfile ? 1.2 : 1.5, lowProfile ? 0.22 : 0.42, 0.06]} />
          <meshStandardMaterial
            ref={neonRef}
            color={visual.color}
            emissive={visual.emissive}
            emissiveIntensity={lowProfile ? glow * 0.45 : glow}
            roughness={0.4}
          />
        </mesh>
      )}

      {!lowProfile && !hideout && (
        <mesh position={[0, height + 0.18, 0]}>
          <boxGeometry args={[0.4, 0.22, 0.4]} />
          <meshStandardMaterial
            ref={roofRef}
            color={visual.emissive}
            emissive={visual.emissive}
            emissiveIntensity={glow * 1.4}
          />
        </mesh>
      )}
      <pointLight
        position={hideout ? [0, height * 0.35, footprint[1] / 2 + 0.2] : [0, height + 0.55, 0]}
        color={hideout ? "#c4783a" : visual.emissive}
        intensity={hideout ? 0.22 : (0.7 + racket.level * 0.3) * (lowProfile ? 0.5 : 1)}
        distance={hideout ? 3.5 : 7}
      />

      {freshness && (
        <mesh
          ref={haloRef}
          geometry={haloGeo}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.06, 0]}
        >
          <meshBasicMaterial
            color={visual.emissive}
            transparent
            opacity={0.65}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <Html position={[0, height + 0.95, 0]} center occlude={false} zIndexRange={[4, 1]}>
        <div className="pointer-events-none flex select-none flex-col items-center gap-0.5">
          {freshness && (
            <span
              className="rounded px-1 text-[8px] font-bold uppercase tracking-wide text-black"
              style={{ background: freshness === "new" ? "#c9a227" : visual.emissive }}
            >
              {freshness === "new" ? "NEW" : "UPGRADED"}
            </span>
          )}
          <div
            className="flex items-center gap-1 rounded-md border border-black/40 px-1.5 py-0.5 shadow"
            style={{ background: `${visual.color}ee` }}
          >
            <Icon className="h-3 w-3 text-black/90" />
            <span className="text-[9px] font-bold uppercase tracking-wide text-black/90">
              {visual.sign}
            </span>
          </div>
          <div className="flex gap-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <span
                key={i}
                className={`h-1 w-1 rounded-full ${i < racket.level ? "bg-amber-300" : "bg-black/40"}`}
              />
            ))}
          </div>
          <span className="rounded bg-black/70 px-1 text-[8px] text-white/80">
            {RACKET_LABELS[racket.type]}
          </span>
        </div>
      </Html>
    </group>
  );
}

export function useOccupiedRacketBlocks(
  layout: CityLayout,
  territories: Territory[],
): Set<string> {
  return useMemo(() => {
    const occupied = new Set<string>();
    for (const t of territories) {
      t.rackets.forEach((_, i) => {
        const b = racketBlockFor(layout, t.id, i);
        if (b) occupied.add(blockKey(b.gx, b.gz));
      });
    }
    return occupied;
  }, [layout, territories]);
}

export default function RacketBuildings({ layout, territories }: Props) {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const discovered = territories.filter((t) => t.discovered && t.rackets.length > 0);

  return (
    <group>
      {discovered.map((t) =>
        t.rackets.map((_, i) => (
          <RacketBuilding
            key={`${t.id}-${t.rackets[i]!.id}`}
            territory={t}
            racketIndex={i}
            layout={layout}
            isPlayerOwned={!!playerFamily && t.owner === playerFamily}
            turn={turn}
          />
        )),
      )}
    </group>
  );
}
