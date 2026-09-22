import { useGameStore } from "@/engine/store";
import type { CrewRole } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";
import { pathsFromRole, canPromote, xpForLevel } from "@/engine/crew";
import { successionReadinessReasons } from "@/engine/succession";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PortraitAvatar from "@/ui/PortraitAvatar";
import PanelShell from "./PanelShell";
import { formatMoney, titleCase } from "../formatters";

const SKILL_LABELS: Record<string, string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

export default function CrewSheet() {
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const crew = useGameStore((s) => s.crew);
  const money = useGameStore((s) => s.money);
  const turn = useGameStore((s) => s.turn);
  const payFuneral = useGameStore((s) => s.payFuneral);
  const promote = useGameStore((s) => s.promote);
  const setPanel = useGameStore((s) => s.setPanel);
  const focusReason = useGameStore((s) => s.focusReason);
  const territories = useGameStore((s) => s.territories);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const playerFamily = useGameStore((s) => s.playerFamily);

  const member = crew.find((c) => c.id === selectedCrewId);
  if (!member) return null;

  const isDead = member.status === "dead";
  const isOwn = member.family === playerFamily;
  const here = territories.find((t) => t.id === selectedTerritoryId);
  const turf = here
    ? !here.owner
      ? "unclaimed"
      : here.owner === playerFamily
        ? "your turf"
        : `${here.owner} turf`
    : null;

  const nextXp = xpForLevel(Math.min(10, member.level + 1));
  const currXp = xpForLevel(member.level);
  const xpProgress =
    member.level >= 10
      ? 100
      : Math.min(100, ((member.xp - currXp) / Math.max(1, nextXp - currXp)) * 100);

  const paths = isOwn && member.status === "active" ? pathsFromRole(member.role) : [];
  const successionReasons =
    member.role === "underboss" ? successionReadinessReasons(member, turn) : null;

  return (
    <PanelShell
      title={member.name}
      subtitle={`${titleCase(member.role)} — ${member.family}`}
      onClose={() => setPanel("none")}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <PortraitAvatar
            seed={member.portraitSeed}
            size={56}
            ringColor={FAMILY_HEX[member.family]}
            role={member.role}
            family={member.family}
            isPlayerBoss={member.isPlayerBoss}
            alt={member.name}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant={isDead ? "destructive" : "outline"} className="text-[10px]">
                {member.status}
              </Badge>
              {member.isPlayerBoss && (
                <Badge className="bg-money/20 text-[10px] text-money">Boss</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Level {member.level} &middot; {member.hits} hits
            </p>
            <div className="mt-1">
              <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                <span>XP</span>
                <span>
                  {member.level >= 10 ? "MAX" : `${member.xp} / ${nextXp}`}
                </span>
              </div>
              <Progress value={xpProgress} className="h-1.5" />
            </div>
          </div>
        </div>

        {here && focusReason && (
          <div className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/60 px-2 py-1.5 text-[11px]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: here.owner ? FAMILY_HEX[here.owner] : "#7a7f87" }}
            />
            <span className="text-foreground">{here.name}</span>
            <span className="text-muted-foreground">· {turf}</span>
            <span className="ml-auto text-muted-foreground">{focusReason}</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <StatBox label="Loyalty" value={member.loyalty} />
          <StatBox label="Wanted" value={member.wanted} accent="text-heat" />
          <StatBox label="XP" value={member.xp} />
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Skills</h3>
          <div className="space-y-1.5">
            {Object.entries(member.skills).map(([key, val]) => (
              <div key={key}>
                <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
                  <span>{SKILL_LABELS[key] ?? key}</span>
                  <span>{val}</span>
                </div>
                <Progress value={Math.min(100, val)} className="h-1.5" />
              </div>
            ))}
          </div>
        </div>

        {member.traits.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Traits</h3>
            <div className="flex flex-wrap gap-1.5">
              {member.traits.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">
                  {titleCase(t)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {successionReasons && (
          <div className="rounded-md border border-panel-border bg-panel/50 p-3">
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              Succession
            </h3>
            {successionReasons.every((r) => r.met) ? (
              <p className="text-xs text-money">Ready to succeed if the boss falls.</p>
            ) : (
              <p className="mb-1 text-xs text-amber-400">Not ready:</p>
            )}
            <ul className="space-y-0.5 text-[11px]">
              {successionReasons.map((r) => (
                <li key={r.label} className={r.met ? "text-money" : "text-muted-foreground"}>
                  {r.met ? "✓" : "○"} {r.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {paths.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              Promotion
            </h3>
            <div className="space-y-2">
              {paths.map((path) => {
                const check = canPromote(member, path.to, crew, money);
                return (
                  <div
                    key={path.to}
                    className="rounded-md border border-panel-border bg-panel/50 p-2"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        → {titleCase(path.to as CrewRole)}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!check.ok}
                        className="h-7 px-2 text-[10px]"
                        onClick={() => promote(member.id, path.to)}
                      >
                        {formatMoney(path.cost)}
                      </Button>
                    </div>
                    <ul className="space-y-0.5 text-[10px]">
                      {check.reasons.map((r) => (
                        <li
                          key={r.label}
                          className={r.met ? "text-money" : "text-muted-foreground"}
                        >
                          {r.met ? "✓" : "○"} {r.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isDead && isOwn && (
          <div className="rounded-md border border-panel-border bg-panel/50 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Give {member.name} a proper send-off to steady the crew&apos;s nerves.
            </p>
            <Button
              className="w-full bg-steel font-ui font-bold uppercase"
              disabled={money < 500}
              onClick={() => payFuneral(member.id)}
            >
              Hold Funeral ($500)
            </Button>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function StatBox({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded bg-panel/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}
