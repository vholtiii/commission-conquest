import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type DealKind, type DealOutcome, type SitdownAgenda } from "@/types/game";
import { dealKindLabel } from "@/engine/deals";
import { agendaTermsText } from "@/engine/agendas";
import PortraitAvatar from "@/ui/PortraitAvatar";
import { Button } from "@/components/ui/button";

const TITLE: Record<DealOutcome, string> = {
  honored: "Deal honored",
  breached: "Word broken",
  expired: "Deal ran out",
  called_in: "Favor called in",
};

const TITLE_COLOR: Record<DealOutcome, string> = {
  honored: "text-emerald-300",
  breached: "text-heat",
  expired: "text-steel-light",
  called_in: "text-amber-300",
};

/** The agenda whose wording describes a deal of this kind. */
function agendaFor(kind: DealKind): SitdownAgenda | null {
  switch (kind) {
    case "truce":
      return "truce";
    case "alliance":
      return "alliance";
    case "liquor":
      return "liquor";
    case "cut":
      return "racket";
    default:
      return null;
  }
}

/** A deal closing: honored, broken, run out, or a favor called in. */
export default function DealSettlementModal() {
  const settlement = useGameStore((s) => s.pendingDealSettlements?.[0] ?? null);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const cinematic = useGameStore(
    (s) => s.cinematicQueue.length > 0 || s.sitdownPhase != null || (s.sitdownCinematicQueue?.length ?? 0) > 0,
  );
  const sitdownCards = useGameStore((s) => s.pendingSitdownResults?.length ?? 0);
  const dismiss = useGameStore((s) => s.dismissDealSettlement);
  const setPanel = useGameStore((s) => s.setPanel);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const playerFamily = useGameStore((s) => s.playerFamily);

  if (!settlement || !playerFamily) return null;
  // After the week's reels and result cards; before the digest.
  if (activeEvent || pendingHitResult || cinematic || sitdownCards > 0) return null;

  const playerBoss = crew.find((c) => c.family === playerFamily && c.role === "boss");
  const rivalBoss = crew.find((c) => c.family === settlement.other && c.role === "boss");
  const agenda = agendaFor(settlement.kind);
  const termsLine = agenda ? agendaTermsText({ territories, crew, playerFamily }, agenda, settlement.terms) : null;

  const deltas = [
    settlement.cash !== 0
      ? `Cash ${settlement.cash > 0 ? "−" : "+"}$${Math.abs(settlement.cash).toLocaleString()}`
      : null,
    settlement.relation !== 0
      ? `Relation ${settlement.relation > 0 ? "+" : "−"}${Math.abs(settlement.relation)} with ${settlement.other}`
      : null,
    settlement.standing !== 0 ? `Standing ${settlement.standing > 0 ? "+" : "−"}${Math.abs(settlement.standing)}` : null,
    settlement.outcome === "breached" && settlement.breachedBy && settlement.breachedBy !== playerFamily
      ? `${settlement.breachedBy} answers to every family for it`
      : settlement.outcome === "breached"
        ? "Every family heard"
        : null,
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
            <h2 className={`font-display text-lg ${TITLE_COLOR[settlement.outcome]}`}>{TITLE[settlement.outcome]}</h2>
            <p className="text-[11px] text-muted-foreground">
              <span
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: FAMILY_HEX[settlement.other] }}
              />
              {settlement.kind === "favor"
                ? `Favor owed to ${settlement.other}`
                : `${dealKindLabel(settlement.kind)} with ${settlement.other}`}{" "}
              · week {settlement.turn}
            </p>
          </div>
          {rivalBoss && (
            <PortraitAvatar
              seed={rivalBoss.portraitSeed}
              size={56}
              role="boss"
              family={rivalBoss.family}
              ringColor={FAMILY_HEX[settlement.other]}
            />
          )}
        </div>

        <p className="mt-3 text-sm text-foreground/90">{settlement.text}</p>
        {termsLine && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            The terms were: {termsLine}.
          </p>
        )}
        {settlement.outcome === "called_in" && settlement.becameDealId && (
          <p className="mt-2 text-[12px] text-amber-300">
            It's on your books now as an obligation. Do it by the deadline or it counts as a broken deal.
          </p>
        )}
        {deltas && <p className="mt-2 text-[11px] text-muted-foreground">{deltas}</p>}

        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => {
              setPanel("commission");
              dismiss();
            }}
          >
            See deals
          </Button>
          <Button className="flex-1 bg-steel font-ui font-bold uppercase" onClick={() => dismiss()}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
