import { useState } from "react";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX } from "@/types/game";
import { CATEGORY_COLOR } from "./logColors";
import { selectDigestLines } from "./digestRank";

export default function TurnDigest() {
  const turn = useGameStore((s) => s.turn);
  const turnLog = useGameStore((s) => s.turnLog);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const pendingReports = useGameStore((s) => s.pendingReports);
  const cinematic = useGameStore(
    (s) => s.cinematicQueue.length > 0 || s.sitdownPhase != null || (s.sitdownCinematicQueue?.length ?? 0) > 0,
  );
  const sitdownCard = useGameStore((s) => (s.pendingSitdownResults?.length ?? 0) > 0);
  const dealCard = useGameStore((s) => (s.pendingDealSettlements?.length ?? 0) > 0);
  const setPanel = useGameStore((s) => s.setPanel);
  const [dismissedTurn, setDismissedTurn] = useState<number | null>(null);

  const closed = turnLog.some((l) => l.id.startsWith("log_turn_"));
  if (!closed || !playerFamily) return null;
  if (dismissedTurn === turn) return null;
  if (activeEvent || pendingHitResult || sitdownCard || dealCard || (pendingReports?.length ?? 0) > 0 || cinematic) {
    return null;
  }

  const lines = selectDigestLines(turnLog, playerFamily, turn);
  const quiet = lines.length === 0;

  return (
    <div className="pointer-events-auto absolute left-1/2 top-16 z-40 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2">
      <div className="rounded-md border border-panel-border bg-panel/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h2 className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Week of {turn}
          </h2>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setDismissedTurn(turn)}
          >
            Dismiss
          </button>
        </div>
        {quiet ? (
          <p className="text-[11px] text-muted-foreground">Quiet week in the city.</p>
        ) : (
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                {line.family && (
                  <span
                    className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: FAMILY_HEX[line.family] }}
                  />
                )}
                <span className={CATEGORY_COLOR[line.category] ?? "text-foreground"}>
                  {line.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="mt-2 text-[10px] text-steel-light hover:underline"
          onClick={() => setPanel("log")}
        >
          Open log
        </button>
      </div>
    </div>
  );
}
