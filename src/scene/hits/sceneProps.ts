import type { MutableRefObject } from "react";
import type { HitCinematic } from "@/types/game";
import type { HitSite } from "./site";

export interface SceneProps {
  cinematic: HitCinematic;
  site: HitSite;
  phase: string;
  /** 0–1 within the current phase. */
  local: number;
  shake: MutableRefObject<number>;
}
