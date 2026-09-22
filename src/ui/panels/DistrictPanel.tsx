import { Swords, Hammer, ShieldPlus, Flame, ArrowUp, Eye, Wine } from "lucide-react";
import { useState } from "react";
import { useGameStore } from "@/engine/store";
import { getFamilyDef } from "@/data/families";
import { FAMILY_HEX, RACKET_LABELS } from "@/types/game";
import { racketIncome, racketPayment, isLegitBusiness, isRacketFrozen, launderCap, launderSiteStatus, fundingLabel, racketFunding, hijackRisk } from "@/engine/economy";
import { isProducerType, isStorageType, planFeedSpeakeasy, stockCap, warehouseManagerEffectText } from "@/engine/liquor";
import { isUnguarded, maxRacketsFor, lotTier, lotTierHint, lotTierLabel, allowedRacketTypes } from "@/engine/territoryValue";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { hiddenCountIn, hasFreshCasing, visibleCrewIn } from "@/engine/intel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";
import Tip from "@/ui/Tip";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";
import type { CrewMember, GameState, Racket } from "@/types/game";

function upgradeTip(
  r: Racket,
  manager: CrewMember | null | undefined,
  frozen: boolean,
  money: number,
  dirtyMoney: number,
): string {
  if (r.level >= 5) return "Already max level.";
  if (frozen) return "Frozen by Treasury audit — cannot upgrade.";
  const pay = racketPayment(r.type, r.upgradeCost, money, dirtyMoney);
  if (!pay) {
    const fund = fundingLabel(racketFunding(r.type));
    return `Need ${formatMoney(r.upgradeCost)} (${fund}).`;
  }
  const nextIncome = racketIncome({ ...r, level: r.level + 1 }, 0, manager);
  const liquorNote = isStorageType(r.type)
    ? " Raises liquor capacity too."
    : "";
  return `Upgrade to Lv ${r.level + 1} — about $${nextIncome}/turn after.${liquorNote} Cost ${formatMoney(r.upgradeCost)}.`;
}

function managerTip(r: Racket, manager: CrewMember | null | undefined): string {
  if (r.type === "warehouse") {
    return manager
      ? `Manager: ${warehouseManagerEffectText(manager, r.stock)}`
      : "Assign a manager — unmanaged warehouses lose 12% of crates each turn.";
  }
  return manager
    ? `${manager.name} runs this racket. Remove or replace from the dropdown.`
    : "Unmanaged rackets earn −30% income. Assign crew to manage.";
}

