import { AlertTriangle } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { getRelation, relationKey, statusFromScore } from "@/engine/relations";
import {
  canDiplomacy,
  diplomacyHint,
  type DiplomacyAction,
} from "@/engine/diplomacy";
import { emptyIntel, familyHq, isCrewVisible } from "@/engine/intel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PanelShell from "./PanelShell";
import Tip from "@/ui/Tip";
import { titleCase } from "../formatters";

const DIPLOMACY_ACTIONS: { id: DiplomacyAction; label: string; war?: boolean }[] = [
  { id: "sitdown", label: "Sit-down" },
  { id: "tribute", label: "Tribute" },
  { id: "demand", label: "Demand" },
  { id: "pact", label: "Pact" },
  { id: "war", label: "War", war: true },
];

const STATUS_COLOR: Record<string, string> = {
  war: "text-heat",
  hostile: "text-heat",
  cold: "text-muted-foreground",
  neutral: "text-muted-foreground",
  truce: "text-steel-light",
  allied: "text-emerald-400",
};

export default function CommissionPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const relations = useGameStore((s) => s.relations);
  const vendettas = useGameStore((s) => s.vendettas);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
  const influence = useGameStore((s) => s.influence);
  const pacts = useGameStore((s) => s.diplomacy?.pacts);
  const takeDiplomacy = useGameStore((s) => s.takeDiplomacy);

  if (!playerFamily) return null;
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== playerFamily);
  const locState = {
    crew,
    territories,
    routes,
    operations,
    playerFamily,
    intel: intel ?? emptyIntel(),
    turn,
  };

  return (
    <PanelShell title="The Commission" subtitle="Standing among the families">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Influence {Math.round(influence)}
      </p>
      <div className="space-y-2">
        {rivals.map((f) => {
          const score = getRelation(relations, playerFamily, f);
          const status = statusFromScore(score);
          const def = getFamilyDef(f);
          const inVendetta = vendettas.includes(f);
          const hq = familyHq(locState, f);
          const hqName = territories.find((t) => t.id === hq)?.name ?? "—";
          const familyCrew = crew.filter(
            (c) => c.family === f && (c.status === "active" || c.status === "wounded"),
          );
          const known = familyCrew.filter((c) => isCrewVisible(locState, c)).length;
          const familyOpen = (intel?.familyReveal?.[f] ?? 0) > turn;
          const totalLabel = familyOpen ? String(familyCrew.length) : "?";
          const pactUntil = pacts?.[f];
          const pactLeft =
            pactUntil != null && turn < pactUntil ? pactUntil - turn : null;

          return (
            <div
              key={relationKey(playerFamily, f)}
              className="rounded-md border border-panel-border bg-panel/50 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_HEX[f] }} />
                  <div>
                    <div className="text-sm font-medium">{def.name}</div>
                    <div className="text-[10px] text-muted-foreground">{def.specialty}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {pactLeft != null && (
                    <Badge variant="outline" className="text-[10px] text-emerald-400">
                      Allied · {pactLeft}t
                    </Badge>
                  )}
                  {inVendetta && (
                    <Badge variant="outline" className="flex items-center gap-1 text-[10px] text-heat">
                      <AlertTriangle className="h-3 w-3" /> Vendetta
                    </Badge>
                  )}
                  <span className={`text-xs font-semibold ${STATUS_COLOR[status]}`}>
                    {titleCase(status)} ({score})
                  </span>
                </div>
              </div>
              <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                <span>HQ: {hqName}</span>
                <span>
                  Known men: {known} / {totalLabel}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {DIPLOMACY_ACTIONS.map((action) => (
                  <DiplomacyButton
                    key={action.id}
                    action={action}
                    target={f}
                    onAct={takeDiplomacy}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function DiplomacyButton({
  action,
  target,
  onAct,
}: {
  action: { id: DiplomacyAction; label: string; war?: boolean };
  target: FamilyName;
  onAct: (action: DiplomacyAction, target: FamilyName) => void;
}) {
  const state = useGameStore();
  const hint = diplomacyHint(state, action.id, target);
  const allowed = canDiplomacy(state, action.id, target).ok;
  return (
    <Tip wrapDisabled content={hint}>
      <Button
        type="button"
        size="sm"
        variant={action.war ? "outline" : "secondary"}
        className={`h-6 px-1.5 text-[10px] ${action.war ? "text-heat" : ""}`}
        disabled={!allowed}
        onClick={() => onAct(action.id, target)}
      >
        {action.label}
      </Button>
    </Tip>
  );
}
