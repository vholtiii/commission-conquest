import { describe, expect, it } from "vitest";
import { buildInitialState } from "@/engine/initialState";
import { getCityLayout, waterfrontScores } from "@/engine/cityLayout";
import { placementBonus } from "@/engine/districtFeatures";

describe("district features", () => {
  it("puts docks on blocks that touch water", () => {
    const game = buildInitialState(11, { startMode: "classic" });
    const docks = game.territories.filter((t) => t.feature === "docks");
    expect(docks.length).toBeGreaterThanOrEqual(6);
    expect(docks.length).toBeLessThanOrEqual(7);
    const scores = waterfrontScores(getCityLayout(game.territories, 11));
    for (const district of docks) {
      expect(scores.get(district.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it("pays a downtown gambling den more when a speakeasy shares the block", () => {
    const gambling = { type: "gambling" as const };
    const bonus = placementBonus({ feature: "downtown" }, gambling, [gambling, { type: "speakeasy" }]);
    expect(bonus.mult).toBeCloseTo(1.2 * 1.15);
    expect(bonus.reasons.join(" ")).toContain("downtown");
    expect(bonus.reasons.join(" ")).toContain("Speakeasy");
  });

  it("keeps one pairing, so a speakeasy next to both picks gambling", () => {
    const bar = { type: "speakeasy" as const };
    const bonus = placementBonus({ feature: "residential" }, bar, [bar, { type: "gambling" }, { type: "warehouse" }]);
    expect(bonus.mult).toBeCloseTo(1.15);
    expect(bonus.reasons.filter((r) => r.includes("+15%"))).toHaveLength(1);
  });
});
