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
  const nextTurn = useGameStore((s) => s.nextTurn);

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
            Turn {turn} &middot; {formatDate(date)} · Wanted {boss?.wanted ?? 0} · Heir {heir}
          </span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center gap-5 overflow-x-auto text-xs">
        <Stat icon={<Users className="h-3.5 w-3.5 text-steel-light" />} label="Crew" value={String(crewCount)} />
        <Stat label="Clean" value={formatMoney(money)} valueClassName="text-money" />
        <Stat label="Dirty" value={formatMoney(dirtyMoney)} valueClassName="text-muted-foreground" />
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
        <Stat
          icon={
            netPositive ? (
              <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-heat" />
            )
          }
          label="Net"
          value={formatDelta(lastNetIncome)}
          valueClassName={netPositive ? "text-emerald-400" : "text-heat"}
        />
        <Stat
          icon={<ShieldAlert className="h-3.5 w-3.5 text-heat" />}
          label="Heat"
          value={`${Math.round(heat.level)}`}
          valueClassName="text-heat"
        />
        <Stat
          icon={<Award className="h-3.5 w-3.5 text-steel-light" />}
          label="Respect"
          value={String(Math.round(reputation.respect))}
          sub={respectHint}
        />
        <Stat
          icon={<Flame className="h-3.5 w-3.5 text-steel-light" />}
          label="Fear"
          value={String(Math.round(reputation.fear))}
        />
        <Stat
          icon={<Footprints className="h-3.5 w-3.5 text-steel-light" />}
          label="Street"
          value={String(Math.round(reputation.streetInfluence))}
        />
        <Stat
          icon={<Landmark className="h-3.5 w-3.5 text-steel-light" />}
          label="Influence"
          value={String(Math.round(influence))}
          sub={infHint}
        />
      </div>

      <Button
        variant="default"
        size="lg"
        className="shrink-0 bg-steel font-ui font-bold uppercase tracking-wide text-white hover:bg-steel-light disabled:opacity-40"
        disabled={!!activeEvent}
        onClick={() => nextTurn()}
      >
        Next Turn
      </Button>
    </header>
  );
}

function Stat({
  icon,
  label,
  value,
  valueClassName,
  sub,
  subClassName,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
  sub?: string;
  subClassName?: string;
}) {
  return (
    <div className="flex flex-col items-center leading-none">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <span className={`font-ui text-sm font-semibold ${valueClassName ?? "text-foreground"}`}>{value}</span>
      {sub && (
        <span className={`text-[9px] ${subClassName ?? "text-muted-foreground"}`}>{sub}</span>
      )}
    </div>
  );
}
