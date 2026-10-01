import { getFamilyDef } from "@/data/families";
import { useGameStore } from "@/engine/store";
import { formatDate } from "./formatters";
import { useTurnTransition } from "./turnTransition";

/** Newsprint card that covers the map while a week resolves. */
export default function TurnCurtain() {
  const phase = useTurnTransition((s) => s.phase);
  const date = useGameStore((s) => s.date);
  const turn = useGameStore((s) => s.turn);
  const playerFamily = useGameStore((s) => s.playerFamily);

  if (phase === "idle" || !playerFamily) return null;

  const hex = getFamilyDef(playerFamily).hex;
  const motion =
    phase === "closing" ? "animate-curtain-in" : phase === "opening" ? "animate-curtain-out" : "opacity-100";

  return (
    <div
      className={`absolute inset-0 z-[38] flex items-center justify-center bg-black/80 ${motion}`}
    >
      <div className="w-[min(28rem,calc(100%-2rem))] bg-[#f3ead3] px-6 py-5 text-center text-[#1a1612] shadow-2xl">
        <p className="text-[10px] uppercase tracking-[0.4em] text-[#6b5b45]">The City</p>
        <h2 className="mt-1 font-display text-3xl leading-none">{formatDate(date)}</h2>
        <div className="mx-auto mt-3 h-0.5 w-24" style={{ background: hex }} />
        <p className="mt-2 text-xs uppercase tracking-[0.25em] text-[#5c4a32]">Week {turn}</p>
      </div>
    </div>
  );
}
