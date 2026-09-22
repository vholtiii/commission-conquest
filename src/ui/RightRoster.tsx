import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useGameStore } from "@/engine/store";
import { RACKET_LABELS } from "@/types/game";
import PortraitAvatar from "./PortraitAvatar";
import { titleCase } from "./formatters";

export default function RightRoster() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const pendingShipments = useGameStore((s) => s.pendingShipments ?? []);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const selectTerritory = useGameStore((s) => s.selectTerritory);

  if (!playerFamily) return null;

  const playerCrew = crew.filter((c) => c.family === playerFamily && c.status !== "dead");
  const muscle = playerCrew;
  const ownedTerritories = territories.filter((t) => t.owner === playerFamily);
  const rackets = ownedTerritories.flatMap((t) => t.rackets.map((r) => ({ racket: r, territory: t })));
  const deliveries = routes.filter((r) => r.family === playerFamily && r.status === "active");
  const ops = operations.filter((o) => o.family === playerFamily && !o.resolved);
  const nameOf = (id: string) => territories.find((t) => t.id === id)?.name ?? id;
  const deliveryCount = deliveries.length + pendingShipments.length;

  return (
    <aside className="panel-surface flex w-72 shrink-0 flex-col border-l">
      <div className="border-b px-3 py-2">
        <h2 className="font-display text-sm text-steel-light">Family Roster</h2>
      </div>
      <ScrollArea className="scrollbar-thin flex-1">
        <Accordion type="multiple" defaultValue={["muscle", "rackets", "deliveries", "operations"]}>
          <AccordionItem value="muscle" className="border-panel-border px-3">
            <AccordionTrigger className="py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline">
              Muscle ({muscle.length})
            </AccordionTrigger>
            <AccordionContent className="space-y-1">
              {muscle.length === 0 && <p className="text-xs text-muted-foreground">No idle crew.</p>}
              {muscle.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectCrew(c.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-elevated"
                >
                  <PortraitAvatar
                    seed={c.portraitSeed}
                    size={28}
                    ringColor="#5c7a99"
                    role={c.role}
                    family={c.family}
                    isPlayerBoss={c.isPlayerBoss}
                    alt={c.name}
                  />
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-xs font-medium">{c.name}</span>
                    <span className="text-[10px] text-muted-foreground">{titleCase(c.role)}</span>
                  </div>
                  {c.status !== "active" && (
                    <Badge variant="outline" className="text-[9px]">
                      {c.status}
                    </Badge>
                  )}
                </button>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="rackets" className="border-panel-border px-3">
            <AccordionTrigger className="py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline">
              Rackets ({rackets.length})
            </AccordionTrigger>
            <AccordionContent className="space-y-1">
              {rackets.length === 0 && <p className="text-xs text-muted-foreground">No rackets built.</p>}
              {rackets.map(({ racket, territory }) => (
                <button
                  key={racket.id}
                  onClick={() =>
                    selectTerritory(territory.id, {
                      toastLabel: RACKET_LABELS[racket.type],
                      racketId: racket.id,
                    })
                  }
                  className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left hover:bg-panel-elevated"
                >
                  <div className="flex flex-col leading-tight">
                    <span className="text-xs font-medium">{RACKET_LABELS[racket.type]}</span>
                    <span className="text-[10px] text-muted-foreground">{territory.name}</span>
                  </div>
                  <Badge variant="outline" className="text-[9px]">
                    Lv {racket.level}
                  </Badge>
                </button>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="deliveries" className="border-panel-border px-3">
            <AccordionTrigger className="py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline">
              Deliveries ({deliveryCount})
            </AccordionTrigger>
            <AccordionContent className="space-y-1">
              {deliveryCount === 0 && <p className="text-xs text-muted-foreground">No active runs.</p>}
              {deliveries.map((r) => {
                const driver = crew.find((c) => c.id === r.driverId);
                return (
                  <div key={r.id} className="flex flex-col rounded-md px-1.5 py-1 text-xs">
                    <span className="font-medium">{driver?.name ?? "Unknown driver"}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {r.cargo} crates &middot; {nameOf(r.sourceTerritoryId)} &rarr;{" "}
                      {nameOf(r.destTerritoryId)}
                    </span>
                  </div>
                );
              })}
              {pendingShipments.map((ship) => (
                <div key={ship.id} className="flex flex-col rounded-md px-1.5 py-1 text-xs">
                  <span className="font-medium">Supplier shipment</span>
                  <span className="text-[10px] text-muted-foreground">
                    {ship.crates} crates &rarr; {nameOf(ship.destTerritoryId)} &middot; arrives T
                    {ship.arriveTurn}
                  </span>
                </div>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="operations" className="border-panel-border px-3">
            <AccordionTrigger className="py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline">
              Operations ({ops.length})
            </AccordionTrigger>
            <AccordionContent className="space-y-1">
              {ops.length === 0 && <p className="text-xs text-muted-foreground">No pending operations.</p>}
              {ops.map((op) => {
                const target = crew.find((c) => c.id === op.targetCrewId);
                const isSurv = op.kind === "surveillance";
                return (
                  <button
                    key={op.id}
                    onClick={() =>
                      selectTerritory(op.targetTerritoryId, {
                        toastLabel: isSurv ? "Surveillance" : "Hit target",
                      })
                    }
                    className="flex w-full flex-col rounded-md px-1.5 py-1 text-left text-xs hover:bg-panel-elevated"
                  >
                    <span className="font-medium">
                      {isSurv
                        ? "Surveillance"
                        : op.approach
                          ? titleCase(op.approach)
                          : "Hit"}{" "}
                      on {target?.name ?? op.targetFamily}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {isSurv
                        ? "Report next turn"
                        : op.pendingTurns > 0
                          ? `${op.pendingTurns} turns remaining`
                          : "Resolving next turn"}
                    </span>
                  </button>
                );
              })}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </ScrollArea>
    </aside>
  );
}
