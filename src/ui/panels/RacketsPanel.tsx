import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MapPin, Ship, Truck, Handshake, UserX } from "lucide-react";
import {
  FAMILY_HEX,
  MAP_STATUS,
  RACKET_LABELS,
  type CrewMember,
  type CrewStatus,
  type Racket,
  type Territory,
  type WeekBookRacket,
} from "@/types/game";
import { useGameStore } from "@/engine/store";
import { isLegitBusiness, launderSiteStatus } from "@/engine/economy";
import { maxRacketsFor } from "@/engine/territoryValue";
import { activeDeals, dealPartner } from "@/engine/deals";
import { Button } from "@/components/ui/button";
import { formatDelta } from "../formatters";
import PanelShell from "./PanelShell";
import { RouteRow } from "./SupplyRoutesSection";
import { isDealRoute } from "@/engine/supplyRoutes";

type Tab = "district" | "routes";

function bookPair(clean: number, dirty: number): string {
  if (clean === 0 && dirty === 0) return "$0";
  if (dirty === 0) return formatDelta(clean);
  if (clean === 0) return `${formatDelta(dirty)} dirty`;
  return `${formatDelta(clean)} clean, ${formatDelta(dirty)} dirty`;
}

export default function RacketsPanel() {
  const [tab, setTab] = useState<Tab>("district");
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const routes = useGameStore((s) => s.routes);
  const pendingShipments = useGameStore((s) => s.pendingShipments ?? []);
  const deals = useGameStore((s) => s.deals);
  const turn = useGameStore((s) => s.turn);

  const racketCount = territories
    .filter((t) => t.owner === playerFamily)
    .reduce((n, t) => n + t.rackets.length, 0);
  const routeCount =
    supplyRoutes.length +
    routes.filter((r) => r.family === playerFamily && r.status === "active").length +
    pendingShipments.length +
    activeDeals({ deals, turn, playerFamily }).filter((d) => d.kind === "liquor").length;

  return (
    <PanelShell title="Rackets" subtitle={`${racketCount} operations running`}>
      <div className="mb-3 flex gap-1 rounded-md border border-panel-border bg-panel/40 p-0.5 text-xs">
        {(
          [
            ["district", "By district", null],
            ["routes", "Routes", routeCount],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 transition-colors ${
              tab === id ? "bg-panel-elevated text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
            {count != null && count > 0 && (
              <span className="rounded bg-steel/30 px-1 text-[10px] tabular-nums text-steel-light">{count}</span>
            )}
          </button>
        ))}
      </div>
      {tab === "district" ? <ByDistrict /> : <RoutesTab />}
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ */
/* By district                                                         */
/* ------------------------------------------------------------------ */

function BooksSummary() {
  const weekBooks = useGameStore((s) => s.weekBooks);
  if (!weekBooks) {
    return <p className="mb-3 border-b border-panel-border pb-3 text-xs text-muted-foreground">The books haven't closed yet.</p>;
  }
  const rows: [string, string][] = [];
  if (weekBooks.blocks !== 0) rows.push(["Blocks", formatDelta(weekBooks.blocks)]);
  if (weekBooks.liquorClean !== 0 || weekBooks.liquorDirty !== 0) {
    rows.push(["Liquor", bookPair(weekBooks.liquorClean, weekBooks.liquorDirty)]);
  }
  if (weekBooks.laundryClean !== 0 || weekBooks.laundryDirty !== 0) {
    rows.push(["Laundry", bookPair(weekBooks.laundryClean, weekBooks.laundryDirty)]);
  }
  for (const cut of weekBooks.cuts) {
    rows.push([cut.clean + cut.dirty < 0 ? `Paid ${cut.family}` : `${cut.family} paid`, bookPair(cut.clean, cut.dirty)]);
  }
  rows.push(["Upkeep", formatDelta(-weekBooks.upkeep)]);
  if (weekBooks.adjustmentClean !== 0 || weekBooks.adjustmentDirty !== 0) {
    rows.push(["No one speaking for the family", bookPair(weekBooks.adjustmentClean, weekBooks.adjustmentDirty)]);
  }
  return (
    <div className="mb-3 space-y-1 border-b border-panel-border pb-3 text-xs">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Last week · Turn {weekBooks.turn}</div>
      <div className="grid grid-cols-3 gap-2 rounded bg-panel/40 px-2 py-1.5 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground">Clean</div>
          <div className="tabular-nums">{formatDelta(weekBooks.clean)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Dirty</div>
          <div className="tabular-nums">{formatDelta(weekBooks.dirty)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Net</div>
          <div className={`font-medium tabular-nums ${weekBooks.net >= 0 ? "text-emerald-400" : "text-heat"}`}>
            {formatDelta(weekBooks.net)}
          </div>
        </div>
      </div>
      {rows.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="flex items-baseline justify-between gap-3 text-muted-foreground">
          <span>{label}</span>
          <span className="shrink-0 tabular-nums text-foreground/80">{value}</span>
        </div>
      ))}
    </div>
  );
}

interface DistrictRow {
  territory: Territory;
  lines: (WeekBookRacket | undefined)[];
  take: number;
  /** Rackets with nobody assigned, or whose man is jailed, wounded or worse. */
  unmanned: number;
}

const AWAY: Record<CrewStatus, string> = {
  active: "is on the job",
  wounded: "is laid up wounded",
  jailed: "is in jail",
  dead: "is dead",
  informant: "is out of reach",
  held: "is being held",
};

/** Only an active manager runs a racket; anyone else leaves it earning like an empty one. */
function managerGap(racket: Racket, crew: CrewMember[]): null | "none" | "away" {
  if (!racket.managerId) return "none";
  const m = crew.find((c) => c.id === racket.managerId);
  return m && m.status === "active" ? null : "away";
}

function ByDistrict() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);
  const weekBooks = useGameStore((s) => s.weekBooks);
  const crew = useGameStore((s) => s.crew);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const districts = useMemo<DistrictRow[]>(() => {
    return territories
      .filter((t) => t.owner === playerFamily)
      .map((territory) => {
        const pool = (weekBooks?.rackets ?? []).filter((l) => l.territoryName === territory.name);
        const used = new Set<number>();
        const lines = territory.rackets.map((r) => {
          const i = pool.findIndex((l, idx) => !used.has(idx) && l.label === RACKET_LABELS[r.type]);
          if (i < 0) return undefined;
          used.add(i);
          return pool[i];
        });
        const take = pool.reduce((n, l) => n + l.clean + l.dirty, 0);
        const unmanned = territory.rackets.filter((r) => managerGap(r, crew) !== null).length;
        return { territory, lines, take, unmanned };
      })
      .sort((a, b) => {
        const aEmpty = a.territory.rackets.length === 0 ? 1 : 0;
        const bEmpty = b.territory.rackets.length === 0 ? 1 : 0;
        if (aEmpty !== bEmpty) return aEmpty - bEmpty;
        return b.take - a.take || a.territory.name.localeCompare(b.territory.name);
      });
  }, [territories, playerFamily, weekBooks, crew]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const withRackets = districts.filter((d) => d.territory.rackets.length > 0);
  const allExpanded = withRackets.length > 0 && withRackets.every((d) => expanded.has(d.territory.id));
  const unmannedTotal = districts.reduce((n, d) => n + d.unmanned, 0);
  const unmannedDistricts = districts.filter((d) => d.unmanned > 0).length;

  return (
    <>
      <BooksSummary />
      {unmannedTotal > 0 && (
        <p className="mb-3 flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          <UserX className="h-3.5 w-3.5 shrink-0" />
          {unmannedTotal} {unmannedTotal === 1 ? "racket" : "rackets"} in {unmannedDistricts}{" "}
          {unmannedDistricts === 1 ? "district needs" : "districts need"} a manager
        </p>
      )}
      {districts.length === 0 && (
        <p className="text-xs text-muted-foreground">No districts yet. Take a block to start a racket.</p>
      )}
      {withRackets.length >= 2 && (
        <div className="mb-1.5 flex justify-end">
          <button
            type="button"
            className="text-[10px] text-steel-light underline-offset-2 hover:underline"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(withRackets.map((d) => d.territory.id)))}
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      )}
      <div className="space-y-2">
        {districts.map((d) => (
          <DistrictGroup
            key={d.territory.id}
            row={d}
            open={expanded.has(d.territory.id)}
            onToggle={() => toggle(d.territory.id)}
            hasBooks={!!weekBooks}
          />
        ))}
      </div>
    </>
  );
}

