import type { MutableRefObject } from "react";
import type { HitCinematic } from "@/types/game";
import type { HitSite } from "./site";

/** Written every frame by the reel driver. Scenes read it inside useFrame so motion is not tied to React renders. */
export interface ReelClock {
  phase: string;
  /** 0–1 within the current phase. */
  local: number;
  /** 0–1 across the whole reel. */
  progress: number;
}

export interface SceneProps {
  cinematic: HitCinematic;
  site: HitSite;
  phase: string;
  /** 0–1 within the current phase. Coarse; use `clock` for anything that moves. */
  local: number;
  clock: MutableRefObject<ReelClock>;
  shake: MutableRefObject<number>;
}
