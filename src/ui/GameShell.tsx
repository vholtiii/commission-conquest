import CityScene from "@/scene/CityScene";
import { useEffect } from "react";
import { useGameStore } from "@/engine/store";
import { duckAmbience } from "@/audio/ambience";
import TopBar from "./TopBar";
import LeftToolbar from "./LeftToolbar";
import RightRoster from "./RightRoster";
import FamilySelectScreen from "./FamilySelectScreen";
import VictoryOverlay from "./VictoryOverlay";
import DistrictPanel from "./panels/DistrictPanel";
import RacketBuildPanel from "./panels/RacketBuildPanel";
import CapturePanel from "./panels/CapturePanel";
import LaunderingPanel from "./panels/LaunderingPanel";
import LawyerPanel from "./panels/LawyerPanel";
import WarehousePanel from "./panels/WarehousePanel";
import RacketsPanel from "./panels/RacketsPanel";
import HitPlanner, { HitResultModal } from "./panels/HitPlanner";
import LookoutReportModal from "./panels/LookoutReportModal";
import CrewPanel from "./panels/CrewPanel";
import CrewSheet from "./panels/CrewSheet";
import CorruptionPanel from "./panels/CorruptionPanel";
import CommissionPanel from "./panels/CommissionPanel";
import TurnLogDrawer from "./panels/TurnLogDrawer";
import MenuPanel from "./panels/MenuPanel";
import EventModal from "./panels/EventModal";
import CrewRequestModal from "./panels/CrewRequestModal";
import SitdownRequestModal from "./panels/SitdownRequestModal";
import SitdownResultModal from "./panels/SitdownResultModal";
import CommissionRulingModal from "./panels/CommissionRulingModal";
import DealSettlementModal from "./panels/DealSettlementModal";
import PanelShell from "./panels/PanelShell";
import FuneralQuietNote from "./FuneralQuietNote";
import HitCaptions from "./HitCaptions";
import SitdownTable from "./SitdownTable";
import MapLegend from "./MapLegend";
import TurnDigest from "./TurnDigest";
import AiDebugPanel from "./panels/AiDebugPanel";
import TurnCurtain from "./TurnCurtain";
import PanelErrorBoundary from "./PanelErrorBoundary";
import GoalsCard from "./GoalsCard";
import { useMapView } from "@/engine/mapView";
import { livingBoss } from "@/engine/jail";
import { successionReadinessReasons } from "@/engine/succession";
import { Button } from "@/components/ui/button";
import { formatMoney } from "./formatters";

function TombsBanner() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const turn = useGameStore((s) => s.turn);
  const tryBribe = useGameStore((s) => s.tryBribe);
  if (!playerFamily) return null;
  const boss = livingBoss({ crew }, playerFamily);
  if (!boss || boss.status !== "jailed") return null;
  const left = Math.max(0, (boss.jailedUntilTurn ?? turn) - turn);
  const cost = 6000 + 2000 * Math.max(0, boss.wanted);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-heat/50 bg-heat/15 px-4 py-2 text-xs">
      <span>
        Boss in the Tombs — {left} turn{left === 1 ? "" : "s"} until the family passes.
      </span>
      <Button
        size="sm"
        className="h-7 shrink-0 bg-heat text-[11px] hover:bg-heat/80"
        onClick={() => tryBribe("judge")}
      >
        Buy the judge · {formatMoney(cost)}
      </Button>
    </div>
  );
}

function LeaderlessBanner() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const reg = useGameStore((s) => s.interregnum);
  const turn = useGameStore((s) => s.turn);
  const setPanel = useGameStore((s) => s.setPanel);
  if (!reg || reg.family !== playerFamily) return null;
  const left = Math.max(0, reg.deadline - turn);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-heat/50 bg-heat/15 px-4 py-2 text-xs">
      <span>
        No boss: {left} week{left === 1 ? "" : "s"} to crown an heir.
      </span>
      <Button size="sm" className="h-7 shrink-0 text-[11px]" onClick={() => setPanel("crew")}>
        Name an underboss
      </Button>
    </div>
  );
}

function HeirWarning() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const turn = useGameStore((s) => s.turn);
  const reg = useGameStore((s) => s.interregnum);
  if (!playerFamily || reg?.family === playerFamily) return null;
  const boss = livingBoss({ crew }, playerFamily);
  if (!boss || (boss.status !== "jailed" && boss.status !== "wounded")) return null;
  const underboss = crew.find((c) => c.family === playerFamily && c.role === "underboss");
  const missing = underboss
    ? successionReadinessReasons(underboss, turn).filter((r) => !r.met).map((r) => r.label)
    : ["No underboss"];
  if (missing.length === 0) return null;
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200">
      Heir at risk — {missing.join(" · ")}
    </div>
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
      <FuneralQuietNote />
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
      return <RacketsPanel />;
    case "laundering":
      return <LaunderingPanel />;
    case "lawyer":
      return <LawyerPanel />;
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
    (s) =>
      (s.cinematicQueue.length > 0 && !s.pendingHitResult) || s.sitdownPhase != null,
  );
  const overview = useMapView((s) => s.overview);
  const activePanel = useGameStore((s) => s.activePanel);

  useEffect(() => {
    duckAmbience(cinematicPlaying);
  }, [cinematicPlaying]);

  if (!playerFamily) {
    return <FamilySelectScreen />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background font-ui">
      <TopBar />
      <TombsBanner />
      <LeaderlessBanner />
      <HeirWarning />
      <div className="relative flex flex-1 overflow-hidden">
        <div className={cinematicPlaying ? "pointer-events-none" : undefined}>
          <LeftToolbar />
        </div>

        <div className="relative z-0 flex-1">
          <CityScene />
          {!cinematicPlaying && <GoalsCard />}
          <TurnCurtain />

          {overview && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2">
              <div className="rounded-md border border-panel-border bg-panel/90 px-3 py-1.5 text-center text-[11px] font-ui text-muted-foreground shadow-lg backdrop-blur-sm">
                Strategic view — scroll in or click a district to return
              </div>
            </div>
          )}

          <TurnDigest />
          <AiDebugPanel />

          <div className="pointer-events-none absolute inset-0 z-40 flex p-4">
            <div
              className={
                cinematicPlaying
                  ? "pointer-events-none flex h-full min-h-0 max-h-full flex-col opacity-40"
                  : "pointer-events-auto relative z-40 flex h-full min-h-0 max-h-full flex-col"
              }
            >
              <PanelErrorBoundary resetKey={activePanel}>
                <ActivePanel />
              </PanelErrorBoundary>
            </div>
          </div>

          <div className="relative z-30">
            <MapLegend />
          </div>
          <PanelErrorBoundary resetKey="modals">
            <HitCaptions />
            <SitdownTable />
            <EventModal />
            <CrewRequestModal />
            <SitdownRequestModal />
            <HitResultModal />
            <SitdownResultModal />
            <CommissionRulingModal />
            <DealSettlementModal />
            <LookoutReportModal />
            <VictoryOverlay />
          </PanelErrorBoundary>
        </div>

        <div className={cinematicPlaying ? "pointer-events-none opacity-40" : undefined}>
          <RightRoster />
        </div>
      </div>
    </div>
  );
}
