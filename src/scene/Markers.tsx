import { useMemo, useState } from "react";
import { Html, Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Building2, Car, Crosshair, Flame, MapPin, AlertTriangle, Eye, Crown, ShieldOff } from "lucide-react";
import type { CityLayout } from "@/engine/cityLayout";
import type { CrewMember, Territory } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS, RACKET_LABELS } from "@/types/game";
import { racketFreshness } from "@/engine/economy";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { useGameStore } from "@/engine/store";
import PortraitAvatar from "@/ui/PortraitAvatar";
import {
  emptyIntel,
  familyHq,
  hasActiveIntel,
  hiddenCountIn,
  visibleCrewIn,
} from "@/engine/intel";
import { activeCrewIds, isUnguarded, maxRacketsFor, lotTier } from "@/engine/territoryValue";
import { useMapView } from "@/engine/mapView";

interface Props {
  layout: CityLayout;
  territories: Territory[];
}

const FAR_LOD = 70;

/** Square district pin — used for areas (claimed or unclaimed), never looks like a person. */
function DistrictPin({
  size,
  color,
  highlighted,
  unclaimed,
}: {
  size: number;
  color: string;
  highlighted: boolean;
  unclaimed: boolean;
}) {
  return (
    <div
      className="relative flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        border: `3px solid ${highlighted ? "#7eb6ff" : color}`,
        background: unclaimed
          ? "linear-gradient(145deg,#3a3d44,#1e2024)"
          : `linear-gradient(145deg, ${color}55, #14161a)`,
        boxShadow: highlighted
          ? "0 0 10px rgba(100,170,255,0.9)"
          : "0 2px 4px rgba(0,0,0,0.55)",
        transform: highlighted ? "scale(1.06)" : "scale(1)",
      }}
    >
      <MapPin
        className={unclaimed ? "text-white/55" : "text-white/90"}
        style={{ width: size * 0.42, height: size * 0.42 }}
      />
      {unclaimed && (
        <span
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.12) 3px, rgba(255,255,255,0.12) 4px)",
            borderRadius: 2,
          }}
        />
      )}
    </div>
  );
}

/** Circular portrait for your family; diamond clip for rivals. */
function CrewMarker({
  member,
  size,
  highlighted,
  isRival,
}: {
  member: CrewMember;
  size: number;
  highlighted: boolean;
  isRival: boolean;
}) {
  const ring = highlighted
    ? isRival
      ? "#e85d5d"
      : "#7eb6ff"
    : FAMILY_HEX[member.family];

  if (isRival) {
    return (
      <div
        className="relative"
        style={{
          width: size,
          height: size,
          filter: highlighted
            ? "drop-shadow(0 0 8px rgba(232,93,93,0.95))"
            : "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
          transform: highlighted ? "scale(1.05)" : "scale(1)",
        }}
      >
        {/* Diamond border frame */}
        <div
          className="absolute inset-0"
          style={{
            transform: "rotate(45deg)",
            border: `3px solid ${ring}`,
            background: "#0d0e10",
            borderRadius: 2,
          }}
        />
        <div
          className="absolute inset-[3px] overflow-hidden"
          style={{ clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)" }}
        >
          <PortraitAvatar
            seed={member.portraitSeed}
            size={size - 6}
            ringColor="transparent"
            role={member.role}
            family={member.family}
            isPlayerBoss={member.isPlayerBoss}
            alt={member.name}
            className="!border-0"
          />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        filter: highlighted
          ? "drop-shadow(0 0 8px rgba(100,170,255,0.95))"
          : "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
        transform: highlighted ? "scale(1.05)" : "scale(1)",
      }}
    >
      <PortraitAvatar
        seed={member.portraitSeed}
        size={size}
        ringColor={ring}
        role={member.role}
        family={member.family}
        isPlayerBoss={member.isPlayerBoss}
        alt={member.name}
        className="!border-[3px]"
      />
    </div>
  );
}

