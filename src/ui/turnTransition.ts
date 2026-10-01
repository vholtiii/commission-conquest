import { create } from "zustand";

export type TurnPhase = "idle" | "closing" | "hold" | "opening";

interface TurnTransitionState {
  phase: TurnPhase;
  setPhase: (phase: TurnPhase) => void;
  begin: () => void;
}

/** Transient curtain state. Not persisted. */
export const useTurnTransition = create<TurnTransitionState>((set) => ({
  phase: "idle",
  setPhase: (phase) => set({ phase }),
  begin: () => set({ phase: "closing" }),
}));
