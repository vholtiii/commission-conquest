import { UserPlus, ArrowUpCircle } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { getFamilyDef } from "@/data/families";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";
import PanelShell from "./PanelShell";
import { formatMoney, titleCase } from "../formatters";

export default function CrewPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const recruitmentPool = useGameStore((s) => s.recruitmentPool);
  const territories = useGameStore((s) => s.territories);
  const money = useGameStore((s) => s.money);
  const recruitFromPool = useGameStore((s) => s.recruitFromPool);
  const assignMember = useGameStore((s) => s.assignMember);
  const selectCrew = useGameStore((s) => s.selectCrew);

  if (!playerFamily) return null;
  const def = getFamilyDef(playerFamily);
  const recruitCost = Math.floor(800 * (1 - (def.bonuses.recruitmentDiscount || 0)));
  const ownedTerritories = territories.filter((t) => t.owner === playerFamily);
  const playerCrew = crew.filter((c) => c.family === playerFamily);

  return (
    <PanelShell title="Crew" subtitle={`${playerCrew.filter((c) => c.status === "active").length} active`}>
      <div className="space-y-5">
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <UserPlus className="h-3.5 w-3.5" /> Recruitment Pool
          </h3>
          <div className="space-y-1.5">
            {recruitmentPool.length === 0 && (
              <p className="text-xs text-muted-foreground">No recruits available. Check back next turn.</p>
            )}
            {recruitmentPool.map((c, i) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-2 py-1.5"
              >
                <PortraitAvatar seed={c.portraitSeed} size={26} ringColor="#5c7a99" role={c.role} family={c.family} alt={c.name} />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-xs font-medium">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    Muscle {c.skills.muscle} &middot; Smarts {c.skills.smarts}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={money < recruitCost}
                  onClick={() => recruitFromPool(i)}
                  className="h-7 px-2 text-[11px]"
                >
                  {formatMoney(recruitCost)}
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            Roster ({playerCrew.length})
          </h3>
          <div className="space-y-1.5">
            {playerCrew.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/40 px-2 py-1.5"
              >
                <button onClick={() => selectCrew(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <PortraitAvatar seed={c.portraitSeed} size={26} ringColor="#5c7a99" role={c.role} family={c.family} isPlayerBoss={c.isPlayerBoss} alt={c.name} />
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-xs font-medium">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {titleCase(c.role)} &middot; {titleCase(c.assignment.type)}
                    </span>
                  </div>
                </button>
                {c.status !== "active" && (
                  <Badge variant="outline" className="text-[9px]">
                    {c.status}
                  </Badge>
                )}
                {c.status === "active" && (
                  <>
                    <select
                      value={
                        c.assignment.type === "garrison"
                          ? c.assignment.territoryId ?? ""
                          : c.assignment.type === "racket"
                            ? `racket:${c.assignment.territoryId}`
                            : ""
                      }
                      onChange={(e) => {
                        if (!e.target.value) return;
                        if (e.target.value.startsWith("racket:")) return;
                        assignMember(c.id, { type: "garrison", territoryId: e.target.value });
                      }}
                      className="h-7 rounded border border-panel-border bg-panel/60 px-1 text-[10px]"
                    >
                      <option value="">Assign…</option>
                      {c.assignment.type === "racket" && (
                        <option value={`racket:${c.assignment.territoryId}`}>
                          Racket —{" "}
                          {territories.find((t) => t.id === c.assignment.territoryId)?.name ??
                            "managed"}
                        </option>
                      )}
                      {ownedTerritories.map((t) => (
                        <option key={t.id} value={t.id}>
                          Garrison — {t.name}
                        </option>
                      ))}
                    </select>
                    {!c.isPlayerBoss && c.role !== "boss" && (
                      <button
                        title="Open promotions"
                        onClick={() => selectCrew(c.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-panel-border hover:text-steel-light"
                      >
                        <ArrowUpCircle className="h-4 w-4" />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
