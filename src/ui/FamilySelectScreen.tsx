import { FAMILIES } from "@/data/families";
import type { FamilyName } from "@/types/game";
import { useGameStore } from "@/engine/store";
import { Button } from "@/components/ui/button";

export default function FamilySelectScreen() {
  const selectFamily = useGameStore((s) => s.selectFamily);

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

      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FAMILIES.map((f) => (
          <div
            key={f.name}
            role="button"
            tabIndex={0}
            onClick={() => selectFamily(f.name as FamilyName)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") selectFamily(f.name as FamilyName);
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
                selectFamily(f.name as FamilyName);
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
