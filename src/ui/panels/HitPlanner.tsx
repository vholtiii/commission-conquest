import { useEffect, useMemo, useState } from "react";
import type { HitApproach, Operation } from "@/types/game";
import { FAMILY_HEX, MAP_STATUS } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { calculateHitOddsBreakdown, defendersFor, estimateFirefightRisk, getawayRisk, territoryHops } from "@/engine/hitOps";
import { resolveCrewTerritoryId } from "@/engine/crewLocation";
import { emptyIntel, hasFreshCasing, namedHitTargets } from "@/engine/intel";
import { isMessageTargetRole, routeDisputeWith } from "@/engine/passage";
import { attributeCinematic, attributionLabel } from "@/engine/attribution";
import { coverFire, getawayCover, isLaidLow, laidLowHouse, safehouseHitPenalty } from "@/engine/safehouse";
import { dinnerActive } from "@/engine/dinner";
import { handsDown } from "@/engine/mourning";
import { canLeadCrew, freeCrewOf, unseatedCrew } from "@/engine/crews";
import {
  approachSpec,
  exposedCrewIds,
  HIT_APPROACH_SPECS,
  missingRequiredRoles,
  type HitRole,
  type HitRoleSlot,
} from "@/data/hitApproaches";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";
import Tip from "@/ui/Tip";
import PanelShell from "./PanelShell";
import { titleCase } from "../formatters";

const APPROACHES: HitApproach[] = ["ambush", "drive_by", "car_bomb", "sitdown_betrayal"];

