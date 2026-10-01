import { useState } from "react";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type TurnLogEntry } from "@/types/game";
import { formatDate } from "./formatters";
import { selectDigestLines } from "./digestRank";
import { useTurnTransition } from "./turnTransition";

/** Ink tones that stay readable on cream newsprint. */
const INK_CATEGORY: Record<TurnLogEntry["category"], string> = {
  hit: "text-[#8a2a2a]",
  ai: "text-[#3d4a5c]",
  economy: "text-[#6a5420]",
  heat: "text-[#8a2a2a]",
  event: "text-[#5a3d6a]",
  combat: "text-[#8a2a2a]",
  delivery: "text-[#2d5a3a]",
  diplomacy: "text-[#2a4a62]",
  system: "text-[#5c564c]",
};

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
  const date = useGameStore((s) => s.date);
  const setPanel = useGameStore((s) => s.setPanel);
  const phase = useTurnTransition((s) => s.phase);
  const [dismissedTurn, setDismissedTurn] = useState<number | null>(null);

  const closed = turnLog.some((l) => l.id.startsWith("log_turn_"));
  if (!closed || !playerFamily) return null;
  if (dismissedTurn === turn) return null;
  if (activeEvent || pendingHitResult || sitdownCard || dealCard || (pendingReports?.length ?? 0) > 0 || cinematic) {
    return null;
  }
  if (phase === "closing" || phase === "hold") return null;

  const lines = selectDigestLines(turnLog, playerFamily, turn);
  const quiet = lines.length === 0;
  const [headline, ...rest] = lines;

  return (
    <div className="pointer-events-auto absolute left-1/2 top-16 z-40 w-[min(24rem,calc(100%-2rem))] -translate-x-1/2">
      <div className="animate-digest-in bg-[#f3ead3] px-4 py-3 text-[#1a1612] shadow-lg">
        <div className="border-y-4 border-double border-[#1a1612] py-1 text-center">
          <h2 className="font-display text-xl leading-none">The Commission</h2>
          <p className="mt-0.5 text-[9px] uppercase tracking-[0.35em] text-[#5c4a32]">Evening Edition</p>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-[#5c4a32]">
          <span>
            {formatDate(date)} · No. {turn}
          </span>
          <button
            type="button"
            className="hover:text-[#1a1612] hover:underline"
            onClick={() => setDismissedTurn(turn)}
          >
            Dismiss
          </button>
        </div>
        {quiet ? (
          <p className="mt-2 font-display text-sm leading-snug">Quiet week in the city.</p>
        ) : (
          <>
            <p className="mt-2 font-display text-[15px] leading-snug">{headline!.text}</p>
            {rest.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-[#1a1612]/30 pt-2">
                {rest.map((line) => (
                  <li key={line.id} className="flex items-start gap-1.5 text-[12px] leading-snug">
                    {line.family && (
                      <span
                        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: FAMILY_HEX[line.family] }}
                      />
                    )}
                    <span className={INK_CATEGORY[line.category]}>{line.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <button
          type="button"
          className="mt-2 text-[10px] uppercase tracking-wide text-[#5c4a32] hover:text-[#1a1612] hover:underline"
          onClick={() => setPanel("log")}
        >
          Open log
        </button>
      </div>
    </div>
  );
}
