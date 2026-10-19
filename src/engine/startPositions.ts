/**
 * Opening holdings. The map file gives a few families a head start, so each
 * game pools those districts, draws five home seats far enough apart, and
 * deals the rest so the families open within about ten percent of each other.
 */
import type { FamilyName, GameSettings, Territory } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { createRng } from "./rng";
import { lotTier, valueScore } from "./territoryValue";

export interface StartingDeal {
  territories: Territory[];
  homeSeats: Partial<Record<FamilyName, string>>;
}

/** Seats exist only for a game that was dealt at random. Older saves, and classic
 *  games, keep the map's own headquarters. */
export function dealtSeats(state: {
  settings?: Pick<GameSettings, "startMode">;
  homeSeats?: Partial<Record<FamilyName, string>>;
}): Partial<Record<FamilyName, string>> | undefined {
  return state.settings?.startMode === "random" ? state.homeSeats : undefined;
}

function hops(from: string, to: string, adj: Map<string, string[]>): number {
  if (from === to) return 0;
  const dist = new Map<string, number>([[from, 0]]);
  const q = [from];
  while (q.length > 0) {
    const cur = q.shift()!;
    const d = dist.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (dist.has(next)) continue;
      if (next === to) return d + 1;
      dist.set(next, d + 1);
      q.push(next);
    }
  }
  return 99;
}

function pickSeats(candidates: Territory[], adj: Map<string, string[]>, minHops: number, rng: Rng): Territory[] {
  const seats: Territory[] = [];
  for (const c of rng.shuffle(candidates)) {
    if (seats.every((s) => hops(s.id, c.id, adj) >= minHops)) seats.push(c);
    if (seats.length === 5) break;
  }
  return seats;
}

function inBand(pool: Territory[]): Territory[] {
  const built = pool.filter((t) => lotTier(t) === "built");
  const source = built.length >= 5 ? built : pool;
  const scores = source.map(valueScore).sort((a, b) => a - b);
  const mid = scores[Math.floor(scores.length / 2)] ?? 0;
  const band = source.filter((t) => {
    const v = valueScore(t);
    return v >= mid * 0.65 && v <= mid * 1.35;
  });
  return band.length >= 5 ? band : source;
}

/**
 * Redistribute the districts the map marks as owned. Unowned ground stays
 * unowned. The same seed always deals the same city.
 */
export function dealStartingHoldings(territories: Territory[], seed: number): StartingDeal {
  const rng = createRng(seed + 17);
  const pooledIds = new Set(territories.filter((t) => t.owner).map((t) => t.id));
  const cleared = territories.map((t) => (pooledIds.has(t.id) ? { ...t, owner: null } : t));
  const pooled = cleared.filter((t) => pooledIds.has(t.id));
  const adj = new Map(cleared.map((t) => [t.id, t.adjacentTerritories]));
  const candidates = inBand(pooled);

  let seats = pickSeats(candidates, adj, 3, rng);
  if (seats.length < 5) seats = pickSeats(candidates, adj, 2, rng);
  if (seats.length < 5) seats = pickSeats(pooled, adj, 1, rng);
  if (seats.length < 5) seats = rng.shuffle(pooled).slice(0, 5);

  const families = rng.shuffle([...ALL_FAMILY_NAMES]);
  const homeSeats: Partial<Record<FamilyName, string>> = {};
  const ownerOf = new Map<string, FamilyName>();
  seats.forEach((seat, i) => {
    const family = families[i]!;
    homeSeats[family] = seat.id;
    ownerOf.set(seat.id, family);
  });

  const rest = pooled
    .filter((t) => !ownerOf.has(t.id))
    .sort((a, b) => valueScore(b) - valueScore(a) || a.id.localeCompare(b.id));
  let idx = 0;
  let dir = 1;
  for (const t of rest) {
    ownerOf.set(t.id, families[idx]!);
    idx += dir;
    if (idx >= families.length) {
      dir = -1;
      idx = families.length - 1;
    } else if (idx < 0) {
      dir = 1;
      idx = 0;
    }
  }

  const scoreOf = new Map(pooled.map((t) => [t.id, valueScore(t)]));
  const held = (family: FamilyName) =>
    [...ownerOf.entries()].filter(([, f]) => f === family).map(([id]) => id);
  const total = (family: FamilyName) => held(family).reduce((n, id) => n + (scoreOf.get(id) ?? 0), 0);
  const imbalance = () => {
    const totals = families.map(total);
    const max = Math.max(...totals);
    const min = Math.min(...totals);
    const mean = totals.reduce((n, v) => n + v, 0) / totals.length;
    const variance = totals.reduce((n, v) => n + (v - mean) ** 2, 0);
    return { spread: max <= 0 ? 0 : (max - min) / max, variance };
  };
  const spread = () => imbalance().spread;
  const improved = (before: { spread: number; variance: number }, after: { spread: number; variance: number }) =>
    after.spread < before.spread - 0.0001 ||
    (Math.abs(after.spread - before.spread) <= 0.0001 && after.variance < before.variance - 1);
  const movable = (family: FamilyName) =>
    held(family)
      .filter((id) => id !== homeSeats[family])
      .sort((a, b) => (scoreOf.get(a) ?? 0) - (scoreOf.get(b) ?? 0));

  for (let pass = 0; pass < 40 && spread() > 0.1; pass++) {
    const ranked = [...families].sort((a, b) => total(b) - total(a));
    const rich = ranked[0]!;
    let moved = false;
    for (let pi = ranked.length - 1; pi >= 1 && !moved; pi--) {
      const poor = ranked[pi]!;
      for (const gift of movable(rich)) {
        const before = imbalance();
        ownerOf.set(gift, poor);
        if (improved(before, imbalance())) {
          moved = true;
          break;
        }
        ownerOf.set(gift, rich);
      }
    }
    if (moved) continue;
    const poor = ranked[ranked.length - 1]!;
    for (const give of [...movable(rich)].reverse()) {
      for (const take of movable(poor)) {
        if ((scoreOf.get(give) ?? 0) <= (scoreOf.get(take) ?? 0)) continue;
        const before = imbalance();
        ownerOf.set(give, poor);
        ownerOf.set(take, rich);
        if (improved(before, imbalance())) {
          moved = true;
          break;
        }
        ownerOf.set(give, rich);
        ownerOf.set(take, poor);
      }
      if (moved) break;
    }
    if (!moved) break;
  }

  return {
    homeSeats,
    territories: cleared.map((t) => {
      const owner = ownerOf.get(t.id);
      return owner ? { ...t, owner } : t;
    }),
  };
}
