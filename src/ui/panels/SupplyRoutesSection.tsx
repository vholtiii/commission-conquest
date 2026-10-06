import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, MapPin, Pause, Play, Truck, X } from "lucide-react";
import {
  FAMILY_HEX,
  MAP_STATUS,
  type FamilyName,
  type GameState,
  type RouteHop,
  type RouteOption,
  type RouteRiskLabel,
  type RouteStrategy,
  type SupplyRoute,
} from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  routeOptions,
  STRATEGY_ORDER,
  strategyBlurb,
  strategyChipLabel,
  strategyUnavailableReason,
  threatFamily,
} from "@/engine/supplyRoutes";
import { activeDeal, termsText } from "@/engine/passage";
import { districtStorage, makeManagerLookup } from "@/engine/liquor";
import { seizureCover } from "@/engine/safehouse";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Tip from "@/ui/Tip";

const LABEL_STYLE = {
  safe: "bg-emerald-500/20 text-emerald-300",
  toll: "bg-amber-500/20 text-amber-300",
  hot: "bg-heat/25 text-heat",
} as const;
const LABEL_TEXT = { safe: "Safe", toll: "Toll road", hot: "Hot" } as const;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** "A", "A and B", "A, B and C". */
function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function riskText(o: Pick<RouteOption, "risk" | "riskMin" | "riskMax">): string {
  if (Math.abs(o.riskMax - o.riskMin) < 0.015) return pct(o.risk);
  return `${pct(o.riskMin)}–${pct(o.riskMax)}`;
}

function hopColor(h: RouteHop): string {
  if (h.kind === "own") return "text-emerald-300";
  if (h.kind === "unclaimed") return "text-muted-foreground";
  if (h.kind === "deal") return "text-amber-300";
  return "text-heat";
}

function labelTip(label: RouteRiskLabel): string {
  switch (label) {
    case "safe":
      return "Own or unclaimed blocks only — lowest base hijack odds.";
    case "toll":
      return "Every rival block crossed has a paid passage deal. Toll per crate.";
    case "hot":
      return "Crosses rival turf without a deal. Their men may stop the truck and remember.";
  }
}

function hopTip(h: RouteHop, name: string): string {
  const odds = h.known ? `${pct(h.risk)} hijack` : `${pct(h.riskMin)}–${pct(h.riskMax)} (uncased)`;
  switch (h.kind) {
    case "own":
      return `${name} — your turf. ${odds}.`;
    case "unclaimed":
      return `${name} — unclaimed. ${odds}.`;
    case "deal":
      return `${name} — passage deal with ${h.owner}. ${odds}.`;
    case "rival":
      return `${name} — ${h.owner} turf, no deal. ${odds}.`;
    case "hostile":
      return `${name} — hostile ${h.owner} turf. ${odds}.`;
  }
}

function strategyChipTip(
  strategy: RouteStrategy,
  option: RouteOption | undefined,
  reason: string | undefined,
  nameOf: (id: string) => string,
): string {
  if (reason) return reason;
  if (!option) return "";
  const path = option.path.map(nameOf).join(" → ");
  return `${strategyBlurb(strategy, option.dodges)} ${path}. ~${riskText(option)} hijack.`;
}

/**
 * What this road buys you and what it costs, relative to the other roads on
 * offer. Short lines; the map shows the shape, this shows the trade.
 */
