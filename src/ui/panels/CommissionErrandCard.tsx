import { useState } from "react";
import { useGameStore } from "@/engine/store";
import {
  ERRAND_APPROACH_HEAT,
  errandOfferWarning,
  canWorkErrand,
  hotHighRanks,
} from "@/engine/commissionErrand";
import { WARRANT } from "@/engine/heat";
import { Button } from "@/components/ui/button";

const SELECT = "w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1.5 text-xs";

export default function CommissionErrandCard() {
  const errand = useGameStore((s) => s.commissionErrand);
  const turn = useGameStore((s) => s.turn);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const operations = useGameStore((s) => s.operations);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const heat = useGameStore((s) => s.heat.level);
  const accept = useGameStore((s) => s.acceptCommissionErrand);
  const decline = useGameStore((s) => s.declineCommissionErrand);
  const caseLead = useGameStore((s) => s.caseCommissionErrand);
  const orderHit = useGameStore((s) => s.orderCommissionHit);
  const warning = useGameStore(errandOfferWarning);

  const [lookout, setLookout] = useState("");
  const [approach, setApproach] = useState<"ambush" | "drive_by" | "car_bomb">("ambush");
  const [shooter, setShooter] = useState("");
  const [wheelman, setWheelman] = useState("");
  const [maker, setMaker] = useState("");
  const [planter, setPlanter] = useState("");

  if (!errand || !playerFamily) return null;

  const place = (id: string | undefined) => territories.find((t) => t.id === id)?.name ?? "a block";
  const able = crew.filter((c) => c.family === playerFamily && canWorkErrand(c, operations));
  const options = (skip: string[]) => able.filter((c) => !skip.includes(c.id));

  if (errand.phase === "offered") {
    const who =
      errand.kind === "family" && errand.markFamily
        ? `One of the ${errand.markFamily}, gone to ground.`
        : "A gangster from another city, hiding in this one.";
    return (
      <section className="rounded-md border border-panel-border bg-panel/50 px-3 py-2">
        <h3 className="text-[11px] uppercase tracking-wide text-steel-light">The table asks</h3>
        <p className="mt-1 text-xs">{who}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {turn <= errand.openedTurn ? "On the table this week and next." : "Last week to take it."}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">{warning}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="h-7 text-xs" onClick={() => accept()}>
            Accept
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => decline()}>
            Decline
          </Button>
        </div>
      </section>
    );
  }

  if (errand.phase === "rival") {
    const left = Math.max(0, (errand.untilTurn ?? turn) - turn);
    return (
      <section className="rounded-md border border-panel-border bg-panel/50 px-3 py-2">
        <h3 className="text-[11px] uppercase tracking-wide text-steel-light">The table asked elsewhere</h3>
        <p className="mt-1 text-xs">
          The {errand.carrier} took the job on {errand.targetName}. {left === 0 ? "This is their last week." : `${left} weeks left.`}
        </p>
      </section>
    );
  }

  const left = Math.max(0, (errand.untilTurn ?? turn) - turn);
  const lead = place(errand.path[errand.leadIndex]);
  const hideout = place(errand.path[errand.path.length - 1]);
  const added = ERRAND_APPROACH_HEAT[approach];
  const hot =
    heat + added >= WARRANT.heatFloor
      ? hotHighRanks(crew, playerFamily)
      : [];

  const send = () => {
    orderHit({
      approach,
      shooterIds: shooter ? [shooter] : [],
      wheelmanId: approach === "drive_by" ? wheelman || undefined : undefined,
      bombMakerId: approach === "car_bomb" ? maker || undefined : undefined,
      planterId: approach === "car_bomb" ? planter || undefined : undefined,
    });
  };

  return (
    <section className="rounded-md border border-panel-border bg-panel/50 px-3 py-2">
      <h3 className="text-[11px] uppercase tracking-wide text-steel-light">The table's man</h3>
      <p className="mt-1 text-xs">
        {errand.targetName}
        {errand.markFamily ? `, ${errand.markFamily}` : ", from out of town"}. {errand.detail}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {left === 0 ? "Last week." : `${left} week${left === 1 ? "" : "s"} left.`}{" "}
        {errand.found ? `He is in ${hideout}.` : `The lead is ${lead}.`}
      </p>
      {errand.report && <p className="mt-1 text-[11px]">{errand.report}</p>}

      {!errand.found && (
        <div className="mt-2 space-y-1.5">
          <select className={SELECT} value={lookout} onChange={(e) => setLookout(e.target.value)}>
            <option value="">Who cases {lead}</option>
            {able.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" className="h-7 text-xs" disabled={!lookout || left <= 0} onClick={() => caseLead(lookout)}>
            Case {lead}
          </Button>
          {left <= 0 && (
            <p className="text-[11px] text-muted-foreground">A report would come back after the seven weeks.</p>
          )}
        </div>
      )}

      {errand.found && (
        <div className="mt-2 space-y-1.5">
          <select
            className={SELECT}
            value={approach}
            onChange={(e) => setApproach(e.target.value as "ambush" | "drive_by" | "car_bomb")}
          >
            <option value="ambush">Ambush · 8 heat</option>
            <option value="drive_by">Drive-by · 12 heat</option>
            <option value="car_bomb">Car bomb · 20 heat</option>
          </select>
          {(approach === "ambush" || approach === "drive_by") && (
            <select className={SELECT} value={shooter} onChange={(e) => setShooter(e.target.value)}>
              <option value="">Shooter</option>
              {options([wheelman]).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {approach === "drive_by" && (
            <select className={SELECT} value={wheelman} onChange={(e) => setWheelman(e.target.value)}>
              <option value="">Wheelman</option>
              {options([shooter]).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {approach === "car_bomb" && (
            <>
              <select className={SELECT} value={maker} onChange={(e) => setMaker(e.target.value)}>
                <option value="">Bomb maker</option>
                {options([planter]).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select className={SELECT} value={planter} onChange={(e) => setPlanter(e.target.value)}>
                <option value="">Planter</option>
                {options([maker]).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {hot.length > 0 && (
            <p className="text-[11px] text-heat">
              {hot.map((c) => c.name).join(", ")} {hot.length === 1 ? "is" : "are"} already wanted past{" "}
              {WARRANT.wantedFloor}. This heat can put them on a warrant.
            </p>
          )}
          <Button size="sm" className="h-7 text-xs" onClick={send}>
            Hit him in {hideout}
          </Button>
        </div>
      )}
    </section>
  );
}
