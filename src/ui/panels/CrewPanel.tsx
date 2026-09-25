import { UserPlus, Users, X } from "lucide-react";
import { useGameStore } from "@/engine/store";
import type { CrewSkills } from "@/types/game";
import {
  canJoinCrew,
  canLeadCrew,
  crewCurriculum,
  crewOf,
  crewSchoolLabel,
  crewSlots,
  isFreelanceSoldier,
} from "@/engine/crews";
import { recruitPrice, recruitTier, recruitTierLine } from "@/engine/recruiting";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";

const SKILL_SHORT: Record<keyof CrewSkills, string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

const SKILL_ABBR: Record<keyof CrewSkills, string> = {
  muscle: "Mu",
  stealth: "St",
  smarts: "Sm",
  charm: "Ch",
  driving: "Dr",
};

function titleCase(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function CrewPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const recruitmentPool = useGameStore((s) => s.recruitmentPool);
  const money = useGameStore((s) => s.money);
  const respect = useGameStore((s) => s.reputation.respect);
  const recruitFromPool = useGameStore((s) => s.recruitFromPool);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const joinCrew = useGameStore((s) => s.joinCrew);
  const leaveCrew = useGameStore((s) => s.leaveCrew);

  if (!playerFamily) return null;
  const tier = recruitTier(respect);
  const playerCrew = crew.filter((c) => c.family === playerFamily);
  // Boss first, then the consigliere, then the capos.
  const LEADER_ORDER: Record<string, number> = { boss: 0, consigliere: 1, capo: 2 };
  const capos = playerCrew
    .filter((c) => canLeadCrew(c))
    .sort((a, b) => (LEADER_ORDER[a.role] ?? 9) - (LEADER_ORDER[b.role] ?? 9));
  const loose = playerCrew.filter(
    (c) => c.status === "active" && !c.capoId && (c.role === "soldier" || c.role === "associate"),
  );

  return (
    <PanelShell title="Crew" subtitle={`${playerCrew.filter((c) => c.status === "active").length} active`}>
      <div className="space-y-5">
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <UserPlus className="h-3.5 w-3.5" /> Recruitment Pool
          </h3>
          <p className="mb-1.5 text-[10px] text-muted-foreground">{recruitTierLine(tier)}</p>
          <div className="space-y-1.5">
            {recruitmentPool.length === 0 && (
              <p className="text-xs text-muted-foreground">Nobody&apos;s come looking this week.</p>
            )}
            {recruitmentPool.map((c, i) => {
              const price = recruitPrice(c, playerFamily);
              return (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-2 py-1.5"
              >
                <PortraitAvatar seed={c.portraitSeed} size={26} ringColor="#5c7a99" role={c.role} family={c.family} alt={c.name} />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-xs font-medium">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {(Object.keys(SKILL_ABBR) as (keyof CrewSkills)[]).map((k, n) => (
                      <span key={k}>
                        {n > 0 && " · "}
                        {SKILL_ABBR[k]} {c.skills[k]}
                      </span>
                    ))}
                    {c.traits.length > 0 && ` · ${c.traits.map(titleCase).join(", ")}`}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={money < price}
                  onClick={() => recruitFromPool(i)}
                  className="h-7 px-2 text-[11px]"
                >
                  {formatMoney(price)}
                </Button>
              </div>
              );
            })}
          </div>
        </div>

        {capos.length > 0 && (
          <div>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Crews
            </h3>
            <div className="space-y-2">
              {capos.map((capo) => {
                const members = crewOf(crew, capo.id);
                const slots = crewSlots(capo);
                const teaches = crewCurriculum(capo);
                const candidates = loose.filter((c) => canJoinCrew(crew, c.id, capo.id).ok);
                return (
                  <div
                    key={capo.id}
                    className="rounded-md border border-panel-border bg-panel/50 px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <button onClick={() => selectCrew(capo.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <PortraitAvatar seed={capo.portraitSeed} size={26} ringColor="#5c7a99" role={capo.role} family={capo.family} alt={capo.name} />
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-xs font-medium">{capo.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {capo.role !== "capo" && `${crewSchoolLabel(capo)} · `}
                            Teaches {teaches.map((k) => SKILL_SHORT[k]).join(" & ")}
                            {capo.status !== "active" && ` · ${capo.status}`}
                          </span>
                        </div>
                      </button>
                      <Badge variant="outline" className="text-[9px]">
                        {members.length}/{slots}
                      </Badge>
                    </div>
                    {(members.length > 0 || candidates.length > 0) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {members.map((m) => (
                          <span
                            key={m.id}
                            className="flex items-center gap-1 rounded border border-panel-border bg-panel/60 px-1.5 py-0.5 text-[10px]"
                          >
                            <button onClick={() => selectCrew(m.id)} className="hover:text-steel-light">
                              {m.name.split(" ").pop()}
                            </button>
                            {m.status !== "active" && (
                              <span className="text-muted-foreground">({m.status})</span>
                            )}
                            <button
                              title="Cut loose"
                              onClick={() => leaveCrew(m.id)}
                              className="text-muted-foreground hover:text-heat"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        {members.length < slots && capo.status === "active" && candidates.length > 0 && (
                          <select
                            value=""
                            onChange={(e) => {
                              if (e.target.value) joinCrew(e.target.value, capo.id);
                            }}
                            className="h-6 rounded border border-panel-border bg-panel/60 px-1 text-[10px]"
                          >
                            <option value="">Add a man…</option>
                            {candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                                {c.role === "associate" ? " (associate → soldier)" : ""}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {loose.some((c) => isFreelanceSoldier(c)) && (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Loose soldiers ({loose.filter((c) => isFreelanceSoldier(c)).length}) stay sharper on the
                street for casing but pick up none of a capo&apos;s habits.
              </p>
            )}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          The full roster lives in the Family Roster on the right — click a man there to post
          him or promote him.
        </p>
      </div>
    </PanelShell>
  );
}
