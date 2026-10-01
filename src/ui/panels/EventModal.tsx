import { useGameStore } from "@/engine/store";
import { Button } from "@/components/ui/button";

const EFFECT_LABEL: Record<string, string> = {
  money: "Clean $",
  dirtyMoney: "Dirty $",
  heat: "Heat",
  respect: "Respect",
  fear: "Fear",
  loyalty: "Loyalty",
  crates: "Crates",
  shipmentDelay: "Shipment delay (turns)",
  shipmentLoss: "Shipment loss",
};

export default function EventModal() {
  const activeEvent = useGameStore((s) => s.activeEvent);
  const chooseEvent = useGameStore((s) => s.chooseEvent);
  // The week's violence plays out first; the paper lands after the reel and its card.
  const reelRunning = useGameStore(
    (s) =>
      s.cinematicQueue.length > 0 ||
      !!s.pendingHitResult ||
      s.sitdownPhase != null ||
      (s.sitdownCinematicQueue?.length ?? 0) > 0,
  );

  if (!activeEvent || reelRunning) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[440px] rounded-lg border p-5">
        <h2 className="font-display text-lg text-steel-light">{activeEvent.title}</h2>
        <p className="mt-2 text-sm text-foreground/85">{activeEvent.description}</p>

        <div className="mt-4 space-y-2">
          {activeEvent.choices.map((choice) => (
            <button
              key={choice.id}
              onClick={() => chooseEvent(choice.id)}
              className="flex w-full flex-col rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-left transition-colors hover:bg-panel-elevated"
            >
              <span className="text-sm font-medium">{choice.text}</span>
              <span className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                {Object.entries(choice.effects).map(([key, val]) => {
                  if (typeof val !== "number") return null;
                  const num = val;
                  if (key === "shipmentLoss") {
                    return (
                      <span key={key} className="text-heat">
                        {EFFECT_LABEL[key]} −{Math.round(num * 100)}%
                      </span>
                    );
                  }
                  return (
                    <span key={key} className={num >= 0 ? "text-emerald-400" : "text-heat"}>
                      {EFFECT_LABEL[key] ?? key} {num >= 0 ? "+" : ""}
                      {num}
                    </span>
                  );
                })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
