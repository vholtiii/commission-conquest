import CityScene from "@/scene/CityScene";
import { useGameStore } from "@/engine/store";
import TopBar from "./TopBar";
import LeftToolbar from "./LeftToolbar";
import RightRoster from "./RightRoster";
import FamilySelectScreen from "./FamilySelectScreen";
import VictoryOverlay from "./VictoryOverlay";
import DistrictPanel from "./panels/DistrictPanel";
import RacketBuildPanel from "./panels/RacketBuildPanel";
import CapturePanel from "./panels/CapturePanel";
import LaunderingPanel from "./panels/LaunderingPanel";
import WarehousePanel from "./panels/WarehousePanel";
import HitPlanner, { HitResultModal } from "./panels/HitPlanner";
import LookoutReportModal from "./panels/LookoutReportModal";
import CrewPanel from "./panels/CrewPanel";
import CrewSheet from "./panels/CrewSheet";
import CorruptionPanel from "./panels/CorruptionPanel";
import CommissionPanel from "./panels/CommissionPanel";
import TurnLogDrawer from "./panels/TurnLogDrawer";
import MenuPanel from "./panels/MenuPanel";
import EventModal from "./panels/EventModal";
import PanelShell from "./panels/PanelShell";
import HitCaptions from "./HitCaptions";
import MapLegend from "./MapLegend";
import TurnDigest from "./TurnDigest";
import { useMapView } from "@/engine/mapView";
import { RACKET_LABELS } from "@/types/game";
import { isLegitBusiness, launderSiteStatus } from "@/engine/economy";

function RacketsOverviewPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);
  const turn = useGameStore((s) => s.turn);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const rackets = territories
    .filter((t) => t.owner === playerFamily)
    .flatMap((t) => t.rackets.map((r) => ({ racket: r, territory: t })));

  return (
    <PanelShell title="Rackets" subtitle={`${rackets.length} operations running`}>
      <div className="space-y-1.5">
        {rackets.length === 0 && <p className="text-xs text-muted-foreground">No rackets yet — select a district you own.</p>}
        {rackets.map(({ racket, territory }) => {
          const frozen = (racket.frozenUntil ?? 0) > turn;
          const siteStatus = isLegitBusiness(racket.type)
            ? launderSiteStatus(racket, turn)
            : "off";
          return (
          <button
            key={racket.id}
            onClick={() =>
              selectTerritory(territory.id, {
                toastLabel: RACKET_LABELS[racket.type],
                racketId: racket.id,
              })
            }
            className="flex w-full items-center justify-between rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-left hover:bg-panel-elevated"
          >
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {RACKET_LABELS[racket.type]}
                {frozen && (
                  <span className="rounded bg-heat/30 px-1 text-[9px] uppercase text-heat">
                    Frozen
                  </span>
                )}
                {siteStatus === "ready" && (
                  <span className="rounded bg-money/20 px-1 text-[9px] uppercase text-money">
                    Laundering
                  </span>
                )}
                {siteStatus === "setting_up" && (
                  <span className="rounded bg-amber-500/20 px-1 text-[9px] uppercase text-amber-300">
                    Setting up
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">{territory.name}</div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              Lv {racket.level}
              <br />
              Stock {racket.stock}
            </div>
          </button>
          );
        })}
      </div>
    </PanelShell>
  );
}

function OperationsOverviewPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const operations = useGameStore((s) => s.operations);
  const crew = useGameStore((s) => s.crew);
  const territories = useGameStore((s) => s.territories);
  const intel = useGameStore((s) => s.intel);
  const selectTerritory = useGameStore((s) => s.selectTerritory);
  const ops = operations.filter((o) => o.family === playerFamily && !o.resolved);
  const reports = Object.values(intel?.reports ?? {})
    .sort((a, b) => b.turn - a.turn)
    .slice(0, 5);

  return (
    <PanelShell title="Operations" subtitle={`${ops.length} pending`}>
      <div className="space-y-1.5">
        {ops.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No operations in motion. Select a rival district to plan a hit.
          </p>
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
              className="flex w-full flex-col rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-left hover:bg-panel-elevated"
            >
              <span className="text-sm font-medium">
                {isSurv
                  ? "Surveillance"
                  : (op.approach?.replace("_", " ") ?? "Hit")}{" "}
                vs {target?.name ?? op.targetFamily}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {isSurv
                  ? "Report next turn"
                  : op.pendingTurns > 0
                    ? `Resolves in ${op.pendingTurns} turn(s)`
                    : "Resolving next turn"}
              </span>
            </button>
          );
        })}
      </div>

      {reports.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-panel-border pt-2">
          <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Reports
          </h3>
          {reports.map((r) => {
            const name =
              territories.find((t) => t.id === r.territoryId)?.name ?? r.territoryId;
            const outcome =
              r.outcome === "clean"
                ? "CLEAN"
                : r.outcome === "spotted_wounded"
                  ? "WOUNDED"
                  : "SPOTTED";
            return (
              <button
                key={r.id}
                onClick={() =>
                  selectTerritory(r.territoryId, { toastLabel: "Lookout report" })
                }
                className="flex w-full flex-col rounded-md border border-panel-border bg-panel/40 px-3 py-2 text-left hover:bg-panel-elevated"
              >
                <span className="flex items-center justify-between gap-2 text-sm font-medium">
                  <span>{name}</span>
                  <span
                    className={`text-[9px] uppercase ${
                      r.outcome === "clean" ? "text-money" : "text-amber-300"
                    }`}
                  >
                    {outcome}
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  T{r.turn} · {r.spottedIds.length} men · garrison {r.garrison}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </PanelShell>
  );
}

function ActivePanel() {
  const activePanel = useGameStore((s) => s.activePanel);

  switch (activePanel) {
    case "district":
      return <DistrictPanel />;
    case "racket_build":
      return <RacketBuildPanel />;
    case "capture":
      return <CapturePanel />;
    case "hit_planner":
      return <HitPlanner />;
    case "crew":
      return <CrewPanel />;
    case "crew_sheet":
      return <CrewSheet />;
    case "rackets":
      return <RacketsOverviewPanel />;
    case "laundering":
      return <LaunderingPanel />;
    case "warehouse":
      return <WarehousePanel />;
    case "operations":
      return <OperationsOverviewPanel />;
    case "corruption":
      return <CorruptionPanel />;
    case "commission":
      return <CommissionPanel />;
    case "log":
      return <TurnLogDrawer />;
    case "menu":
      return <MenuPanel />;
    default:
      return null;
  }
}

export default function GameShell() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const cinematicPlaying = useGameStore(
    (s) => s.cinematicQueue.length > 0 && !s.pendingHitResult,
  );
  const overview = useMapView((s) => s.overview);

  if (!playerFamily) {
    return <FamilySelectScreen />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background font-ui">
      <TopBar />
      <div className="relative flex flex-1 overflow-hidden">
        <div className={cinematicPlaying ? "pointer-events-none" : undefined}>
          <LeftToolbar />
        </div>

        <div className="relative z-0 flex-1">
          <CityScene />

          {overview && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2">
              <div className="rounded-md border border-panel-border bg-panel/90 px-3 py-1.5 text-center text-[11px] font-ui text-muted-foreground shadow-lg backdrop-blur-sm">
                Strategic view — scroll in or click a district to return
              </div>
            </div>
          )}

          <TurnDigest />

          <div className="pointer-events-none absolute inset-0 z-40 flex items-start p-4">
            <div
              className={
                cinematicPlaying
                  ? "pointer-events-none opacity-40"
                  : "pointer-events-auto relative z-40"
              }
            >
              <ActivePanel />
            </div>
          </div>

          <div className="relative z-30">
            <MapLegend />
          </div>
          <HitCaptions />
          <EventModal />
          <HitResultModal />
          <LookoutReportModal />
          <VictoryOverlay />
        </div>

        <div className={cinematicPlaying ? "pointer-events-none opacity-40" : undefined}>
          <RightRoster />
        </div>
      </div>
    </div>
  );
}
