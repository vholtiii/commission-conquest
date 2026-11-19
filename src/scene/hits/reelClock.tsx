import { createContext, useContext, type ReactNode } from "react";

/** Written every frame by the reel that is playing. Props read it so slow motion hits every moving part. */
export interface ReelSample {
  /** Timeline seconds. Advances by `dt`, which is already scaled. */
  time: number;
  /** Scaled frame delta. */
  dt: number;
  scale: number;
  phase: string;
  local: number;
  progress: number;
}

let sample: ReelSample | null = null;

export function publishReel(next: ReelSample | null): void {
  sample = next;
}

export function readReel(): ReelSample | null {
  return sample;
}

const ReelScopeContext = createContext(false);

/** People and props under this provider take their time from the reel, so a slow-motion beat slows them too. */
export function ReelScope({ children }: { children: ReactNode }) {
  return <ReelScopeContext.Provider value={true}>{children}</ReelScopeContext.Provider>;
}

export function useInReel(): boolean {
  return useContext(ReelScopeContext);
}
