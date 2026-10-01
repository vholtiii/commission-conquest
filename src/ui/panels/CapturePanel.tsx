import { useMemo, useState } from "react";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX } from "@/types/game";
import {
  captureAllowance,
  captureOdds,
  captureStrength,
  eligibleCaptureCrew,
} from "@/engine/capture";
import { captureParty } from "@/engine/crews";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import PortraitAvatar from "@/ui/PortraitAvatar";
import PanelShell from "./PanelShell";
import { dinnerActive } from "@/engine/dinner";

export default function CapturePanel() {
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const captureTerritory = useGameStore((s) => s.captureTerritory);
  const setPanel = useGameStore((s) => s.setPanel);
  const state = useGameStore((s) => s);

  const [picked, setPicked] = useState<string[]>([]);

  const territory = territories.find((t) => t.id === selectedTerritoryId);
  const eligible = useMemo(() => {
    if (!territory || !playerFamily) return [];
    return eligibleCaptureCrew(
      { crew, playerFamily },
      territory.id,
    );
  }, [crew, playerFamily, territory]);

  if (!territory || !playerFamily) return null;
  if (territory.owner === playerFamily) {
    return (
      <PanelShell title="Capture" onClose={() => setPanel("district")}>
        <p className="text-xs text-muted-foreground">You already control this district.</p>
      </PanelShell>
    );
  }

  const party = captureParty(crew, picked);
  const along = party.filter((id) => !picked.includes(id));
  const strength = captureStrength(state, territory.id, party);
  const odds = captureOdds(strength.atk, strength.def);
  const oddsPct = Math.round(odds * 100);
  const allowance = captureAllowance(state, playerFamily, territory);
  const bonusNote =
    allowance.bonusReason === "expansionist"
      ? "Your family moves fast: two districts a week."
      : allowance.bonusReason === "vacuum"
        ? "No boss on this block — it can be a second grab this week."
        : allowance.bonusReason === "vendetta"
          ? "Vendetta: their turf can be a second grab this week."
          : null;

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  return (
    <PanelShell
      title={`Capture ${territory.name}`}
      subtitle={territory.owner ? `${territory.owner} turf` : "Unclaimed"}
      onClose={() => setPanel("district")}
    >
      <div className="mb-3 space-y-1 rounded border border-panel-border bg-panel/50 px-2 py-2 text-[11px] text-muted-foreground">
        <div>
          {strength.defenders.length} defender
          {strength.defenders.length === 1 ? "" : "s"}
          {" · "}
          defense +{Math.round(territory.defenseBonus * 100)}%
          {territory.leadershipVacuum > 0 ? " · leadership vacuum" : ""}
        </div>
        {territory.owner === null && (
          <div className="text-money">Empty block — base garrison resistance only.</div>
        )}
        {strength.notes.map((n) => (
          <div key={n} className={n.startsWith("Your boss") || n.includes("away") ? "text-money" : "text-heat"}>
            {n}
          </div>
        ))}
        <div className={allowance.ok ? "" : "text-heat"}>
          Moves this week: {allowance.used}/{allowance.limit}
          {bonusNote ? ` · ${bonusNote}` : ""}
        </div>
        {dinnerActive(state) && (
          <div className="text-heat">The family is at the table</div>
        )}
        {!allowance.ok && allowance.blocked && (
          <div className="text-heat">{allowance.blocked}</div>
        )}
      </div>

      <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        Squad ({picked.length} selected)
      </h3>
      <p className="mb-2 text-[10px] text-muted-foreground">
        First pick leads. A boss, capo, or consigliere brings his free crew, and they garrison the block if you take it.
      </p>

      {eligible.length === 0 ? (
        <p className="text-xs text-heat">No idle or local garrison crew available.</p>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {eligible.map((c) => {
            const selected = picked.includes(c.id);
            const isLead = picked[0] === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                  selected
                    ? "border-steel/50 bg-steel/15"
                    : "border-panel-border bg-panel/40 hover:bg-panel-elevated"
                }`}
              >
                <Checkbox
                  checked={selected}
                  onCheckedChange={() => toggle(c.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <PortraitAvatar
                  seed={c.portraitSeed}
                  size={28}
                  ringColor={FAMILY_HEX[c.family]}
                  role={c.role}
                  family={c.family}
                  isPlayerBoss={c.isPlayerBoss}
                  alt={c.name}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{c.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {c.role} · muscle {c.skills.muscle}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  {isLead && (
                    <Badge className="bg-money/20 text-[8px] text-money">Leads</Badge>
                  )}
                  {c.role === "boss" && (
                    <Badge className="bg-heat/20 text-[8px] text-heat">Boss</Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {along.length > 0 && (
        <p className="mt-2 text-[10px] text-amber-300">
          Comes along:{" "}
          {along
            .map((id) => crew.find((c) => c.id === id)?.name ?? "a soldier")
            .join(", ")}
          . Their muscle is in the odds.
        </p>
      )}

      <div className="mt-3 rounded border border-panel-border bg-panel/50 px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Win chance</span>
          <span
            className={`font-semibold ${
              oddsPct >= 60 ? "text-money" : oddsPct >= 35 ? "text-amber-300" : "text-heat"
            }`}
          >
            ~{oddsPct}%
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
          <div
            className="h-full rounded-full bg-steel transition-all"
            style={{ width: `${Math.min(100, oddsPct)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
          <span>Atk {Math.round(strength.atk)}</span>
          <span>Def {Math.round(strength.def)}</span>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={() => setPanel("district")}>
          Cancel
        </Button>
        <Button
          className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
          disabled={picked.length < 1 || !allowance.ok || dinnerActive(state)}
          onClick={() => captureTerritory(territory.id, picked)}
        >
          Attack
        </Button>
      </div>
    </PanelShell>
  );
}