function summarizeOption(
  option: RouteOption,
  all: RouteOption[],
  state: Pick<GameState, "passageDeals" | "turn" | "playerFamily" | "territories">,
): { pros: string[]; cons: string[] } {
  const pros: string[] = [];
  const cons: string[] = [];
  const garage = state.playerFamily ? seizureCover(state, state.playerFamily, option.path) : null;
  if (garage) {
    pros.push(
      `Safehouse ${garage.hops === 0 ? "on the road" : "a block off the road"} (Lv ${garage.level}) — ducks ${Math.round(garage.evasion * 100)}% of police checkpoints`,
    );
  }
  const hops = option.hops.length;
  const lengths = all.map((o) => o.hops.length);
  const risks = all.map((o) => o.risk);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  const safest = Math.min(...risks);
  const riskiest = Math.max(...risks);

  const titled = new Set(option.strategies);
  if (all.length > 1 && option.risk === safest && riskiest - safest > 0.01) pros.push("Lowest hijack odds");
  if (all.length > 1 && option.risk === riskiest && riskiest - safest > 0.01) cons.push("Riskiest road on offer");
  // "Direct" in the title already says shortest.
  if (all.length > 1 && hops === shortest && longest > shortest && !titled.has("direct")) {
    pros.push(`Shortest road (${hops} hop${hops === 1 ? "" : "s"})`);
  }
  if (all.length > 1 && hops === longest && longest > shortest) cons.push(`Long haul (${hops} hops)`);

  const kinds = new Set(option.hops.map((h) => h.kind));
  // "Home turf" in the title already says it never leaves your blocks.
  if (option.families.length === 0 && !titled.has("home_turf")) {
    pros.push(kinds.has("unclaimed") ? "No family to answer to" : "Never leaves your turf");
  }
  for (const f of option.families) {
    const deal = activeDeal(state, f);
    if (deal) {
      pros.push(`${f} men wave you through`);
      cons.push(`Pays ${f}: ${termsText(deal.terms)}`);
    } else {
      cons.push(`No deal with ${f} — sit-down first, or run hot and get taxed`);
    }
  }
  const hostile = [...new Set(option.hops.filter((h) => h.kind === "hostile").map((h) => h.owner))];
  if (hostile.length > 0) cons.push(`Runs past hostile ${hostile.join(", ")}`);
  const unknown = option.hops.filter((h) => !h.known).length;
  if (unknown > 0) cons.push(`${unknown} uncased block${unknown === 1 ? "" : "s"} — odds are a guess`);

  return { pros: pros.slice(0, 3), cons: cons.slice(0, 3) };
}

/**
 * Standing liquor orders: pick two districts, a driver, a road, and let the
 * trucks roll every week. Roads through rival turf need a passage deal or
 * run hot.
 */
