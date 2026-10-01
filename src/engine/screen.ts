import type { GameState } from "@/types/game";

type Screen = Pick<GameState, "cinematicQueue" | "sitdownPhase" | "sitdownCinematicQueue" | "pendingHitResult">;

/** A hit reel or a sit-down is playing on the map. */
export function reelOnScreen(s: Screen): boolean {
  return s.cinematicQueue.length > 0 || s.sitdownPhase != null || (s.sitdownCinematicQueue?.length ?? 0) > 0;
}

/**
 * The reel, or the result card that follows it, still owns the screen.
 * Pop-ups and toasts wait until this clears.
 */
export function screenHeld(s: Screen): boolean {
  return reelOnScreen(s) || !!s.pendingHitResult;
}
