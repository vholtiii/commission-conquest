import { describe, expect, it } from "vitest";
import { captureAllowance } from "@/engine/capture";
import type { FamilyName } from "@/types/game";

const quiet = { turn: 4, captureTally: { turn: 4, byFamily: {} }, vendettas: [] as FamilyName[] };

describe("capture allowance", () => {
  it("allows one grab a week, two for Valenti, and a second against a vendetta", () => {
    expect(captureAllowance(quiet, "Moretti").ok).toBe(true);
    expect(captureAllowance(quiet, "Moretti").limit).toBe(1);
    const used = { ...quiet, captureTally: { turn: 4, byFamily: { Moretti: 1 } } };
    expect(captureAllowance(used, "Moretti").ok).toBe(false);
    expect(captureAllowance(quiet, "Valenti").limit).toBe(2);
    const valentiUsed = { ...quiet, captureTally: { turn: 4, byFamily: { Valenti: 1 } } };
    expect(captureAllowance(valentiUsed, "Valenti").ok).toBe(true);
    const vendetta = {
      ...used,
      vendettas: ["Moretti", "Rinaldi"] as FamilyName[],
    };
    const extra = captureAllowance(vendetta, "Moretti", { owner: "Rinaldi", leadershipVacuum: 0 });
    expect(extra.ok).toBe(true);
    expect(extra.bonusReason).toBe("vendetta");
  });
});
