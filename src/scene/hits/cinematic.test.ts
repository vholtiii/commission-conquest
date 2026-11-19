import { describe, expect, it } from "vitest";
import type { HitApproach, HitResult } from "@/types/game";
import { activeShot, fovAt } from "./director";
import { Vector3 } from "three";
import { CAR_BOMB, listCovers, SHOT_LISTS, SITDOWN } from "./shotlists";
import { scaleAt, timelineFor, totalDuration, type PhaseDef } from "./timeline";

function result(partial: Partial<HitResult> = {}): HitResult {
  return {
    operationId: "op",
    outcome: "clean_kill",
    beats: [],
    heatGain: 0,
    fearGain: 0,
    casualties: [],
    casualtyDetail: [],
    defenders: 0,
    tippedOff: false,
    targetDead: true,
    headline: "",
    successChance: 0.5,
    ...partial,
  };
}

const APPROACHES: HitApproach[] = ["ambush", "drive_by", "car_bomb", "sitdown_betrayal", "summons"];

describe("hit timelines", () => {
  it("keeps every full reel between 11 and 14 seconds", () => {
    const cases: Partial<HitResult>[] = [
      {},
      { outcome: "botched_arrested" },
      { outcome: "botched_killed" },
      { markAbsent: true },
      { complication: "cop_on_fender" },
      { complication: "dud" },
      { complication: "rain" },
    ];
    for (const approach of APPROACHES) {
      for (const partial of cases) {
        const phases = timelineFor(approach, result(partial), "ours");
        const total = totalDuration(phases);
        expect(total, `${approach} ${partial.complication ?? partial.outcome ?? "clean"}`).toBeGreaterThanOrEqual(11);
        expect(total).toBeLessThanOrEqual(14);
      }
    }
  });

  it("opens a blast or a fizzle on the stakeout, and keeps the plant only when nothing goes off", () => {
    const blows: Partial<HitResult>[] = [
      {},
      { outcome: "messy_kill" },
      { outcome: "botched_arrested" },
      { outcome: "botched_killed" },
      { complication: "dud" },
      { complication: "rain" },
      { complication: "wrong_car" },
    ];
    for (const partial of blows) {
      const phases = timelineFor("car_bomb", result(partial), "ours");
      expect(phases[0]?.name, partial.complication ?? partial.outcome ?? "clean").toBe("stakeout");
      expect(phases.some((p) => p.name === "plant")).toBe(false);
      if (partial.complication !== "dud" && partial.complication !== "rain") {
        expect(phases.some((p) => p.name === "detonate")).toBe(true);
      }
    }
    for (const partial of [{ complication: "cop_on_fender" as const }, { markAbsent: true }]) {
      const phases = timelineFor("car_bomb", result(partial), "ours");
      expect(phases[0]?.name).toBe("plant");
      expect(phases.some((p) => p.name === "detonate")).toBe(false);
      expect(phases.some((p) => p.name === "stakeout")).toBe(false);
    }
  });

  it("plays a witnessed reel as only the last two beats", () => {
    for (const approach of APPROACHES) {
      const full = timelineFor(approach, result(), "ours");
      const seen = timelineFor(approach, result(), "witnessed");
      expect(seen.map((p) => p.name)).toEqual(full.slice(-2).map((p) => p.name));
      expect(totalDuration(seen)).toBeLessThan(totalDuration(full));
    }
  });

  it("eases into and out of slow motion", () => {
    const phase: PhaseDef = {
      name: "spray",
      duration: 3,
      caption: "execution",
      label: "The spray",
      scale: [
        { at: 0, scale: 1 },
        { at: 0.3, scale: 1 },
        { at: 0.36, scale: 0.3 },
        { at: 0.5, scale: 0.3 },
        { at: 0.58, scale: 1 },
      ],
    };
    expect(scaleAt(phase, 0)).toBe(1);
    expect(scaleAt(phase, 0.36)).toBeCloseTo(0.3, 5);
    expect(scaleAt(phase, 0.45)).toBeCloseTo(0.3, 5);
    expect(scaleAt(phase, 1)).toBe(1);
    const mid = scaleAt(phase, 0.33);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(1);
  });
});

describe("shot lists", () => {
  it("covers every beat of every hit reel", () => {
    for (const approach of APPROACHES) {
      const lists = SHOT_LISTS[approach]!;
      const phases = timelineFor(approach, result(), "ours");
      for (const phase of phases) {
        const shots = lists[phase.name];
        expect(shots, `${approach} ${phase.name}`).toBeTruthy();
        expect(listCovers(shots!)).toBe(true);
      }
    }
  });

  it("covers every car bomb variant, plant and stakeout included", () => {
    const cases: Partial<HitResult>[] = [
      {},
      { complication: "dud" },
      { complication: "cop_on_fender" },
      { markAbsent: true },
    ];
    for (const partial of cases) {
      const phases = timelineFor("car_bomb", result(partial), "ours");
      for (const phase of phases) {
        const shots = CAR_BOMB[phase.name];
        expect(shots, phase.name).toBeTruthy();
        expect(listCovers(shots!)).toBe(true);
      }
    }
  });

  it("covers every sit-down beat", () => {
    for (const [name, shots] of Object.entries(SITDOWN)) {
      expect(listCovers(shots), name).toBe(true);
    }
  });

  it("punches the lens in and back out", () => {
    const spec = {
      id: "punch",
      start: 0,
      end: 1,
      frame: () => ({ pos: new Vector3(), look: new Vector3() }),
      fov: [40, 40] as const,
      punch: { at: 0.2, fov: 18 },
    };
    expect(fovAt(spec, 0)).toBeCloseTo(40, 3);
    expect(fovAt(spec, 0.24)).toBeLessThan(30);
    expect(fovAt(spec, 0.9)).toBeCloseTo(40, 3);
    expect(activeShot([spec], 0.5)?.u).toBeCloseTo(0.5, 5);
  });
});
