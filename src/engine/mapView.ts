import { create } from "zustand";

interface MapViewState {
  /** True when the camera is far enough for the strategic overlay. */
  overview: boolean;
  /** True when the camera is close enough to read one block's plumbing. */
  close: boolean;
  /** 0..1 fade for the strategic overlay (smoothstep of camera distance). */
  blend: number;
  /** Bumped by the Overview toolbar button to request a fly in/out. */
  overviewNonce: number;
  setOverview: (overview: boolean, blend: number, close?: boolean) => void;
  requestOverview: () => void;
}

export const useMapView = create<MapViewState>((set) => ({
  overview: false,
  close: false,
  blend: 0,
  overviewNonce: 0,
  setOverview: (overview, blend, close = false) => set({ overview, blend, close }),
  requestOverview: () => set((s) => ({ overviewNonce: s.overviewNonce + 1 })),
}));
