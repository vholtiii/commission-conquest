import { hasManagedWarehouse, makeManagerLookup } from "./liquor";
import type { FamilyName, GameState, PanelId } from "@/types/game";

export type OnboardingAction =
  | { kind: "panel"; panel: PanelId }
  | { kind: "territory"; territoryId: string };

export interface OnboardingGoal {
  id: string;
  label: string;
  done: boolean;
  action: OnboardingAction;
}

function rivalBlock(state: GameState, family: FamilyName): string | null {
  const mine = new Set(state.territories.filter((t) => t.owner === family).map((t) => t.id));
  for (const t of state.territories) {
    if (t.owner === family || !t.owner) continue;
    if (t.adjacentTerritories.some((id) => mine.has(id))) return t.id;
  }
  return state.territories.find((t) => t.owner && t.owner !== family)?.id ?? null;
}

/** First-weeks checklist. Done is read off the city, never stored. */
export function onboardingGoals(state: GameState): OnboardingGoal[] {
  const family = state.playerFamily;
  if (!family) return [];
  const mine = state.territories.filter((t) => t.owner === family);
  const home = mine[0];
  const lookup = makeManagerLookup(state.crew, family);
  const lookout = rivalBlock(state, family);
  return [
    {
      id: "manager",
      label: "Put a manager on a racket",
      done: mine.some((t) => t.rackets.some((r) => !!r.managerId)),
      action: { kind: "panel", panel: "crew" },
    },
    {
      id: "build",
      label: "Build a racket",
      done: mine.some((t) => t.rackets.some((r) => (r.builtTurn ?? 0) > 0)),
      action: home ? { kind: "territory", territoryId: home.id } : { kind: "panel", panel: "racket_build" },
    },
    {
      id: "lookout",
      label: "Send a lookout to a rival block",
      done: Object.keys(state.intel?.reports ?? {}).length > 0,
      action: lookout ? { kind: "territory", territoryId: lookout } : { kind: "panel", panel: "operations" },
    },
    {
      id: "warehouse",
      label: "Build and manage a warehouse",
      done: mine.some((t) => hasManagedWarehouse(t, lookup, state.turn)),
      action: { kind: "panel", panel: "warehouse" },
    },
    {
      id: "route",
      label: "Open a supply route",
      done: (state.supplyRoutes?.length ?? 0) > 0,
      action: { kind: "panel", panel: "warehouse" },
    },
    {
      id: "laundry",
      label: "Set up a laundering site",
      done: Object.values(state.launderPlan ?? {}).some((n) => n > 0),
      action: { kind: "panel", panel: "laundering" },
    },
  ];
}
