import { useRef } from "react";
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { resolveCrewLocation } from "@/engine/crewLocation";
import { hasFreshCasing } from "@/engine/intel";
import { venueTravel } from "@/engine/sitdowns";
import { useGameStore } from "@/engine/store";
import type { Sitdown } from "@/types/game";

const STEEL = "#9aa8b8";
const GOLD = "#d4a24a";

function PulsingRing({ x, z, color }: { x: number; z: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const p = (Math.sin(clock.elapsedTime * 2.4) + 1) / 2;
    const s = 1.15 + p * 0.35;
    mesh.scale.set(s, s, s);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.55 - p * 0.3;
  });
  return (
    <mesh ref={ref} position={[x, 0.12, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.35, 1.6, 28]} />
      <meshBasicMaterial color={color} transparent opacity={0.45} depthWrite={false} />
    </mesh>
  );
}

function Marker({
  sitdown,
  layout,
}: {
  sitdown: Sitdown;
  layout: CityLayout;
}) {
  const state = useGameStore();
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const player = state.playerFamily;
  if (!player) return null;
  const center = layout.centers.find((c) => c.territoryId === sitdown.venueTerritoryId);
  if (!center) return null;
  const family = sitdown.proposer === player ? sitdown.other : sitdown.proposer;
  const color = sitdown.purpose === "passage" ? GOLD : STEEL;
  const when =
    sitdown.status === "proposed"
      ? "invite"
      : sitdown.heldTurn <= state.turn
        ? "now"
        : `T+${sitdown.heldTurn - state.turn}`;
  const cased = hasFreshCasing(state, sitdown.venueTerritoryId);
  const travel = venueTravel(state, family, sitdown.venue);
  const boss = state.crew.find((c) => c.family === player && c.role === "boss" && c.status === "active");
  const homeId = boss ? resolveCrewLocation(state, boss.id).territoryId : null;
  const home = homeId ? layout.centers.find((c) => c.territoryId === homeId) : null;

  return (
    <group>
      <PulsingRing x={center.worldX} z={center.worldZ} color={color} />
      {travel.playerTravels && home && (
        <Line
          points={[
            [home.worldX, 0.35, home.worldZ],
            [center.worldX, 0.35, center.worldZ],
          ]}
          color={color}
          dashed
          dashSize={0.55}
          gapSize={0.35}
          lineWidth={1}
        />
      )}
      <Html position={[center.worldX, 2.4, center.worldZ]} center zIndexRange={[20, 0]}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            selectTerritory(sitdown.venueTerritoryId);
          }}
          className="pointer-events-auto whitespace-nowrap rounded border border-white/15 bg-black/75 px-2 py-1 text-left font-ui text-[10px] text-white shadow"
        >
          <span style={{ color }}>Sit-down</span>
          {` · ${family} · ${when}`}
          <span className="block text-[9px] text-white/70">
            {cased ? "Venue cased" : "Venue not cased"}
          </span>
        </button>
      </Html>
    </group>
  );
}

/** Pulsing rings for sit-downs the player is part of. Hidden while a cinematic plays. */
export default function SitdownOverlay({ layout }: { layout: CityLayout }) {
  const sitdowns = useGameStore((s) => s.sitdowns);
  const player = useGameStore((s) => s.playerFamily);
  const phase = useGameStore((s) => s.sitdownPhase);
  const hitPlaying = useGameStore((s) => s.cinematicQueue.length > 0 && !s.pendingHitResult);
  const mine = (sitdowns ?? []).filter(
    (s) =>
      (s.status === "proposed" || s.status === "scheduled" || s.status === "at_table") &&
      (s.proposer === player || s.other === player),
  );
  if (!player || phase || hitPlaying) return null;
  if (mine.length === 0) return null;
  return (
    <group>
      {mine.map((s) => (
        <Marker key={s.id} sitdown={s} layout={layout} />
      ))}
    </group>
  );
}