function DistrictGroup({
  row,
  open,
  onToggle,
  hasBooks,
}: {
  row: DistrictRow;
  open: boolean;
  onToggle: () => void;
  hasBooks: boolean;
}) {
  const { territory, lines, take, unmanned } = row;
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const slots = maxRacketsFor(territory);
  const empty = territory.rackets.length === 0;

  return (
    <div className="rounded-md border border-panel-border bg-panel/30">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          disabled={empty}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          {empty ? (
            <span className="w-3.5" />
          ) : open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{territory.name}</span>
          {unmanned > 0 && (
            <span
              title={`${unmanned} ${unmanned === 1 ? "racket needs" : "rackets need"} a manager`}
              className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/20 px-1 text-[10px] tabular-nums text-amber-300"
            >
              <UserX className="h-3 w-3" />
              {unmanned}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {territory.rackets.length}/{slots} · Heat {Math.round(territory.heatLevel)}
          </span>
        </button>
        {hasBooks && !empty && (
          <span className={`shrink-0 text-xs tabular-nums ${take >= 0 ? "text-emerald-400" : "text-heat"}`}>
            {formatDelta(take)}
          </span>
        )}
        {empty && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => selectTerritory(territory.id, { toastLabel: "Build a racket" })}
          >
            Build
          </Button>
        )}
        <button
          type="button"
          title="Show this district on the map"
          onClick={() => selectTerritory(territory.id)}
          className="rounded p-0.5 text-muted-foreground hover:bg-panel-border hover:text-steel-light"
        >
          <MapPin className="h-3 w-3" />
        </button>
      </div>
      {open && !empty && (
        <div className="space-y-1 border-t border-panel-border/60 p-1.5">
          {territory.rackets.map((r, i) => (
            <RacketRow key={r.id} racket={r} territory={territory} line={lines[i]} />
          ))}
        </div>
      )}
    </div>
  );
}

function RacketRow({
  racket,
  territory,
  line,
}: {
  racket: Racket;
  territory: Territory;
  line: WeekBookRacket | undefined;
}) {
  const turn = useGameStore((s) => s.turn);
  const crew = useGameStore((s) => s.crew);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const frozen = (racket.frozenUntil ?? 0) > turn;
  const siteStatus = isLegitBusiness(racket.type) ? launderSiteStatus(racket, turn) : "off";
  const gap = managerGap(racket, crew);
  const assigned = racket.managerId ? crew.find((c) => c.id === racket.managerId) : undefined;
  const awayText = assigned ? `${assigned.name} ${AWAY[assigned.status]}` : "His manager is gone";

  return (
    <button
      type="button"
      onClick={() => selectTerritory(territory.id, { toastLabel: RACKET_LABELS[racket.type], racketId: racket.id })}
      className={`flex w-full items-center justify-between gap-2 rounded border border-panel-border/60 bg-panel/50 px-2.5 py-1.5 text-left hover:bg-panel-elevated ${
        gap ? "border-l-2 border-l-amber-400" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {RACKET_LABELS[racket.type]}
          {gap === "none" && (
            <span className="rounded bg-amber-500/20 px-1 text-[9px] uppercase text-amber-300">No manager</span>
          )}
          {gap === "away" && (
            <span title={awayText} className="rounded bg-amber-500/20 px-1 text-[9px] uppercase text-amber-300">
              Manager away
            </span>
          )}
          {frozen && <span className="rounded bg-heat/30 px-1 text-[9px] uppercase text-heat">Frozen</span>}
          {siteStatus === "ready" && (
            <span className="rounded bg-money/20 px-1 text-[9px] uppercase text-money">Laundering</span>
          )}
          {siteStatus === "setting_up" && (
            <span className="rounded bg-amber-500/20 px-1 text-[9px] uppercase text-amber-300">Setting up</span>
          )}
        </div>
        <div className="truncate text-[11px]">
          {gap === null && assigned ? (
            <span className="text-muted-foreground">{assigned.name}</span>
          ) : gap === "away" ? (
            <span className="text-amber-400">{awayText}</span>
          ) : (
            <span className="text-amber-400">Nobody</span>
          )}
          {line && <span className="text-muted-foreground"> · {bookPair(line.clean, line.dirty)}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right text-[11px] text-muted-foreground">
        Lv {racket.level}
        <br />
        Stock {racket.stock}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="mb-3">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon} {title} ({count})
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function PinButton({ territoryId, label }: { territoryId: string; label: string }) {
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  return (
    <button
      type="button"
      title="Pan the map to the destination district."
      onClick={() => selectTerritory(territoryId, { toastLabel: label })}
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-panel-border hover:text-steel-light"
    >
      <MapPin className="h-3 w-3" />
    </button>
  );
}

function RoutesTab() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const turn = useGameStore((s) => s.turn);
  const deals = useGameStore((s) => s.deals);
  const supplyRoutes = useGameStore((s) => (s.supplyRoutes ?? []).filter((r) => !isDealRoute(r)));
  const routes = useGameStore((s) => s.routes);
  const pendingShipments = useGameStore((s) => s.pendingShipments ?? []);
  const cancel = useGameStore((s) => s.cancelSupplyRoute);
  const toggle = useGameStore((s) => s.toggleSupplyRoute);
  const setHot = useGameStore((s) => s.setRouteRunHot);
  const reopen = useGameStore((s) => s.reopenPassageTalks);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const shownIds = useGameStore((s) => s.shownSupplyRouteIds);
  const setShown = useGameStore((s) => s.setShownSupplyRoutes);
  const setPanel = useGameStore((s) => s.setPanel);
  const hiddenRef = useRef(new Set<string>());

  const nameOf = (id: string) => territories.find((t) => t.id === id)?.name ?? id;
  const crewName = (id: string) => crew.find((c) => c.id === id)?.name ?? "—";
  const trucks = routes.filter((r) => r.family === playerFamily && r.status === "active");
  const contracts = activeDeals({ deals, turn, playerFamily }).filter((d) => d.kind === "liquor");
  const total = supplyRoutes.length + trucks.length + pendingShipments.length + contracts.length;
  const drawableKey = [...supplyRoutes.map((r) => r.id), ...trucks.map((r) => r.id)].join("|");
  const drawableIds = drawableKey.length ? drawableKey.split("|") : [];

  useEffect(() => {
    const ids = drawableKey.length ? drawableKey.split("|") : [];
    setShown(ids.filter((id) => !hiddenRef.current.has(id)));
  }, [drawableKey, setShown]);
  useEffect(() => () => setShown(null), [setShown]);

  const shown = new Set(shownIds ?? []);
  const shownCount = drawableIds.filter((id) => shown.has(id)).length;
  const toggleLine = (id: string) => {
    const current = useGameStore.getState().shownSupplyRouteIds ?? [];
    const on = current.includes(id);
    if (on) hiddenRef.current.add(id);
    else hiddenRef.current.delete(id);
    setShown(on ? current.filter((x) => x !== id) : [...current, id]);
  };
  const setAll = (on: boolean) => {
    if (on) hiddenRef.current.clear();
    else for (const id of drawableIds) hiddenRef.current.add(id);
    setShown(on ? [...drawableIds] : []);
  };

  return (
    <>
      {total === 0 && (
        <p className="mb-3 text-xs text-muted-foreground">No liquor on the move. Open a supply route from a warehouse.</p>
      )}

      {drawableIds.length > 0 && (
        <div className="mb-3 flex items-center justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">
            {shownCount} of {drawableIds.length} on the map
            <span
              className="ml-1 inline-block h-[3px] w-5 align-middle"
              style={{ borderTop: `2px dashed ${MAP_STATUS.supplyRoute}` }}
            />
          </span>
          <button
            type="button"
            onClick={() => setAll(shownCount < drawableIds.length)}
            className="text-steel-light underline-offset-2 hover:underline"
          >
            {shownCount === drawableIds.length ? "Hide all" : "Show all"}
          </button>
        </div>
      )}

      <Section icon={<Truck className="h-3 w-3" />} title="Supply routes" count={supplyRoutes.length}>
        {supplyRoutes.map((r) => (
          <RouteRow
            key={r.id}
            route={r}
            focused={shown.has(r.id)}
            nameOf={nameOf}
            crewName={crewName}
            onCancel={() => cancel(r.id)}
            onToggle={() => toggle(r.id)}
            onHot={(v) => setHot(r.id, v)}
            onTalk={() => reopen(r.id)}
            onFocus={() => toggleLine(r.id)}
            focusTips={["Show this route on the map.", "Hide this route on the map."]}
            onGoTo={() => selectTerritory(r.destTerritoryId, { toastLabel: "Supply route" })}
          />
        ))}
        <p className="text-[9px] text-muted-foreground">
          Every route starts on the map. Click one to hide or show it. The ring is the start, the arrow the stop.
        </p>
      </Section>

      <Section icon={<Truck className="h-3 w-3" />} title="Trucks on the road" count={trucks.length}>
        {trucks.map((r) => (
          <div
            key={r.id}
            className={`flex items-center justify-between gap-2 rounded-md border bg-panel/50 p-2 text-[10px] ${
              shown.has(r.id) ? "" : "border-panel-border"
            }`}
            style={shown.has(r.id) ? { borderColor: MAP_STATUS.supplyRoute } : undefined}
          >
            <div className="min-w-0">
              <button
                type="button"
                title={shown.has(r.id) ? "Hide this route on the map." : "Show this route on the map."}
                onClick={() => toggleLine(r.id)}
                className="flex min-w-0 items-center gap-1.5 text-left font-medium text-foreground hover:underline"
              >
                <span
                  className="inline-block h-[3px] w-4 shrink-0"
                  style={{ borderTop: `2px dashed ${shown.has(r.id) ? MAP_STATUS.supplyRoute : MAP_STATUS.supplyOption}` }}
                />
                <span className="truncate">
                  {nameOf(r.sourceTerritoryId)} → {nameOf(r.destTerritoryId)}
                </span>
              </button>
              <div className="text-muted-foreground">
                {r.cargo} crates · {crewName(r.driverId)} · {Math.max(0, r.path.length - 1)} hops
              </div>
            </div>
            <PinButton territoryId={r.destTerritoryId} label="Delivery" />
          </div>
        ))}
      </Section>

      <Section icon={<Ship className="h-3 w-3" />} title="Incoming shipments" count={pendingShipments.length}>
        {pendingShipments.map((s) => {
          const weeks = Math.max(0, s.arriveTurn - turn);
          return (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-md border border-panel-border bg-panel/50 p-2 text-[10px]"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {s.crates} crates → {nameOf(s.destTerritoryId)}
                </div>
                <div className="text-muted-foreground">
                  {weeks <= 1 ? "Arrives next week" : `Arrives in ${weeks} weeks`}
                </div>
              </div>
              <PinButton territoryId={s.destTerritoryId} label="Shipment" />
            </div>
          );
        })}
      </Section>

      <Section icon={<Handshake className="h-3 w-3" />} title="Liquor contracts" count={contracts.length}>
        {contracts.map((d) => {
          const partner = dealPartner({ playerFamily }, d);
          const weSend = d.obligor ? d.obligor === playerFamily : true;
          const crates = d.terms.crates ?? 0;
          const when = d.untilTurn != null ? ` · ${d.terms.weekly ? "ends" : "due"} T${d.untilTurn}` : "";
          return (
            <div
              key={d.id}
              className="flex items-center justify-between gap-2 rounded-md border border-panel-border bg-panel/50 p-2 text-[10px]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: FAMILY_HEX[partner] }} />
                  {weSend ? `To the ${partner}s` : `From the ${partner}s`}
                </div>
                <div className="text-muted-foreground">
                  {crates} crates{d.terms.weekly ? " a week" : ""}
                  {d.terms.weekly && d.delivered ? ` · ${d.delivered} sent` : ""}
                  {d.terms.destTerritoryId ? ` · ${nameOf(d.terms.destTerritoryId)}` : ""}
                  {when}
                </div>
              </div>
              {d.terms.destTerritoryId && <PinButton territoryId={d.terms.destTerritoryId} label="Liquor contract" />}
            </div>
          );
        })}
      </Section>

      <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => setPanel("warehouse")}>
        <Truck className="mr-1.5 h-3.5 w-3.5" /> New supply route
      </Button>
    </>
  );
}
