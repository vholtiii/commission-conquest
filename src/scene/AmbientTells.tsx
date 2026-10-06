import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import { resolveCrewLocation } from "@/engine/crewLocation";
import { normalizeIntel } from "@/engine/intel";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import { activeCrewIds, isUnguarded } from "@/engine/territoryValue";
import type { FamilyName, Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";
import CrewSedans, { crewSedans } from "./CrewSedans";
import Person, { type PersonRole } from "./Person";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const LOW_LOYALTY = 40;

function silhouette(role: string): PersonRole {
  if (role === "associate") return "associate";
  if (role === "soldier") return "soldier";
  return "boss";
}

function offsetFor(id: string): [number, number] {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const ang = ((h % 360) * Math.PI) / 180;
  const dist = 2.6 + (h % 4) * 0.35;
  return [Math.cos(ang) * dist, Math.sin(ang) * dist];
}

/** Wordless street props. Hidden in the strategic overview. */
export default function AmbientTells({ layout, territories }: Props) {
  const overview = useMapView((s) => s.overview);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const operations = useGameStore((s) => s.operations);
  const routes = useGameStore((s) => s.routes);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);
  const sitdownFamily = useGameStore((s) => s.sitdownCinematicQueue?.[0]?.family);
  // A witnessed hit shows the shooters and the mark, nothing else about who
  // was on that block — so its parked cars go dark for the reel.
  const witnessedBlock = useGameStore((s) => {
    const reel = s.cinematicQueue[0];
    return reel && !s.pendingHitResult && reel.perspective === "witnessed"
      ? reel.targetTerritoryId
      : null;
  });

  if (overview || !playerFamily) return null;

  const byId = new Map(territories.map((t) => [t.id, t]));
  const centerById = new Map(layout.centers.map((c) => [c.territoryId, c]));
  const standing = activeCrewIds(crew);
  const locState = {
    crew,
    territories,
    routes,
    operations,
    playerFamily,
    turn,
    intel: normalizeIntel(intel),
  };
  const hiddenBosses =
    sitdownPhase && sitdownFamily ? new Set<FamilyName>([playerFamily, sitdownFamily]) : undefined;
  const cars = crewSedans(locState, byId, centerById, layout, hiddenBosses).filter(
    (car) => car.territoryId !== witnessedBlock,
  );

  const owned = territories.filter(
    (t) => t.owner === playerFamily && t.discovered && t.rackets.length > 0,
  );

  const loiterers = crew.filter(
    (c) =>
      c.family === playerFamily &&
      c.status === "active" &&
      c.role !== "boss" &&
      c.loyalty < LOW_LOYALTY,
  );

  const lookouts = operations.filter(
    (o) =>
      !o.resolved &&
      o.kind === "surveillance" &&
      o.targetFamily === playerFamily,
  );

  return (
    <group>
      {owned.map((territory) => {
        const block = racketBlockFor(layout, territory.id, 0);
        if (!block) return null;
        const guarded = !isUnguarded(territory, standing);
        const x = block.worldX;
        const z = block.worldZ + 0.95;
        return (
          <group key={territory.id}>
            <mesh position={[x, 0.05, z]} receiveShadow>
              <boxGeometry args={[0.8, 0.08, 0.36]} />
              <meshStandardMaterial color="#4a453e" roughness={0.9} />
            </mesh>
            {guarded && (
              <Person position={[x, 0, z]} color={FAMILY_HEX[playerFamily]} role="soldier" />
            )}
          </group>
        );
      })}

      {loiterers.map((member) => {
        const loc = resolveCrewLocation(locState, member.id);
        if (!loc.territoryId) return null;
        const center = centerById.get(loc.territoryId);
        const home = byId.get(loc.territoryId);
        if (!center || !home?.discovered) return null;
        const [ox, oz] = offsetFor(member.id);
        return (
          <Person
            key={member.id}
            position={[center.worldX + ox, 0, center.worldZ + oz]}
            color={FAMILY_HEX[member.family]}
            role={silhouette(member.role)}
          />
        );
      })}

      {lookouts.map((op, i) => {
        const block = racketBlockFor(layout, op.targetTerritoryId, 0);
        const center = centerById.get(op.targetTerritoryId);
        if (!block && !center) return null;
        const x = (block?.worldX ?? center!.worldX) + i * 0.4;
        const z = block?.worldZ ?? center!.worldZ;
        const roof = block?.kind === "building" ? 3.3 : 1.55;
        return (
          <Person
            key={op.id}
            position={[x, roof, z]}
            color="#2a3340"
            role="soldier"
          />
        );
      })}

      <CrewSedans cars={cars} layout={layout} />
    </group>
  );
}
