import { useState } from "react";
import { Save, FolderOpen, RotateCcw } from "lucide-react";
import { useGameStore } from "@/engine/store";
import type { GameSettings } from "@/types/game";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import PanelShell from "./PanelShell";

const SLOTS = [1, 2, 3];

export default function MenuPanel() {
  const saveSlot = useGameStore((s) => s.saveSlot);
  const loadSlot = useGameStore((s) => s.loadSlot);
  const newGame = useGameStore((s) => s.newGame);
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const [difficulty, setDifficulty] = useState<GameSettings["difficulty"]>(settings.difficulty);

  return (
    <PanelShell title="Menu" subtitle="Save, load, or start over">
      <div className="space-y-5">
        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Save Slots</h3>
          <div className="space-y-1.5">
            {SLOTS.map((slot) => (
              <div
                key={slot}
                className="flex items-center justify-between rounded-md border border-panel-border bg-panel/50 px-3 py-2"
              >
                <span className="text-sm">Slot {slot}</span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-[11px]" onClick={() => saveSlot(slot)}>
                    <Save className="h-3 w-3" /> Save
                  </Button>
                  <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-[11px]" onClick={() => loadSlot(slot)}>
                    <FolderOpen className="h-3 w-3" /> Load
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Playback</h3>
          <label className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={!!settings.skipCinematics}
              onCheckedChange={(v) => updateSettings({ skipCinematics: !!v })}
            />
            Skip hit cinematics
          </label>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">New Game</h3>
          <div className="flex gap-1.5">
            {(["easy", "normal", "hard"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs capitalize ${
                  difficulty === d
                    ? "border-steel bg-steel/20 text-steel-light"
                    : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <Button
            className="mt-2 w-full gap-2 bg-heat font-ui font-bold uppercase hover:bg-heat/80"
            onClick={() => newGame({ difficulty })}
          >
            <RotateCcw className="h-4 w-4" /> Start New Game
          </Button>
        </div>
      </div>
    </PanelShell>
  );
}
