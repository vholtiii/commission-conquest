import type { TurnLogEntry } from "@/types/game";

export const CATEGORY_COLOR: Record<TurnLogEntry["category"], string> = {
  hit: "text-heat",
  ai: "text-steel-light",
  economy: "text-money",
  heat: "text-heat",
  event: "text-purple-300",
  combat: "text-heat",
  delivery: "text-emerald-400",
  diplomacy: "text-sky-300",
  system: "text-muted-foreground",
};
