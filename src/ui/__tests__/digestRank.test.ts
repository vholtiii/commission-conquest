import { describe, expect, it } from "vitest";
import { digestTarget, inferTone } from "@/ui/digestRank";
import type { TurnLogEntry } from "@/types/game";

const blocks = [
  { id: "east_village", name: "East Village" },
  { id: "village", name: "Village" },
  { id: "red_hook", name: "Red Hook" },
];

function log(partial: Partial<TurnLogEntry>): TurnLogEntry {
  return { id: "log_x", turn: 4, category: "event", text: "", ...partial };
}

describe("digestTarget", () => {
  it("uses tagged fields first", () => {
    const t = digestTarget(log({ territoryId: "red_hook", tone: "money", text: "East Village" }), blocks);
    expect(t).toEqual({ territoryId: "red_hook", crewId: undefined, tone: "money" });
  });

  it("recovers the block from a raid id", () => {
    const t = digestTarget(log({ id: "log_raid_4_east_village", category: "heat" }), blocks);
    expect(t.territoryId).toBe("east_village");
    expect(t.tone).toBe("warning");
  });

  it("falls back to the longest block name in the text", () => {
    const t = digestTarget(log({ category: "hit", text: "A body turned up in East Village." }), blocks);
    expect(t.territoryId).toBe("east_village");
    expect(t.tone).toBe("violence");
  });

  it("leaves lines with no place unlocated", () => {
    expect(digestTarget(log({ text: "Quiet week." }), blocks).territoryId).toBeUndefined();
  });
});

describe("inferTone", () => {
  it("maps categories to tones", () => {
    expect(inferTone(log({ category: "economy" }))).toBe("money");
    expect(inferTone(log({ id: "log_case_op1", category: "hit" }))).toBe("intel");
    expect(inferTone(log({ id: "log_audit_4_r1", category: "economy" }))).toBe("warning");
  });
});
