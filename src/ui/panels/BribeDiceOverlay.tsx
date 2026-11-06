import { useEffect, useState } from "react";
import { useGameStore } from "@/engine/store";

const TUMBLE_MS = 1200;
const HOLD_MS = 4500;

function digits(roll: number): [number, number] {
  const n = Math.max(1, Math.min(100, roll));
  if (n === 100) return [0, 0];
  return [Math.floor(n / 10), n % 10];
}

export default function BribeDiceOverlay() {
  const roll = useGameStore((s) => s.bribeRoll);
  const [phase, setPhase] = useState<"tumble" | "result">("tumble");
  const token = roll ? `${roll.desk}:${roll.roll}:${roll.need}:${roll.landed}` : "";

  useEffect(() => {
    if (!token) return;
    setPhase("tumble");
    const show = window.setTimeout(() => setPhase("result"), TUMBLE_MS);
    const hide = window.setTimeout(() => useGameStore.getState().dismissBribeRoll(), TUMBLE_MS + HOLD_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [token]);

  if (!roll) return null;

  const tumbling = phase === "tumble";
  const [tens, ones] = digits(roll.roll);
  const missCopy =
    roll.hurts.length > 0
      ? roll.hurts.join(" · ")
      : "They kept the envelope. The odds were fair.";

  return (
    <div className="pointer-events-none absolute inset-0 z-[60] flex items-center justify-center px-4">
      <button
        type="button"
        className="pointer-events-auto w-full max-w-sm rounded-lg border border-panel-border bg-panel/95 p-4 text-left shadow-2xl backdrop-blur-sm"
        onClick={() => useGameStore.getState().dismissBribeRoll()}
      >
        <div className="flex items-center justify-center gap-3" style={{ perspective: "480px" }}>
          <div className={`bribe-die ${tumbling ? "tumbling" : ""}`}>{tumbling ? "?" : tens}</div>
          <div className={`bribe-die ${tumbling ? "tumbling" : ""}`} style={{ animationDelay: "80ms" }}>
            {tumbling ? "?" : ones}
          </div>
        </div>
        {!tumbling && (
          <div className="mt-3 text-center">
            {roll.landed ? (
              <>
                <p className="font-display text-base text-money">The money landed</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Rolled {roll.roll} · needed {roll.need}
                  {roll.courierName ? ` · ${roll.courierName.split(" ").slice(-1)[0]} carried it` : ""}
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-base text-heat">They kept the envelope</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Rolled {roll.roll} · needed {roll.need}
                </p>
                <p className="mt-2 text-xs text-foreground/90">{missCopy}</p>
              </>
            )}
            <p className="mt-2 text-[10px] text-muted-foreground">Click to close</p>
          </div>
        )}
      </button>
    </div>
  );
}
