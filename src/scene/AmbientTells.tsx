import type { CityLayout } from "@/engine/cityLayout";
import { racketBlockFor } from "@/engine/cityLayout";
import { familyHq, resolveCrewLocation } from "@/engine/crewLocation";
import { useMapView } from "@/engine/mapView";
import { useGameStore } from "@/engine/store";
import { activeGarrisonSet, isUnguarded } from "@/engine/territoryValue";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Territory } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const LOW_LOYALTY = 40;

function Figure({
  position,
  color,
}: {
  position: [number, number, number];
  color: string;
}) {
  return (
    <group position={position}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.22, 0.45, 0.16]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.68, 0]}>
        <boxGeometry args={[0.16, 0.16, 0.16]} />
        <meshStandardMaterial color="#d7c4a8" />
      </mesh>
    </group>
  );
}

function ParkedSedan({ position }: { position: [number, number, number] }) {
  return (
    <group position={position} rotation={[0, Math.PI / 2, 0]}>
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[1.7, 0.38, 0.78]} />
        <meshStandardMaterial color="#141416" metalness={0.5} roughness={0.32} />
      </mesh>
      <mesh position={[-0.08, 0.52, 0]}>
        <boxGeometry args={[0.85, 0.3, 0.68]} />
        <meshStandardMaterial color="#222226" roughness={0.45} />
      </mesh>
      {[
        [-0.48, 0.14, 0.36],
        [0.48, 0.14, 0.36],
        [-0.48, 0.14, -0.36],
        [0.48, 0.14, -0.36],
      ].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.13, 0.13, 0.1, 10]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      ))}
      <mesh position={[0.82, 0.3, 0.22]}>
        <boxGeometry args={[0.08, 0.1, 0.14]} />
        <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0.82, 0.3, -0.22]}>
        <boxGeometry args={[0.08, 0.1, 0.14]} />
        <meshStandardMaterial color="#ffe9a8" emissive="#ffd27a" emissiveIntensity={0.7} />
      </mesh>
    </group>
  );
}

/** A road cell in front of the usual camera (+Z), so the car sits on the street instead of inside a block. */
function curbSpot(layout: CityLayout, cx: number, cz: number): [number, number] {
  let bestX = cx;
  let bestZ = cz + 2.6;
  let bestScore = Infinity;
  for (const block of layout.blocks) {
    if (block.kind !== "road") continue;
    const dx = block.worldX - cx;
    const dz = block.worldZ - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.4 || d2 > 36) continue;
    const score = d2 - dz * 6;
    if (score < bestScore) {
      bestScore = score;
      bestX = block.worldX;
      bestZ = block.worldZ;
    }
  }
  return [bestX, bestZ];
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

  if (overview || !playerFamily) return null;

  const byId = new Map(territories.map((t) => [t.id, t]));
  const centerById = new Map(layout.centers.map((c) => [c.territoryId, c]));
  const garrison = activeGarrisonSet({ crew, territories }, playerFamily);
  const locState = { crew, territories, routes, operations, playerFamily };

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
        const guarded = !isUnguarded(territory, garrison);
        const x = block.worldX;
        const z = block.worldZ + 0.95;
        return (
          <group key={territory.id}>
            <mesh position={[x, 0.05, z]} receiveShadow>
              <boxGeometry args={[0.8, 0.08, 0.36]} />
              <meshStandardMaterial color="#4a453e" roughness={0.9} />
            </mesh>
            {guarded && (
              <Figure position={[x, 0, z]} color={FAMILY_HEX[playerFamily]} />
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
          <Figure
            key={member.id}
            position={[center.worldX + ox, 0, center.worldZ + oz]}
            color="#6a5a4a"
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
          <Figure
            key={op.id}
            position={[x, roof, z]}
            color="#2a3340"
          />
        );
      })}

      {ALL_FAMILY_NAMES.map((family) => {
        const hq = familyHq({ territories }, family);
        if (!hq) return null;
        const boss = crew.find(
          (c) => c.family === family && c.role === "boss" && c.status === "active",
        );
        if (!boss) return null;
        const loc = resolveCrewLocation(locState, boss.id);
        if (loc.territoryId !== hq) return null;
        const home = byId.get(hq);
        const center = centerById.get(hq);
        if (!home?.discovered || !center) return null;
        const [x, z] = curbSpot(layout, center.worldX, center.worldZ);
        return <ParkedSedan key={family} position={[x, 0, z]} />;
      })}
    </group>
  );
}
