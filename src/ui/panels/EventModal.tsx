import { useState } from "react";
import { useGameStore } from "@/engine/store";
import type { CrewSkills, EventEffects, EventManPick, GameEvent } from "@/types/game";
import { modifierChip } from "@/engine/eventModifiers";
import {
  MAKING_PER_SKILL,
  SKILL_KEYS,
  allocationOk,
  emptyAlloc,
  pointsThatFit,
} from "@/engine/making";

const EFFECT_LABEL: Record<string, string> = {
  money: "Clean $",
  dirtyMoney: "Dirty $",
  heat: "Heat",
  respect: "Respect",
  fear: "Fear",
  loyalty: "Loyalty",
  crewLoyalty: "Crew loyalty",
  crates: "Crates",
  shipmentDelay: "Shipment delay (turns)",
  shipmentLoss: "Shipment loss",
};

/** Heat going up is bad; everything else reads by sign. */
const BAD_WHEN_UP = new Set(["heat", "shipmentDelay"]);

const MAN_LABEL: Record<EventManPick, string> = {
  capo: "A capo",
  soldier: "A soldier",
  muscle: "Your best gun",
  any: "One of your men",
  subject: "He",
  manager: "The manager",
};

interface Chip {
  text: string;
  good: boolean;
}

function effectChips(fx: Omit<EventEffects, "gamble">): Chip[] {
  const chips: Chip[] = [];
  for (const [key, val] of Object.entries(fx)) {
    if (typeof val !== "number" || val === 0 || key === "moneyLossFrac") continue;
    if (key === "shipmentLoss") {
      chips.push({ text: `${EFFECT_LABEL[key]} −${Math.round(val * 100)}%`, good: false });
      continue;
    }
    const good = BAD_WHEN_UP.has(key) ? val < 0 : val > 0;
    chips.push({ text: `${EFFECT_LABEL[key] ?? key} ${val >= 0 ? "+" : ""}${val}`, good });
  }
  if (fx.recruit) chips.push({ text: `${fx.recruit.role === "soldier" ? "Soldier" : "Man"} joins`, good: true });
  if (fx.rivalRecruit) chips.push({ text: `${fx.rivalRecruit.family} gain a man`, good: false });
  if (fx.jailMan) chips.push({ text: `${MAN_LABEL[fx.jailMan.pick]} jailed`, good: false });
  if (fx.woundMan) chips.push({ text: `${MAN_LABEL[fx.woundMan.pick]} wounded`, good: false });
  if (fx.wantedMan) chips.push({ text: `${MAN_LABEL[fx.wantedMan.pick]} wanted +${fx.wantedMan.delta}`, good: false });
  if (fx.releaseMan) chips.push({ text: "A man walks free", good: true });
  if (fx.truce) chips.push({ text: `Truce ${fx.truce.weeks} wk`, good: true });
  if (fx.relationDelta) {
    const d = fx.relationDelta.delta;
    chips.push({ text: `${fx.relationDelta.family} ${d >= 0 ? "+" : ""}${d}`, good: d >= 0 });
  }
  for (const r of fx.relations ?? []) {
    const who = r.family === "allRivals" ? "All families" : r.family;
    chips.push({ text: `${who} ${r.delta >= 0 ? "+" : ""}${r.delta}`, good: r.delta >= 0 });
  }
  if (fx.racket) {
    chips.push({
      text: fx.racket.action === "destroy" ? "Racket destroyed" : `Racket shut ${fx.racket.turns ?? 1} wk`,
      good: false,
    });
  }
  if (fx.territoryHeat) chips.push({ text: `District heat +${fx.territoryHeat.delta}`, good: false });
  if (fx.modifier) {
    chips.push({
      text: `${modifierChip(fx.modifier)} / ${fx.modifier.weeks} wk`,
      good:
        fx.modifier.kind === "heatPerWeek" || fx.modifier.kind === "shipmentSpeed"
          ? fx.modifier.value < 0
          : fx.modifier.kind === "raidChance"
            ? fx.modifier.value < 1
            : fx.modifier.value > 0,
    });
  }
  if (fx.shipment) chips.push({ text: `+${fx.shipment.crates} crates next wk`, good: true });
  if (fx.rival?.treasury) chips.push({ text: `${fx.rival.family} take the score`, good: false });
  if (fx.moneyLossFrac) chips.push({ text: `Lose ${Math.round(fx.moneyLossFrac * 100)}% clean $`, good: false });
  return chips;
}

