import { describe, expect, it } from "vitest";
import { getCityLayout } from "@/engine/cityLayout";
import { buildInitialState } from "@/engine/initialState";
import { districtAnchor, streetRoute, streetRouteCells } from "@/engine/streetRoute";

const PATH = ["little_italy", "manhattan", "west_village"] as const;

function cellAt(
  layout: ReturnType<typeof getCityLayout>,
  gx: number,
  gz: number,
) {
  return layout.blocks.find((b) => b.gx === gx && b.gz === gz);
}

describe("streetRoute", () => {
  it("walks the streets between district anchors on the normal map", () => {
    const game = buildInitialState(11, { startMode: "classic" });
    const layout = getCityLayout(game.territories, game.seed);
    const anchors = PATH.map((id) => {
      const a = districtAnchor(layout, id);
      expect(a, id).toBeTruthy();
      return a!;
    });

    const cells = streetRouteCells(layout, [...PATH]);
    expect(cells.length).toBeGreaterThanOrEqual(PATH.length);

    for (const anchor of anchors) {
      expect(
        cells.some((c) => c.gx === anchor.gx && c.gz === anchor.gz),
        `path misses ${anchor.territoryId} at ${anchor.gx},${anchor.gz}`,
      ).toBe(true);
    }

    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i]!;
      const b = cells[i + 1]!;
      expect(a.gx === b.gx || a.gz === b.gz, `${a.gx},${a.gz} to ${b.gx},${b.gz} is diagonal`).toBe(
        true,
      );
      const dx = Math.sign(b.gx - a.gx);
      const dz = Math.sign(b.gz - a.gz);
      const steps = Math.abs(b.gx - a.gx) + Math.abs(b.gz - a.gz);
      expect(steps).toBeGreaterThan(0);
      for (let s = 0; s <= steps; s++) {
        const gx = a.gx + dx * s;
        const gz = a.gz + dz * s;
        const cell = cellAt(layout, gx, gz);
        expect(cell, `missing ${gx},${gz}`).toBeTruthy();
        const onEnd = (gx === a.gx && gz === a.gz) || (gx === b.gx && gz === b.gz);
        if (onEnd) expect(cell!.kind).toBe("road");
        else expect(["road", "water"]).toContain(cell!.kind);
      }
    }

    const points = streetRoute(layout, [...PATH]);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.x).toBeCloseTo(anchors[0]!.worldX, 5);
    expect(points[0]!.z).toBeCloseTo(anchors[0]!.worldZ, 5);
    expect(points[points.length - 1]!.x).toBeCloseTo(anchors[anchors.length - 1]!.worldX, 5);
    expect(points[points.length - 1]!.z).toBeCloseTo(anchors[anchors.length - 1]!.worldZ, 5);

    for (const anchor of anchors) {
      const near = points.some(
        (p) => Math.hypot(p.x - anchor.worldX, p.z - anchor.worldZ) < 0.05,
      );
      expect(near, `polyline misses anchor ${anchor.territoryId}`).toBe(true);
    }

    for (let i = 0; i < points.length - 1; i++) {
      const dx = Math.abs(points[i + 1]!.x - points[i]!.x);
      const dz = Math.abs(points[i + 1]!.z - points[i]!.z);
      const aligned = dx < 0.05 || dz < 0.05;
      const chord = Math.hypot(dx, dz);
      expect(aligned || chord < 0.55, `long diagonal ${dx.toFixed(2)},${dz.toFixed(2)}`).toBe(true);
    }
  });

  it("traces a standing liquor road through a third district", () => {
    const game = buildInitialState(11, { startMode: "classic" });
    const layout = getCityLayout(game.territories, game.seed);
    const path = ["east_village", "park_slope", "manhattan"];
    const cells = streetRouteCells(layout, path);
    expect(cells.length).toBeGreaterThanOrEqual(path.length);
    for (const id of path) {
      const anchor = districtAnchor(layout, id)!;
      expect(cells.some((c) => c.gx === anchor.gx && c.gz === anchor.gz), id).toBe(true);
    }
    expect(streetRoute(layout, path).length).toBeGreaterThan(2);
  });
});
