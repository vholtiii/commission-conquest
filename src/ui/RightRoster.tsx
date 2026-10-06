import type { ReactNode } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ArrowUpCircle, Eye, Shield } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { canLeadCrew, crewOf, crewSlots, isSettling } from "@/engine/crews";
import { canPromote, pathsFromRole } from "@/engine/crew";
import { FAMILY_HEX, RACKET_LABELS, type CrewMember, type CrewRole, type Territory } from "@/types/game";
import PortraitAvatar from "./PortraitAvatar";
import Tip from "./Tip";
import { formatMoney, titleCase } from "./formatters";

const ROLE_GROUPS: { role: CrewRole; label: string }[] = [
  { role: "boss", label: "Boss" },
  { role: "underboss", label: "Underboss" },
  { role: "consigliere", label: "Consigliere" },
  { role: "capo", label: "Capos" },
  { role: "hitman", label: "Hitmen" },
  { role: "soldier", label: "Loose soldiers" },
  { role: "associate", label: "Associates" },
];

/** What the promote arrow says: the paths open to this man and whether any is affordable now. */
function promotionState(
  member: CrewMember,
  crew: CrewMember[],
  money: number,
): { ready: boolean; tip: string } | null {
  if (member.status !== "active") return null;
  const paths = pathsFromRole(member.role);
  if (paths.length === 0) return null;
  const checks = paths.map((p) => ({ path: p, check: canPromote(member, p.to, crew, money) }));
  const open = checks.filter((c) => c.check.ok);
  if (open.length > 0) {
    return {
      ready: true,
      tip: `Ready for promotion: ${open
        .map((c) => `${titleCase(c.path.to)} (${formatMoney(c.path.cost)})`)
        .join(", ")}. Open his sheet to promote.`,
    };
  }
  const first = checks[0]!;
  const missing = first.check.reasons.filter((r) => !r.met).map((r) => r.label);
  return {
    ready: false,
    tip: `Can become ${checks.map((c) => titleCase(c.path.to)).join(" or ")} — not yet: ${missing.join(", ")}.`,
  };
}

/** A man's current job, for the mark beside his name. Other jobs stay unmarked. */
function dutyMark(member: CrewMember, territories: Territory[]): { tip: string; node: ReactNode } | null {
  if (member.status !== "active") return null;
  const a = member.assignment;
  if (a.type === "idle") {
    return {
      tip: "Idle",
      node: <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-500" aria-label="Idle" />,
    };
  }
  if (a.type === "garrison") {
    const place = territories.find((t) => t.id === a.territoryId)?.name;
    return {
      tip: place ? `Garrisoned in ${place}` : "Garrisoned",
      node: <Shield className="h-3.5 w-3.5 shrink-0 text-steel-light" aria-label="Garrisoned" />,
    };
  }
  if (a.type === "racket") {
    const post = territories
      .flatMap((t) => t.rackets.map((r) => ({ racket: r, territory: t })))
      .find((x) => x.racket.id === a.racketId || x.racket.managerId === member.id);
    const tip = post ? `Running ${RACKET_LABELS[post.racket.type]} in ${post.territory.name}` : "Running a racket";
    return {
      tip,
      node: (
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: FAMILY_HEX[member.family] }}
          aria-label="Running a racket"
        />
      ),
    };
  }
  return null;
}

