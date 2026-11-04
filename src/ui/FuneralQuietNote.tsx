import { useGameStore } from "@/engine/store";
import { commissionHeld, funeralWeeksLeft, handsDown } from "@/engine/mourning";

/** Streets-are-quiet copy. Boss funerals also hold the table. */
export default function FuneralQuietNote() {
  const turn = useGameStore((s) => s.turn);
  const mourningUntil = useGameStore((s) => s.mourningUntil);
  const mourningForBoss = useGameStore((s) => s.mourningForBoss);
  const state = { turn, mourningUntil, mourningForBoss };
  if (!handsDown(state)) return null;

  const weeks = funeralWeeksLeft(state);
  const text = commissionHeld(state)
    ? `A boss is in the ground. Streets stay quiet for ${weeks} more week${weeks === 1 ? "" : "s"}. The table stands down too.`
    : "Funeral. Streets stay quiet this week. The table can still send a man.";

  return <p className="text-[11px] text-muted-foreground">{text}</p>;
}
