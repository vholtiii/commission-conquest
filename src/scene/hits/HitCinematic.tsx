import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import type { HitApproach, HitCinematic as HitCinematicData, HitResult } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { useTurnTransition } from "@/ui/turnTransition";
import { burst, engine, explosion, fizzle, footsteps, glass, mutedShot, setSfxVolume, siren } from "@/audio/sfx";
import { applyShake } from "./cameraRig";
import { phaseAt, timelineFor, totalDuration, type PhaseDef } from "./timeline";
import { siteFor } from "./site";
import { useReelHold } from "./reelHold";
import CarBombCinematic from "./CarBombCinematic";
import DriveByCinematic from "./DriveByCinematic";
import AmbushCinematic from "./AmbushCinematic";
import SitdownBetrayalCinematic from "./SitdownBetrayalCinematic";
import SummonsCinematic from "./SummonsCinematic";

interface Props {
  layout: CityLayout;
  controlsRef: MutableRefObject<{ enabled?: boolean; target: THREE.Vector3; update: () => void } | null>;
}

const SCENES: Record<HitApproach, typeof CarBombCinematic> = {
  car_bomb: CarBombCinematic,
  drive_by: DriveByCinematic,
  ambush: AmbushCinematic,
  sitdown_betrayal: SitdownBetrayalCinematic,
  summons: SummonsCinematic,
};

function playCue(approach: HitApproach, phase: string, result: HitResult): void {
  const police = result.outcome === "botched_arrested" || result.outcome === "botched_killed";
  if (phase === "plant" || phase === "roll" || phase === "arrive" || phase === "position" || phase === "drive") {
    engine(approach === "drive_by" ? 2 : 1.2);
    if (phase === "position") footsteps(4, 0.5);
  }
  if (phase === "detonate") {
    if (result.complication === "dud" || result.complication === "rain") fizzle();
    else explosion();
  }
  if (phase === "abort") footsteps(5, 0.3);
  if (phase === "spray") {
    burst(result.defenders > 0 ? 8 : 5, 0.08);
    glass();
  }
  if (phase === "strike" && result.complication !== "patrol" && !result.markAbsent) burst(3, 0.12);
  if (
    (phase === "handshake" || phase === "back_room") &&
    !result.markAbsent &&
    result.complication !== "pat_down" &&
    result.complication !== "toast"
  ) {
    mutedShot();
    if (result.outcome === "messy_kill" || result.complication === "witness" || result.complication === "kitchen_backup") {
      glass();
    }
  }
  if (police && (phase === "aftermath" || phase === "getaway" || phase === "melt" || phase === "walk_out")) {
    siren(2.2);
  }
}

export default function HitCinematic({ layout, controlsRef }: Props) {
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const sfxVolume = useGameStore((s) => s.settings.sfxVolume ?? 0.7);
  const { invalidate } = useThree();

  const current: HitCinematicData | null = pendingHitResult ? null : (cinematicQueue[0] ?? null);
  const phases = useMemo(
    () => (current ? timelineFor(current.approach, current.result, current.perspective) : []),
    [current?.operationId, current?.approach, current?.perspective],
  );
  const site = useMemo(
    () => (current ? siteFor(layout, current) : null),
    [current?.operationId, layout],
  );

  const startTime = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const lastCue = useRef<string>("");
  const shake = useRef(0);
  const [live, setLive] = useState<{ phase: PhaseDef; local: number } | null>(null);

  useEffect(() => {
    startTime.current = null;
    finishedRef.current = false;
    lastCue.current = "";
    shake.current = 0;
    useReelHold.getState().setHeld(false);
    setLive(phases[0] ? { phase: phases[0], local: 0 } : null);
    setSfxVolume(sfxVolume);
    if (controlsRef.current) controlsRef.current.enabled = !current;
    return () => {
      if (controlsRef.current) controlsRef.current.enabled = true;
    };
  }, [current?.operationId, controlsRef, phases, sfxVolume]);

  useEffect(() => {
    if (!current || !live) return;
    window.dispatchEvent(
      new CustomEvent("hit-cinematic-phase", {
        detail: { phase: live.phase.name, label: live.phase.label, caption: live.phase.caption, cinematic: current },
      }),
    );
  }, [live?.phase.name, current?.operationId]);

  useFrame(({ clock }) => {
    if (!current || phases.length === 0) return;
    if (startTime.current === null) {
      // Don't roll under the turn curtain; the first beat is the setup.
      if (useTurnTransition.getState().phase !== "idle") {
        invalidate();
        return;
      }
      startTime.current = clock.getElapsedTime();
    }
    const elapsed = clock.getElapsedTime() - startTime.current;
    const total = totalDuration(phases);
    const at = phaseAt(phases, elapsed);
    if (lastCue.current !== at.phase.name) {
      lastCue.current = at.phase.name;
      setSfxVolume(sfxVolume);
      playCue(current.approach, at.phase.name, current.result);
    }
    setLive((prev) =>
      prev && prev.phase.name === at.phase.name && Math.abs(prev.local - at.local) < 0.02
        ? prev
        : { phase: at.phase, local: at.local },
    );
    invalidate();
    if (elapsed >= total && !finishedRef.current) {
      // Hold the last frame. The player moves on from the captions when ready;
      // finishCinematic then advances the queue and re-enables the camera.
      finishedRef.current = true;
      useReelHold.getState().setHeld(true);
    }
  });

  const { camera } = useThree();
  useFrame(() => {
    applyShake(camera, shake);
  });

  if (!current || !site || !live) return null;
  const Scene = SCENES[current.approach];
  return <Scene cinematic={current} site={site} phase={live.phase.name} local={live.local} shake={shake} />;
}

export function useHitCinematicPhase(): {
  phase: string;
  label: string;
  caption: PhaseDef["caption"];
  cinematic: HitCinematicData | null;
} {
  const cinematicQueue = useGameStore((s) => s.cinematicQueue);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const [detail, setDetail] = useState<{ phase: string; label: string; caption: PhaseDef["caption"] }>({
    phase: "depart",
    label: "En route",
    caption: "approach",
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent).detail as { phase: string; label: string; caption: PhaseDef["caption"] };
      setDetail({ phase: next.phase, label: next.label, caption: next.caption });
    };
    window.addEventListener("hit-cinematic-phase", handler);
    return () => window.removeEventListener("hit-cinematic-phase", handler);
  }, []);

  return {
    ...detail,
    cinematic: pendingHitResult ? null : (cinematicQueue[0] ?? null),
  };
}
