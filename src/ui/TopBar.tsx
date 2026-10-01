import { useEffect, useRef } from "react";
import { Users, ShieldAlert, Landmark, TrendingUp, TrendingDown, Wine, Award, Flame, Footprints } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { getFamilyDef } from "@/data/families";
import { getBoss } from "@/engine/crew";
import { successionReadinessReasons } from "@/engine/succession";
import { influenceTick } from "@/engine/victory";
import { totalCapacity, totalCrates } from "@/engine/liquor";
import { nextRecruitTier, recruitTier } from "@/engine/recruiting";
import { Button } from "@/components/ui/button";
import { formatDate, formatDelta, formatMoney } from "./formatters";
import WantedTag from "./WantedTag";
import { useTurnTransition } from "./turnTransition";
import { useAnimatedNumber, type StatFlash } from "./useAnimatedNumber";
import { cn } from "@/lib/utils";

const CLOSE_MS = 220;
const HOLD_MS = 450;
const OPEN_MS = 250;

function turnIsBlocked(): boolean {
  const s = useGameStore.getState();
  return (
    !s.playerFamily ||
    !!s.activeEvent ||
    s.cinematicQueue.length > 0 ||
    !!s.pendingHitResult ||
    (s.sitdownCinematicQueue?.length ?? 0) > 0 ||
    s.sitdownPhase != null ||
    (s.pendingSitdownResults?.length ?? 0) > 0 ||
    (s.pendingRulings?.length ?? 0) > 0 ||
    (s.pendingReports?.length ?? 0) > 0
  );
}

export default function TopBar() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const date = useGameStore((s) => s.date);
  const crew = useGameStore((s) => s.crew);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const lastNetIncome = useGameStore((s) => s.lastNetIncome);
  const heat = useGameStore((s) => s.heat);
  const influence = useGameStore((s) => s.influence);
  const reputation = useGameStore((s) => s.reputation);
  const territories = useGameStore((s) => s.territories);
  const liquorLedger = useGameStore((s) => s.liquorLedger);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const cinematicQueued = useGameStore((s) => s.cinematicQueue.length > 0);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const sitdownQueued = useGameStore((s) => (s.sitdownCinematicQueue?.length ?? 0) > 0);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);
  const pendingSitdowns = useGameStore((s) => (s.pendingSitdownResults?.length ?? 0) > 0);
  const pendingRuling = useGameStore((s) => (s.pendingRulings?.length ?? 0) > 0);
  const pendingReports = useGameStore((s) => (s.pendingReports?.length ?? 0) > 0);
  const nextTurn = useGameStore((s) => s.nextTurn);
  const phase = useTurnTransition((s) => s.phase);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const bucket = timers.current;
    return () => {
      for (const id of bucket) window.clearTimeout(id);
      useTurnTransition.getState().setPhase("idle");
    };
  }, []);

  if (!playerFamily) return null;
  const def = getFamilyDef(playerFamily);
  const boss = getBoss(crew, playerFamily);
  const underboss = crew.find(
    (c) => c.family === playerFamily && c.role === "underboss" && c.status !== "dead",
  );
  const heir = !underboss
    ? "None"
    : successionReadinessReasons(underboss, turn).every((r) => r.met)
      ? "Secure"
      : "At risk";
  const crewCount = crew.filter((c) => c.family === playerFamily && c.status !== "dead").length;
  const netPositive = lastNetIncome >= 0;
  const infDelta = influenceTick(reputation);
  const infHint = `${infDelta >= 0 ? "+" : ""}${infDelta.toFixed(1)}/t`;
  const respectTier = recruitTier(reputation.respect);
  const respectNext = nextRecruitTier(reputation.respect);
  const respectHint = respectNext
    ? `${respectTier.label} · ${respectTier.walkIns}/wk · next ${respectNext.min}`
    : `${respectTier.label} · ${respectTier.walkIns}/wk`;
  const liquorState = {
    territories,
    turn,
    crew,
    playerFamily,
  } as Parameters<typeof totalCrates>[0];
  const stored = totalCrates(liquorState, playerFamily);
  const cap = totalCapacity(liquorState, playerFamily);
  const liquorNet = liquorLedger ? liquorLedger.cashIn - liquorLedger.cashOut : null;

  const blocked =
    !!activeEvent ||
    cinematicQueued ||
    !!pendingHitResult ||
    sitdownQueued ||
    sitdownPhase != null ||
    pendingSitdowns ||
    pendingRuling ||
    pendingReports;

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
  };

  const endTurn = () => {
    if (useTurnTransition.getState().phase !== "idle" || turnIsBlocked()) return;
    useTurnTransition.getState().begin();
    later(CLOSE_MS, () => {
      try {
        nextTurn();
      } finally {
        const open = () => {
          useTurnTransition.getState().setPhase("opening");
          later(OPEN_MS, () => useTurnTransition.getState().setPhase("idle"));
        };
        if (turnIsBlocked()) open();
        else {
          useTurnTransition.getState().setPhase("hold");
          later(HOLD_MS, open);
        }
      }
    });
  };

  return (
    <header className="panel-surface flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: def.hex, boxShadow: `0 0 8px ${def.hex}` }}
        />
        <div className="flex flex-col leading-none">
          <span className="font-display text-sm text-foreground">{def.name} Family</span>
          <span className="text-[11px] text-muted-foreground">
            Turn {turn} &middot; {formatDate(date)} ·{" "}
            {boss ? (
              <WantedTag member={boss} className="capitalize" showReducers={false} />
            ) : (
              "Wanted 0"
            )}{" "}
            · Heir {heir}
          </span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center gap-5 overflow-visible text-xs">
        <AnimatedStat
          icon={<Users className="h-3.5 w-3.5 text-steel-light" />}
          label="Crew"
          value={crewCount}
          format={(n) => String(Math.round(n))}
        />
        <AnimatedStat label="Clean" value={money} format={formatMoney} chip={formatDelta} valueClassName="text-money" />
        <AnimatedStat
          label="Dirty"
          value={dirtyMoney}
          format={formatMoney}
          chip={formatDelta}
          valueClassName="text-muted-foreground"
        />
        <Stat
          icon={<Wine className="h-3.5 w-3.5 text-steel-light" />}
          label="Crates"
          value={`${stored}/${cap}`}
          sub={
            liquorNet != null
              ? `${liquorNet >= 0 ? "+" : ""}${formatMoney(liquorNet)}`
              : undefined
          }
          subClassName={
            liquorNet != null
              ? liquorNet >= 0
                ? "text-emerald-400"
                : "text-heat"
              : undefined
          }
        />
        <AnimatedStat
          icon={
            netPositive ? (
              <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-heat" />
            )
          }
          label="Net"
          value={lastNetIncome}
          format={formatDelta}
          chip={formatDelta}
          valueClassName={netPositive ? "text-emerald-400" : "text-heat"}
        />
        <AnimatedStat
          icon={<ShieldAlert className="h-3.5 w-3.5 text-heat" />}
          label="Heat"
          value={heat.level}
          format={(n) => String(Math.round(n))}
          valueClassName="text-heat"
        />
        <AnimatedStat
          icon={<Award className="h-3.5 w-3.5 text-steel-light" />}
          label="Respect"
          value={reputation.respect}
          format={(n) => String(Math.round(n))}
          sub={respectHint}
        />
        <AnimatedStat
          icon={<Flame className="h-3.5 w-3.5 text-steel-light" />}
          label="Fear"
          value={reputation.fear}
          format={(n) => String(Math.round(n))}
        />
        <AnimatedStat
          icon={<Footprints className="h-3.5 w-3.5 text-steel-light" />}
          label="Street"
          value={reputation.streetInfluence}
          format={(n) => String(Math.round(n))}
        />
        <AnimatedStat
          icon={<Landmark className="h-3.5 w-3.5 text-steel-light" />}
          label="Influence"
          value={influence}
          format={(n) => String(Math.round(n))}
          sub={infHint}
        />
      </div>

      <Button
        variant="default"
        size="lg"
        className="shrink-0 bg-steel font-ui font-bold uppercase tracking-wide text-white hover:bg-steel-light disabled:opacity-40"
        disabled={blocked || phase !== "idle"}
        onClick={endTurn}
      >
        Next Turn
      </Button>
    </header>
  );
}

