import { describe, expect, it } from "vitest";
import { cadence, leadTurnsFor, tempoFor } from "@/engine/tempo";

describe("temperament timers", () => {
  it("gives volatile families short deals and economic families long ones", () => {
    expect(tempoFor("volatile").truceWeeks).toBe(4);
    expect(tempoFor("volatile").contractWeeks).toBe(4);
    expect(tempoFor("economic").truceWeeks).toBe(8);
    expect(tempoFor("smuggler").standingSaleWeeks).toBe(8);
    for (const personality of ["economic", "expansionist", "covert", "smuggler", "volatile"] as const) {
      const tempo = tempoFor(personality);
      for (const weeks of [tempo.truceWeeks, tempo.contractWeeks, tempo.messageCooldown, tempo.passageGrudge, tempo.callInCooldown]) {
        expect(weeks).toBeGreaterThanOrEqual(4);
        expect(weeks).toBeLessThanOrEqual(12);
      }
    }
  });

  it("jitters city cadences inside their bands, stable per seed", () => {
    expect(cadence(3, "dinner")).toBe(cadence(3, "dinner"));
    expect(cadence(3, "dinner")).toBeGreaterThanOrEqual(7);
    expect(cadence(3, "dinner")).toBeLessThanOrEqual(10);
    expect(cadence(9, "errand")).toBeGreaterThanOrEqual(6);
    expect(cadence(9, "commission")).toBeLessThanOrEqual(10);
  });

  it("asks for a longer sudden-death streak on a longer game", () => {
    expect(leadTurnsFor("short")).toBe(5);
    expect(leadTurnsFor("medium")).toBe(6);
    expect(leadTurnsFor(undefined)).toBe(6);
    expect(leadTurnsFor("long")).toBe(8);
  });
});
