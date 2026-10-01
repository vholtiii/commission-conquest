import { useMemo } from "react";
import { useHitCinematicPhase } from "@/scene/hits/HitCinematic";
import { useReelHold } from "@/scene/hits/reelHold";
import { useGameStore } from "@/engine/store";
import { attributeCinematic, attributionLabel } from "@/engine/attribution";
import { Button } from "@/components/ui/button";
import type { HitBeat } from "@/types/game";

function captionForPhase(caption: HitBeat["phase"] | "hold", beats: HitBeat[]): string {
  if (caption === "hold") return beats.find((b) => b.phase === "complication")?.text ?? "";
  return beats.find((b) => b.phase === caption)?.text ?? "";
}

export default function HitCaptions() {
  const { label, caption, cinematic } = useHitCinematicPhase();
  const held = useReelHold((s) => s.held);
  const finishCinematic = useGameStore((s) => s.finishCinematic);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const territories = useGameStore((s) => s.territories);

  const text = useMemo(() => {
    if (!cinematic) return "";
    return captionForPhase(caption, cinematic.result.beats);
  }, [caption, cinematic]);

  if (!cinematic) return null;
  const witnessed = cinematic.perspective === "witnessed";
  const block = territories.find((t) => t.id === cinematic.targetTerritoryId)?.name;
  // Somebody else's war: say whose, so the reel reads as news and not a job of
  // yours. The shooters are named only when the street would know them.
  const header = witnessed
    ? `${attributionLabel(attributeCinematic(useGameStore.getState(), cinematic))} on ${cinematic.targetFamily}${block ? ` · ${block}` : ""}`
    : label;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex flex-col justify-between">
      {/* Letterbox */}
      <div className="h-14 bg-gradient-to-b from-black/90 to-transparent" />
      <div className="flex flex-col items-center gap-3 px-6 pb-8">
        <div className="max-w-xl rounded-md bg-black/75 px-4 py-3 text-center backdrop-blur-sm">
          <div className={`mb-1 text-[10px] uppercase tracking-[0.2em] ${witnessed ? "text-muted-foreground" : "text-heat"}`}>
            {header}
          </div>
          <p className="font-display text-base text-white/95">{text}</p>
        </div>
        <div className="pointer-events-auto flex gap-2">
          {held ? (
            <Button
              size="sm"
              className="h-8 animate-digest-in bg-heat px-4 text-xs uppercase tracking-wide text-white hover:bg-heat/80"
              onClick={() => finishCinematic()}
            >
              {witnessed ? "Continue" : "See the result"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 bg-black/60 text-xs uppercase tracking-wide text-white hover:bg-black/80"
              onClick={() => finishCinematic()}
            >
              Skip
            </Button>
          )}
          {witnessed ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[10px] text-muted-foreground hover:text-white"
              onClick={() => {
                updateSettings({ rivalCinematics: "off" });
                // Drop every rival reel still queued; the sit-downs pick up after.
                let next = useGameStore.getState().cinematicQueue[0];
                while (next && next.perspective === "witnessed") {
                  finishCinematic();
                  next = useGameStore.getState().cinematicQueue[0];
                }
              }}
            >
              Skip rival hits
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[10px] text-muted-foreground hover:text-white"
              onClick={() => {
                updateSettings({ skipCinematics: true });
                finishCinematic();
              }}
            >
              Always skip
            </Button>
          )}
        </div>
      </div>
      <div className="h-14 bg-gradient-to-t from-black/90 to-transparent" />
    </div>
  );
}
