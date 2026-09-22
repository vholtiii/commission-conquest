import { Eye } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { RACKET_LABELS } from "@/types/game";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";

function outcomeBadge(outcome: "clean" | "spotted" | "spotted_wounded") {
  if (outcome === "clean") {
    return <Badge className="bg-money/25 text-money">CLEAN</Badge>;
  }
  if (outcome === "spotted_wounded") {
    return <Badge className="bg-heat/25 text-heat">SPOTTED, WOUNDED</Badge>;
  }
  return <Badge className="bg-amber-500/25 text-amber-300">SPOTTED</Badge>;
}

export default function LookoutReportModal() {
  const pendingReports = useGameStore((s) => s.pendingReports);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const dismissLookoutReport = useGameStore((s) => s.dismissLookoutReport);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const setPanel = useGameStore((s) => s.setPanel);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);

  const report = pendingReports?.[0];
  if (!report || pendingHitResult || cinematicQueue.length > 0) return null;

  const district =
    territories.find((t) => t.id === report.territoryId)?.name ?? "District";
  const lookout = report.lookoutId
    ? crew.find((c) => c.id === report.lookoutId)
    : undefined;
  const spotted = report.spottedIds
    .map((id) => crew.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const newSet = new Set(report.newIds);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto panel-surface-elevated w-full max-w-md rounded-lg border p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            <div>
              <h2 className="font-display text-lg text-sky-200">
                Lookout report — {district}
              </h2>
              {lookout && (
                <div className="mt-1 flex items-center gap-1.5">
                  <PortraitAvatar
                    seed={lookout.portraitSeed}
                    size={22}
                    role={lookout.role}
                    family={lookout.family}
                    alt={lookout.name}
                  />
                  <span className="text-[11px] text-muted-foreground">{lookout.name}</span>
                </div>
              )}
              {report.forHit && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Surveil-first casing complete
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {outcomeBadge(report.outcome)}
            {report.relationDelta !== 0 && (
              <span className="text-[10px] text-heat">
                Relations {report.relationDelta}
              </span>
            )}
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase text-sky-300">Spotted</div>
          {spotted.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nobody home.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {spotted.map((c) => (
                <div key={c.id} className="flex items-center gap-1">
                  <PortraitAvatar
                    seed={c.portraitSeed}
                    size={28}
                    role={c.role}
                    family={c.family}
                    alt={c.name}
                  />
                  <div className="flex flex-col">
                    <span className="text-[10px]">
                      {c.name.split(" ").slice(-1)[0]}
                      {newSet.has(c.id) && (
                        <span className="ml-1 text-[8px] uppercase text-money">NEW</span>
                      )}
                    </span>
                    <span className="text-[8px] text-muted-foreground">{c.role}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[10px]">
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Men</div>
            <div className="font-semibold">{report.spottedIds.length}</div>
          </div>
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Garrison</div>
            <div className="font-semibold">{report.garrison}</div>
          </div>
          <div className="rounded bg-panel/50 px-2 py-1.5">
            <div className="text-muted-foreground">Defense</div>
            <div className="font-semibold">+{report.defenseBonus}</div>
          </div>
        </div>

        {report.rackets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {report.rackets.map((r, i) => {
              const visual = RACKET_VISUALS[r.type];
              const Icon = visual.Icon;
              return (
                <span
                  key={`${r.type}-${i}`}
                  className="inline-flex items-center gap-1 rounded bg-panel/50 px-1.5 py-0.5 text-[10px]"
                >
                  <Icon className="h-3 w-3" style={{ color: visual.emissive }} />
                  {RACKET_LABELS[r.type]} Lv{r.level}
                </span>
              );
            })}
          </div>
        )}

        {(report.oddsSample || report.tipRiskAfter !== undefined) && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-center text-[10px]">
            {report.oddsSample && (
              <div className="rounded bg-panel/50 px-2 py-1.5">
                <div className="text-muted-foreground">Hit odds (top mark)</div>
                <div className="font-semibold">
                  {Math.round(report.oddsSample.before * 100)}% →{" "}
                  <span className="text-money">
                    {Math.round(report.oddsSample.after * 100)}%
                  </span>
                </div>
              </div>
            )}
            {report.tipRiskAfter !== undefined && (
              <div className="rounded bg-panel/50 px-2 py-1.5">
                <div className="text-muted-foreground">Tip-off risk</div>
                <div className="font-semibold">
                  {Math.round(report.tipRiskAfter * 100)}%
                </div>
              </div>
            )}
          </div>
        )}

        {report.rivalOps.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">
              Rival operations
            </div>
            <div className="space-y-1">
              {report.rivalOps.map((op) => {
                const targetName =
                  territories.find((t) => t.id === op.targetTerritoryId)?.name ??
                  op.targetTerritoryId;
                return (
                  <div
                    key={op.operationId}
                    className={`rounded border px-2 py-1 text-[11px] ${
                      op.aimedAtPlayer
                        ? "border-heat/40 bg-heat/10 text-heat"
                        : "border-panel-border bg-panel/40"
                    }`}
                  >
                    {(op.approach ?? "op").replace("_", " ")} → {targetName}
                    {op.pendingTurns > 0
                      ? ` · ${op.pendingTurns} turn(s)`
                      : " · imminent"}
                    {op.aimedAtPlayer ? " · aimed at you" : ""}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            className="flex-1 text-xs"
            onClick={() => {
              selectTerritory(report.territoryId, { toastLabel: "Lookout report" });
              dismissLookoutReport();
            }}
          >
            View district
          </Button>
          {spotted.length > 0 && (
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => {
                selectTerritory(report.territoryId);
                setPanel("hit_planner");
                dismissLookoutReport();
              }}
            >
              Plan hit
            </Button>
          )}
          <Button
            className="flex-1 bg-steel font-ui text-xs font-bold uppercase"
            onClick={() => dismissLookoutReport()}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
