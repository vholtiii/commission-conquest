import { Banknote } from "lucide-react";
import { RACKET_LABELS } from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  auditChance,
  auditModifiersLabel,
  isLegitBusiness,
  isLaunderSiteSetUp,
  isRacketFrozen,
  launderCap,
  launderCut,
  launderManagerMods,
  launderSiteStatus,
  sortLaunderFillOrder,
  type LaunderSitePlan,
} from "@/engine/economy";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";
import PortraitAvatar from "../PortraitAvatar";

function riskLabel(p: number): { text: string; className: string } {
  if (p <= 0) return { text: "Safe", className: "bg-money/20 text-money" };
  if (p < 0.25) return { text: `Risky ${(p * 100).toFixed(0)}%`, className: "bg-amber-500/20 text-amber-300" };
  return { text: `Reckless ${(p * 100).toFixed(0)}%`, className: "bg-heat/20 text-heat" };
}

export default function LaunderingPanel() {
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const turn = useGameStore((s) => s.turn);
  const heat = useGameStore((s) => s.heat);
  const bribes = useGameStore((s) => s.bribes);
  const launderPlan = useGameStore((s) => s.launderPlan ?? {});
  const setLaunderAmount = useGameStore((s) => s.setLaunderAmount);
  const clearLaunderPlan = useGameStore((s) => s.clearLaunderPlan);
  const suggestSafeSpread = useGameStore((s) => s.suggestSafeSpread);
  const setupLaunderSite = useGameStore((s) => s.setupLaunderSite);
  const stopLaunderSite = useGameStore((s) => s.stopLaunderSite);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const setPanel = useGameStore((s) => s.setPanel);

  const ctx = {
    heatLevel: heat.level,
    mayorActive: bribes.mayor.isActive,
    chiefsActive: bribes.chiefs.isActive,
  };
  const mods = auditModifiersLabel(ctx, turn);

  type SiteRow = LaunderSitePlan & { territoryId: string; districtName: string };

  const setUpSites: SiteRow[] = [];
  const available: SiteRow[] = [];
  let totalCap = 0;

  for (const t of territories) {
    if (t.owner !== playerFamily) continue;
    for (const r of t.rackets) {
      if (!isLegitBusiness(r.type)) continue;
      const manager = r.managerId
        ? crew.find((c) => c.id === r.managerId && c.status === "active") ?? null
        : null;
      const cap = launderCap(r, manager, turn);
      const plan = Math.max(0, launderPlan[r.id] ?? 0);
      const row: SiteRow = {
        racket: r,
        territoryId: t.id,
        districtName: t.name,
        manager,
        plan,
        cap: Math.max(1, cap),
        ratio: plan / Math.max(1, cap),
      };
      if (isLaunderSiteSetUp(r)) {
        if (!isRacketFrozen(r, turn) && launderSiteStatus(r, turn) === "ready") {
          totalCap += cap;
        }
        setUpSites.push(row);
      } else {
        available.push(row);
      }
    }
  }

  const activeOrdered = sortLaunderFillOrder(
    setUpSites.filter(
      (s) =>
        !isRacketFrozen(s.racket, turn) &&
        launderSiteStatus(s.racket, turn) === "ready",
    ),
  );
  const settingUp = setUpSites.filter(
    (s) =>
      !isRacketFrozen(s.racket, turn) &&
      launderSiteStatus(s.racket, turn) === "setting_up",
  );
  const frozen = setUpSites.filter((s) => isRacketFrozen(s.racket, turn));
  const displaySites = [...activeOrdered, ...settingUp, ...frozen];

  let routed = 0;
  let expectedClean = 0;
  for (const s of activeOrdered) {
    const amount = Math.min(s.plan, Math.max(0, dirtyMoney - routed));
    routed += amount;
    expectedClean += Math.floor(amount * (1 - launderCut(s.racket.type)));
  }

  const maxShare =
    routed > 0
      ? Math.max(...activeOrdered.map((s) => Math.min(s.plan, dirtyMoney) / routed), 0)
      : 0;

  const hasAnyLegit = setUpSites.length > 0 || available.length > 0;

  return (
    <PanelShell title="Laundering" subtitle="Route dirty cash through legit businesses" width="w-[420px]">
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Badge variant="outline" className="bg-heat/15 text-heat">
            Dirty {formatMoney(dirtyMoney)}
          </Badge>
          <Badge variant="outline" className="bg-money/15 text-money">
            Clean {formatMoney(money)}
          </Badge>
          <Badge variant="outline">Safe cap {formatMoney(totalCap)}</Badge>
        </div>
        {mods && (
          <p className="text-[10px] text-muted-foreground">{mods}</p>
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => suggestSafeSpread()}>
            Suggest safe spread
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => clearLaunderPlan()}>
            Clear
          </Button>
        </div>
      </div>

      {!hasAnyLegit ? (
        <div className="rounded border border-dashed border-panel-border p-4 text-center text-xs text-muted-foreground">
          <Banknote className="mx-auto mb-2 h-6 w-6 opacity-50" />
          Build a legit business (deli, laundromat, …) to wash cash.
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              Laundering sites
            </h3>
            {displaySites.length === 0 ? (
              <p className="rounded border border-dashed border-panel-border p-3 text-center text-[11px] text-muted-foreground">
                Pick a business below to set up as a laundering site.
              </p>
            ) : (
              <div className="space-y-3">
                {displaySites.map((site) => {
                  const r = site.racket;
                  const frozenBiz = isRacketFrozen(r, turn);
                  const status = launderSiteStatus(r, turn);
                  const Icon = RACKET_VISUALS[r.type].Icon;
                  const cut = launderCut(r.type);
                  const p = frozenBiz || status !== "ready"
                    ? 0
                    : auditChance(
                        r,
                        site.plan,
                        { ...ctx, manager: site.manager, scrutinyPrev: r.scrutiny },
                        turn,
                      );
                  const risk = riskLabel(p);
                  const projected = Math.floor(site.plan * (1 - cut));
                  const modsMgr = launderManagerMods(site.manager);
                  const fillIdx = activeOrdered.findIndex((s) => s.racket.id === r.id);

                  return (
                    <div
                      key={r.id}
                      className="rounded border border-panel-border bg-panel/40 p-2.5"
                    >
                      <div className="mb-1.5 flex items-start justify-between gap-2">
                        <button
                          type="button"
                          className="flex items-center gap-2 text-left"
                          onClick={() => {
                            selectTerritory(site.territoryId);
                            setPanel("district");
                          }}
                        >
                          {!frozenBiz && status === "ready" && fillIdx >= 0 && (
                            <span className="text-[10px] text-muted-foreground">#{fillIdx + 1}</span>
                          )}
                          <span
                            className="flex h-7 w-7 items-center justify-center rounded"
                            style={{ background: RACKET_VISUALS[r.type].color + "33" }}
                          >
                            <Icon className="h-3.5 w-3.5" style={{ color: RACKET_VISUALS[r.type].emissive }} />
                          </span>
                          <span>
                            <span className="block text-xs font-semibold">
                              {RACKET_LABELS[r.type]} Lv{r.level}
                            </span>
                            <span className="text-[10px] text-muted-foreground">{site.districtName}</span>
                          </span>
                        </button>
                        <div className="flex flex-col items-end gap-0.5">
                          {frozenBiz && (
                            <Badge className="bg-heat/30 text-heat">
                              FROZEN ({(r.frozenUntil ?? turn) - turn})
                            </Badge>
                          )}
                          {!frozenBiz && status === "setting_up" && (
                            <Badge className="bg-amber-500/20 text-amber-300">
                              Setting up — active next turn
                            </Badge>
                          )}
                          {!frozenBiz && status === "ready" && (
                            <Badge className={risk.className}>{risk.text}</Badge>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[10px] text-muted-foreground"
                            onClick={() => stopLaunderSite(site.territoryId, r.id)}
                          >
                            Stop
                          </Button>
                        </div>
                      </div>

                      {site.manager && (
                        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <PortraitAvatar
                            seed={site.manager.portraitSeed}
                            size={16}
                            role={site.manager.role}
                            family={site.manager.family}
                            alt={site.manager.name}
                          />
                          {site.manager.name.split(" ").slice(-1)[0]}
                          {modsMgr.capMult > 1.01 && (
                            <Badge variant="outline" className="text-[9px]">
                              +{Math.round((modsMgr.capMult - 1) * 100)}% cap
                            </Badge>
                          )}
                          {modsMgr.auditMult < 0.99 && (
                            <Badge variant="outline" className="text-[9px]">
                              −{Math.round((1 - modsMgr.auditMult) * 100)}% audit
                            </Badge>
                          )}
                        </div>
                      )}

                      <p className="mb-1 text-[10px] text-muted-foreground">
                        Safe up to {formatMoney(site.cap)} · cut {(cut * 100).toFixed(0)}%
                        {!frozenBiz && site.plan > 0 && (
                          <> · out ~{formatMoney(projected)}</>
                        )}
                      </p>

                      {!frozenBiz && (
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={site.cap * 2}
                            step={50}
                            value={site.plan}
                            onChange={(e) => setLaunderAmount(r.id, Number(e.target.value))}
                            className="h-1.5 flex-1 accent-steel"
                          />
                          <input
                            type="number"
                            min={0}
                            step={50}
                            value={site.plan}
                            onChange={(e) => setLaunderAmount(r.id, Number(e.target.value))}
                            className="w-20 rounded border border-panel-border bg-panel px-1.5 py-0.5 text-right text-xs"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {available.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Available businesses
              </h3>
              <div className="space-y-2">
                {available.map((site) => {
                  const r = site.racket;
                  const Icon = RACKET_VISUALS[r.type].Icon;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded border border-panel-border bg-panel/30 px-2.5 py-2"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 text-left"
                        onClick={() => {
                          selectTerritory(site.territoryId);
                          setPanel("district");
                        }}
                      >
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded"
                          style={{ background: RACKET_VISUALS[r.type].color + "33" }}
                        >
                          <Icon className="h-3.5 w-3.5" style={{ color: RACKET_VISUALS[r.type].emissive }} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold">
                            {RACKET_LABELS[r.type]} Lv{r.level}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{site.districtName}</span>
                        </span>
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7 shrink-0 text-[10px]"
                        disabled={isRacketFrozen(r, turn)}
                        onClick={() => setupLaunderSite(site.territoryId, r.id)}
                      >
                        Set up site
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {displaySites.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-panel-border pt-3 text-[11px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Routed</span>
            <span>{formatMoney(routed)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Expected clean</span>
            <span className="text-money">{formatMoney(expectedClean)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Sites</span>
            <span>
              Spread across {activeOrdered.filter((s) => s.plan > 0).length} site
              {activeOrdered.filter((s) => s.plan > 0).length === 1 ? "" : "s"}
            </span>
          </div>
          {maxShare > 0.6 && routed > 0 && (
            <p className="text-[10px] text-amber-300">
              One site carries {(maxShare * 100).toFixed(0)}% of the wash — spread it out.
            </p>
          )}
        </div>
      )}
    </PanelShell>
  );
}