export default function EventModal() {
  const activeEvent = useGameStore((s) => s.activeEvent);
  const chooseEvent = useGameStore((s) => s.chooseEvent);
  // The week's violence plays out first; the paper lands after the reel and its card.
  const reelRunning = useGameStore(
    (s) =>
      s.cinematicQueue.length > 0 ||
      !!s.pendingHitResult ||
      s.sitdownPhase != null ||
      (s.sitdownCinematicQueue?.length ?? 0) > 0,
  );

  if (!activeEvent || reelRunning) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[440px] rounded-lg border p-5">
        <h2 className="font-display text-lg text-steel-light">{activeEvent.title}</h2>
        <p className="mt-2 text-sm text-foreground/85">{activeEvent.description}</p>

        <div className="mt-4 space-y-2">
          {activeEvent.templateId === "making" ? (
            <MakingCard key={activeEvent.id} event={activeEvent} />
          ) : null}
          {activeEvent.templateId === "making"
            ? null
            : activeEvent.choices.map((choice) => (
            <button
              key={choice.id}
              onClick={() => chooseEvent(choice.id)}
              className="flex w-full flex-col rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-left transition-colors hover:bg-panel-elevated"
            >
              <span className="text-sm font-medium">{choice.text}</span>
              <span className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                {effectChips(choice.effects).map((chip, i) => (
                  <span key={i} className={chip.good ? "text-emerald-400" : "text-heat"}>
                    {chip.text}
                  </span>
                ))}
                {choice.effects.gamble && (
                  <span
                    className="rounded border border-amber-500/50 px-1 text-amber-400"
                    title="It could go either way."
                  >
                    Risky — could go wrong
                  </span>
                )}
                {(choice.effects.hint || choice.effects.followUp) && (
                  <span className="italic text-steel-light">
                    {choice.effects.hint ?? "Consequences may follow"}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const SKILL_LABEL: Record<(typeof SKILL_KEYS)[number], string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

function MakingCard({ event }: { event: GameEvent }) {
  const member = useGameStore((s) => s.crew.find((c) => c.id === event.subjectCrewId));
  const openBooks = useGameStore((s) => s.openBooks);
  const [alloc, setAlloc] = useState<CrewSkills>(emptyAlloc);

  if (!member) return null;

  const fit = pointsThatFit(member.skills);
  const placed = SKILL_KEYS.reduce((n, k) => n + alloc[k], 0);
  const ready = allocationOk(member.skills, alloc);

  const bump = (key: (typeof SKILL_KEYS)[number], dir: 1 | -1) => {
    setAlloc((prev) => {
      const next = { ...prev, [key]: prev[key] + dir };
      if (next[key] < 0 || next[key] > MAKING_PER_SKILL) return prev;
      if (member.skills[key] + next[key] > 100) return prev;
      const sum = SKILL_KEYS.reduce((n, k) => n + next[k], 0);
      if (sum > fit) return prev;
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {SKILL_KEYS.map((key) => {
        const atCap = member.skills[key] >= 100 || alloc[key] >= MAKING_PER_SKILL || placed >= fit;
        return (
          <div key={key} className="flex items-center justify-between gap-2 text-sm">
            <span>
              {SKILL_LABEL[key]}{" "}
              <span className="text-muted-foreground">{member.skills[key]}</span>
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="h-6 w-6 rounded border border-panel-border disabled:opacity-30"
                disabled={alloc[key] <= 0}
                onClick={() => bump(key, -1)}
              >
                −
              </button>
              <span className="w-4 text-center">{alloc[key]}</span>
              <button
                type="button"
                className="h-6 w-6 rounded border border-panel-border disabled:opacity-30"
                disabled={atCap}
                onClick={() => bump(key, 1)}
              >
                +
              </button>
            </span>
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        {fit === 0
          ? "Nothing fits. The books can still open."
          : ready
            ? "Every point that fits is placed."
            : `${fit - placed} left to place.`}
      </p>
      <button
        type="button"
        disabled={!ready}
        onClick={() => openBooks(alloc)}
        className="w-full rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
      >
        Open the books
      </button>
    </div>
  );
}
