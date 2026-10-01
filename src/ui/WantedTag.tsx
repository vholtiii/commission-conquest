import { useGameStore } from "@/engine/store";
import { arrestRisk, type ArrestRisk } from "@/engine/heat";
import type { CrewMember } from "@/types/game";
import Tip from "./Tip";

/** Live arrest odds for one man, straight from the store. */
export function useArrestRisk(member: CrewMember): ArrestRisk {
  const heat = useGameStore((s) => s.heat);
  const bribes = useGameStore((s) => s.bribes);
  const territories = useGameStore((s) => s.territories);
  const turn = useGameStore((s) => s.turn);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const ratLeakTurn = useGameStore((s) => s.ratLeakTurn);
  return arrestRisk({ heat, bribes, territories, turn, playerFamily, ratLeakTurn }, member);
}

/** "8%" — the weekly pickup chance as the UI prints it. */
export function pct(risk: ArrestRisk): string {
  return `${Math.round(risk.chance * 100)}%`;
}

/** Tooltip body: the gate, and whatever's working in his favour. */
export function riskTip(risk: ArrestRisk): string {
  const cover =
    risk.reducers.length > 0
      ? ` Working for him: ${risk.reducers.map((r) => `${r.label} (${r.effect})`).join(", ")}.`
      : "";
  return risk.note + cover;
}

/**
 * `wanted 3 (0%)` with the arrest odds in parentheses. When bribes, a safehouse
 * or a legit front are pulling his odds down, the parentheses go green and a
 * small tag says what.
 */
export default function WantedTag({
  member,
  className = "",
  showLabel = true,
  showReducers = true,
}: {
  member: CrewMember;
  className?: string;
  /** Print "wanted " before the number. */
  showLabel?: boolean;
  /** Spell out the reducers after the odds (otherwise the green alone says so). */
  showReducers?: boolean;
}) {
  const risk = useArrestRisk(member);
  const covered = risk.reducers.length > 0;
  return (
    <Tip content={riskTip(risk)}>
      <span className={`inline-flex items-baseline gap-1 whitespace-nowrap ${className}`}>
        <span>
          {showLabel && "wanted "}
          {member.wanted}
        </span>
        <span className={covered ? "text-emerald-400" : risk.listed ? "text-heat" : "text-muted-foreground"}>
          ({pct(risk)})
        </span>
        {covered && showReducers && (
          <span className="text-emerald-400/90">· {risk.reducers.map((r) => r.label).join(", ")}</span>
        )}
      </span>
    </Tip>
  );
}
