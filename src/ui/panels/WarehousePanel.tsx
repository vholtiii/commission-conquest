import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Wine } from "lucide-react";
import {
  RACKET_LABELS,
  type DeliveryRoute,
  type FamilyName,
  type GameState,
  type Territory,
} from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  findDeliveryPath,
  formatPaymentParts,
  hijackRisk,
  isRacketFrozen,
  racketPayment,
  canManageRacket,
} from "@/engine/economy";
import {
  districtStorage,
  hasManagedWarehouse,
  hasWarehouse,
  idleStorageCost,
  isStorageType,
  makeManagerLookup,
  shipmentSeizureChance,
  stashHeat,
  stashRaidChance,
  districtRaidMult,
  stockCap,
  supplierPrice,
  totalCapacity,
  totalCrates,
  warehouseManagerEffectText,
  warehouseManagerMods,
} from "@/engine/liquor";
import { activeCrewIds, isUnguarded } from "@/engine/territoryValue";
import { RACKET_VISUALS } from "@/data/racketVisuals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PanelShell from "./PanelShell";
import SupplyRoutesSection from "./SupplyRoutesSection";
import { formatMoney } from "../formatters";

function mockRoute(
  territories: Territory[],
  family: FamilyName,
  driverId: string,
  sourceId: string,
  destId: string,
  cargo: number,
): DeliveryRoute | null {
  const path = findDeliveryPath(territories, sourceId, destId, family, true);
  if (!path || path.length < 2) return null;
  return {
    id: "preview",
    family,
    driverId,
    sourceTerritoryId: sourceId,
    destTerritoryId: destId,
    path,
    cargo,
    status: "active",
  };
}

