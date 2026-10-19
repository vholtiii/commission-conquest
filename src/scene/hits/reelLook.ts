import { create } from "zustand";

interface ReelLookState {
  /** 0 is the daytime map. 1 is the night grade a reel asks for. */
  grade: number;
  setGrade: (grade: number) => void;
}

/** Transient. Not persisted. Atmosphere reads it while a reel is up. */
export const useReelLook = create<ReelLookState>((set) => ({
  grade: 0,
  setGrade: (grade) => set({ grade }),
}));

/** Heavy in a rain complication, steady through autumn and winter, a drizzle otherwise. */
export function reelRain(month: number, complication?: string): number {
  if (complication === "rain") return 1;
  if (month >= 10 || month <= 2) return 0.62;
  return 0.3;
}
