import type { RacketType } from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import { useGameStore } from "@/engine/store";
import {
  LAUNDER_RULES,
  RACKET_BUILD_COST,
  fundingLabel,
  isLegitBusiness,
  paymentShortfall,
  racketFunding,
  racketPayment,
} from "@/engine/economy";
import { maxRacketsFor, allowedRacketTypes, lotTier, lotTierLabel, lotTierHint } from "@/engine/territoryValue";
import { BOSS_PRESENCE, bossPresentIn, presenceBuildCost } from "@/engine/bossPresence";
import { Badge } from "@/components/ui/badge";
import Tip from "@/ui/Tip";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";

const VICE_ORDER: RacketType[] = [
  "still",
  "brewery",
  "warehouse",
  "speakeasy",
  "gambling",
  "brothel",
  "loan_shark",
];

const LEGIT_ORDER: RacketType[] = [
  "laundromat",
  "deli",
  "barber",
  "restaurant",
  "trucking",
];

const RACKET_BLURB: Record<RacketType, string> = {
  still: "Cheap moonshine — produces 5+3L crates/turn.",
  brewery: "Bigger batches — produces 8+4L crates/turn.",
  warehouse: "Liquor hub. Needs a manager (smarts) or crates walk out the back.",
  speakeasy: "Sells crates — needs supply.",
  gambling: "High dirty income, moderate heat.",
  brothel: "Highest dirty income, highest heat.",
  loan_shark: "Steady dirty income, low stock needs.",
  laundromat: `Washes up to $${LAUNDER_RULES.laundromat.capPerLevel}/lvl at a ${LAUNDER_RULES.laundromat.cut * 100}% cut.`,
  deli: `Washes up to $${LAUNDER_RULES.deli.capPerLevel}/lvl at a ${LAUNDER_RULES.deli.cut * 100}% cut.`,
  barber: `Washes up to $${LAUNDER_RULES.barber.capPerLevel}/lvl at a ${LAUNDER_RULES.barber.cut * 100}% cut.`,
  restaurant: `Washes up to $${LAUNDER_RULES.restaurant.capPerLevel}/lvl at a ${LAUNDER_RULES.restaurant.cut * 100}% cut.`,
  trucking: `Washes up to $${LAUNDER_RULES.trucking.capPerLevel}/lvl at a ${LAUNDER_RULES.trucking.cut * 100}% cut.`,
  safehouse: "Garrisoned crew shed wanted status; raids and shakedowns falter here. No income.",
};

function fundingBadgeClass(funding: ReturnType<typeof racketFunding>): string {
  if (funding === "clean") return "bg-money/20 text-money";
  if (funding === "dirty") return "bg-heat/20 text-heat";
  return "bg-amber-500/20 text-amber-300";
}

const HIDEOUT_ORDER: RacketType[] = ["safehouse"];

function buildTip(
  type: RacketType,
  full: boolean,
  money: number,
  dirtyMoney: number,
  bossHere: boolean,
  denied?: string,
): string {
  if (denied) return denied;
  const cost = presenceBuildCost(RACKET_BUILD_COST[type], bossHere);
  const funding = fundingLabel(racketFunding(type));
  if (full) return "District slots full — upgrade buildings or clear a racket elsewhere.";
  const short = paymentShortfall(type, cost, money, dirtyMoney);
  if (short) {
    return `Cannot afford ${formatMoney(cost)} (${funding}). Need ${formatMoney(short.amount)} more.`;
  }
  const discount = bossHere
    ? ` The boss is on this block — ${Math.round(BOSS_PRESENCE.buildDiscount * 100)}% off, was ${formatMoney(RACKET_BUILD_COST[type])}.`
    : "";
  return `${RACKET_BLURB[type]} Costs ${formatMoney(cost)} (${funding}).${discount}`;
}

