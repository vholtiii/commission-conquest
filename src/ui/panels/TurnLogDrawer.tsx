import { useGameStore } from "@/engine/store";
import { FAMILY_HEX } from "@/types/game";
import { CATEGORY_COLOR } from "../logColors";
import PanelShell from "./PanelShell";

export default function TurnLogDrawer() {
  const turnLog = useGameStore((s) => s.turnLog);
  const entries = [...turnLog].slice(-100).reverse();

  return (
    <PanelShell title="Turn Log" subtitle="Recent events" width="w-[420px]">
      <div className="space-y-1.5">
        {entries.map((e) => (
          <div key={e.id} className="flex gap-2 rounded px-1.5 py-1 text-xs hover:bg-panel-elevated">
            <span className="w-8 shrink-0 text-[10px] text-muted-foreground">T{e.turn}</span>
            {e.family && (
              <span
                className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: FAMILY_HEX[e.family] }}
              />
            )}
            <span className={CATEGORY_COLOR[e.category] ?? "text-foreground"}>{e.text}</span>
          </div>
        ))}
        {entries.length === 0 && <p className="text-xs text-muted-foreground">No events yet.</p>}
      </div>
    </PanelShell>
  );
}
