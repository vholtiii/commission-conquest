import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type SitdownFollow } from "@/types/game";
import PortraitAvatar from "@/ui/PortraitAvatar";
import { Button } from "@/components/ui/button";
import { termsText } from "@/engine/passage";
import { agendaLabel, agendaTermsText } from "@/engine/agendas";
import { isAgendaTable } from "@/engine/sitdowns";

const FOLLOW_LABEL: Record<SitdownFollow, string> = {
  case_venue: "Case the venue",
  plan_hit: "Plan a hit",
  open_liquor: "Open the liquor books",
  open_commission: "Back to the commission",
  open_deals: "See the deal",
};

/** What the table changed, after the cars pull away. */
export default function SitdownResultModal() {
  const result = useGameStore((s) => s.pendingSitdownResults?.[0] ?? null);
  const phase = useGameStore((s) => s.sitdownPhase);
  const dismiss = useGameStore((s) => s.dismissSitdownResult);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const setPanel = useGameStore((s) => s.setPanel);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);

  if (!result || phase || !playerFamily) return null;
  const where = territories.find((t) => t.id === result.venueTerritoryId)?.name ?? "the table";
  const playerBoss = crew.find((c) => c.family === playerFamily && c.role === "boss");
  const rivalBoss = crew.find((c) => c.family === result.family && c.role === "boss");

  function follow() {
    if (result!.follow === "open_liquor") setPanel("warehouse");
    else if (result!.follow === "open_commission" || result!.follow === "open_deals") setPanel("commission");
    else {
      selectTerritory(result!.venueTerritoryId);
      setPanel("district");
    }
    dismiss();
  }

  const delta = [
    `Relation ${result.deltas.relation >= 0 ? "+" : ""}${result.deltas.relation}`,
    `Respect ${result.deltas.respect >= 0 ? "+" : ""}${result.deltas.respect}`,
    result.deltas.fear != null ? `Fear ${result.deltas.fear >= 0 ? "+" : ""}${result.deltas.fear}` : null,
    result.hostFee != null ? `Host $${result.hostFee}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[440px] rounded-lg border p-5">
        <div className="flex items-center justify-between">
          {playerBoss && (
            <PortraitAvatar
              seed={playerBoss.portraitSeed}
              size={56}
              role="boss"
              family={playerBoss.family}
              isPlayerBoss={playerBoss.isPlayerBoss}
              ringColor={FAMILY_HEX[playerFamily]}
            />
          )}
          <div className="text-center">
            <h2 className="font-display text-lg text-steel-light">
              {result.success ? (isAgendaTable(result.purpose) ? "Terms struck" : "The table held") : "Nothing settled"}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {result.family} · {where}
              {isAgendaTable(result.purpose) ? ` · ${agendaLabel(result.purpose)}` : ""}
              {result.betrayal === "ours" ? " · You brought steel" : ""}
              {result.betrayal === "theirs" ? " · They brought steel" : ""}
            </p>
          </div>
          {rivalBoss && (
            <PortraitAvatar
              seed={rivalBoss.portraitSeed}
              size={56}
              role="boss"
              family={rivalBoss.family}
              ringColor={FAMILY_HEX[result.family]}
            />
          )}
        </div>
        <div className="mt-3 space-y-1">
          {result.lines.map((line) => (
            <p key={line} className="text-sm text-foreground/90">
              {line}
            </p>
          ))}
        </div>
        {result.struck && (
          <p className="mt-2 text-[12px] text-emerald-400">Passage: {termsText(result.struck)}</p>
        )}
        {result.struckTerms && result.purpose && (
          <p className="mt-2 text-[12px] text-emerald-400">
            {agendaLabel(result.purpose)}: {agendaTermsText({ territories, crew, playerFamily }, result.purpose, result.struckTerms)}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{delta}</p>
        <Button className="mt-4 w-full" onClick={follow}>
          {FOLLOW_LABEL[result.follow]}
        </Button>
      </div>
    </div>
  );
}