function TypeButton({
  type,
  full,
  money,
  dirtyMoney,
  bossHere,
  denied,
  onBuild,
}: {
  type: RacketType;
  full: boolean;
  money: number;
  dirtyMoney: number;
  bossHere: boolean;
  denied?: string;
  onBuild: () => void;
}) {
  const cost = presenceBuildCost(RACKET_BUILD_COST[type], bossHere);
  const funding = racketFunding(type);
  const pay = racketPayment(type, cost, money, dirtyMoney);
  const short = paymentShortfall(type, cost, money, dirtyMoney);
  const canAfford = !!pay && !full && !denied;

  return (
    <Tip wrapDisabled content={buildTip(type, full, money, dirtyMoney, bossHere, denied)}>
      <button
        type="button"
        disabled={!canAfford}
        onClick={onBuild}
        className="flex w-full flex-col gap-1 rounded border border-panel-border bg-panel/50 px-3 py-2 text-left transition-colors hover:bg-panel-elevated disabled:cursor-not-allowed disabled:opacity-40"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold">{RACKET_LABELS[type]}</span>
          <span className={`text-[11px] ${bossHere ? "text-amber-300" : "text-muted-foreground"}`}>
            {formatMoney(cost)}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground">{RACKET_BLURB[type]}</p>
        <div className="flex flex-wrap gap-1">
          <Badge className={fundingBadgeClass(funding)}>{fundingLabel(funding)}</Badge>
          {isLegitBusiness(type) && (
            <Badge variant="outline" className="text-[9px]">
              Clean income
            </Badge>
          )}
          {denied && (
            <Badge variant="outline" className="text-[9px]">
              Lot too thin
            </Badge>
          )}
          {!denied && short && (
            <Badge className="bg-heat/20 text-heat">
              Need {formatMoney(short.amount)} more
            </Badge>
          )}
        </div>
      </button>
    </Tip>
  );
}

export default function RacketBuildPanel() {
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const territories = useGameStore((s) => s.territories);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const buildRacket = useGameStore((s) => s.buildRacket);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const turn = useGameStore((s) => s.turn);

  const territory = territories.find((t) => t.id === selectedTerritoryId);
  if (!territory) return null;
  const bossHere =
    !!playerFamily &&
    bossPresentIn({ crew, territories, routes, operations, playerFamily, turn }, playerFamily, territory.id);

  const slots = maxRacketsFor(territory);
  const full = territory.rackets.length >= slots;
  const tier = lotTier(territory);
  const allowed = new Set(allowedRacketTypes(territory));
  const tierLabel = lotTierLabel(tier);
  const denied = tierLabel ? lotTierHint(tier) : undefined;

  return (
    <PanelShell
      title="Build Racket"
      subtitle={`${territory.name} — ${territory.rackets.length}/${slots} slots (${territory.buildingBlocks ?? 0} buildings${tierLabel ? ` · ${tierLabel}` : ""})${bossHere ? ` · boss here, ${Math.round(BOSS_PRESENCE.buildDiscount * 100)}% off` : ""}`}
    >
      <div className="mb-3 flex gap-2 text-[11px]">
        <span className="text-money">Clean {formatMoney(money)}</span>
        <span className="text-heat">Dirty {formatMoney(dirtyMoney)}</span>
      </div>

      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Vice & production
      </div>
      <div className="mb-4 space-y-2">
        {VICE_ORDER.map((type) => (
          <TypeButton
            key={type}
            type={type}
            full={full}
            denied={allowed.has(type) ? undefined : denied}
            money={money}
            dirtyMoney={dirtyMoney}
            bossHere={bossHere}
            onBuild={() => buildRacket(territory.id, type)}
          />
        ))}
      </div>

      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Legit businesses
      </div>
      <div className="space-y-2">
        {LEGIT_ORDER.map((type) => (
          <TypeButton
            key={type}
            type={type}
            full={full}
            denied={allowed.has(type) ? undefined : denied}
            money={money}
            dirtyMoney={dirtyMoney}
            bossHere={bossHere}
            onBuild={() => buildRacket(territory.id, type)}
          />
        ))}
      </div>

      <div className="mb-2 mt-4 text-[10px] uppercase tracking-wide text-muted-foreground">
        Hideouts
      </div>
      <div className="space-y-2">
        {HIDEOUT_ORDER.map((type) => (
          <TypeButton
            key={type}
            type={type}
            full={full}
            denied={allowed.has(type) ? undefined : denied}
            money={money}
            dirtyMoney={dirtyMoney}
            bossHere={bossHere}
            onBuild={() => buildRacket(territory.id, type)}
          />
        ))}
      </div>
    </PanelShell>
  );
}
