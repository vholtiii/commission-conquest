import { describe, expect, it } from "vitest";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { BOROUGH_ORDER } from "@/data/boroughs";
import { getCityLayout } from "@/engine/cityLayout";
import { alignTerritoriesToMap, buildInitialState } from "@/engine/initialState";
import { districtCount, mapDims, type MapSize } from "@/engine/mapSize";
import { valueScore } from "@/engine/territoryValue";
import type { Territory } from "@/types/game";

function components(territories: Territory[]): number {
  const adj = new Map(territories.map((t) => [t.id, t.adjacentTerritories]));
  const seen = new Set<string>();
  let count = 0;
  for (const t of territories) {
    if (seen.has(t.id)) continue;
    count += 1;
    const stack = [t.id];
    seen.add(t.id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return count;
}

function expectConnectedCity(size: MapSize, districts: number) {
  const game = buildInitialState(11, { mapSize: size, startMode: "classic" });
  expect(game.territories).toHaveLength(districts);
  expect(districtCount(size)).toBe(districts);
  expect(game.settings.mapSize).toBe(size);
  const ids = new Set(game.territories.map((t) => t.id));
  expect(ids.size).toBe(districts);
  for (const t of game.territories) {
    for (const id of t.adjacentTerritories) {
      expect(ids.has(id), `${t.id} borders a missing district`).toBe(true);
      const other = game.territories.find((row) => row.id === id);
      expect(other?.adjacentTerritories, `${id} does not border ${t.id}`).toContain(t.id);
    }
  }
  expect(components(game.territories)).toBe(1);
  for (const borough of BOROUGH_ORDER) {
    expect(game.territories.some((t) => t.borough === borough), borough).toBe(true);
  }
  const layout = getCityLayout(game.territories, game.seed, mapDims(size));
  const dims = mapDims(size);
  expect(layout.gridW).toBe(dims.w);
  expect(layout.gridH).toBe(dims.h);
  for (const t of game.territories) {
    const land = layout.blocks.filter((b) => b.territoryId === t.id && b.kind !== "water").length;
    expect(land, `${t.id} has no land`).toBeGreaterThan(0);
    if (!t.emptyLot) expect(t.buildingBlocks, t.id).toBeGreaterThan(0);
  }
  const round = alignTerritoriesToMap(JSON.parse(JSON.stringify(game.territories)) as Territory[], size);
  expect(round.map((t) => [t.id, t.x, t.y])).toEqual(game.territories.map((t) => [t.id, t.x, t.y]));
  return game;
}

describe("map size", () => {
  it("keeps the normal map on its file coordinates", () => {
    const game = expectConnectedCity("normal", 57);
    expect(game.settings.startMode).toBe("classic");
    expect(game.homeSeats).toBeUndefined();
    const manhattan = game.territories.find((t) => t.id === "manhattan");
    expect(manhattan).toMatchObject({ x: 35, y: 45 });
  });

  it("shrinks the city to the central districts", () => {
    const game = expectConnectedCity("small", 36);
    expect(game.settings.startMode).toBe("random");
    expect(game.territories.some((t) => t.id === "jfk_airport")).toBe(false);
    expect(game.territories.some((t) => t.id === "manhattan")).toBe(true);
  });

  it("adds the outer towns around the old city", () => {
    const game = expectConnectedCity("large", 75);
    expect(game.settings.startMode).toBe("random");
    const manhattan = game.territories.find((t) => t.id === "manhattan");
    expect(manhattan?.x).toBeCloseTo(37.1);
    expect(manhattan?.y).toBeCloseTo(45.7);
    expect(game.territories.some((t) => t.id === "fort_lee")).toBe(true);
    expect(game.territories.find((t) => t.id === "fort_lee")?.owner).toBeNull();
  });

  it("deals five home seats on a small or large map", () => {
    for (const size of ["small", "large"] as const) {
      for (const seed of [11, 29, 47, 83]) {
        const game = buildInitialState(seed, { mapSize: size, startMode: "classic" });
        const seats = ALL_FAMILY_NAMES.map((name) => game.homeSeats?.[name]);
        expect(new Set(seats).size, `${size} seed ${seed}`).toBe(5);
        for (const name of ALL_FAMILY_NAMES) {
          const seat = game.territories.find((t) => t.id === game.homeSeats?.[name]);
          expect(seat?.owner, `${size} ${name} seed ${seed}`).toBe(name);
        }
        const totals = ALL_FAMILY_NAMES.map((name) =>
          game.territories.filter((t) => t.owner === name).reduce((n, t) => n + valueScore(t), 0),
        );
        const max = Math.max(...totals);
        const min = Math.min(...totals);
        expect((max - min) / max, `${size} seed ${seed}`).toBeLessThanOrEqual(0.15);
      }
    }
  });
});
