import type { LucideIcon } from "lucide-react";
import {
  Users,
  Warehouse,
  Crosshair,
  HandCoins,
  Scale,
  ScrollText,
  Menu as MenuIcon,
  Map,
  Banknote,
  Wine,
} from "lucide-react";
import type { PanelId } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { useMapView } from "@/engine/mapView";
import { cn } from "@/lib/utils";

interface ToolbarItem {
  id: PanelId;
  label: string;
  icon: LucideIcon;
}

const ITEMS: ToolbarItem[] = [
  { id: "crew", label: "Crew", icon: Users },
  { id: "rackets", label: "Rackets", icon: Warehouse },
  { id: "laundering", label: "Launder", icon: Banknote },
  { id: "warehouse", label: "Liquor", icon: Wine },
  { id: "operations", label: "Operations", icon: Crosshair },
  { id: "corruption", label: "Corruption", icon: HandCoins },
  { id: "commission", label: "Commission", icon: Scale },
  { id: "log", label: "Log", icon: ScrollText },
];

export default function LeftToolbar() {
  const activePanel = useGameStore((s) => s.activePanel);
  const setPanel = useGameStore((s) => s.setPanel);
  const overview = useMapView((s) => s.overview);
  const requestOverview = useMapView((s) => s.requestOverview);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const launderPlan = useGameStore((s) => s.launderPlan ?? {});
  const planned = Object.values(launderPlan).reduce((a, b) => a + b, 0);
  const nudge = dirtyMoney >= 1000 && planned <= 0;

  return (
    <nav className="panel-surface scrollbar-thin flex h-full min-h-0 w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain border-r py-3">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = activePanel === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setPanel(active ? "none" : item.id)}
            title={item.label}
            className={cn(
              "relative flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] uppercase tracking-wide transition-colors",
              active
                ? "bg-steel/20 text-steel-light ring-1 ring-steel/50"
                : "text-muted-foreground hover:bg-panel-elevated hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
            {item.id === "laundering" && nudge && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            )}
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={() => requestOverview()}
          title="Overview"
          className={cn(
            "flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] uppercase tracking-wide transition-colors",
            overview
              ? "bg-steel/20 text-steel-light ring-1 ring-steel/50"
              : "text-muted-foreground hover:bg-panel-elevated hover:text-foreground",
          )}
        >
          <Map className="h-4 w-4" />
          Overview
        </button>
        <button
          type="button"
          onClick={() => setPanel(activePanel === "menu" ? "none" : "menu")}
          title="Menu"
          className={cn(
            "flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] uppercase tracking-wide transition-colors",
            activePanel === "menu"
              ? "bg-steel/20 text-steel-light ring-1 ring-steel/50"
              : "text-muted-foreground hover:bg-panel-elevated hover:text-foreground",
          )}
        >
          <MenuIcon className="h-4 w-4" />
          Menu
        </button>
      </div>
    </nav>
  );
}