export default function WarehousePanel() {
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const turn = useGameStore((s) => s.turn);
  const heat = useGameStore((s) => s.heat);
  const seed = useGameStore((s) => s.seed);
  const bribes = useGameStore((s) => s.bribes);
  const pendingShipments = useGameStore((s) => s.pendingShipments ?? []);
  const liquorLedger = useGameStore((s) => s.liquorLedger);
  const buyWhisky = useGameStore((s) => s.buyWhisky);
  const startDelivery = useGameStore((s) => s.startDelivery);
  const assignManager = useGameStore((s) => s.assignManager);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const setPanel = useGameStore((s) => s.setPanel);
  const liquorView = useGameStore((s) => s.liquorView) ?? "stock";
  const setLiquorView = useGameStore((s) => s.setLiquorView);
  const routeCount = useGameStore((s) => s.supplyRoutes?.length ?? 0);

  const lookup = useMemo(
    () => makeManagerLookup(crew, playerFamily),
    [crew, playerFamily],
  );

  const owned = useMemo(
    () => territories.filter((t) => t.owner === playerFamily),
    [territories, playerFamily],
  );

  const warehouseDistricts = useMemo(
    () => owned.filter((t) => hasWarehouse(t, turn)),
    [owned, turn],
  );

  const managedDistricts = useMemo(
    () => owned.filter((t) => hasManagedWarehouse(t, lookup, turn)),
    [owned, lookup, turn],
  );

  const buyDests = useMemo(
    () =>
      managedDistricts.filter((t) => districtStorage(t, turn, lookup).free >= 5),
    [managedDistricts, turn, lookup],
  );

  const [buyDestId, setBuyDestId] = useState("");
  const [buyQty, setBuyQty] = useState(5);
  const [sendForms, setSendForms] = useState<
    Record<string, { destId: string; crates: number; driverId: string }>
  >({});

  const effectiveBuyDest =
    buyDestId && buyDests.some((t) => t.id === buyDestId)
      ? buyDestId
      : buyDests[0]?.id ?? "";

  const buyDest = owned.find((t) => t.id === effectiveBuyDest);
  const buyFree = buyDest ? districtStorage(buyDest, turn, lookup).free : 0;
  const price = supplierPrice(seed, turn, heat.level);
  const prevPrice = turn > 1 ? supplierPrice(seed, turn - 1, heat.level) : price;
  const qty = Math.min(Math.max(5, Math.round(buyQty / 5) * 5), Math.max(5, buyFree));
  const cost = qty * price;
  const pay = racketPayment("warehouse", cost, money, dirtyMoney);
  const seizeP = shipmentSeizureChance(heat.level, bribes);

  const liquorState = { territories, turn, crew, playerFamily } as GameState;
  const crates = playerFamily ? totalCrates(liquorState, playerFamily) : 0;
  const cap = playerFamily ? totalCapacity(liquorState, playerFamily) : 0;

  const drySpeakeasies = owned.some((t) =>
    t.rackets.some((r) => r.type === "speakeasy" && r.stock === 0),
  );
  const totalIdleCost = owned.reduce(
    (sum, t) => sum + idleStorageCost(t, turn, lookup),
    0,
  );
  const anyStashHeat = owned.some((t) => {
    const unguarded = isUnguarded(t, activeCrewIds(crew));
    return stashHeat(t, unguarded, turn, lookup) > 0;
  });

  const idleDrivers = crew.filter(
    (c) =>
      c.family === playerFamily &&
      c.status === "active" &&
      c.assignment.type === "idle",
  );

  const managerCandidates = crew.filter((c) => canManageRacket(c, playerFamily, "warehouse"));

  if (!playerFamily) return null;

  const fullState = useGameStore.getState();

  function getSendForm(sourceId: string) {
    return (
      sendForms[sourceId] ?? {
        destId: "",
        crates: 5,
        driverId: idleDrivers[0]?.id ?? "",
      }
    );
  }

  function patchSendForm(
    sourceId: string,
    patch: Partial<{ destId: string; crates: number; driverId: string }>,
  ) {
    setSendForms((prev) => ({
      ...prev,
      [sourceId]: { ...getSendForm(sourceId), ...patch },
    }));
  }

  const ledgerNet = liquorLedger
    ? liquorLedger.cashIn - liquorLedger.cashOut
    : 0;

  return (
    <PanelShell
      title="Liquor"
      subtitle={liquorView === "routes" ? "Standing liquor routes — hold, run hot, or close them" : "Warehouse logistics — managers, buy, stash, run crates"}
      width="w-[440px]"
    >
      <div className="mb-3 flex gap-1">
        <button
          type="button"
          onClick={() => setLiquorView("stock")}
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            liquorView === "stock"
              ? "border-steel-light text-foreground"
              : "border-panel-border text-muted-foreground hover:border-steel-light"
          }`}
        >
          Stock
        </button>
        <button
          type="button"
          onClick={() => setLiquorView("routes")}
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            liquorView === "routes"
              ? "border-steel-light text-foreground"
              : "border-panel-border text-muted-foreground hover:border-steel-light"
          }`}
        >
          Routes ({routeCount})
        </button>
      </div>

      {liquorView === "routes" ? (
        <SupplyRoutesSection />
      ) : (
      <>
      <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
        <Badge variant="outline">
          Crates {crates}/{cap}
        </Badge>
        <Badge variant="outline" className="gap-1">
          Supplier ${price}/crate
          {turn > 1 && price !== prevPrice && (
            <span className={price > prevPrice ? "text-heat" : "text-money"}>
              {price > prevPrice ? (
                <ArrowUp className="inline h-3 w-3" />
              ) : (
                <ArrowDown className="inline h-3 w-3" />
              )}
              was ${prevPrice}
            </span>
          )}
        </Badge>
        <Badge variant="outline">
          Incoming {pendingShipments.length}
        </Badge>
      </div>

      {liquorLedger && (
        <div className="mb-3 space-y-1.5 rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>Produced {liquorLedger.produced}</span>
            <span>Sold {liquorLedger.sold}</span>
            {liquorLedger.dumped > 0 && (
              <span className="text-amber-300">Dumped {liquorLedger.dumped}</span>
            )}
            {(liquorLedger.shrunk ?? 0) > 0 && (
              <span className="text-heat">Lost {liquorLedger.shrunk}</span>
            )}
            {liquorLedger.stolen > 0 && (
              <span className="text-heat">Stolen {liquorLedger.stolen}</span>
            )}
            {liquorLedger.seized > 0 && (
              <span className="text-heat">Seized {liquorLedger.seized}</span>
            )}
            <span className={ledgerNet >= 0 ? "text-money" : "text-heat"}>
              Net {ledgerNet >= 0 ? "+" : ""}
              {formatMoney(ledgerNet)}
            </span>
            {liquorLedger.heat > 0 && (
              <span className="text-heat">Heat +{liquorLedger.heat}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {(liquorLedger.shrunk ?? 0) > 0 && (
              <Badge className="bg-heat/20 text-[9px] text-heat">Pilferage</Badge>
            )}
            {liquorLedger.dumped > 0 && (
              <Badge className="bg-amber-500/20 text-[9px] text-amber-300">
                Backed up
              </Badge>
            )}
            {drySpeakeasies && (
              <Badge
                className="bg-heat/20 text-[9px] text-heat"
                title="A speakeasy only pours what's in its own district. Open a supply route to feed it."
              >
                Dry speakeasies — open a supply route
              </Badge>
            )}
            {totalIdleCost > 0 && (
              <Badge className="bg-amber-500/20 text-[9px] text-amber-300">
                Idle capacity
              </Badge>
            )}
            {anyStashHeat && (
              <Badge className="bg-heat/20 text-[9px] text-heat">
                Exposed stash
              </Badge>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 rounded border border-panel-border bg-panel/40 p-2.5">
        <h3 className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          Buy whisky
        </h3>
        {buyDests.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Need a managed warehouse with free space.
          </p>
        ) : (
          <div className="space-y-2">
            <label className="block text-[10px] text-muted-foreground">
              Destination
              <select
                value={effectiveBuyDest}
                onChange={(e) => {
                  setBuyDestId(e.target.value);
                  const dest = owned.find((t) => t.id === e.target.value);
                  if (dest) {
                    const free = districtStorage(dest, turn, lookup).free;
                    setBuyQty(Math.min(buyQty, Math.max(5, free)));
                  }
                }}
                className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
              >
                {buyDests.map((t) => {
                  const free = districtStorage(t, turn, lookup).free;
                  return (
                    <option key={t.id} value={t.id}>
                      {t.name} ({free} free)
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="block text-[10px] text-muted-foreground">
              Crates (min 5)
              <input
                type="number"
                min={5}
                step={5}
                max={Math.max(5, buyFree)}
                value={qty}
                onChange={(e) => setBuyQty(Number(e.target.value) || 5)}
                className="mt-0.5 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span>
                Cost {formatMoney(cost)}
                {pay ? ` · ${formatPaymentParts(pay)}` : " · cannot afford"}
              </span>
              <Badge className="bg-amber-500/20 text-[9px] text-amber-300">
                Seizure {(seizeP * 100).toFixed(0)}%
              </Badge>
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={!pay || buyFree < 5}
              onClick={() => buyWhisky(effectiveBuyDest, qty)}
            >
              <Wine className="mr-1.5 h-3.5 w-3.5" />
              Buy {qty} crates
            </Button>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Warehouses ({warehouseDistricts.length})
        </h3>
        {warehouseDistricts.length === 0 ? (
          <div className="rounded border border-dashed border-panel-border p-4 text-center text-xs text-muted-foreground">
            <Wine className="mx-auto mb-2 h-6 w-6 opacity-50" />
            Build a warehouse and assign a manager.
          </div>
        ) : (
          <div className="space-y-3">
            {warehouseDistricts.map((t) => {
              const storage = districtStorage(t, turn, lookup);
              const unguarded = isUnguarded(t, activeCrewIds(crew));
              const raidMult = districtRaidMult(t, lookup);
              const raidP = stashRaidChance(
                storage.stored,
                heat.level,
                unguarded,
                bribes,
                raidMult,
              );
              const managed = hasManagedWarehouse(t, lookup, turn);
              const warehouses = t.rackets.filter((r) => r.type === "warehouse");
              const form = getSendForm(t.id);
              const otherManaged = managedDistricts.filter((d) => d.id !== t.id);
              const destId =
                form.destId && otherManaged.some((d) => d.id === form.destId)
                  ? form.destId
                  : otherManaged[0]?.id ?? "";
              const driverId =
                form.driverId && idleDrivers.some((c) => c.id === form.driverId)
                  ? form.driverId
                  : idleDrivers[0]?.id ?? "";
              const maxSend = Math.max(1, storage.stored);
              const sendCrates = Math.min(
                Math.max(1, form.crates || 1),
                maxSend,
              );
              const preview =
                driverId && destId && managed
                  ? mockRoute(
                      territories,
                      playerFamily,
                      driverId,
                      t.id,
                      destId,
                      sendCrates,
                    )
                  : null;
              const hijack = preview ? hijackRisk(fullState, preview) : null;

              return (
                <div
                  key={t.id}
                  className="rounded border border-panel-border bg-panel/40 p-2.5"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="text-left text-xs font-semibold hover:underline"
                      onClick={() => {
                        selectTerritory(t.id);
                        setPanel("district");
                      }}
                    >
                      {t.name}
                    </button>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!managed && (
                        <Badge className="bg-heat/20 text-[9px] text-heat">
                          Unmanaged
                        </Badge>
                      )}
                      {unguarded && (
                        <Badge className="bg-heat/20 text-[9px] text-heat">
                          Unguarded
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[9px]">
                        Raid {(raidP * 100).toFixed(0)}%
                      </Badge>
                    </div>
                  </div>

                  {warehouses.map((wh) => {
                    const mgr = lookup(wh);
                    const mods = warehouseManagerMods(mgr);
                    return (
                      <div
                        key={wh.id}
                        className="mb-2 rounded border border-panel-border/60 bg-panel/30 p-1.5"
                      >
                        <div className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="text-muted-foreground">
                            Manager
                            {mgr ? `: ${mgr.name}` : ""}
                            {mods.managed ? ` · smarts ${mods.score}` : ""}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {warehouseManagerEffectText(mgr, wh.stock)}
                        </p>
                        {!mods.managed && (
                          <select
                            value=""
                            onChange={(e) => {
                              const id = e.target.value;
                              if (id) assignManager(t.id, wh.id, id);
                            }}
                            className="mt-1 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                          >
                            <option value="">Assign manager…</option>
                            {managerCandidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} (smarts {c.skills.smarts}
                                {c.traits.includes("bookkeeper")
                                  ? ", bookkeeper"
                                  : ""}
                                )
                              </option>
                            ))}
                          </select>
                        )}
                        {mods.managed && (
                          <select
                            value={wh.managerId ?? ""}
                            onChange={(e) => {
                              const id = e.target.value;
                              assignManager(t.id, wh.id, id || null);
                            }}
                            className="mt-1 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                          >
                            <option value="">Remove manager</option>
                            {[
                              ...(wh.managerId ? crew.filter((c) => c.id === wh.managerId) : []),
                              ...managerCandidates.filter((c) => c.id !== wh.managerId),
                            ].map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} (smarts {c.skills.smarts}
                                {c.traits.includes("bookkeeper")
                                  ? ", bookkeeper"
                                  : ""}
                                )
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}

                  <div className="mb-2 space-y-1.5">
                    {t.rackets
                      .filter((r) => isStorageType(r.type))
                      .map((r) => {
                        const capR = stockCap(r, lookup(r));
                        const frozen = isRacketFrozen(r, turn);
                        const pct =
                          capR > 0 ? Math.min(100, (r.stock / capR) * 100) : 0;
                        const Icon = RACKET_VISUALS[r.type].Icon;
                        return (
                          <div key={r.id} className="space-y-0.5">
                            <div className="flex items-center gap-1.5 text-[10px]">
                              <Icon
                                className="h-3 w-3"
                                style={{ color: RACKET_VISUALS[r.type].emissive }}
                              />
                              <span className="text-muted-foreground">
                                {RACKET_LABELS[r.type]}
                              </span>
                              <span className="ml-auto font-medium">
                                {r.stock}/{capR}
                              </span>
                              {frozen && (
                                <Badge className="bg-heat/30 text-[8px] text-heat">
                                  Frozen
                                </Badge>
                              )}
                              {!frozen && r.stock >= capR && capR > 0 && (
                                <Badge className="bg-amber-500/20 text-[8px] text-amber-300">
                                  Full
                                </Badge>
                              )}
                              {r.type === "speakeasy" && r.stock === 0 && (
                                <Badge className="bg-heat/20 text-[8px] text-heat">
                                  Dry
                                </Badge>
                              )}
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-steel/70"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>

                  {managed && storage.stored > 0 && otherManaged.length > 0 && (
                    <div className="space-y-1.5 border-t border-panel-border pt-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Send crates
                      </p>
                      <select
                        value={destId}
                        onChange={(e) =>
                          patchSendForm(t.id, { destId: e.target.value })
                        }
                        className="w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                      >
                        {otherManaged.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min={1}
                          max={maxSend}
                          value={sendCrates}
                          onChange={(e) =>
                            patchSendForm(t.id, {
                              crates: Number(e.target.value) || 1,
                            })
                          }
                          className="w-20 rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                        />
                        <select
                          value={driverId}
                          onChange={(e) =>
                            patchSendForm(t.id, { driverId: e.target.value })
                          }
                          className="min-w-0 flex-1 rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                        >
                          {idleDrivers.length === 0 && (
                            <option value="">No idle crew</option>
                          )}
                          {idleDrivers.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} (drive {c.skills.driving})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        {hijack != null ? (
                          <Badge className="bg-amber-500/20 text-[9px] text-amber-300">
                            Hijack {(hijack * 100).toFixed(0)}%
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            {destId ? "No route" : "Pick destination"}
                          </span>
                        )}
                        <Button
                          size="sm"
                          className="h-7 text-[11px]"
                          disabled={
                            !driverId || !destId || !preview || sendCrates < 1
                          }
                          onClick={() =>
                            startDelivery(driverId, t.id, destId, sendCrates)
                          }
                        >
                          Send
                        </Button>
                      </div>
                    </div>
                  )}
                  {!managed && (
                    <p className="border-t border-panel-border pt-2 text-[10px] text-muted-foreground">
                      Assign a manager to buy, send, or receive crates here.
                    </p>
                  )}
                  {managed && otherManaged.length === 0 && storage.stored > 0 && (
                    <p className="border-t border-panel-border pt-2 text-[10px] text-muted-foreground">
                      Need another managed warehouse to send crates.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}
    </PanelShell>
  );
}
