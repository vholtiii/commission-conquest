import { useState } from "react";
import { HandCoins } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { BRIBE_FAIL_FEE, bribeSuccessRate } from "@/engine/bribes";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";

type BribeKey = "cops" | "captains" | "chiefs" | "mayor";

const BRIBE_INFO: Record<BribeKey, { label: string; blurb: string; cost: number }> = {
  cops: {
    label: "Beat Cops",
    blurb:
      "3 weeks. Heat −5 now, cools 2 more a week, new heat −25%. They name every face in one rival district.",
    cost: 500,
  },
  captains: {
    label: "Precinct Captains",
    blurb: "5 weeks. Heat −2 now, cools 1 more a week, new heat −10%.",
    cost: 2000,
  },
  chiefs: {
    label: "Police Chiefs",
    blurb:
      "7 weeks. Opens the books on one family. Liquor raids and seizures ×0.6, laundering audits ×0.7. Heat −2 now. Rivals learn where your mattresses are.",
    cost: 8000,
  },
  mayor: {
    label: "City Hall",
    blurb:
      "10 weeks. Heat −8 now, cools 3 more a week, new heat −15%. Liquor raids and seizures ×0.4, audits ×0.5, and the judge is far likelier to deal. Rivals learn where your mattresses are.",
    cost: 25000,
  },
};

const ORDER: BribeKey[] = ["cops", "captains", "chiefs", "mayor"];

export default function CorruptionPanel() {
  const money = useGameStore((s) => s.money);
  const bribes = useGameStore((s) => s.bribes);
  const tryBribe = useGameStore((s) => s.tryBribe);
  const territories = useGameStore((s) => s.territories);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const reputation = useGameStore((s) => s.reputation);
  const heat = useGameStore((s) => s.heat);

  const rivalDistricts = territories.filter(
    (t) => t.owner && t.owner !== playerFamily && t.discovered,
  );
  const rivalFamilies = ALL_FAMILY_NAMES.filter((f) => f !== playerFamily);

  const defaultDistrict =
    rivalDistricts.find((t) => t.id === selectedTerritoryId)?.id ??
    rivalDistricts[0]?.id ??
    "";
  const [districtId, setDistrictId] = useState(defaultDistrict);
  const [familyId, setFamilyId] = useState(rivalFamilies[0] ?? "");

  return (
    <PanelShell title="Corruption" subtitle="Grease the right palms">
      <div className="space-y-2.5">
        <p className="text-[11px] text-muted-foreground">
          Paid in clean cash. Respect and fear raise the odds and heat lowers them. A bribe that
          falls through still costs {Math.round(BRIBE_FAIL_FEE * 100)}% of the price and +5 heat.
        </p>
        {ORDER.map((key) => {
          const info = BRIBE_INFO[key];
          const status = bribes[key];
          const canAfford = money >= info.cost;
          const needsDistrict = key === "cops";
          const needsFamily = key === "chiefs";
          const ready =
            canAfford &&
            !status.isActive &&
            (!needsDistrict || !!districtId) &&
            (!needsFamily || !!familyId);

          let activeExtra = "";
          if (status.isActive && status.targetTerritory) {
            const n = territories.find((t) => t.id === status.targetTerritory)?.name;
            if (n) activeExtra = ` — ${n}`;
          }
          if (status.isActive && status.targetFamily) {
            activeExtra = ` — ${status.targetFamily}`;
          }

          return (
            <div key={key} className="rounded-md border border-panel-border bg-panel/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <HandCoins className="h-3.5 w-3.5 text-money" />
                    {info.label}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{info.blurb}</p>
                </div>
                {status.isActive && (
                  <Badge className="whitespace-nowrap bg-emerald-500/20 text-[10px] text-emerald-400">
                    Active {status.turnsRemaining}t{activeExtra}
                  </Badge>
                )}
              </div>
              {needsDistrict && !status.isActive && (
                <select
                  value={districtId}
                  onChange={(e) => setDistrictId(e.target.value)}
                  className="mt-2 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                >
                  <option value="">Select rival district…</option>
                  {rivalDistricts.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.owner})
                    </option>
                  ))}
                </select>
              )}
              {needsFamily && !status.isActive && (
                <select
                  value={familyId}
                  onChange={(e) => setFamilyId(e.target.value)}
                  className="mt-2 w-full rounded-md border border-panel-border bg-panel/60 px-2 py-1 text-xs"
                >
                  <option value="">Select family…</option>
                  {rivalFamilies.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              )}
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-money">
                  {formatMoney(info.cost)}
                  {!status.isActive && (
                    <span className="ml-2 text-muted-foreground">
                      {Math.round(bribeSuccessRate({ reputation, heat }, key) * 100)}% to land
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!ready}
                  onClick={() =>
                    tryBribe(
                      key,
                      needsFamily ? (familyId as typeof rivalFamilies[0]) : undefined,
                      needsDistrict ? districtId : undefined,
                    )
                  }
                  className="h-7 px-3 text-[11px]"
                >
                  Bribe
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}
