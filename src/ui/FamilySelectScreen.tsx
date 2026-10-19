import { useState } from "react";
import { FAMILIES } from "@/data/families";
import type { FamilyName, GameLength, GameSettings } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { Button } from "@/components/ui/button";

export default function FamilySelectScreen() {
  const selectFamily = useGameStore((s) => s.selectFamily);
  const newGame = useGameStore((s) => s.newGame);
  const [difficulty, setDifficulty] = useState<GameSettings["difficulty"]>("normal");
  const [gameLength, setGameLength] = useState<GameLength>("medium");
  const [startMode, setStartMode] = useState<NonNullable<GameSettings["startMode"]>>("random");

  const lead = (name: FamilyName) => {
    newGame({ difficulty, gameLength, startMode });
    selectFamily(name);
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-[#0f1013] px-6 py-10">
      <div className="mb-8 text-center">
        <h1 className="font-display text-4xl text-steel-light drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)]">
          Commission Conquest
        </h1>
        <p className="mt-2 text-sm uppercase tracking-[0.25em] text-muted-foreground">
          Choose your family, take the city
        </p>
      </div>

      <div className="mb-6 flex w-full max-w-xl flex-col gap-1.5">
        <div className="flex gap-1.5">
          {(["easy", "normal", "hard"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDifficulty(d)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-xs capitalize ${
                difficulty === d
                  ? "border-steel bg-steel/20 text-steel-light"
                  : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(
            [
              ["short", "Short · 30"],
              ["medium", "Medium · 50"],
              ["long", "Long · 80"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setGameLength(id)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] ${
                gameLength === id
                  ? "border-steel bg-steel/20 text-steel-light"
                  : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(
            [
              ["random", "Random starts"],
              ["classic", "Classic map"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setStartMode(id)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] ${
                startMode === id
                  ? "border-steel bg-steel/20 text-steel-light"
                  : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FAMILIES.map((f) => (
          <div
            key={f.name}
            role="button"
            tabIndex={0}
            onClick={() => lead(f.name as FamilyName)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") lead(f.name as FamilyName);
            }}
            className="panel-surface-elevated group flex cursor-pointer flex-col rounded-lg border p-4 text-left transition-transform hover:-translate-y-1 hover:border-steel/60"
          >
            <div className="mb-3 flex items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-display"
                style={{ background: `${f.hex}22`, border: `2px solid ${f.hex}`, color: f.hex }}
              >
                {f.name.charAt(0)}
              </span>
              <div>
                <h3 className="font-display text-lg text-foreground">{f.name}</h3>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.specialty}</p>
              </div>
            </div>
            <p className="mb-3 text-xs italic text-muted-foreground">Boss: {f.boss}</p>
            <p className="mb-4 flex-1 text-sm text-foreground/80">{f.description}</p>

            <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
              <Bonus label="Combat" value={f.bonuses.combatBonus} />
              <Bonus label="Income" value={f.bonuses.incomeBonus} />
              <Bonus label="Recruit" value={f.bonuses.recruitmentDiscount} />
            </div>

            <Button
              className="mt-4 w-full bg-steel font-ui font-bold uppercase tracking-wide group-hover:bg-steel-light"
              style={{ boxShadow: `0 0 0 1px ${f.hex}44` }}
              onClick={(e) => {
                e.stopPropagation();
                lead(f.name as FamilyName);
              }}
            >
              Lead the {f.name} family
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bonus({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-panel/60 px-1.5 py-1">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-money font-semibold">+{Math.round(value * 100)}%</div>
    </div>
  );
}