function TerritoryMarker({ territory, cx, cz }: { territory: Territory; cx: number; cz: number }) {
  const overview = useMapView((s) => s.overview);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const hitTargetPreviewId = useGameStore((s) => s.hitTargetPreviewId);
  const focusReason = useGameStore((s) => s.focusReason);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const operations = useGameStore((s) => s.operations);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
  const routes = useGameStore((s) => s.routes);
  const camera = useThree((s) => s.camera);
  const [hovered, setHovered] = useState(false);

  if (overview) return null;

  const locationState = {
    crew,
    territories,
    routes,
    operations,
    playerFamily,
    intel: intel ?? emptyIntel(),
    turn,
  };

  const focused =
    selectedCrewId && selectedTerritoryId === territory.id
      ? crew.find((c) => c.id === selectedCrewId)
      : undefined;

  const previewTarget =
    hitTargetPreviewId && !focused
      ? crew.find((c) => c.id === hitTargetPreviewId)
      : undefined;
  const previewOnThisDistrict =
    previewTarget &&
    (territory.garrisonIds.includes(previewTarget.id) ||
      previewTarget.assignment.territoryId === territory.id ||
      selectedTerritoryId === territory.id);

  const visibleHere = visibleCrewIn(locationState, territory.id);
  const face =
    visibleHere.find((c) => c.family === playerFamily) ??
    visibleHere.find((c) => c.role === "boss") ??
    visibleHere[0];

  /** Person marker: focused crew, hit-plan preview, or visible face. */
  const person = focused ?? (previewOnThisDistrict ? previewTarget : null) ?? face ?? null;
  const showingPerson = !!person;
  const isRivalPerson = !!person && person.family !== playerFamily;
  const isPlayerPerson = !!person && person.family === playerFamily;
  const isHitPreview = !!previewOnThisDistrict && person?.id === hitTargetPreviewId;

  const hqId = territory.owner ? familyHq(locationState, territory.owner) : null;
  const isHq = !!hqId && hqId === territory.id && territory.owner !== playerFamily;
  const intelActive = hasActiveIntel(locationState, territory.id);
  const knownCount = visibleHere.filter((c) => c.family !== playerFamily).length;
  const unknownCount = hiddenCountIn(locationState, territory.id);
  const hasFreshRacket =
    territory.owner === playerFamily &&
    territory.rackets.some((r) => racketFreshness(r, turn) !== null);
  const racketSlots = maxRacketsFor(territory);
  const isBigBlock = racketSlots >= 5;
  const playerUnguarded = territory.owner === playerFamily && isUnguarded(territory, activeCrewIds(crew));

  const districtColor = territory.owner ? FAMILY_HEX[territory.owner] : "#6a6e76";
  const isHighlighted = selectedTerritoryId === territory.id || !!focused || isHitPreview;
  const unclaimed = !territory.owner;

  const pendingOps = operations.filter((o) => !o.resolved && o.family === playerFamily);
  const isHitTarget = pendingOps.some((o) => o.targetTerritoryId === territory.id);
  const isHitOrigin = pendingOps.some((o) => o.originTerritoryId === territory.id);
  const rivalTippedThreat = operations.some(
    (o) =>
      !o.resolved &&
      o.kind === "hit" &&
      o.tippedOff &&
      o.targetFamily === playerFamily &&
      o.targetTerritoryId === territory.id,
  );

  const camDist = Math.hypot(camera.position.x - cx, camera.position.z - cz);
  const far = camDist > FAR_LOD && !isHighlighted && !hovered;

  const markerSize = isHighlighted ? 52 : 44;

  const label = focused
    ? focused.name.split(" ").slice(-1)[0]
    : isHitPreview && person
      ? person.name.split(" ").slice(-1)[0]
      : isHq && person
        ? person.name.split(" ").slice(-1)[0]
        : territory.name;

  const kindLabel = showingPerson
    ? isHitPreview
      ? "Hit Target"
      : isHq
        ? "HQ"
        : isRivalPerson
          ? "Rival"
          : isPlayerPerson
            ? "Crew"
            : "Person"
    : unclaimed
      ? "Unclaimed"
      : "District";

  return (
    <Html
      position={[cx, 0.15, cz]}
      center
      occlude={false}
      zIndexRange={isHighlighted ? [8, 4] : [5, 1]}
      style={{ pointerEvents: "auto" }}
    >
      <div
        className="flex select-none flex-col items-center gap-1 cursor-pointer"
        onPointerDown={(e) => {
          e.stopPropagation();
          if (person && !focused) {
            // Clicking a garrison face opens that crew; otherwise select the district
            selectCrew(person.id);
          } else {
            selectTerritory(territory.id);
          }
        }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {far ? (
          <div className="flex flex-col items-center gap-0.5">
            {showingPerson && isRivalPerson ? (
              <div
                className="h-3 w-3 border-2 border-white/80 shadow"
                style={{ background: districtColor, transform: "rotate(45deg)" }}
              />
            ) : showingPerson ? (
              <div
                className="h-3.5 w-3.5 rounded-full border-2 border-white/80 shadow"
                style={{ background: districtColor }}
              />
            ) : (
              <div
                className="h-3 w-3 border-2 border-white/80 shadow"
                style={{ background: districtColor, borderRadius: 2 }}
              />
            )}
            <span className="whitespace-nowrap rounded bg-black/75 px-1 py-0.5 text-[10px] font-ui font-semibold text-white/90">
              {territory.name}
            </span>
          </div>
        ) : (
          <>
            {showingPerson ? (
              <CrewMarker
                member={person!}
                size={markerSize}
                highlighted={isHighlighted}
                isRival={isRivalPerson}
              />
            ) : (
              <DistrictPin
                size={markerSize}
                color={districtColor}
                highlighted={isHighlighted}
                unclaimed={unclaimed}
              />
            )}

            <div className="flex items-center gap-0.5">
              {!far &&
                territory.rackets.length === 0 &&
                lotTier(territory) !== "built" && (
                  <span className="rounded bg-black/75 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white/80">
                    {lotTier(territory) === "empty" ? "Vacant lot" : "Sparse"}
                  </span>
                )}
              {territory.rackets.length > 0 && (
                <div className="relative flex h-[18px] items-center gap-0.5 rounded-full border border-panel-border bg-panel-elevated px-1.5">
                  {far ? (
                    <>
                      <Building2 className="h-3 w-3 text-steel-light" />
                      <span className="text-[9px] font-semibold text-white">
                        {territory.rackets.length}
                      </span>
                    </>
                  ) : (
                    territory.rackets.slice(0, 3).map((r) => {
                      const Icon = RACKET_VISUALS[r.type].Icon;
                      return (
                        <Icon
                          key={r.id}
                          className="h-3 w-3"
                          style={{ color: RACKET_VISUALS[r.type].emissive }}
                        />
                      );
                    })
                  )}
                  {hasFreshRacket && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-amber-300 shadow-[0_0_6px_2px_rgba(201,162,39,0.85)]" />
                  )}
                </div>
              )}
              {territory.heatLevel > 3 && (
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-panel-border bg-heat/90">
                  <Flame className="h-3 w-3 text-white" />
                </div>
              )}
              {isHitTarget && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border"
                  style={{
                    background: `${MAP_STATUS.hitPending}E6`,
                    borderColor: MAP_STATUS.hitPending,
                  }}
                >
                  <Crosshair className="h-3 w-3 text-white" />
                </div>
              )}
              {isHitPreview && !isHitTarget && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border"
                  style={{
                    background: `${MAP_STATUS.hitPreview}CC`,
                    borderColor: MAP_STATUS.hitPreview,
                  }}
                >
                  <Crosshair className="h-3 w-3 text-white" />
                </div>
              )}
              {isHitOrigin && (
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-amber-300 bg-amber-800/90">
                  <Car className="h-3 w-3 text-white" />
                </div>
              )}
              {rivalTippedThreat && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border"
                  style={{
                    background: MAP_STATUS.vendetta,
                    borderColor: MAP_STATUS.vendetta,
                  }}
                  title="Rival muscle casing this district"
                >
                  <AlertTriangle className="h-3 w-3 text-black" />
                </div>
              )}
              {isHq && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-amber-200 bg-amber-700/90"
                  title="Family headquarters"
                >
                  <Crown className="h-3 w-3 text-white" />
                </div>
              )}
              {intelActive && !isHitTarget && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-sky-300 bg-sky-800/90"
                  title="Active intel"
                >
                  <Eye className="h-3 w-3 text-white" />
                </div>
              )}
              {isBigBlock && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-amber-400 bg-amber-900/80"
                  title={`${racketSlots} racket slots`}
                >
                  <Building2 className="h-3 w-3 text-amber-200" />
                </div>
              )}
              {playerUnguarded && (
                <div
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-heat bg-heat/90"
                  title="Unguarded rackets"
                >
                  <ShieldOff className="h-3 w-3 text-white" />
                </div>
              )}
            </div>

            <span
              className="whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-ui font-semibold text-white/95"
              style={{
                textShadow: "0 1px 2px rgba(0,0,0,0.8)",
                boxShadow: isBigBlock ? "0 0 0 1.5px rgba(251,191,36,0.85)" : undefined,
              }}
            >
              {label}
            </span>
            {focused && focusReason && (
              <span
                className="whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-ui font-medium uppercase tracking-wide"
                style={{
                  background: "rgba(0,0,0,0.7)",
                  color: territory.owner === playerFamily ? "#9ed0ff" : "#ffd28a",
                  border: `1px solid ${territory.owner ? FAMILY_HEX[territory.owner] : "#6a6e76"}`,
                }}
              >
                {focusReason} · {territory.owner === playerFamily ? "your turf" : territory.owner ? `${territory.owner} turf` : "unclaimed"}
              </span>
            )}
          </>
        )}

        {hovered && (
          <div className="absolute left-1/2 top-full z-50 mt-1 w-44 -translate-x-1/2 rounded-md border border-panel-border bg-panel-elevated/95 p-2 text-left shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-foreground">{territory.name}</div>
              <span className="rounded bg-panel px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                {kindLabel}
              </span>
            </div>
            <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
              <div>Owner: {territory.owner ?? "Unclaimed"}</div>
              {person && <div>{isRivalPerson ? "Rival" : "Crew"}: {person.name}</div>}
              <div>Income: ${territory.baseIncome}</div>
              <div>
                Slots: {territory.rackets.length}/{racketSlots}
                {territory.buildingBlocks
                  ? ` · ${territory.buildingBlocks} buildings`
                  : lotTier(territory) === "empty"
                    ? " · empty lot"
                    : lotTier(territory) === "sparse"
                      ? " · sparse lot"
                      : ""}
              </div>
              {territory.rackets.some((r) => (r.frozenUntil ?? 0) > turn) && (
                <div className="text-heat">
                  Frozen:{" "}
                  {territory.rackets
                    .filter((r) => (r.frozenUntil ?? 0) > turn)
                    .map((r) => RACKET_LABELS[r.type])
                    .join(", ")}
                </div>
              )}
              {playerUnguarded && (
                <div className="text-heat">Unguarded rackets</div>
              )}
              {territory.rackets.length > 0 ? (
                <div className="space-y-0.5">
                  {territory.rackets.map((r) => {
                    const fresh = racketFreshness(r, turn);
                    return (
                      <div key={r.id}>
                        {RACKET_LABELS[r.type]} Lv{r.level}
                        {fresh === "new" && (
                          <span className="ml-1 text-amber-300">NEW</span>
                        )}
                        {fresh === "upgraded" && (
                          <span className="ml-1 text-amber-300">UP</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div>Rackets: 0</div>
              )}
              {territory.owner === playerFamily ? (
                <div>Garrison: {territory.garrisonIds.length}</div>
              ) : (
                <div>
                  Known: {knownCount}
                  {unknownCount > 0 ? ` · Unknown: ${unknownCount}?` : ""}
                </div>
              )}
              {isHq && <div className="text-amber-300">Headquarters</div>}
              {intelActive && <div className="text-sky-300">Intel active</div>}
              {intel?.reports?.[territory.id] && (
                <div className="text-sky-300">
                  Cased T{intel.reports[territory.id]!.turn}
                </div>
              )}
              {territory.heatLevel > 0 && <div>Heat: {territory.heatLevel}</div>}
            </div>
          </div>
        )}
      </div>
    </Html>
  );
}

export default function Markers({ layout, territories }: Props) {
  const routes = useGameStore((s) => s.routes);
  const byId = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);
  const centerById = useMemo(
    () => new Map(layout.centers.map((c) => [c.territoryId, c])),
    [layout],
  );

  return (
    <group>
      {layout.centers.map((c) => {
        const t = byId.get(c.territoryId);
        if (!t || !t.discovered) return null;
        return <TerritoryMarker key={c.territoryId} territory={t} cx={c.worldX} cz={c.worldZ} />;
      })}

      {routes
        .filter((r) => r.status === "active")
        .map((route) => {
          const points = route.path
            .map((tid) => centerById.get(tid))
            .filter(Boolean)
            .map((c) => [c!.worldX, 0.4, c!.worldZ] as [number, number, number]);
          if (points.length < 2) return null;
          return (
            <Line
              key={route.id}
              points={points}
              color={FAMILY_HEX[route.family]}
              lineWidth={1.5}
              dashed
              dashScale={2}
              dashSize={0.5}
              gapSize={0.35}
            />
          );
        })}
    </group>
  );
}
