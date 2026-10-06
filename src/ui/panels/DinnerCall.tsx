import { useGameStore } from "@/engine/store";
import { canCallDinner, dinnerActive, dinnerWeek } from "@/engine/dinner";
import { Button } from "@/components/ui/button";
import Tip from "@/ui/Tip";

/** The boss calls this. A short house still hosts: he sits first, and the rest stay out. */
export default function DinnerCall() {
  const turn = useGameStore((s) => s.turn);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const familyDinner = useGameStore((s) => s.familyDinner);
  const lastDinnerTurn = useGameStore((s) => s.lastDinnerTurn);
  const mattresses = useGameStore((s) => s.mattresses);
  const operations = useGameStore((s) => s.operations);
  const sitdowns = useGameStore((s) => s.sitdowns);
  const callFamilyDinner = useGameStore((s) => s.callFamilyDinner);
  void turn;
  void crew;
  void territories;
  void lastDinnerTurn;
  void mattresses;
  void operations;
  void sitdowns;

  const snap = useGameStore.getState();
  const active = dinnerActive(snap);
  const gate = canCallDinner(snap);
  const week = dinnerWeek(snap);
  const blockName = territories.find((t) => t.id === familyDinner?.territoryId)?.name ?? "the safehouse";

  if (active) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
        Family dinner — week {week} of 2 · the family is at {blockName}
      </div>
    );
  }

  return (
    <div>
      <Tip
        wrapDisabled
        content={
          gate.ok
            ? `+10 loyalty for everyone who sits. The rackets run thin for two weeks.${gate.reason ? ` ${gate.reason}` : ""}`
            : gate.reason
        }
      >
        <Button
          size="sm"
          variant="secondary"
          className="h-7 w-full text-[11px]"
          disabled={!gate.ok}
          onClick={callFamilyDinner}
        >
          Call a family dinner
        </Button>
      </Tip>
      {gate.reason && <p className="mt-1 text-[10px] text-muted-foreground">{gate.reason}</p>}
    </div>
  );
}
