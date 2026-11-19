import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import type { HitApproach, HitCinematic as HitCinematicData, HitResult } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { useTurnTransition } from "@/ui/turnTransition";
import {
  burst,
  engine,
  explosion,
  fire,
  fizzle,
  footsteps,
  glass,
  mutedShot,
  rainBed,
  ricochet,
  setSfxVolume,
  siren,
  thud,
  tyreSqueal,
} from "@/audio/sfx";
import { publishReel, ReelScope } from "./reelClock";
import { frozenLocal, phaseAt, renderKey, scaleAt, timelineFor, totalDuration, type PhaseDef } from "./timeline";
import { siteFor } from "./site";
import { useReelHold } from "./reelHold";
import { reelRain } from "./reelLook";
import ReelAtmosphere from "./props/ReelAtmosphere";
import CarBombCinematic from "./CarBombCinematic";
import DriveByCinematic from "./DriveByCinematic";
import AmbushCinematic from "./AmbushCinematic";
import SitdownBetrayalCinematic from "./SitdownBetrayalCinematic";
import SummonsCinematic from "./SummonsCinematic";
import type { ReelClock } from "./sceneProps";

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
  if (phase === "plant" || phase === "stakeout" || phase === "roll" || phase === "arrive" || phase === "position" || phase === "drive") {
    engine(approach === "drive_by" ? 2 : 1.2);
    if (phase === "position") footsteps(4, 0.5);
  }
  if (phase === "detonate") {
    if (result.complication === "dud" || result.complication === "rain") fizzle();
    else {
      explosion();
      if (result.targetDead) thud();
    }
  }
  if (phase === "abort") footsteps(5, 0.3);
  if (phase === "spray") {
    burst(result.defenders > 0 ? 8 : 5, 0.08);
    ricochet();
    glass();
    footsteps(7, 0.2);
    if (result.targetDead) thud();
  }
  if (phase === "strike" && result.complication !== "patrol" && !result.markAbsent) {
    burst(3, 0.12);
    ricochet();
    footsteps(6, 0.22);
    if (result.targetDead) thud();
  }
  if (
    phase === "aftermath" &&
    approach === "car_bomb" &&
    result.complication !== "dud" &&
    result.complication !== "rain" &&
    result.complication !== "cop_on_fender"
  ) {
    fire(2.6);
  }
  if (
    (phase === "getaway" || phase === "drive_off") &&
    result.outcome !== "botched_arrested" &&
    result.outcome !== "botched_killed"
  ) {
    tyreSqueal();
  }
  if (
    (phase === "handshake" || phase === "back_room") &&
    !result.markAbsent &&
    result.complication !== "pat_down" &&
    result.complication !== "toast"
  ) {
    mutedShot();
    if (result.targetDead) thud();
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
  const { invalidate, gl, camera } = useThree();

  const current: HitCinematicData | null = pendingHitResult ? null : (cinematicQueue[0] ?? null);
  const phases = useMemo(
    () => (current ? timelineFor(current.approach, current.result, current.perspective) : []),
    [current?.operationId, current?.approach, current?.perspective],
  );
  const site = useMemo(
    () => (current ? siteFor(layout, current, useGameStore.getState().territories) : null),
    [current?.operationId, layout],
  );

  const startTime = useRef<number | null>(null);
  const elapsedRef = useRef(0);
  const finishedRef = useRef(false);
  const lastCue = useRef<string>("");
  const cueDone = useRef(false);
  const liveKey = useRef("");
  const shake = useRef(0);
  const reelClock = useRef<ReelClock>({ phase: "", local: 0, progress: 0 });
  const rootRef = useRef<THREE.Group>(null);
  const warm = useRef<string | null>(null);
  const warming = useRef(false);
  const [live, setLive] = useState<{ phase: PhaseDef; local: number } | null>(null);

  useEffect(() => {
    startTime.current = null;
    elapsedRef.current = 0;
    finishedRef.current = false;
    lastCue.current = "";
    cueDone.current = false;
    liveKey.current = "";
    shake.current = 0;
    publishReel(null);
    reelClock.current = { phase: phases[0]?.name ?? "", local: 0, progress: 0 };
    useReelHold.getState().setHeld(false);
    setLive(phases[0] ? { phase: phases[0], local: 0 } : null);
    setSfxVolume(sfxVolume);
    const controls = controlsRef.current as {
      enabled?: boolean;
      minDistance?: number;
      maxPolarAngle?: number;
      minPolarAngle?: number;
    } | null;
    const limits = controls
      ? { minDistance: controls.minDistance, maxPolarAngle: controls.maxPolarAngle, minPolarAngle: controls.minPolarAngle }
      : null;
    if (controls) {
      controls.enabled = !current;
      if (current) {
        // The map refuses to come in closer than a district. A reel has to.
        controls.minDistance = 0.4;
        controls.minPolarAngle = 0.05;
        controls.maxPolarAngle = Math.PI / 2.02;
      }
    }
    return () => {
      const back = controlsRef.current as typeof controls;
      if (!back) return;
      back.enabled = true;
      if (limits) {
        back.minDistance = limits.minDistance;
        back.maxPolarAngle = limits.maxPolarAngle;
        back.minPolarAngle = limits.minPolarAngle;
      }
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

  useFrame((_, dt) => {
    if (!current || phases.length === 0) return;
    if (warm.current !== current.operationId) {
      // Compile every material in the reel, lights included, before the first frame of action.
      if (!warming.current && rootRef.current) {
        warming.current = true;
        const op = current.operationId;
        gl.compileAsync(rootRef.current, camera).finally(() => {
          warming.current = false;
          // A skip can start the next reel before this compile finishes.
          if (useGameStore.getState().cinematicQueue[0]?.operationId === op) warm.current = op;
          invalidate();
        });
      }
      invalidate();
      return;
    }
    if (startTime.current === null) {
      // Don't roll under the turn curtain; the first beat is the setup.
      if (useTurnTransition.getState().phase !== "idle") {
        invalidate();
        return;
      }
      startTime.current = 0;
      elapsedRef.current = 0;
    }
    const step = Math.min(0.05, Math.max(0, dt));
    const before = phaseAt(phases, elapsedRef.current);
    const scale = scaleAt(before.phase, before.local);
    elapsedRef.current += step * scale;
    const elapsed = elapsedRef.current;
    const total = totalDuration(phases);
    const at = phaseAt(phases, elapsed);
    reelClock.current.phase = at.phase.name;
    reelClock.current.local = at.local;
    reelClock.current.progress = total > 0 ? Math.min(1, elapsed / total) : 1;
    publishReel({
      time: elapsed,
      dt: step * scale,
      scale,
      phase: at.phase.name,
      local: at.local,
      progress: reelClock.current.progress,
    });
    if (lastCue.current !== at.phase.name) {
      const first = lastCue.current === "";
      lastCue.current = at.phase.name;
      cueDone.current = false;
      setSfxVolume(sfxVolume);
      if (first) {
        // Slow motion stretches the wall clock past the timeline, so the bed outlasts the reel.
        rainBed(total * 1.4, reelRain(useGameStore.getState().date.month, current.result.complication));
      }
    }
    if (!cueDone.current && at.local >= (at.phase.cueAt ?? 0)) {
      cueDone.current = true;
      playCue(current.approach, at.phase.name, current.result);
    }
    const key = renderKey(at.phase.name, at.local);
    if (key !== liveKey.current) {
      liveKey.current = key;
      setLive({ phase: at.phase, local: frozenLocal(at.phase.name, at.local) });
    }
    invalidate();
    if (elapsed >= total && !finishedRef.current) {
      // Hold the last frame. The player moves on from the captions when ready;
      // finishCinematic then advances the queue and re-enables the camera.
      finishedRef.current = true;
      useReelHold.getState().setHeld(true);
    }
  });

  if (!current || !site || !live) return null;
  const Scene = SCENES[current.approach];
  const month = useGameStore.getState().date.month;
  return (
    <group ref={rootRef}>
      <ReelScope>
        <ReelAtmosphere
          center={site.road}
          facing={site.facing}
          amount={reelRain(month, current.result.complication)}
        />
        <Scene cinematic={current} site={site} phase={live.phase.name} local={live.local} clock={reelClock} shake={shake} />
      </ReelScope>
    </group>
  );
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
