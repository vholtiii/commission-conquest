import { Trophy, Skull } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { Button } from "@/components/ui/button";

export default function VictoryOverlay() {
  const victory = useGameStore((s) => s.victory);
  const newGame = useGameStore((s) => s.newGame);
  const turn = useGameStore((s) => s.turn);

  if (!victory.won && !victory.lost) return null;

  const won = victory.won;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="panel-surface-elevated flex max-w-md flex-col items-center rounded-lg border p-8 text-center">
        {won ? (
          <Trophy className="mb-4 h-14 w-14 text-money" />
        ) : (
          <Skull className="mb-4 h-14 w-14 text-heat" />
        )}
        <h2 className="font-display text-3xl text-foreground">{won ? "Victory" : "Game Over"}</h2>
        <p className="mt-3 text-sm text-muted-foreground">{victory.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground">Reached on turn {turn}.</p>
        <Button
          className="mt-6 w-full bg-steel font-ui font-bold uppercase tracking-wide hover:bg-steel-light"
          onClick={() => newGame()}
        >
          New Game
        </Button>
      </div>
    </div>
  );
}