export default function HitPlanner() {
  const state = useGameStore((s) => s);
  const {
    playerFamily,
    crew,
    territories,
    selectedTerritoryId,
    setPanel,
    planPlayerHit,
    setHitTargetPreview,
  } = state;

  const territory = territories.find((t) => t.id === selectedTerritoryId);
  const rivalFamily = territory?.owner && territory.owner !== playerFamily ? territory.owner : null;

  const rivalTargets = useMemo(() => {
    if (!territory || !rivalFamily) return [];
    return namedHitTargets(
      {
        crew,
        territories,
        routes: state.routes,
        operations: state.operations,
        playerFamily,
        intel: state.intel ?? emptyIntel(),
        turn: state.turn,
      },
      territory.id,
      rivalFamily,
    );
  }, [
    crew,
    territories,
    state.routes,
    state.operations,
    state.intel,
    state.turn,
    playerFamily,
    territory,
    rivalFamily,
  ]);

  const availableCrew = useMemo(
    () =>
      crew.filter(
        (c) =>
          c.family === playerFamily &&
          c.status === "active" &&
          (c.assignment.type === "idle" ||
            c.assignment.type === "garrison" ||
            c.role === "boss"),
      ),
    [crew, playerFamily],
  );

  const [targetCrewId, setTargetCrewId] = useState<string>("");
  const [blind, setBlind] = useState(false);
  const [approach, setApproach] = useState<HitApproach>("ambush");
  const [shooterIds, setShooterIds] = useState<string[]>([]);
  const [wheelmanId, setWheelmanId] = useState<string>("");
  const [lookoutId, setLookoutId] = useState<string>("");
  const [bombMakerId, setBombMakerId] = useState<string>("");
  const [planterId, setPlanterId] = useState<string>("");
  const [negotiatorId, setNegotiatorId] = useState<string>("");
  const [surveilFirst, setSurveilFirst] = useState(false);
  const [sendMessage, setSendMessage] = useState(false);

  // Sync default target when district targets change
  useEffect(() => {
    if (blind) {
      setHitTargetPreview(null);
      return;
    }
    if (rivalTargets.length === 0) {
      setTargetCrewId("");
      setHitTargetPreview(null);
      return;
    }
    if (!rivalTargets.some((c) => c.id === targetCrewId)) {
      const next = rivalTargets[0]!.id;
      setTargetCrewId(next);
      setHitTargetPreview(next);
    } else if (targetCrewId) {
      setHitTargetPreview(targetCrewId);
    }
  }, [rivalTargets, targetCrewId, setHitTargetPreview, blind]);

  useEffect(() => {
    return () => setHitTargetPreview(null);
  }, [setHitTargetPreview]);

  const picks = {
    shooterIds,
    wheelmanId: wheelmanId || undefined,
    lookoutId: lookoutId || undefined,
    bombMakerId: bombMakerId || undefined,
    planterId: planterId || undefined,
    negotiatorId: negotiatorId || undefined,
  };

  const usedIds = useMemo(() => {
    const s = new Set<string>(shooterIds);
    if (wheelmanId) s.add(wheelmanId);
    if (lookoutId) s.add(lookoutId);
    if (bombMakerId) s.add(bombMakerId);
    if (planterId) s.add(planterId);
    if (negotiatorId) s.add(negotiatorId);
    return s;
  }, [shooterIds, wheelmanId, lookoutId, bombMakerId, planterId, negotiatorId]);

  const crewGap = useMemo(() => unseatedCrew(crew, [...usedIds]), [crew, usedIds]);
  const roster = useMemo(() => {
    const byId = new Map(availableCrew.map((c) => [c.id, c]));
    for (const id of usedIds) {
      const leader = crew.find((c) => c.id === id);
      if (!leader || !canLeadCrew(leader)) continue;
      for (const man of freeCrewOf(crew, leader.id)) byId.set(man.id, man);
    }
    return [...byId.values()];
  }, [availableCrew, crew, usedIds]);

  const rideAlong = useMemo(() => {
    const singles = new Set(
      [wheelmanId, lookoutId, bombMakerId, planterId, negotiatorId].filter(Boolean),
    );
    const men: typeof crew = [];
    const seen = new Set<string>();
    for (const id of usedIds) {
      const leader = crew.find((c) => c.id === id);
      if (!leader || !canLeadCrew(leader)) continue;
      for (const man of freeCrewOf(crew, leader.id)) {
        if (singles.has(man.id) || seen.has(man.id)) continue;
        seen.add(man.id);
        men.push(man);
      }
    }
    return men;
  }, [crew, usedIds, wheelmanId, lookoutId, bombMakerId, planterId, negotiatorId]);

  const draftOp: Operation | null = useMemo(() => {
    if (!playerFamily || !territory || !rivalFamily) return null;
    const assignedIds = [
      ...shooterIds,
      wheelmanId,
      lookoutId,
      bombMakerId,
      planterId,
      negotiatorId,
    ].filter(Boolean) as string[];
    const originLead = assignedIds[0] ? crew.find((c) => c.id === assignedIds[0]) : undefined;
    const originTerritoryId =
      (originLead &&
        resolveCrewTerritoryId(
          {
            crew,
            territories,
            routes: state.routes,
            operations: state.operations,
            playerFamily,
          },
          originLead.id,
        )) ||
      territories.find((t) => t.owner === playerFamily && t.isStrategic)?.id ||
      territories.find((t) => t.owner === playerFamily)?.id ||
      territory.id;

    return {
      id: "draft",
      family: playerFamily,
      kind: "hit",
      targetCrewId: blind ? undefined : targetCrewId || undefined,
      targetTerritoryId: territory.id,
      originTerritoryId,
      targetFamily: rivalFamily,
      approach,
      shooterIds,
      wheelmanId: wheelmanId || undefined,
      lookoutId: lookoutId || undefined,
      bombMakerId: bombMakerId || undefined,
      planterId: planterId || undefined,
      negotiatorId: negotiatorId || undefined,
      surveilled: surveilFirst,
      tippedOff: false,
      blind,
      pendingTurns: surveilFirst ? 2 : 1,
      resolved: false,
    };
  }, [
    playerFamily,
    territory,
    rivalFamily,
    targetCrewId,
    blind,
    approach,
    shooterIds,
    wheelmanId,
    lookoutId,
    bombMakerId,
    planterId,
    negotiatorId,
    surveilFirst,
    crew,
    territories,
    state.routes,
    state.operations,
  ]);

  const oddsBreakdown = draftOp ? calculateHitOddsBreakdown(state, draftOp) : null;
  const defenders = draftOp ? defendersFor(state, draftOp) : 0;
  const atRisk = draftOp ? exposedCrewIds(draftOp).length : 0;
  const firefightEst = draftOp ? estimateFirefightRisk(state, draftOp) : 0;
  const hops = draftOp
    ? territoryHops(state, draftOp.originTerritoryId, draftOp.targetTerritoryId)
    : 0;
  const gRisk = draftOp ? getawayRisk(state, draftOp) : 0;
  const door = draftOp && playerFamily ? getawayCover(state, playerFamily, draftOp.targetTerritoryId) : null;
  const cover = draftOp ? coverFire(state, draftOp.targetFamily, draftOp.targetTerritoryId) : null;
  const missing = missingRequiredRoles(approach, picks);
  const selectedTarget = rivalTargets.find((c) => c.id === targetCrewId);
  const dispute = rivalFamily ? routeDisputeWith(state, rivalFamily) : null;
  const messageEligible =
    !blind && !!selectedTarget && isMessageTargetRole(selectedTarget) && !!dispute;
  const message = sendMessage && messageEligible;
  const atTable = dinnerActive(state);
  const quiet = handsDown(state);
  const quietWeeks = Math.max(0, (state.mourningUntil ?? 0) - state.turn);
  const canOrder =
    !quiet &&
    !atTable &&
    missing.length === 0 &&
    crewGap.length === 0 &&
    (blind || (!!targetCrewId && rivalTargets.length > 0));
  const spec = approachSpec(approach);

  function clearRoles() {
    setShooterIds([]);
    setWheelmanId("");
    setLookoutId("");
    setBombMakerId("");
    setPlanterId("");
    setNegotiatorId("");
  }

  function selectApproach(a: HitApproach) {
    setApproach(a);
    clearRoles();
  }

  function selectTarget(id: string) {
    setBlind(false);
    setTargetCrewId(id);
    setHitTargetPreview(id);
  }

  function selectBlind() {
    setBlind(true);
    setTargetCrewId("");
    setHitTargetPreview(null);
  }

  function candidatesFor(slot: HitRoleSlot, excludeSelf?: string): typeof availableCrew {
    return roster.filter((c) => {
      if (excludeSelf && c.id === excludeSelf) return true;
      if (slot.multi) {
        if (usedIds.has(c.id) && !shooterIds.includes(c.id)) return false;
        if (c.role === "boss" && !slot.allowBoss) return false;
        return true;
      }
      if (usedIds.has(c.id) && c.id !== excludeSelf) return false;
      if (c.role === "boss" && !slot.allowBoss) return false;
      return true;
    });
  }

  function setSingleRole(role: HitRole, id: string) {
    switch (role) {
      case "wheelman":
        setWheelmanId(id);
        break;
      case "lookout":
        setLookoutId(id);
        break;
      case "bomb_maker":
        setBombMakerId(id);
        break;
      case "planter":
        setPlanterId(id);
        break;
      case "negotiator":
        setNegotiatorId(id);
        break;
      default:
        break;
    }
  }

  function getSingleRole(role: HitRole): string {
    switch (role) {
      case "wheelman":
        return wheelmanId;
      case "lookout":
        return lookoutId;
      case "bomb_maker":
        return bombMakerId;
      case "planter":
        return planterId;
      case "negotiator":
        return negotiatorId;
      default:
        return "";
    }
  }

  function toggleShooter(id: string) {
    setShooterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  if (!territory || !rivalFamily) {
    return (
      <PanelShell title="Plan Hit" onClose={() => setPanel("district")}>
        <p className="text-sm text-muted-foreground">Select a rival-controlled district first.</p>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Plan Hit" subtitle={`${territory.name} — ${rivalFamily}`} onClose={() => setPanel("district")}>
      <div className="space-y-4">
        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Target</h3>
          <p className="mb-1.5 text-[10px] text-muted-foreground">
            Case the district, bribe cops, or strike blind. Only known faces appear below.
          </p>
          {territory &&
            hasFreshCasing(
              {
                crew,
                territories,
                routes: state.routes,
                operations: state.operations,
                playerFamily,
                intel: state.intel,
                turn: state.turn,
              },
              territory.id,
            ) && (
              <div className="mb-1.5 rounded border border-sky-500/30 bg-sky-950/30 px-2 py-1 text-[10px] text-sky-200">
                Cased T{state.intel?.reports?.[territory.id]?.turn ?? state.turn} — intel bonus
                active (+6% odds, lower tip-off)
              </div>
            )}
          <div className="space-y-1">
            {rivalTargets.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No confirmed faces. Case this block, bribe cops, or hit blind.
              </p>
            )}
            {rivalTargets.map((c) => (
              <button
                key={c.id}
                onClick={() => selectTarget(c.id)}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left ${
                  !blind && targetCrewId === c.id ? "bg-steel/20 ring-1 ring-steel/50" : "hover:bg-panel-elevated"
                }`}
              >
                <PortraitAvatar
                  seed={c.portraitSeed}
                  size={24}
                  ringColor={FAMILY_HEX[c.family]}
                  role={c.role}
                  family={c.family}
                  alt={c.name}
                />
                <span className="text-xs">{c.name}</span>
                {isLaidLow(c) && (() => {
                  const house = laidLowHouse(state, c);
                  const lv = house?.level ?? 1;
                  return (
                    <Tip content={`He's inside a level ${lv} safehouse. Your men know where — the casing holds two weeks — but a hit on a man behind that door fights at −${Math.round(safehouseHitPenalty(lv) * 100)}%.`}>
                      <span className="rounded bg-heat/15 px-1 text-[9px] uppercase tracking-wide text-heat">laid low · Lv {lv}</span>
                    </Tip>
                  );
                })()}
                <span className="ml-auto text-[10px] text-muted-foreground">{titleCase(c.role)}</span>
              </button>
            ))}
            <button
              onClick={() => selectBlind()}
              className={`w-full rounded-md border px-2 py-2 text-left ${
                blind
                  ? "border-heat bg-heat/15 ring-1 ring-heat/40"
                  : "border-dashed border-panel-border bg-panel/40 hover:bg-panel-elevated"
              }`}
            >
              <div className="text-xs font-medium">Blind hit — whoever is there</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                −12% odds · less tip-off · respect & influence hit · fear rises
              </div>
            </button>
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Approach</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {APPROACHES.map((a) => {
              const aSpec = HIT_APPROACH_SPECS[a];
              return (
                <button
                  key={a}
                  onClick={() => selectApproach(a)}
                  className={`rounded-md border px-2 py-1.5 text-left ${
                    approach === a
                      ? "border-steel bg-steel/20 text-steel-light"
                      : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                  }`}
                >
                  <div className="text-xs font-medium">{aSpec.label}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
                    {aSpec.description}
                  </div>
                  <div className="mt-1 flex gap-2 text-[9px] text-muted-foreground">
                    <span>Heat ~{aSpec.heatHint}</span>
                    <span>{aSpec.skillsHint}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {approach === "car_bomb" &&
            crew.find((c) => c.id === targetCrewId)?.role === "boss" && (
            <p className="mt-1.5 text-[10px] text-heat">
              A boss&apos;s car only goes up when he uses it. The package waits up to 3 weeks for
              him to travel — a sit-down will do it. Every week it sits is a chance it&apos;s found.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            Team — {spec.label}
          </h3>
          {spec.roles.map((slot) => {
            if (slot.multi) {
              const options = candidatesFor(slot);
              return (
                <div key={slot.role}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <h4 className="text-[11px] font-medium">
                      {slot.label}
                      {slot.required && <span className="text-heat"> *</span>}
                      <span className="ml-1 text-muted-foreground">({shooterIds.length})</span>
                    </h4>
                    <span className="text-[9px] text-muted-foreground">{slot.hint}</span>
                  </div>
                  <div className="max-h-28 space-y-1 overflow-y-auto scrollbar-thin">
                    {options.length === 0 && (
                      <p className="text-[10px] text-muted-foreground">No available crew.</p>
                    )}
                    {options.map((c) => (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-panel-elevated"
                      >
                        <Checkbox
                          checked={shooterIds.includes(c.id)}
                          onCheckedChange={() => toggleShooter(c.id)}
                        />
                        <PortraitAvatar
                          seed={c.portraitSeed}
                          size={22}
                          ringColor="#5c7a99"
                          role={c.role}
                          family={c.family}
                          alt={c.name}
                        />
                        <span className="text-xs">{c.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {c.skills[slot.skill]} {slot.skill}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            }

            const value = getSingleRole(slot.role);
            const options = candidatesFor(slot, value || undefined);
            return (
              <div key={slot.role}>
                <div className="mb-1 flex items-baseline justify-between">
                  <h4 className="text-[11px] font-medium">
                    {slot.label}
                    {slot.required && <span className="text-heat"> *</span>}
                  </h4>
                  <span className="text-[9px] text-muted-foreground">{slot.hint}</span>
                </div>
                <select
                  value={value}
                  onChange={(e) => setSingleRole(slot.role, e.target.value)}
                  className="w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1.5 text-xs"
                >
                  <option value="">{slot.required ? "Select…" : "None"}</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.skills[slot.skill]} {slot.skill}
                      {o.role === "boss" ? ", boss" : ""})
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
          {!spec.roles.some((r) => r.multi) && rideAlong.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium">
                Ride along<span className="text-heat"> *</span>
              </div>
              <p className="mb-1 text-[10px] text-muted-foreground">
                No gunner seat on this approach. Check them to come as shooters — the job gets louder.
              </p>
              <div className="max-h-28 space-y-1 overflow-y-auto scrollbar-thin">
                {rideAlong.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-panel-elevated"
                  >
                    <Checkbox
                      checked={shooterIds.includes(c.id)}
                      onCheckedChange={() => toggleShooter(c.id)}
                    />
                    <span className="text-xs">{c.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{c.role}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={surveilFirst} onCheckedChange={(v) => setSurveilFirst(!!v)} />
          Surveil first (safer, delays hit by a turn)
        </label>

        {!blind && selectedTarget && (
          <div
            className={`rounded-md border p-2 ${
              message ? "border-amber-400/60 bg-amber-500/10" : "border-panel-border bg-panel/40"
            }`}
          >
            <label
              className={`flex items-center gap-2 text-xs ${
                messageEligible ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <Checkbox
                checked={message}
                disabled={!messageEligible}
                onCheckedChange={(v) => setSendMessage(!!v)}
              />
              Send a message — a point about the trucks, not a war
            </label>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {dispute
                ? isMessageTargetRole(selectedTarget)
                  ? `${dispute} Half the standing lost, no vendetta. If it lands, ${rivalFamily} asks less for passage and taxes your trucks less for a while.`
                  : "A message goes to a hitman, consigliere, underboss or senior capo — somebody they'll miss, not the boss."
                : `No route beef with ${rivalFamily}: nothing to make a point about.`}
            </p>
          </div>
        )}

        <div className="rounded-md border border-panel-border bg-panel/50 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Estimated Success</span>
            <Badge className="bg-steel/30 text-steel-light">
              {oddsBreakdown ? `${Math.round(oddsBreakdown.total * 100)}%` : "—"}
            </Badge>
          </div>
          {oddsBreakdown && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span>Base {pct(oddsBreakdown.base)}</span>
              <span>Roles {pct(oddsBreakdown.roles)}</span>
              <span>Target {pct(oddsBreakdown.target)}</span>
              <span>District {pct(oddsBreakdown.district)}</span>
              <span>Garrison {pct(oddsBreakdown.garrison)}</span>
              <span>Getaway {pct(oddsBreakdown.getaway)}</span>
              <span>Intel {pct(oddsBreakdown.intel)}</span>
              <span>Approach {pct(oddsBreakdown.approach)}</span>
              <span>Heat {pct(oddsBreakdown.heat)}</span>
              {oddsBreakdown.fear !== 0 && (
                <span title="Feared families get the mark to the table">
                  Fear {pct(oddsBreakdown.fear)}
                </span>
              )}
              {oddsBreakdown.other - oddsBreakdown.fear !== 0 && (
                <span>Other {pct(oddsBreakdown.other - oddsBreakdown.fear)}</span>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-panel-border/50 pt-1.5 text-[10px] text-muted-foreground">
            <span>
              Defenders: <span className="text-foreground">{defenders}</span>
            </span>
            <span>
              Crew at risk: <span className="text-foreground">{atRisk}</span>
              {firefightEst > 0 && (
                <span className="text-heat"> (~{Math.round(firefightEst * 100)}% fire)</span>
              )}
            </span>
            {cover && cover.men > 0 && (
              <span className="col-span-2 text-heat">
                {cover.men} {cover.men === 1 ? "man" : "men"} in the {cover.from[0]!.territory.name} safehouse
                {cover.from[0]!.hops === 0 ? "" : " next door"} (Lv {cover.from[0]!.level}) will return fire
                {cover.from.length > 1 ? ` — and more from ${cover.from.length - 1} other house${cover.from.length > 2 ? "s" : ""}` : ""}.
              </span>
            )}
            <span className="col-span-2">
              Getaway: {hops} district{hops === 1 ? "" : "s"}
              {gRisk > 0.05 ? (
                <span className="text-heat"> — elevated arrest risk</span>
              ) : gRisk < 0 ? (
                <span className="text-money"> — clean exit</span>
              ) : (
                <span> — routine</span>
              )}
              {door && (
                <Tip content={`Your level ${door.level} safehouse in ${door.territory.name} is ${door.hops === 0 ? "on the block" : door.hops === 1 ? "one block over" : "two blocks over"}. The crew can duck through that door — getaway risk −${Math.round(door.bonus * 100)}%.`}>
                  <span className="text-money"> · safehouse {door.hops === 0 ? "on the block" : `${door.hops} block${door.hops === 1 ? "" : "s"} off`}</span>
                </Tip>
              )}
            </span>
          </div>
        </div>

        {!canOrder && (
          <p className="text-[11px] text-heat">
            {quiet
              ? `The city is quiet for a funeral. ${quietWeeks} week${quietWeeks === 1 ? "" : "s"} left.`
              : atTable
              ? "The family is at the table"
              : crewGap.length > 0
                ? `His crew comes along — give a role to ${crewGap.flatMap((g) => g.men.map((m) => m.name)).join(", ")}`
              : missing.length > 0
              ? `Still need: ${missing.join(", ")}`
              : !blind && rivalTargets.length === 0
                ? "No known target — case the district or strike blind."
                : "Select a target or blind hit."}
          </p>
        )}

        <Button
          className="w-full bg-heat font-ui font-bold uppercase tracking-wide text-white hover:bg-heat/80"
          disabled={!canOrder}
          onClick={() => {
            if (!canOrder) return;
            planPlayerHit({
              targetCrewId: blind ? undefined : targetCrewId,
              targetTerritoryId: territory.id,
              approach,
              shooterIds,
              wheelmanId: wheelmanId || undefined,
              lookoutId: lookoutId || undefined,
              bombMakerId: bombMakerId || undefined,
              planterId: planterId || undefined,
              negotiatorId: negotiatorId || undefined,
              surveilFirst,
              blind,
              intent: message ? "message" : undefined,
            });
          }}
        >
          {blind ? "Order Blind Hit" : message ? "Send the Message" : "Order the Hit"}
        </Button>
      </div>
    </PanelShell>
  );
}

function pct(n: number): string {
  const v = Math.round(n * 100);
  return v >= 0 ? `+${v}%` : `${v}%`;
}

/** Compact bottom result card shown after a hit cinematic (or immediately if cinematics skipped). */
export function HitResultModal() {
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const pendingHitCinematic = useGameStore((s) => s.pendingHitCinematic);
  const dismissHitResult = useGameStore((s) => s.dismissHitResult);
  const crew = useGameStore((s) => s.crew);

  if (!pendingHitResult) return null;
  const r = pendingHitResult;
  const incoming = pendingHitCinematic?.perspective === "incoming" ? pendingHitCinematic : null;
  // The card says only what the case file says; the shooters' family is the investigation.
  const who = incoming ? attributionLabel(attributeCinematic(useGameStore.getState(), incoming)) : null;
  const markFate = !incoming
    ? null
    : r.targetDead
      ? `${incoming.targetName} is dead.`
      : r.outcome === "botched_wounded"
        ? `${incoming.targetName} is wounded, but alive.`
        : `${incoming.targetName} slipped away.`;
  const detail = r.casualtyDetail ?? [];
  const byFate = {
    dead: detail.filter((d) => d.fate === "dead"),
    wounded: detail.filter((d) => d.fate === "wounded"),
    jailed: detail.filter((d) => d.fate === "jailed"),
  };

  function row(
    label: string,
    items: typeof detail,
    colorClass: string,
  ) {
    if (items.length === 0) return null;
    return (
      <div className="mt-2">
        <div className={`mb-1 text-[10px] uppercase ${colorClass}`}>{label}</div>
        <div className="flex flex-wrap items-center gap-2">
          {items.map((d) => {
            const c = crew.find((m) => m.id === d.crewId);
            if (!c) return null;
            return (
              <div key={`${d.crewId}-${d.cause}`} className="flex items-center gap-1">
                <PortraitAvatar
                  seed={c.portraitSeed}
                  size={28}
                  role={c.role}
                  family={c.family}
                  isPlayerBoss={c.isPlayerBoss}
                  alt={c.name}
                />
                <div className="flex flex-col">
                  <span className={`text-[10px] ${colorClass}`}>
                    {c.name.split(" ").slice(-1)[0]}
                  </span>
                  <span className="text-[8px] text-muted-foreground">
                    {d.cause === "firefight" ? "garrison fire" : "botch"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto panel-surface-elevated w-full max-w-md rounded-lg border p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display text-lg text-heat">{r.headline}</h2>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {incoming && (
              <Badge className="bg-heat/25 text-heat">Incoming — {who}</Badge>
            )}
            {r.blind && (
              <Badge className="bg-heat/25 text-heat">Blind</Badge>
            )}
            {r.tippedOff && (
              <Badge
                className="shrink-0"
                style={{
                  background: `${MAP_STATUS.vendetta}33`,
                  color: MAP_STATUS.vendetta,
                }}
              >
                Tipped off
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
          {r.beats.map((beat, i) => (
            <p key={i} className="text-xs text-foreground/85">
              <span className="mr-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                {titleCase(beat.phase)}:
              </span>
              {beat.text}
            </p>
          ))}
        </div>
        {markFate && <p className="mt-2 text-xs text-heat">{markFate}</p>}
        {incoming && detail.length > 0 && (
          <div className="mb-1 mt-2 text-[10px] uppercase text-muted-foreground">Their losses</div>
        )}
        {row("Killed", byFate.dead, "text-heat")}
        {row("Wounded", byFate.wounded, "text-amber-400")}
        {row("Jailed", byFate.jailed, "text-steel-light")}
        {(r.revealedIds?.length ?? 0) > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] uppercase text-sky-300">Spotted</div>
            <div className="flex flex-wrap items-center gap-2">
              {r.revealedIds!.map((id) => {
                const c = crew.find((m) => m.id === id);
                if (!c) return null;
                return (
                  <div key={id} className="flex items-center gap-1">
                    <PortraitAvatar
                      seed={c.portraitSeed}
                      size={28}
                      role={c.role}
                      family={c.family}
                      alt={c.name}
                    />
                    <span className="text-[10px]">{c.name.split(" ").slice(-1)[0]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {(r.respectDelta !== undefined || r.influenceDelta !== undefined) && (
          <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[10px]">
            <div className="rounded bg-panel/50 px-2 py-1">
              Respect{" "}
              <span className={(r.respectDelta ?? 0) >= 0 ? "text-money" : "text-heat"}>
                {(r.respectDelta ?? 0) >= 0 ? "+" : ""}
                {r.respectDelta ?? 0}
              </span>
            </div>
            <div className="rounded bg-panel/50 px-2 py-1">
              Fear <span className="text-money">+{r.fearGain}</span>
            </div>
            <div className="rounded bg-panel/50 px-2 py-1">
              Influence{" "}
              <span className={(r.influenceDelta ?? 0) >= 0 ? "text-money" : "text-heat"}>
                {(r.influenceDelta ?? 0) >= 0 ? "+" : ""}
                {r.influenceDelta ?? 0}
              </span>
            </div>
          </div>
        )}
        {r.loyaltyDelta !== undefined && r.loyaltyDelta > 0 && (
          <p className="mt-2 text-center text-[11px] text-money">
            Loyalty +{r.loyaltyDelta}
            {r.loyaltyNames && r.loyaltyNames.length > 0 ? ` for ${r.loyaltyNames.join(", ")}` : ""}
          </p>
        )}
        {detail.length === 0 && r.casualties.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] uppercase text-muted-foreground">Casualties</span>
            {r.casualties.map((id) => {
              const c = crew.find((m) => m.id === id);
              if (!c) return null;
              return (
                <div key={id} className="flex items-center gap-1">
                  <PortraitAvatar
                    seed={c.portraitSeed}
                    size={28}
                    role={c.role}
                    family={c.family}
                    isPlayerBoss={c.isPlayerBoss}
                    alt={c.name}
                  />
                  <span className="text-[10px] text-heat">{c.name.split(" ").slice(-1)[0]}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Heat</div>
            <div className="font-semibold text-heat">+{r.heatGain}</div>
          </div>
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Fear</div>
            <div className="font-semibold text-money">+{r.fearGain}</div>
          </div>
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Defenders</div>
            <div className="font-semibold">{r.defenders ?? 0}</div>
          </div>
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Odds</div>
            <div className="font-semibold">{Math.round(r.successChance * 100)}%</div>
          </div>
        </div>
        <Button className="mt-3 w-full bg-steel font-ui font-bold uppercase" onClick={() => dismissHitResult()}>
          Continue
        </Button>
      </div>
    </div>
  );
}
