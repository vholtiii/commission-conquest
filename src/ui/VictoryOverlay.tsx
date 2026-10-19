import { Trophy, Skull } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { useGameStore } from "@/engine/store";
import { screenHeld } from "@/engine/screen";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import { digestPriority } from "./digestRank";
import { Button } from "@/components/ui/button";

export default function VictoryOverlay() {
  const victory = useGameStore((s) => s.victory);
  const newGame = useGameStore((s) => s.newGame);
  const turn = useGameStore((s) => s.turn);
  const history = useGameStore((s) => s.history);
  const headlines = useGameStore((s) => s.headlines);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const held = useGameStore(screenHeld);

  if (!victory.won && !victory.lost) return null;
  if (held) return null;

  const won = victory.won;
  const rows = (history ?? []).map((entry) => {
    const row: Record<string, number> = { turn: entry.turn };
    for (const name of ALL_FAMILY_NAMES) {
      const spot = entry.families[name as FamilyName];
      row[`${name}-wealth`] = spot?.wealth ?? 0;
      row[`${name}-influence`] = spot?.influence ?? 0;
      row[`${name}-districts`] = spot?.districts ?? 0;
    }
    return row;
  });
  const biggest = [...(headlines ?? [])]
    .sort((a, b) => digestPriority(a, playerFamily) - digestPriority(b, playerFamily))
    .slice(0, 5);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="panel-surface-elevated flex w-full max-w-[720px] flex-col items-center rounded-lg border p-6 text-center">
        {won ? <Trophy className="mb-3 h-12 w-12 text-money" /> : <Skull className="mb-3 h-12 w-12 text-heat" />}
        <h2 className="font-display text-3xl text-foreground">{won ? "Victory" : "Game Over"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{victory.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground">Reached on turn {turn}.</p>

        {rows.length > 1 && (
          <div className="mt-4 grid w-full grid-cols-3 gap-2 text-left">
            <RecapChart title="Wealth" field="wealth" rows={rows} player={playerFamily} />
            <RecapChart title="Influence" field="influence" rows={rows} player={playerFamily} />
            <RecapChart title="Districts" field="districts" rows={rows} player={playerFamily} />
          </div>
        )}

        {biggest.length > 0 && (
          <div className="mt-4 w-full text-left">
            <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">Biggest headlines</h3>
            <ul className="mt-1 space-y-1">
              {biggest.map((line) => (
                <li key={line.id} className="text-xs text-foreground/90">
                  <span className="mr-2 tabular-nums text-muted-foreground">T{line.turn}</span>
                  {line.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button
          className="mt-5 w-full bg-steel font-ui font-bold uppercase tracking-wide hover:bg-steel-light"
          onClick={() => newGame()}
        >
          New Game
        </Button>
      </div>
    </div>
  );
}

function RecapChart({
  title,
  field,
  rows,
  player,
}: {
  title: string;
  field: "wealth" | "influence" | "districts";
  rows: Record<string, number>[];
  player: FamilyName | null;
}) {
  return (
    <div className="rounded border border-panel-border bg-panel/40 p-2">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="h-24">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <XAxis dataKey="turn" hide />
            <YAxis hide />
            {ALL_FAMILY_NAMES.map((name) => (
              <Line
                key={name}
                type="monotone"
                dataKey={`${name}-${field}`}
                stroke={FAMILY_HEX[name as FamilyName]}
                strokeWidth={name === player ? 2.5 : 1}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
