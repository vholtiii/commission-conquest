import { useState } from "react";
import { HandCoins } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";

type BribeKey = "cops" | "captains" | "chiefs" | "mayor";

const BRIBE_INFO: Record<BribeKey, { label: string; blurb: string; cost: number }> = {
  cops: {
    label: "Beat Cops",
    blurb: "Watch one rival district — reveals faces for 3 turns.",
    cost: 500,
  },
  captains: { label: "Precinct Captains", blurb: "Longer heat relief and eased raids.", cost: 2000 },
  chiefs: {
    label: "Police Chiefs",
    blurb: "Open the books on a whole family for 7 turns.",
    cost: 8000,
  },
  mayor: { label: "City Hall", blurb: "Best heat relief and shuts down investigations.", cost: 25000 },
};

const ORDER: BribeKey[] = ["cops", "captains", "chiefs", "mayor"];

export default function CorruptionPanel() {
  const money = useGameStore((s) => s.money);
  const bribes = useGameStore((s) => s.bribes);
  const tryBribe = useGameStore((s) => s.tryBribe);
  const territories = useGameStore((s) => s.territories);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);

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
                <span className="text-xs text-money">{formatMoney(info.cost)}</span>
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