export default function DistrictPanel() {
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
  const setPanel = useGameStore((s) => s.setPanel);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const upgradeRacketAt = useGameStore((s) => s.upgradeRacketAt);
  const assignManager = useGameStore((s) => s.assignManager);
  const setupLaunderSite = useGameStore((s) => s.setupLaunderSite);
  const stopLaunderSite = useGameStore((s) => s.stopLaunderSite);
  const launderPlan = useGameStore((s) => s.launderPlan ?? {});
  const caseDistrict = useGameStore((s) => s.caseDistrict);
  const [caseLookoutId, setCaseLookoutId] = useState("");

  const territory = territories.find((t) => t.id === selectedTerritoryId);
  if (!territory || !playerFamily) return null;

  const locState = {
    crew,
    territories,
    routes,
    operations,
    playerFamily,
    intel: intel ?? { known: {}, districtReveal: {}, familyReveal: {}, reports: {} },
    turn,
  };

  const owner = territory.owner ? getFamilyDef(territory.owner) : null;
  const isOwned = territory.owner === playerFamily;
  const isRival = !!territory.owner && territory.owner !== playerFamily;
  const visible = visibleCrewIn(locState, territory.id);
  const garrison = isOwned
    ? (territory.garrisonIds
        .map((id) => crew.find((c) => c.id === id))
        .filter(Boolean) as NonNullable<ReturnType<typeof crew.find>>[])
    : visible.filter((c) => c.family === territory.owner);
  const unknown = isRival ? hiddenCountIn(locState, territory.id) : 0;
  const lookouts = crew.filter(
    (c) =>
      c.family === playerFamily &&
      c.status === "active" &&
      (c.assignment.type === "idle" || c.assignment.type === "garrison"),
  );
  const managerCandidates = crew.filter(
    (c) =>
      c.family === playerFamily &&
      c.status === "active" &&
      c.role !== "boss" &&
      c.assignment.type !== "operation" &&
      c.assignment.type !== "surveillance" &&
      c.assignment.type !== "delivery",
  );
  const racketSlots = maxRacketsFor(territory);
  const slotsFull = territory.rackets.length >= racketSlots;
  const tier = lotTier(territory);
  const tierLabel = lotTierLabel(tier);
  const unguarded =
    isOwned &&
    isUnguarded(territory, new Set(
      territory.garrisonIds.filter((id) => {
        const c = crew.find((m) => m.id === id);
        return !!c && c.status === "active";
      }),
    ));

  return (
    <PanelShell title={territory.name} subtitle={territory.borough}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: owner ? FAMILY_HEX[owner.name] : "#7a7f87" }}
            />
            <span className="text-sm">{owner ? `${owner.name} controlled` : "Unclaimed"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {tierLabel && (
              <Tip content={lotTierHint(tier)}>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {tierLabel}
                </Badge>
              </Tip>
            )}
            {territory.isStrategic && (
              <Badge variant="outline" className="text-[10px] text-money">
                Strategic
              </Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <InfoBox label="Base Income" value={`$${territory.baseIncome}`} />
          <InfoBox
            label="Heat"
            value={`${territory.heatLevel}`}
            valueClassName={territory.heatLevel > 4 ? "text-heat" : undefined}
            icon={territory.heatLevel > 4 ? <Flame className="h-3 w-3" /> : undefined}
          />
          <InfoBox label="Defense" value={`+${Math.round(territory.defenseBonus * 100)}%`} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-center text-xs">
          <InfoBox
            label="Buildings"
            value={`${territory.buildingBlocks ?? 0}${tier === "empty" ? " (empty lot)" : tier === "sparse" ? " (sparse)" : ""}`}
          />
          <InfoBox
            label="Slots"
            value={`${territory.rackets.length}/${racketSlots}`}
          />
        </div>

        {unguarded && (
          <p className="rounded border border-heat/40 bg-heat/10 px-2 py-1.5 text-[11px] text-heat">
            Unguarded — rackets can be shaken down
          </p>
        )}

        {territory.strategicBonus && (
          <p className="rounded bg-panel/60 p-2 text-[11px] text-muted-foreground">
            {territory.strategicBonus.description} (+{territory.strategicBonus.value} {territory.strategicBonus.type})
          </p>
        )}

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            {isOwned ? `Garrison (${garrison.length})` : `Known presence (${garrison.length})`}
          </h3>
          {garrison.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {isRival ? "No confirmed faces here." : "No crew stationed here."}
            </p>
          )}
          <div className="space-y-1">
            {garrison.map((c) => (
              <button
                key={c.id}
                onClick={() => selectCrew(c.id)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-elevated"
              >
                <PortraitAvatar seed={c.portraitSeed} size={24} ringColor={FAMILY_HEX[c.family]} role={c.role} family={c.family} isPlayerBoss={c.isPlayerBoss} alt={c.name} />
                <span className="text-xs">{c.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{c.role}</span>
              </button>
            ))}
          </div>
          {isRival && unknown > 0 && (
            <div className="mt-2 rounded border border-dashed border-panel-border bg-panel/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              Unknown presence: {unknown} figure{unknown === 1 ? "" : "s"}
            </div>
          )}
          {isRival && intel?.reports?.[territory.id] && (() => {
            const report = intel.reports[territory.id]!;
            const lookout = report.lookoutId
              ? crew.find((c) => c.id === report.lookoutId)
              : undefined;
            const fresh = hasFreshCasing(locState, territory.id);
            const stale =
              !fresh || turn - report.turn > 2 || report.spottedIds.every((id) => {
                const k = intel.known[id];
                return !k || k.territoryId !== territory.id;
              });
            return (
              <div className="mt-2 space-y-1 rounded border border-sky-500/30 bg-sky-950/30 p-2">
                <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-sky-200">
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" /> Last lookout report
                  </span>
                  <span className="text-[9px] uppercase text-muted-foreground">
                    {report.outcome.replace("_", " ")}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  T{report.turn}
                  {lookout ? ` by ${lookout.name}` : ""} · {report.spottedIds.length} men ·
                  garrison {report.garrison}
                  {report.rivalOps.length > 0
                    ? ` · ${report.rivalOps.length} rival op(s)`
                    : ""}
                </p>
                {fresh && !stale ? (
                  <Badge className="bg-money/20 text-[9px] text-money">
                    Fresh intel: +6% hit odds
                  </Badge>
                ) : (
                  <p className="text-[10px] text-amber-300/80">
                    Stale — crew may have moved
                  </p>
                )}
              </div>
            );
          })()}
          {isRival && (() => {
            const pendingSurv = operations.find(
              (o) =>
                !o.resolved &&
                o.kind === "surveillance" &&
                o.family === playerFamily &&
                o.targetTerritoryId === territory.id,
            );
            if (pendingSurv) {
              const lookout = pendingSurv.lookoutId
                ? crew.find((c) => c.id === pendingSurv.lookoutId)
                : undefined;
              return (
                <div className="mt-2 rounded border border-panel-border bg-panel/50 p-2 text-[11px]">
                  <div className="flex items-center gap-1.5 font-medium text-sky-200">
                    <Eye className="h-3.5 w-3.5" />
                    Lookout {lookout?.name ?? "assigned"} casing — report next turn
                  </div>
                </div>
              );
            }
            return (
              <div className="mt-2 space-y-1.5 rounded border border-panel-border bg-panel/50 p-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium">
                  <Eye className="h-3.5 w-3.5 text-sky-300" /> Case this district
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Assign a lookout for 1 turn to reveal who is here.
                </p>
                <select
                  value={caseLookoutId}
                  onChange={(e) => setCaseLookoutId(e.target.value)}
                  className="w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                >
                  <option value="">Select lookout…</option>
                  {lookouts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} (stealth {c.skills.stealth})
                    </option>
                  ))}
                </select>
                <Tip
                  wrapDisabled
                  content={
                    caseLookoutId
                      ? "Send a lookout for 1 turn to reveal who is stationed here."
                      : lookouts.length === 0
                        ? "No idle or garrison crew available to case."
                        : "Select a lookout first."
                  }
                >
                  <Button
                    size="sm"
                    className="h-7 w-full text-[11px]"
                    disabled={!caseLookoutId}
                    onClick={() => {
                      if (!caseLookoutId) return;
                      caseDistrict(territory.id, caseLookoutId);
                      setCaseLookoutId("");
                    }}
                  >
                    Send lookout
                  </Button>
                </Tip>
              </div>
            );
          })()}
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            Rackets ({territory.rackets.length}/{racketSlots})
          </h3>
          {territory.rackets.length === 0 && <p className="text-xs text-muted-foreground">No rackets built.</p>}
          <div className="space-y-1.5">
            {territory.rackets.map((r) => {
              const visual = RACKET_VISUALS[r.type];
              const Icon = visual.Icon;
              const manager = r.managerId ? crew.find((c) => c.id === r.managerId) : null;
              const frozen = isRacketFrozen(r, turn);
              const income = frozen ? 0 : racketIncome(r, 0, manager);
              const canUpgrade =
                isOwned &&
                !frozen &&
                r.level < 5 &&
                !!racketPayment(r.type, r.upgradeCost, money, dirtyMoney);
              const washCap = isLegitBusiness(r.type)
                ? launderCap(r, manager, turn)
                : 0;
              const plan = launderPlan[r.id] ?? 0;
              return (
                <div
                  key={r.id}
                  className="rounded border border-panel-border bg-panel/50 px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="flex h-7 w-7 items-center justify-center rounded"
                      style={{ background: `${visual.color}33` }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: visual.emissive }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate text-xs font-medium">
                        {RACKET_LABELS[r.type]}
                        {frozen && (
                          <Badge className="bg-heat/30 text-[9px] text-heat">
                            FROZEN ({(r.frozenUntil ?? turn) - turn})
                          </Badge>
                        )}
                        {isOwned &&
                          r.type === "speakeasy" &&
                          r.stock === 0 &&
                          !frozen && (
                            <Badge className="bg-heat/20 text-[9px] text-heat">Dry</Badge>
                          )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        {r.type === "safehouse" ? (
                          <span>Hideout · −{r.level} wanted/turn for garrisoned crew</span>
                        ) : (
                          <span className="text-money">${income}/turn</span>
                        )}
                        {isOwned && isStorageType(r.type) && (
                          <span>
                            {r.stock}/{stockCap(r, manager)} crates
                          </span>
                        )}
                        <span className="flex gap-0.5">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <span
                              key={i}
                              className={`h-1 w-1 rounded-full ${i < r.level ? "bg-amber-400" : "bg-muted"}`}
                            />
                          ))}
                        </span>
                      </div>
                      {isOwned && isLegitBusiness(r.type) && (() => {
                        const status = launderSiteStatus(r, turn);
                        if (status === "off") {
                          return (
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                              <span className="text-muted-foreground">Not a laundering site</span>
                              <Tip
                                wrapDisabled
                                content={
                                  frozen
                                    ? "Frozen by Treasury audit — cannot set up laundering."
                                    : "Free. Takes one turn for the books to open, then you can route dirty cash here."
                                }
                              >
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  className="h-5 px-1.5 text-[9px]"
                                  disabled={frozen}
                                  onClick={() => setupLaunderSite(territory.id, r.id)}
                                >
                                  Set up laundering
                                </Button>
                              </Tip>
                            </div>
                          );
                        }
                        if (status === "setting_up") {
                          return (
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                              <span className="text-amber-300">Setting up — active next turn</span>
                              <Tip content="Cancel setup and clear this as a laundering site.">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 px-1.5 text-[9px] text-muted-foreground"
                                  onClick={() => stopLaunderSite(territory.id, r.id)}
                                >
                                  Stop
                                </Button>
                              </Tip>
                            </div>
                          );
                        }
                        return (
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                            <span className="text-muted-foreground">
                              Laundering site · washes up to ${washCap}
                              {plan > 0 ? ` · routing $${plan}` : ""}
                            </span>
                            <Tip content="Stop laundering here and clear any standing wash order. Re-setup takes another turn.">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-5 px-1.5 text-[9px] text-muted-foreground"
                                onClick={() => stopLaunderSite(territory.id, r.id)}
                              >
                                Stop
                              </Button>
                            </Tip>
                          </div>
                        );
                      })()}
                      {isOwned && (
                        <div className="mt-1 flex items-center gap-1.5">
                          {manager ? (
                            <button
                              type="button"
                              onClick={() => selectCrew(manager.id)}
                              className="flex items-center gap-1 text-[10px] text-foreground hover:underline"
                            >
                              <PortraitAvatar
                                seed={manager.portraitSeed}
                                size={16}
                                role={manager.role}
                                family={manager.family}
                                alt={manager.name}
                              />
                              {manager.name.split(" ").slice(-1)[0]}
                            </button>
                          ) : (
                            <Tip content={managerTip(r, null)}>
                              <Badge variant="outline" className="text-[9px] text-amber-400">
                                {r.type === "warehouse"
                                  ? "Unmanaged −12%"
                                  : "Unmanaged −30%"}
                              </Badge>
                            </Tip>
                          )}
                          <Tip content={managerTip(r, manager)} wrapDisabled>
                            <select
                              value={r.managerId ?? ""}
                              onChange={(e) =>
                                assignManager(territory.id, r.id, e.target.value || null)
                              }
                              className="h-6 max-w-[9rem] rounded border border-panel-border bg-panel/60 px-1 text-[10px]"
                            >
                              <option value="">Assign manager…</option>
                              {managerCandidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name.split(" ").slice(-1)[0]} ({c.role})
                                </option>
                              ))}
                            </select>
                          </Tip>
                        </div>
                      )}
                      {isOwned && r.type === "warehouse" && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {warehouseManagerEffectText(manager, r.stock)}
                        </p>
                      )}
                    </div>
                    {isOwned && r.level < 5 && (
                      <Tip
                        wrapDisabled
                        content={upgradeTip(r, manager, frozen, money, dirtyMoney)}
                      >
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!canUpgrade}
                          className="h-7 gap-1 px-2 text-[10px]"
                          onClick={() => upgradeRacketAt(territory.id, r.id)}
                        >
                          <ArrowUp className="h-3 w-3" />
                          {formatMoney(r.upgradeCost)}
                        </Button>
                      </Tip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          {isOwned &&
            territory.rackets.some(
              (r) => r.type === "speakeasy" && r.stock === 0 && !isRacketFrozen(r, turn),
            ) && (
              <FeedSpeakeasyButton territoryId={territory.id} />
            )}
          {isOwned &&
            territory.rackets.some((r) => isProducerType(r.type)) &&
            !territory.rackets.some((r) => r.type === "warehouse") && (
            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
              No warehouse: overflow production is dumped each turn.
            </p>
          )}
          {isOwned && territory.rackets.some((r) => r.type === "warehouse") && (
            <Tip content="Open liquor logistics — buy whisky, assign warehouse managers, send crates.">
              <Button
                variant="secondary"
                className="justify-start gap-2"
                onClick={() => setPanel("warehouse")}
              >
                <Wine className="h-4 w-4 text-steel-light" /> Liquor
              </Button>
            </Tip>
          )}
          {isOwned && territory.rackets.some((r) => isLegitBusiness(r.type)) && (
            <Tip content="Route dirty cash through set-up legit businesses.">
              <Button
                variant="secondary"
                className="justify-start gap-2"
                onClick={() => setPanel("laundering")}
              >
                <Eye className="h-4 w-4 text-steel-light" /> Launder
              </Button>
            </Tip>
          )}
          {isOwned && !slotsFull && (
            <>
              {tier !== "built" && (
                <p className="text-[10px] text-muted-foreground">{lotTierHint(tier)}</p>
              )}
              <Tip
                content={
                  tier === "built"
                    ? `Open a new racket here (${territory.rackets.length}/${racketSlots} slots used).`
                    : `${lotTierHint(tier)} Allowed: ${allowedRacketTypes(territory)
                        .map((type) => RACKET_LABELS[type])
                        .join(", ")}.`
                }
              >
                <Button
                  variant="secondary"
                  className="justify-start gap-2"
                  onClick={() => setPanel("racket_build")}
                >
                  <Hammer className="h-4 w-4 text-steel-light" /> Build Racket
                </Button>
              </Tip>
            </>
          )}
          {isOwned && slotsFull && (
            <p className="text-[10px] text-muted-foreground">District full — {racketSlots}/{racketSlots} rackets.</p>
          )}
          {!isOwned && (
            <Tip content="Move crew in to take this district.">
              <Button
                variant="secondary"
                className="justify-start gap-2"
                onClick={() => setPanel("capture")}
              >
                <ShieldPlus className="h-4 w-4 text-emerald-400" /> Capture Territory
              </Button>
            </Tip>
          )}
          {isRival && (
            <Tip content="Plan a hit on rival crew in this district.">
              <Button
                variant="secondary"
                className="justify-start gap-2"
                onClick={() => setPanel("hit_planner")}
              >
                <Swords className="h-4 w-4 text-heat" /> Plan Hit
              </Button>
            </Tip>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function FeedSpeakeasyButton({ territoryId }: { territoryId: string }) {
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const startDelivery = useGameStore((s) => s.startDelivery);
  const feed = planFeedSpeakeasy(
    { territories, crew, playerFamily, turn },
    territoryId,
  );
  const sourceName = feed.ok
    ? territories.find((t) => t.id === feed.sourceId)?.name ?? "warehouse"
    : "";
  let tip = feed.ok ? "" : feed.reason;
  if (feed.ok && playerFamily) {
    const risk = hijackRisk({ territories, crew } as GameState, {
      id: "preview",
      family: playerFamily,
      driverId: feed.driverId,
      sourceTerritoryId: feed.sourceId,
      destTerritoryId: territoryId,
      path: feed.path,
      cargo: feed.cargo,
      status: "active",
    });
    tip = `Sends ${feed.cargo} crates from ${sourceName}. Hijack ${(risk * 100).toFixed(0)}%.`;
  }

  return (
    <Tip wrapDisabled content={tip}>
      <Button
        variant="secondary"
        className="h-auto justify-start gap-2 whitespace-normal py-2 text-left"
        disabled={!feed.ok}
        onClick={() => {
          if (!feed.ok) return;
          startDelivery(feed.driverId, feed.sourceId, territoryId, feed.cargo);
        }}
      >
        <Wine className="h-4 w-4 shrink-0 text-steel-light" />
        {feed.ok ? `Feed speakeasy: ${feed.cargo} crates from ${sourceName}` : "Feed speakeasy"}
      </Button>
    </Tip>
  );
}

function InfoBox({
  label,
  value,
  valueClassName,
  icon,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded bg-panel/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`flex items-center justify-center gap-1 font-semibold ${valueClassName ?? ""}`}>
        {icon}
        {value}
      </div>
    </div>
  );
}
