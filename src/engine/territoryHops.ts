import type { GameState } from "@/types/game";

/** Blocks between two districts, along adjacent streets. */
export function territoryHops(
  state: Pick<GameState, "territories">,
  originId: string | undefined,
  targetId: string,
): number {
  if (!originId || originId === targetId) return 0;
  const byId = new Map(state.territories.map((t) => [t.id, t]));
  if (!byId.has(originId) || !byId.has(targetId)) return 4;
  const queue: { id: string; dist: number }[] = [{ id: originId, dist: 0 }];
  const seen = new Set<string>([originId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = byId.get(cur.id);
    if (!node) continue;
    for (const adj of node.adjacentTerritories) {
      if (seen.has(adj)) continue;
      if (adj === targetId) return cur.dist + 1;
      seen.add(adj);
      queue.push({ id: adj, dist: cur.dist + 1 });
    }
  }
  return 5;
}
