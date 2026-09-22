import { useMemo } from "react";
import { useHitCinematicPhase } from "@/scene/HitCinematic";
import { useGameStore } from "@/engine/store";
import { Button } from "@/components/ui/button";
import type { HitBeat } from "@/types/game";

function captionForPhase(
  phase: string,
  beats: HitBeat[],
): string {
  const map: Record<string, HitBeat["phase"]> = {
    depart: "approach",
    travel: "approach",
    strike: "execution",
    getaway: "getaway",
  };
  // Show complication briefly at end of travel / start of strike
  if (phase === "travel") {
    const approach = beats.find((b) => b.phase === "approach");
    return approach?.text ?? "The crew is en route…";
  }
  if (phase === "depart") {
    return "Wheels turning. The hit is in motion.";
  }
  if (phase === "strike") {
    const complication = beats.find((b) => b.phase === "complication");
    const execution = beats.find((b) => b.phase === "execution");
    return execution?.text ?? complication?.text ?? "Guns out.";
  }
  if (phase === "getaway") {
    const getaway = beats.find((b) => b.phase === "getaway");
    return getaway?.text ?? "Getaway.";
  }
  void map;
  return "";
}

export default function HitCaptions() {
  const { phase, cinematic } = useHitCinematicPhase();
  const finishCinematic = useGameStore((s) => s.finishCinematic);
  const updateSettings = useGameStore((s) => s.updateSettings);

  const text = useMemo(() => {
    if (!cinematic) return "";
    return captionForPhase(phase, cinematic.result.beats);
  }, [phase, cinematic]);

  if (!cinematic) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex flex-col justify-between">
      {/* Letterbox */}
      <div className="h-14 bg-gradient-to-b from-black/90 to-transparent" />
      <div className="flex flex-col items-center gap-3 px-6 pb-8">
        <div className="max-w-xl rounded-md bg-black/75 px-4 py-3 text-center backdrop-blur-sm">
          <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-heat">
            {phase === "strike" ? "Execution" : phase === "getaway" ? "Getaway" : "En Route"}
          </div>
          <p className="font-display text-base text-white/95">{text}</p>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-8 bg-black/60 text-xs uppercase tracking-wide text-white hover:bg-black/80"
            onClick={() => finishCinematic()}
          >
            Skip
          </Button>
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
        </div>
      </div>
      <div className="h-14 bg-gradient-to-t from-black/90 to-transparent" />
    </div>
  );
}
