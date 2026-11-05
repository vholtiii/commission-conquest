import { WARRANT } from "./heat";
import { resolveCrewTerritoryId } from "./crewLocation";
import type { GameState, Territory } from "@/types/game";

/** One line about what is wrong on this block. */
export function streetTalk(
  state: Pick<GameState, "playerFamily" | "crew" | "territories" | "heat" | "supplyRoutes" | "turn" | "routes" | "operations">,
  territory: Territory,
): string | null {
  const family = state.playerFamily;
  if (!family || territory.owner !== family) return null;

  const heat = state.heat?.level ?? 0;
  if (heat >= WARRANT.heatFloor) {
    const loc = {
      crew: state.crew,
      territories: state.territories,
      routes: state.routes,
      operations: state.operations,
      playerFamily: family,
      turn: state.turn,
    };
    const marked = state.crew.find(
      (c) =>
        c.family === family &&
        c.status !== "dead" &&
        c.wanted > WARRANT.wantedFloor &&
        resolveCrewTerritoryId(loc, c.id) === territory.id,
    );
    if (marked) return `${marked.name} is wanted past the line in ${territory.name}.`;
  }

  const routes = (state.supplyRoutes ?? []).filter(
    (r) =>
      r.family === family &&
      (r.sourceTerritoryId === territory.id ||
        r.destTerritoryId === territory.id ||
        r.path.includes(territory.id)),
  );
  const hijacked = routes.find((r) => r.last?.outcome === "hijacked");
  if (hijacked) return `They took the truck out of ${territory.name}.`;
  const dryTruck = routes.find((r) => r.last?.outcome === "no_stock");
  if (dryTruck) return `${territory.name} — the truck never left the warehouse.`;

  const dryBar = territory.rackets.some((r) => r.type === "speakeasy" && r.stock === 0);
  const cooker = territory.rackets.some((r) => r.type === "still" || r.type === "brewery");
  if (dryBar && cooker) return `${territory.name} poured water; the still out back was late.`;

  return null;
}