function CrewRow({
  member,
  crew,
  money,
  territories,
  onSelect,
  compact = false,
  settling = false,
  slots,
  watched = false,
}: {
  member: CrewMember;
  crew: CrewMember[];
  money: number;
  territories: Territory[];
  onSelect: () => void;
  compact?: boolean;
  settling?: boolean;
  slots?: string;
  watched?: boolean;
}) {
  const promo = promotionState(member, crew, money);
  const duty = dutyMark(member, territories);
  return (
    <div className="flex w-full items-center gap-1 rounded-md pr-1 hover:bg-panel-elevated">
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left"
      >
        <PortraitAvatar
          seed={member.portraitSeed}
          size={compact ? 22 : 28}
          ringColor="#5c7a99"
          role={member.role}
          family={member.family}
          isPlayerBoss={member.isPlayerBoss}
          alt={member.name}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1 leading-tight">
          <span className={`truncate font-medium ${compact ? "text-[11px]" : "text-xs"}`}>
            {member.name}
            {member.role === "soldier" && !member.traits.includes("made_man") ? " (associate)" : ""}
          </span>
          {duty && (
            <Tip content={duty.tip} side="left">
              {duty.node}
            </Tip>
          )}
          {watched && (
            <Tip content="Being watched" side="left">
              <Eye className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-label="Being watched" />
            </Tip>
          )}
        </div>
        {slots && (
          <span className="text-[9px] text-muted-foreground" title="Crew filled">
            {slots}
          </span>
        )}
        {settling && (
          <Badge variant="outline" className="text-[9px] text-amber-200">
            settling in
          </Badge>
        )}
        {member.status !== "active" && (
          <Badge variant="outline" className="text-[9px]">
            {member.putAway ? "put away" : member.status}
          </Badge>
        )}
      </button>
      {promo && (
        <Tip content={promo.tip} side="left">
          <button
            type="button"
            aria-label={`Promotion for ${member.name}`}
            onClick={onSelect}
            className={`shrink-0 rounded p-0.5 hover:bg-panel-border ${
              promo.ready ? "text-money" : "text-muted-foreground/60 hover:text-steel-light"
            }`}
          >
            <ArrowUpCircle className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Empty-state row that says where to start, with a button that takes you there. */
function EmptyHint({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
  return (
    <div className="rounded-md border border-dashed border-panel-border/80 px-2 py-1.5">
      <p className="text-[11px] leading-snug text-muted-foreground">{text}</p>
      <button
        onClick={onClick}
        className="mt-1 text-[11px] font-medium text-steel-light underline-offset-2 hover:underline"
      >
        {action} &rarr;
      </button>
    </div>
  );
}

export default function RightRoster() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const pendingShipments = useGameStore((s) => s.pendingShipments ?? []);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const turn = useGameStore((s) => s.turn);
  const money = useGameStore((s) => s.money);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const setPanel = useGameStore((s) => s.setPanel);
  const showLiquorRoutes = useGameStore((s) => s.showLiquorRoutes);
  const ratAffair = useGameStore((s) => s.ratAffair);
  const watchedId =
    ratAffair && ratAffair.kind !== "lie" ? ratAffair.crewId : null;

  if (!playerFamily) return null;

  const playerCrew = crew.filter((c) => c.family === playerFamily && c.status !== "dead");
  const muscle = playerCrew;
  // Men under a living leader render on that leader's branch, not in their rank group.
  // A capoId pointing at a dead or missing leader falls back into the rank group.
  const leaders = playerCrew.filter(canLeadCrew);
  const inCrew = new Set(leaders.flatMap((l) => crewOf(crew, l.id).map((m) => m.id)));
  const roleGroups = ROLE_GROUPS.map((group) => ({
    ...group,
    members: muscle.filter((c) => c.role === group.role && !inCrew.has(c.id)),
  })).filter((group) => group.members.length > 0);
  const ownedTerritories = territories.filter((t) => t.owner === playerFamily);
  const rackets = ownedTerritories.flatMap((t) => t.rackets.map((r) => ({ racket: r, territory: t })));
  const deliveries = routes.filter((r) => r.family === playerFamily && r.status === "active");
  const ops = operations.filter((o) => o.family === playerFamily && !o.resolved);
  const nameOf = (id: string) => territories.find((t) => t.id === id)?.name ?? id;
  const deliveryCount = deliveries.length + pendingShipments.length + supplyRoutes.length;

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
            <AccordionContent className="space-y-2">
              {muscle.length === 0 && <p className="text-xs text-muted-foreground">No idle crew.</p>}
              {roleGroups.map((group) => (
                <div key={group.role}>
                  <div className="px-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-steel-light">
                    {group.label}
                    <span className="ml-1 text-muted-foreground">{group.members.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.members.map((c) => {
                      const led = canLeadCrew(c) ? crewOf(crew, c.id) : [];
                      return (
                        <div key={c.id}>
                          <CrewRow
                            member={c}
                            crew={crew}
                            money={money}
                            territories={territories}
                            slots={canLeadCrew(c) ? `${led.length}/${crewSlots(c)}` : undefined}
                            watched={c.id === watchedId}
                            onSelect={() => selectCrew(c.id)}
                          />
                          {led.length > 0 && (
                            <div className="ml-3 space-y-0.5 border-l border-panel-border pl-2">
                              {led.map((m) => (
                                <CrewRow
                                  key={m.id}
                                  member={m}
                                  crew={crew}
                                  money={money}
                                  territories={territories}
                                  compact
                                  settling={isSettling(m, turn)}
                                  watched={m.id === watchedId}
                                  onSelect={() => selectCrew(m.id)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
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
              {deliveryCount === 0 && (
                <EmptyHint
                  text="No crates on the road. Open a supply route to feed a speakeasy every week, or send a one-off run."
                  action="Manage routes"
                  onClick={() => showLiquorRoutes()}
                />
              )}
              {supplyRoutes.map((r) => {
                const driver = crew.find((c) => c.id === r.driverId);
                const tone =
                  r.status === "suspended"
                    ? "text-muted-foreground"
                    : r.status === "negotiating"
                      ? "text-amber-300"
                      : r.last?.outcome === "hijacked" || r.last?.outcome === "stopped"
                        ? "text-heat"
                        : "text-emerald-300";
                const status =
                  r.status === "suspended"
                    ? "held"
                    : r.status === "negotiating"
                      ? `waiting on ${r.awaitingFamilies.join(", ")}`
                      : r.last
                        ? r.last.outcome.replace("_", " ")
                        : "rolling";
                return (
                  <button
                    key={r.id}
                    onClick={() => showLiquorRoutes(r.id)}
                    className="flex w-full flex-col rounded-md px-1.5 py-1 text-left text-xs hover:bg-panel-elevated"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <span className="text-[9px] uppercase tracking-wide text-steel-light">Route</span>
                      {nameOf(r.sourceTerritoryId)} &rarr; {nameOf(r.destTerritoryId)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {r.cratesPerTurn}/week &middot; {driver?.name ?? "no driver"} &middot;{" "}
                      <span className={tone}>{status}</span>
                    </span>
                  </button>
                );
              })}
              {deliveries.map((r) => {
                const driver = crew.find((c) => c.id === r.driverId);
                return (
                  <button
                    key={r.id}
                    onClick={() =>
                      selectTerritory(r.destTerritoryId, {
                        toastLabel: `Delivery from ${nameOf(r.sourceTerritoryId)}`,
                      })
                    }
                    className="flex w-full flex-col rounded-md px-1.5 py-1 text-left text-xs hover:bg-panel-elevated"
                  >
                    <span className="font-medium">{driver?.name ?? "Unknown driver"}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {r.cargo} crates &middot; {nameOf(r.sourceTerritoryId)} &rarr;{" "}
                      {nameOf(r.destTerritoryId)}
                    </span>
                  </button>
                );
              })}
              {pendingShipments.map((ship) => (
                <button
                  key={ship.id}
                  onClick={() =>
                    selectTerritory(ship.destTerritoryId, { toastLabel: "Supplier shipment" })
                  }
                  className="flex w-full flex-col rounded-md px-1.5 py-1 text-left text-xs hover:bg-panel-elevated"
                >
                  <span className="font-medium">Supplier shipment</span>
                  <span className="text-[10px] text-muted-foreground">
                    {ship.crates} crates &rarr; {nameOf(ship.destTerritoryId)} &middot; arrives T
                    {ship.arriveTurn}
                  </span>
                </button>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="operations" className="border-panel-border px-3">
            <AccordionTrigger className="py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline">
              Operations ({ops.length})
            </AccordionTrigger>
            <AccordionContent className="space-y-1">
              {ops.length === 0 && (
                <EmptyHint
                  text="Nothing in the works. Case a district or plan a hit from a district's panel, or manage jobs in Operations."
                  action="Open Operations"
                  onClick={() => setPanel("operations")}
                />
              )}
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
