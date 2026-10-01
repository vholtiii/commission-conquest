import { create } from "zustand";

interface ReelHoldState {
  /** The reel has played out and is holding on its last frame for the player. */
  held: boolean;
  setHeld: (held: boolean) => void;
}

/** Transient. Not persisted. */
export const useReelHold = create<ReelHoldState>((set) => ({
  held: false,
  setHeld: (held) => set({ held }),
}));
