import { useGameStore } from "@/engine/store";
import { onboardingGoals } from "@/engine/onboarding";
import PortraitAvatar from "./PortraitAvatar";

export default function GoalsCard() {
  const turn = useGameStore((s) => s.turn);
  const dismissed = useGameStore((s) => s.onboardingDismissed);
  const state = useGameStore((s) => s);
  const setPanel = useGameStore((s) => s.setPanel);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const dismiss = useGameStore((s) => s.dismissOnboarding);
  const note = useGameStore((s) => s.consigliereNote);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);

  if (turn <= 10) {
    if (dismissed) return null;
    const goals = onboardingGoals(state);
    if (goals.length === 0 || goals.every((g) => g.done)) return null;
    return (
      <div className="pointer-events-auto absolute left-3 top-3 z-30 w-64 rounded-lg border border-panel-border bg-panel/95 p-3 shadow-lg backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-display text-sm text-steel-light">First weeks</h2>
          <button type="button" className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground" onClick={dismiss}>
            Dismiss
          </button>
        </div>
        <ul className="space-y-1.5">
          {goals.map((goal) => (
            <li key={goal.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className={goal.done ? "text-muted-foreground line-through" : "text-foreground"}>{goal.label}</span>
              {!goal.done && (
                <button
                  type="button"
                  className="shrink-0 rounded border border-panel-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-panel-elevated"
                  onClick={() => {
                    if (goal.action.kind === "territory") selectTerritory(goal.action.territoryId);
                    else setPanel(goal.action.panel);
                  }}
                >
                  Show me
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!note) return null;
  const consigliere = crew.find(
    (c) => c.family === playerFamily && c.role === "consigliere" && c.status === "active",
  );

  return (
    <div className="pointer-events-auto absolute left-3 top-3 z-30 w-64 rounded-lg border border-panel-border bg-panel/95 p-3 shadow-lg backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-2">
        {consigliere && (
          <PortraitAvatar
            seed={consigliere.portraitSeed}
            size={28}
            role={consigliere.role}
            family={consigliere.family}
            alt={consigliere.name}
          />
        )}
        <h2 className="font-display text-sm text-steel-light">
          {consigliere?.name ?? "Consigliere"}
        </h2>
      </div>
      <p className="text-[11px] text-foreground">{note.line}</p>
      {note.kind !== "absent" && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">+2 Respect · this week</span>
          {note.show && (
            <button
              type="button"
              className="shrink-0 rounded border border-panel-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-panel-elevated"
              onClick={() => {
                if (note.show === "crew" && note.crewId) selectCrew(note.crewId);
                else if (note.show === "corruption" || note.show === "commission") setPanel(note.show);
              }}
            >
              Show me
            </button>
          )}
        </div>
      )}
    </div>
  );
}