export default function SupplyRoutesSection() {
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const passageDeals = useGameStore((s) => s.passageDeals ?? []);
  const establish = useGameStore((s) => s.establishSupplyRoute);
  const cancel = useGameStore((s) => s.cancelSupplyRoute);
  const toggle = useGameStore((s) => s.toggleSupplyRoute);
  const setHot = useGameStore((s) => s.setRouteRunHot);
  const reopen = useGameStore((s) => s.reopenPassageTalks);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const focusId = useGameStore((s) => s.supplyRouteFocusId);
  const setFocus = useGameStore((s) => s.setSupplyRouteFocus);
  const setPreview = useGameStore((s) => s.setSupplyRoutePreview);

  const [sourceId, setSourceId] = useState("");
  const [destId, setDestId] = useState("");
  const [crates, setCrates] = useState(10);
  const [driverId, setDriverId] = useState("");
  const [escortId, setEscortId] = useState("");
  const [strategyPick, setStrategyPick] = useState<RouteStrategy>("direct");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [runHot, setRunHot] = useState(false);
  const [open, setOpen] = useState(supplyRoutes.length === 0);

  const lookup = useMemo(() => makeManagerLookup(crew, playerFamily), [crew, playerFamily]);
  const owned = useMemo(
    () => territories.filter((t) => t.owner === playerFamily),
    [territories, playerFamily],
  );
  const sources = useMemo(
    () =>
      owned.filter((t) =>
        t.rackets.some(
          (r) => (r.type === "warehouse" || r.type === "still" || r.type === "brewery") && r.stock > 0,
        ),
      ),
    [owned],
  );
  const dests = useMemo(
    () => owned.filter((t) => t.rackets.some((r) => r.type === "warehouse" || r.type === "speakeasy")),
    [owned],
  );
  const free = useMemo(
    () =>
      crew.filter(
        (c) =>
          c.family === playerFamily &&
          c.status === "active" &&
          c.role !== "boss" &&
          (c.assignment.type === "idle" || c.assignment.type === "garrison"),
      ),
    [crew, playerFamily],
  );

  const effSource = sources.some((t) => t.id === sourceId) ? sourceId : sources[0]?.id ?? "";
  const destChoices = dests.filter((t) => t.id !== effSource);
  const effDest = destChoices.some((t) => t.id === destId) ? destId : destChoices[0]?.id ?? "";
  const effDriver = free.some((c) => c.id === driverId) ? driverId : free[0]?.id ?? "";
  const effEscort = free.some((c) => c.id === escortId && c.id !== effDriver) ? escortId : "";

  const state = useGameStore.getState();
  const options = useMemo(() => {
    if (!playerFamily || !effSource || !effDest) return [];
    return routeOptions(state, effSource, effDest, playerFamily, effDriver || undefined, effEscort || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerFamily, effSource, effDest, effDriver, effEscort, territories, crew, passageDeals, turn]);
  // The strategy you clicked, falling back to whatever the safest road is called.
  const effStrategy: RouteStrategy | undefined = options.some((o) => o.strategies.includes(strategyPick))
    ? strategyPick
    : options[0]?.strategies[0];
  const chosen = effStrategy ? options.find((o) => o.strategies.includes(effStrategy)) : undefined;
  const threat = useMemo(
    () => (playerFamily ? threatFamily(state, playerFamily) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerFamily, territories, turn],
  );

  // One road on the map: the chip under the cursor, otherwise the chosen strategy.
  useEffect(() => {
    if (!open || options.length === 0) {
      setPreview(null);
      return;
    }
    const shownId = hoverId && options.some((o) => o.id === hoverId) ? hoverId : chosen?.id ?? null;
    const shown = options.find((o) => o.id === shownId);
    if (!shown) {
      setPreview(null);
      return;
    }
    setPreview({
      options: [{ id: shown.id, path: shown.path, label: shown.label, strategies: shown.strategies }],
      chosenId: shown.id,
    });
  }, [open, options, chosen, hoverId, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);

  const nameOf = (id: string) => territories.find((t) => t.id === id)?.name ?? id;
  const sourceStock = effSource
    ? districtStorage(territories.find((t) => t.id === effSource)!, turn, lookup).stored
    : 0;
  const driver = free.find((c) => c.id === effDriver);
  const escort = free.find((c) => c.id === effEscort);

  if (!playerFamily) return null;

  return (
    <div className="mb-4 rounded border border-panel-border bg-panel/40 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <Tip content="Standing orders: N crates a week from a warehouse or still to a warehouse or speakeasy.">
          <h3 className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Truck className="h-3 w-3" /> Supply routes ({supplyRoutes.length})
          </h3>
        </Tip>
        <Tip
          content={
            open
              ? "Close the route picker. Map preview lines clear."
              : "Pick two districts, a strategy, and open a weekly liquor run."
          }
        >
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[10px] text-steel-light underline-offset-2 hover:underline"
          >
            {open ? "Hide new route" : "New route"}
          </button>
        </Tip>
      </div>

      {supplyRoutes.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {supplyRoutes.map((r) => (
            <RouteRow
              key={r.id}
              route={r}
              focused={focusId === r.id}
              nameOf={nameOf}
              crewName={(id) => crew.find((c) => c.id === id)?.name ?? "—"}
              onCancel={() => cancel(r.id)}
              onToggle={() => toggle(r.id)}
              onHot={(v) => setHot(r.id, v)}
              onTalk={() => reopen(r.id)}
              onFocus={() => setFocus(focusId === r.id ? null : r.id)}
              onGoTo={() => selectTerritory(r.destTerritoryId, { toastLabel: "Supply route" })}
            />
          ))}
          <Tip content="Click a standing route to trace it on the map in dotted purple.">
            <p className="text-[9px] text-muted-foreground">
              Click a route to trace it. The ring is the start, the arrow the stop
              <span className="ml-1 inline-block h-[3px] w-5 align-middle" style={{ borderTop: `2px dotted ${MAP_STATUS.supplyRoute}` }} />
            </p>
          </Tip>
        </div>
      )}

      {passageDeals.filter((d) => d.status === "active").length > 0 && (
        <div className="mb-2 space-y-1 border-t border-panel-border pt-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Passage deals</p>
          {passageDeals
            .filter((d) => d.status === "active")
            .map((d) => (
              <Tip
                key={d.id}
                content={`Passage through ${d.family} turf. Trucks pay the toll each run; two missed tolls void the deal.${d.missedTolls > 0 ? " Toll is overdue — pay or relation drops." : ""}`}
              >
                <div className="flex items-start gap-1.5 text-[10px]">
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: FAMILY_HEX[d.family] }}
                  />
                  <span>
                    <span className="font-medium">{d.family}</span>: {termsText(d.terms)}
                    {d.untilTurn !== null && (
                      <span className="text-muted-foreground"> · ends T{d.untilTurn}</span>
                    )}
                    {d.missedTolls > 0 && <span className="text-heat"> · toll missed</span>}
                  </span>
                </div>
              </Tip>
            ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-panel-border pt-2">
          {sources.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing to ship. A warehouse, still or brewery with crates is the start of a route.
            </p>
          ) : destChoices.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nowhere to send it. Another district with a warehouse or speakeasy takes crates.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Tip content="District with a warehouse, still or brewery that has crates to ship.">
                  <label className="block text-[10px] text-muted-foreground">
                    From
                    <select
                    value={effSource}
                    onChange={(e) => setSourceId(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs text-foreground"
                  >
                    {sources.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({districtStorage(t, turn, lookup).stored})
                      </option>
                    ))}
                    </select>
                  </label>
                </Tip>
                <Tip content="Warehouse or speakeasy that receives crates. Dry speakeasies need a route.">
                  <label className="block text-[10px] text-muted-foreground">
                    To
                    <select
                    value={effDest}
                    onChange={(e) => setDestId(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs text-foreground"
                  >
                    {destChoices.map((t) => {
                      const dry = t.rackets.some((r) => r.type === "speakeasy" && r.stock === 0);
                      return (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {dry ? " — dry" : ""}
                        </option>
                      );
                    })}
                    </select>
                  </label>
                </Tip>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Tip content="Each chip is a way of finding a road: fewest hops, stay on your turf, paid passage, avoid heat, dodge a threat, or a second road from Direct. Hover to preview on the map.">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">How do you want to run it?</p>
                  </Tip>
                  {options.length > 1 && (
                    <Tip content="The chosen road is the purple line on the map. Hover another chip to swap it.">
                      <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
                        <span className="inline-block h-[3px] w-4" style={{ borderTop: `2px dotted ${MAP_STATUS.supplyRoute}` }} />
                        chosen road
                      </span>
                    </Tip>
                  )}
                </div>
                <StrategyChips
                  options={options}
                  chosen={chosen}
                  threat={threat}
                  state={state}
                  family={playerFamily}
                  nameOf={nameOf}
                  onPick={setStrategyPick}
                  onHover={setHoverId}
                />
                {options.length === 0 && (
                  <p className="text-[11px] text-heat">No road connects those districts.</p>
                )}
                {options.length === 1 && (
                  <p className="text-[10px] text-muted-foreground">
                    Only one road between these districts — every way of going lands on it. The choice
                    here is the driver and the escort.
                  </p>
                )}
                {chosen && effStrategy && (
                  <ChosenRoad
                    option={chosen}
                    strategy={effStrategy}
                    summary={summarizeOption(chosen, options, state)}
                    nameOf={nameOf}
                  />
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px]">
                <Tip
                  content={
                    driver
                      ? `Driver skill and wheelman trait lower hijack odds.${escort ? " Escort cuts risk ~25% but rides along." : ""} Crates ship every turn from source stock.`
                      : "Need an idle or garrisoned soldier to drive. The boss can't run routes."
                  }
                >
                  <span className="min-w-0 truncate text-muted-foreground">
                    {driver ? (
                      <>
                        <span className="text-foreground">{driver.name}</span> drives
                      </>
                    ) : (
                      <span className="text-heat">No free men to drive</span>
                    )}
                    {" · "}
                    {escort ? (
                      <>
                        <span className="text-foreground">{escort.name}</span> rides escort
                      </>
                    ) : (
                      "no escort"
                    )}
                    {" · "}
                    <span className="text-foreground">{crates}</span> crates/wk
                  </span>
                </Tip>
                <Tip content={setupOpen ? "Collapse driver, escort and crate settings." : "Change driver, escort, or crates per week."}>
                  <button
                    type="button"
                    onClick={() => setSetupOpen((v) => !v)}
                    className="shrink-0 text-steel-light underline-offset-2 hover:underline"
                  >
                    {setupOpen ? "done" : "change"}
                  </button>
                </Tip>
              </div>

              {setupOpen && (
              <div className="grid grid-cols-3 gap-2">
                <Tip content={`Crates pulled from source stock each turn (max ${sourceStock} on hand).`}>
                  <label className="block text-[10px] text-muted-foreground">
                    Crates/week
                    <input
                    type="number"
                    min={1}
                    max={Math.max(1, sourceStock)}
                    value={crates}
                    onChange={(e) => setCrates(Math.max(1, Number(e.target.value) || 1))}
                    className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs text-foreground"
                    />
                  </label>
                </Tip>
                <Tip content="Driving skill lowers hijack odds. Wheelman trait helps further. Must be idle or garrisoned.">
                  <label className="block text-[10px] text-muted-foreground">
                    Driver
                    <select
                    value={effDriver}
                    onChange={(e) => setDriverId(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs text-foreground"
                  >
                    {free.length === 0 && <option value="">No free men</option>}
                    {free.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} (drive {c.skills.driving})
                      </option>
                    ))}
                    </select>
                  </label>
                </Tip>
                <Tip content="Optional muscle on the truck. Cuts hijack risk ~25% but they're exposed if it goes bad.">
                  <label className="block text-[10px] text-muted-foreground">
                    Escort
                    <select
                    value={effEscort}
                    onChange={(e) => setEscortId(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs text-foreground"
                  >
                    <option value="">None</option>
                    {free
                      .filter((c) => c.id !== effDriver)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} (muscle {c.skills.muscle})
                        </option>
                      ))}
                    </select>
                  </label>
                </Tip>
              </div>
              )}

              {chosen && chosen.needsDeal.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[10px]">
                  <Tip content="Without passage, the route waits at the table. Your boss travels to negotiate tolls — a car-bomb opportunity for rivals.">
                    <p className="text-amber-200">
                      Crosses {chosen.needsDeal.join(", ")} turf with no deal. A passage sit-down is
                      called for the week after next — your boss travels to their table.
                    </p>
                  </Tip>
                  <Tip content="Skip the sit-down and run now. Their men tax 15–30% of the cargo, relation drops, and they remember (passage grudge).">
                    <label className="mt-1.5 flex items-center gap-2 text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={runHot}
                        onChange={(e) => setRunHot(e.target.checked)}
                        className="accent-heat"
                      />
                      Roll now without a deal (hot: their men tax the truck, and they remember)
                    </label>
                  </Tip>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <Tip
                  content={
                    chosen && effStrategy
                      ? `Weekly run: ${strategyChipLabel(effStrategy, chosen.dodges)}, ${chosen.path.length - 1} hops, ~${riskText(chosen)} chance of hijack each delivery.`
                      : "Pick a strategy chip to see the road summary."
                  }
                >
                  <span className="text-[10px] text-muted-foreground">
                    {chosen && effStrategy
                      ? `${strategyChipLabel(effStrategy, chosen.dodges)} · ${chosen.path.length - 1} hops · ~${riskText(chosen)} hijack`
                      : ""}
                  </span>
                </Tip>
                <Tip
                  wrapDisabled
                  content={
                    !chosen
                      ? "Pick a strategy with a road between these districts."
                      : !effDriver
                        ? "Assign a driver first."
                        : "Open the standing weekly order. Trucks roll each turn until you hold or close the route."
                  }
                >
                  <span>
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      disabled={!chosen || !effDriver || crates < 1}
                      onClick={() => {
                    if (!chosen) return;
                    establish({
                      sourceTerritoryId: effSource,
                      destTerritoryId: effDest,
                      path: chosen.path,
                      cratesPerTurn: crates,
                      driverId: effDriver,
                      escortId: effEscort || undefined,
                      runHot,
                    });
                    setOpen(false);
                      }}
                    >
                      Open route
                    </Button>
                  </span>
                </Tip>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One chip per strategy. Chips that landed on the same road light up
 * together; strategies with no road here are greyed with the reason.
 * Hovering a chip previews its road on the map.
 */
function StrategyChips({
  options,
  chosen,
  threat,
  state,
  family,
  nameOf,
  onPick,
  onHover,
}: {
  options: RouteOption[];
  chosen: RouteOption | undefined;
  threat: FamilyName | undefined;
  state: GameState;
  family: FamilyName;
  nameOf: (id: string) => string;
  onPick: (s: RouteStrategy) => void;
  onHover: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {STRATEGY_ORDER.map((s) => {
        const option = options.find((o) => o.strategies.includes(s));
        const active = !!option && !!chosen && option.id === chosen.id;
        const reason = option ? undefined : strategyUnavailableReason(s, options, state, family);
        const label = strategyChipLabel(s, option?.dodges ?? threat);
        const tip = strategyChipTip(s, option, reason, nameOf);
        return (
          <Tip key={s} wrapDisabled content={tip} side="bottom">
            <button
              type="button"
              disabled={!option}
              onClick={() => onPick(s)}
              onMouseEnter={() => option && onHover(option.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => option && onHover(option.id)}
              onBlur={() => onHover(null)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                !option
                  ? "cursor-not-allowed border-panel-border/60 text-muted-foreground/50 line-through decoration-muted-foreground/40"
                  : active
                    ? "bg-panel-elevated text-foreground"
                    : "border-panel-border bg-panel/50 text-foreground/80 hover:border-steel/70"
              }`}
              style={active ? { borderColor: MAP_STATUS.supplyRoute } : undefined}
            >
              <span
                className="inline-block h-[3px] w-3 shrink-0"
                style={{
                  borderTop: `2px dotted ${!option ? "transparent" : active ? MAP_STATUS.supplyRoute : MAP_STATUS.supplyOption}`,
                }}
              />
              {label}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** The road behind the chip you picked: what it is, where it goes, what it trades. */
function ChosenRoad({
  option,
  strategy,
  summary,
  nameOf,
}: {
  option: RouteOption;
  strategy: RouteStrategy;
  summary: { pros: string[]; cons: string[] };
  nameOf: (id: string) => string;
}) {
  const unknown = option.hops.filter((h) => !h.known).length;
  const also = option.strategies.filter((s) => s !== strategy);
  return (
    <div
      className="rounded-md border bg-panel-elevated px-2 py-1.5 text-[10px]"
      style={{ borderColor: MAP_STATUS.supplyRoute }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-[11px] font-medium text-foreground">{strategyChipLabel(strategy, option.dodges)}</span>
          <Tip content={labelTip(option.label)}>
            <Badge className={`shrink-0 text-[9px] ${LABEL_STYLE[option.label]}`}>{LABEL_TEXT[option.label]}</Badge>
          </Tip>
        </span>
        <Tip
          content={
            unknown > 0
              ? `${unknown} block${unknown === 1 ? "" : "s"} not cased — odds shown as a range until you have intel.`
              : "Combined hijack odds for the whole run (driver and escort included)."
          }
        >
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {unknown > 0 ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {riskText(option)} hijack · {option.hops.length} hop{option.hops.length === 1 ? "" : "s"}
          </span>
        </Tip>
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {strategyBlurb(strategy, option.dodges)}
        {also.length > 0 && (
          <span className="text-muted-foreground/70">
            {" "}Same road as {listText(also.map((s) => strategyChipLabel(s, option.dodges)))}.
          </span>
        )}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-1 leading-snug">
        <span className="text-emerald-300">{nameOf(option.path[0]!)}</span>
        {option.hops.map((h) => (
          <span key={h.territoryId}>
            <span className="text-muted-foreground">→ </span>
            <Tip content={hopTip(h, nameOf(h.territoryId))}>
              <span className={hopColor(h)}>{nameOf(h.territoryId)}</span>
            </Tip>
          </span>
        ))}
      </div>
      {option.families.length > 0 && (
        <p className="mt-0.5 text-muted-foreground">
          Crosses {option.families.map((f) => (option.needsDeal.includes(f) ? `${f} (no deal)` : `${f} (deal)`)).join(", ")}
          {unknown > 0 ? ` · ${unknown} uncased block${unknown === 1 ? "" : "s"}` : ""}
        </p>
      )}
      {(summary.pros.length > 0 || summary.cons.length > 0) && (
        <div className="mt-1 space-y-px border-t border-panel-border/60 pt-1 text-[9.5px] leading-snug">
          {summary.pros.map((p) => (
            <Tip key={p} content={p}>
              <div className="flex gap-1 text-emerald-300/90">
                <span className="w-2 shrink-0">+</span>
                <span>{p}</span>
              </div>
            </Tip>
          ))}
          {summary.cons.map((c) => (
            <Tip key={c} content={c}>
              <div className="flex gap-1 text-amber-200/90">
                <span className="w-2 shrink-0">−</span>
                <span>{c}</span>
              </div>
            </Tip>
          ))}
        </div>
      )}
    </div>
  );
}

function RouteRow({
  route,
  focused,
  nameOf,
  crewName,
  onCancel,
  onToggle,
  onHot,
  onTalk,
  onFocus,
  onGoTo,
}: {
  route: SupplyRoute;
  focused: boolean;
  nameOf: (id: string) => string;
  crewName: (id: string) => string;
  onCancel: () => void;
  onToggle: () => void;
  onHot: (v: boolean) => void;
  onTalk: () => void;
  /** Toggle the dotted road on the map. */
  onFocus: () => void;
  /** Fly to the destination district. */
  onGoTo: () => void;
}) {
  const state = useGameStore.getState();
  const families = route.path
    .map((tid) => state.territories.find((t) => t.id === tid)?.owner)
    .filter((f): f is NonNullable<typeof f> => !!f && f !== route.family);
  const hotWith = [...new Set(families)].filter((f) => !activeDeal(state, f));
  const status =
    route.status === "suspended"
      ? { text: route.suspendedReason ?? "Held", cls: "text-muted-foreground" }
      : route.status === "negotiating"
        ? { text: `Waiting on ${route.awaitingFamilies.join(", ")}`, cls: "text-amber-300" }
        : hotWith.length
          ? { text: `Running hot past ${hotWith.join(", ")}`, cls: "text-heat" }
          : { text: "Rolling", cls: "text-emerald-300" };

  return (
    <div
      className={`rounded-md border bg-panel/50 p-2 text-[10px] transition-colors ${
        focused ? "" : "border-panel-border"
      }`}
      style={focused ? { borderColor: MAP_STATUS.supplyRoute } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <Tip content={focused ? "Hide this road on the map." : "Trace this route. A ring marks the start and an arrow the stop."}>
          <button
            type="button"
            onClick={onFocus}
            className="flex min-w-0 items-center gap-1.5 text-left font-medium text-foreground hover:underline"
          >
            <span
              className="inline-block h-[3px] w-4 shrink-0"
              style={{ borderTop: `2px dotted ${focused ? MAP_STATUS.supplyRoute : MAP_STATUS.supplyOption}` }}
            />
            <span className="truncate">
              {nameOf(route.sourceTerritoryId)} → {nameOf(route.destTerritoryId)}
            </span>
          </button>
        </Tip>
        <span className="flex items-center gap-1">
          <Tip content={status.text}>
            <span className={status.cls}>{status.text}</span>
          </Tip>
          <Tip content="Pan the map to the destination district.">
            <button
              type="button"
              onClick={onGoTo}
              className="rounded p-0.5 text-muted-foreground hover:bg-panel-border hover:text-steel-light"
            >
              <MapPin className="h-3 w-3" />
            </button>
          </Tip>
        </span>
      </div>
      {focused && (
        <p className="mt-0.5 text-[9.5px]" style={{ color: MAP_STATUS.supplyRoute }}>
          {route.path.map(nameOf).join(" → ")}
        </p>
      )}
      <p className="text-muted-foreground">
        {route.cratesPerTurn} crates/week · {crewName(route.driverId)}
        {route.escortId ? ` + ${crewName(route.escortId)}` : ""} · {route.path.length - 1} hops
      </p>
      {route.last && (
        <p className={route.last.outcome === "delivered" ? "text-foreground/80" : "text-amber-200"}>
          T{route.last.turn}: {route.last.text}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Tip content={route.status === "suspended" ? "Resume weekly deliveries." : "Pause the route — no crates ship while held."}>
          <span>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={onToggle}>
              {route.status === "suspended" ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
              {route.status === "suspended" ? "Resume" : "Hold"}
            </Button>
          </span>
        </Tip>
        {(route.awaitingFamilies.length > 0 || hotWith.length > 0) && (
          <>
            <Tip content="Call another passage sit-down for families blocking the road.">
              <span>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={onTalk}>
                  Ask for passage
                </Button>
              </span>
            </Tip>
            <Tip
              content={
                route.runHot
                  ? "Wait for passage instead of running without a deal."
                  : "Run without a deal — their men tax the truck and remember."
              }
            >
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-1.5 text-[10px] ${route.runHot ? "text-heat" : ""}`}
                  onClick={() => onHot(!route.runHot)}
                >
                  {route.runHot ? "Stop running hot" : "Run hot"}
                </Button>
              </span>
            </Tip>
          </>
        )}
        <Tip content="Cancel the standing order. Driver and escort return to idle.">
          <span>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-[10px] text-heat" onClick={onCancel}>
              <X className="mr-1 h-3 w-3" /> Close
            </Button>
          </span>
        </Tip>
      </div>
    </div>
  );
}
