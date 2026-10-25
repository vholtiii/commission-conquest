import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { getFamilyDef } from "@/data/families";
import { FAMILY_HEX, type FamilyName, type GameState } from "@/types/game";
import { mindOf, rivalFamilies } from "@/engine/ai/minds";
import { grievance } from "@/engine/ai/aiMemory";
import { blockBelief, believedGarrison, liveGarrison } from "@/engine/ai/aiBeliefs";
import { activeRivalPacts } from "@/engine/ai/rivalPacts";

/** `?aidebug` turns the setting on once, then leaves the URL so the toggle stays in charge. */
function consumeDebugFlag(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("aidebug")) return false;
  url.searchParams.delete("aidebug");
  window.history.replaceState(window.history.state, "", url.toString());
  return true;
}

function seenLabel(state: GameState, family: FamilyName, territoryId: string): string {
  const b = blockBelief(state, family, territoryId);
  if (!b) return "never seen";
  const age = state.turn - b.seen;
  return age <= 0 ? "seen this week" : `seen ${age}w ago`;
}

/** Developer view of what each rival family is thinking. Read-only. */
export default function AiDebugPanel() {
  const show = useGameStore((s) => !!s.settings.showAiThinking);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const state = useGameStore() as GameState;
  const [open, setOpen] = useState<FamilyName | null>(null);
  useEffect(() => {
    if (consumeDebugFlag()) updateSettings({ showAiThinking: true });
  }, [updateSettings]);
  if (!show) return null;
  if (!state.playerFamily) return null;

  const trace = state.aiTrace;
  const selected = state.territories.find((t) => t.id === state.selectedTerritoryId);
  const families = rivalFamilies(state).filter((f) => !(state.defunctFamilies ?? []).includes(f));
  const pacts = activeRivalPacts(state);

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-40 max-h-[60vh] w-80 overflow-y-auto rounded-md border border-panel-border bg-panel/95 p-2 text-[11px] font-ui shadow-lg backdrop-blur-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Rival thinking {trace ? `· week ${trace.turn} · ${trace.ms.toFixed(1)} ms` : ""}
        </span>
        <button
          type="button"
          aria-label="Hide rival thinking"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => updateSettings({ showAiThinking: false })}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {state.settings.aiBrain === "classic" && (
        <p className="mb-1 text-muted-foreground">Classic AI is on: families are not planning.</p>
      )}
      <ul className="space-y-1">
        {families.map((f) => {
          const mind = mindOf(state, f);
          const t = trace?.families?.[f];
          const goal = mind.goal;
          const grudges = families
            .concat(state.playerFamily ? [state.playerFamily] : [])
            .filter((o) => o !== f)
            .map((o) => ({ o, g: grievance(mind, o, state.turn, getFamilyDef(f).personality), trust: mind.trust[o] ?? 0 }))
            .filter((x) => x.g > 0.2 || Math.abs(x.trust) >= 5)
            .sort((a, b) => b.g - a.g);
          const expanded = open === f;
          return (
            <li key={f} className="rounded border border-panel-border/60 bg-background/40 px-2 py-1">
              <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setOpen(expanded ? null : f)}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: FAMILY_HEX[f] }} />
                <span className="font-semibold">{f}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {goal ? `${goal.kind.replace("_", " ")}${goal.target ? ` → ${goal.target}` : ""}` : "no goal"}
                  {goal ? ` (step ${goal.step}, fails ${goal.failures})` : ""}
                </span>
              </button>
              {t?.goalReason && <div className="mt-0.5 text-muted-foreground">{t.goalReason}</div>}
              {t && t.chosen.length > 0 && <div className="mt-0.5">Did: {t.chosen.join("; ")}</div>}
              {expanded && (
                <div className="mt-1 space-y-1 border-t border-panel-border/60 pt-1">
                  {(t?.options ?? []).map((o) => (
                    <div key={o.action}>
                      <span className="font-mono">{o.score.toFixed(2)}</span> {o.action}
                      <span className="text-muted-foreground"> — {o.reasons.join(", ")}</span>
                    </div>
                  ))}
                  {grudges.length > 0 && (
                    <div className="text-muted-foreground">
                      {grudges.map((x) => `${x.o}: grudge ${x.g.toFixed(1)}, trust ${Math.round(x.trust)}`).join(" · ")}
                    </div>
                  )}
                  <div className="text-muted-foreground">
                    {mind.memories.length} memories · scouts {mind.stats.scouts} · switches {mind.stats.goalSwitches} · border floor{" "}
                    {mind.adapt.minBorder || 1}
                  </div>
                  {selected && selected.owner !== f && (
                    <div>
                      {selected.name}: believes {believedGarrison(state, f, selected).toFixed(1)} men, really {liveGarrison(state, selected)}
                      <span className="text-muted-foreground">
                        {" "}
                        ({seenLabel(state, f, selected.id)})
                      </span>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {pacts.length > 0 && (
        <div className="mt-1.5 border-t border-panel-border pt-1 text-muted-foreground">
          {pacts.map((p) => `${p.a}–${p.b} ${p.kind}${p.target ? ` vs ${p.target}` : ""} (${p.until - state.turn}w)`).join(" · ")}
        </div>
      )}
    </div>
  );
}