function signedCount(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return "";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function AnimatedStat({
  value,
  format,
  chip,
  ...rest
}: {
  icon?: React.ReactNode;
  label: string;
  value: number;
  format: (n: number) => string;
  chip?: (n: number) => string;
  valueClassName?: string;
  sub?: string;
  subClassName?: string;
}) {
  const anim = useAnimatedNumber(value);
  const chipText = anim.flash ? (chip ? chip(anim.delta) : signedCount(anim.delta)) : "";
  return (
    <Stat
      {...rest}
      value={format(anim.display)}
      flash={anim.flash}
      chipText={chipText || undefined}
    />
  );
}

function Stat({
  icon,
  label,
  value,
  valueClassName,
  sub,
  subClassName,
  flash,
  chipText,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
  sub?: string;
  subClassName?: string;
  flash?: StatFlash;
  chipText?: string;
}) {
  return (
    <div className="relative flex flex-col items-center leading-none">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <span className="relative inline-flex items-start">
        <span
          className={cn(
            "font-ui text-sm font-semibold",
            valueClassName ?? "text-foreground",
            flash === "up" && "animate-stat-flash-up",
            flash === "down" && "animate-stat-flash-down",
          )}
        >
          {value}
        </span>
        {chipText && (
          <span
            className={cn(
              "pointer-events-none absolute left-full top-0 ml-0.5 whitespace-nowrap text-[9px] leading-none animate-delta-float",
              flash === "down" ? "text-heat" : "text-emerald-400",
            )}
          >
            {chipText}
          </span>
        )}
      </span>
      {sub && (
        <span className={`text-[9px] ${subClassName ?? "text-muted-foreground"}`}>{sub}</span>
      )}
    </div>
  );
}
