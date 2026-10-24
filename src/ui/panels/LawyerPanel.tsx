import { useEffect, useRef, useState } from "react";
import { Gavel } from "lucide-react";
import { useGameStore } from "@/engine/store";
import type { CrewMember } from "@/types/game";
import {
  BOSS_PLEA_COST,
  BOSS_PLEA_HEAT,
  BOSS_PLEA_WEEKS,
  LAWYER_COOLDOWN_TURNS,
  LAWYER_HEAT,
  QUIET_COST,
  QUIET_HEAT,
  QUIET_WANTED,
  WASH_MIN,
  lawyerBlockReason,
  lawyerOffer,
  washQuote,
} from "@/engine/economy";
import {
  activeRetainer,
  BAIL_HEAT,
  bailBase,
  currentRate,
  FIGHT_WEEKS,
  fightBase,
  lawyerFee,
  lawyerName,
  RETAINER_ORDER,
  RETAINER_WEEKS,
  RETAINERS,
  retainerFee,
  weeksInside,
  weeksToCool,
} from "@/engine/lawyer";
import { lawyerAuditReads } from "@/engine/auditReads";
import { Button } from "@/components/ui/button";
import PanelShell from "./PanelShell";
import { formatMoney, titleCase } from "../formatters";

function Section({ title, voice, children }: { title: string; voice?: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-panel-border bg-panel/40 p-2.5">
      <div className="text-xs font-semibold">{title}</div>
      {voice && <p className="mt-0.5 text-[10px] italic text-muted-foreground">&ldquo;{voice}&rdquo;</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function LawyerPanel() {
  const state = useGameStore((s) => s);
  const {
    crew,
    playerFamily,
    money,
    dirtyMoney,
    turn,
    callLawyer,
    postBail,
    fightCase,
    quietWanted,
    pleadBossCase,
    hireRetainer,
    rushWash,
    pauseLaunderSite,
  } = state;
  const focusId = state.lawyerFocusCrewId ?? null;
  const focusRef = useRef<HTMLDivElement>(null);
  const [washText, setWashText] = useState("");

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusId]);

  const name = lawyerName(state);
  const rate = currentRate(state);
  const tier = activeRetainer(state);
  const bailout = lawyerOffer(state);
  const reads = lawyerAuditReads(state);

  const own = crew.filter((c) => c.family === playerFamily && c.status !== "dead");
  const inside = own.filter((c) => c.status === "jailed");
  const boss = own.find((c) => c.role === "boss");
  const bossInside = boss?.status === "jailed";
  const wanted = own.filter((c) => c.status !== "jailed" && c.wanted > 0);
  const pleaUntil = state.lawyerBossPleaUntil ?? 0;
  const sentence = boss?.jailedUntilTurn ?? 0;
  const pleaSpent =
    bossInside && pleaUntil > 0 && sentence <= pleaUntil && sentence >= pleaUntil - BOSS_PLEA_WEEKS;
  const quietUsed = (state.lawyerWantedTurn ?? 0) === turn;
  const washUsed = (state.lawyerWashTurn ?? 0) === turn;
  const washAmount = Math.floor(Number(washText) || 0);
  const wash = washQuote(washAmount, rate);
  const washTooMuch = wash != null && wash.pile > dirtyMoney;

  const headerVoice =
    rate >= 1.5
      ? "You keep calling, I keep billing. That's the arrangement."
      : bossInside
        ? "They've got the old man. Let's not waste a week."
        : inside.length === 0
          ? "Nobody inside. That's how I like my clients."
          : `${plural(inside.length, "of yours", "of yours")} in the Tombs. Who first?`;

  function caseRow(man: CrewMember) {
    const weeks = weeksInside(man, turn);
    const focused = man.id === focusId;
    const isBoss = man.role === "boss";
    const bail = lawyerFee(state, bailBase(man), true);
    const fight = lawyerFee(state, fightBase(man), true);
    const plea = lawyerFee(state, BOSS_PLEA_COST, true);
    return (
      <div
        key={man.id}
        ref={focused ? focusRef : undefined}
        className={`rounded border px-2 py-1.5 ${focused ? "border-amber-400/60 bg-amber-500/10" : "border-panel-border bg-panel/30"}`}
      >
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
          <span>
            {man.name} <span className="text-muted-foreground">({titleCase(man.role)} · wanted {man.wanted})</span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {isBoss ? `chair passes in ${plural(weeks, "week")}` : `out in ${plural(weeks, "week")}`}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isBoss ? (
            pleaSpent ? (
              <span className="text-[10px] text-muted-foreground">That sentence already had its plea.</span>
            ) : (
              <Button type="button" size="sm" className="h-6 text-[10px]" disabled={dirtyMoney < plea} onClick={() => pleadBossCase()}>
                Plead it down · −{BOSS_PLEA_WEEKS} wks · {formatMoney(plea)}
              </Button>
            )
          ) : (
            <>
              <Button type="button" size="sm" className="h-6 text-[10px]" disabled={dirtyMoney < bail} onClick={() => postBail(man.id)}>
                Post bail · {formatMoney(bail)}
              </Button>
              {man.caseFought ? (
                <span className="self-center text-[10px] text-muted-foreground">Case already fought.</span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 text-[10px]"
                  disabled={dirtyMoney < fight}
                  onClick={() => fightCase(man.id)}
                >
                  Fight the case · −{FIGHT_WEEKS} wks · {formatMoney(fight)}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <PanelShell title={name} subtitle="The family's lawyer" width="w-[420px]">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Gavel className="h-3.5 w-3.5" />
              Dirty {formatMoney(dirtyMoney)} · clean {formatMoney(money)}
            </span>
            <span className={rate > 1 ? "text-amber-300" : ""}>
              His rate: {rate.toFixed(2).replace(/0$/, "")}×
              {rate > 1 ? ` (cools in ${plural(weeksToCool(rate), "week")})` : ""}
            </span>
          </div>
          <p className="text-[10px] italic text-muted-foreground">&ldquo;{headerVoice}&rdquo;</p>
          <p className="text-[10px] text-muted-foreground">
            Every job raises his rate 15%. It eases 5% a week. Fees are dirty cash.
          </p>
        </div>

        <Section
          title="Inside"
          voice={inside.length === 0 ? undefined : bossInside ? "The boss first. Everyone else can wait a week." : undefined}
        >
          {inside.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">Nobody of yours is in the Tombs.</p>
          ) : (
            inside.map(caseRow)
          )}
          <p className="text-[10px] text-muted-foreground">
            Bail walks him today, wanted stays on him, heat +{BAIL_HEAT}. Fighting the case cuts {FIGHT_WEEKS} weeks once
            per sentence.
            {tier ? ` The ${RETAINERS[tier].label.toLowerCase()} retainer takes ${Math.round(RETAINERS[tier].discount * 100)}% off.` : ""}
          </p>
          {wanted.length > 0 && (
            <div className="border-t border-panel-border/60 pt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">On the sheet</div>
              {wanted.map((man) => {
                const fee = lawyerFee(state, QUIET_COST, true);
                return (
                  <div key={man.id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                    <span>
                      {man.name} <span className="text-muted-foreground">· wanted {man.wanted}</span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-6 text-[10px]"
                      disabled={quietUsed || dirtyMoney < fee}
                      onClick={() => quietWanted(man.id)}
                    >
                      Quiet · −{QUIET_WANTED} · {formatMoney(fee)}
                    </Button>
                  </div>
                );
              })}
              <p className="text-[10px] text-muted-foreground">
                {quietUsed ? "He already quieted a name this week." : `One name a week. Heat +${QUIET_HEAT}.`}
              </p>
            </div>
          )}
        </Section>

        <Section
          title="Books"
          voice={
            !tier
              ? undefined
              : reads.length === 0
                ? "Treasury's quiet on your fronts. Keep it boring."
                : "Treasury's sniffing. I'd stop washing where I tell you."
          }
        >
          {!tier ? (
            <p className="text-[10px] text-muted-foreground">
              No one is watching your books. On retainer he reads the Treasury&apos;s mail and tells you which
              fronts to pause before an audit lands. Washing near a front&apos;s cap draws looks; over it draws a file.
            </p>
          ) : reads.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No warnings this week.</p>
          ) : (
            reads.map((read) => {
              const washing = (state.launderPlan?.[read.racketId] ?? 0) > 0;
              return (
                <div key={read.racketId} className="flex items-start justify-between gap-2 rounded border border-panel-border bg-panel/30 px-2 py-1.5">
                  <div className="text-[11px]">
                    <div>
                      {read.label} <span className="text-muted-foreground">· {read.districtName}</span>
                    </div>
                    <div className={`text-[10px] ${read.advice === "pause" ? "text-heat" : "text-amber-300"}`}>{read.tag}</div>
                  </div>
                  {washing ? (
                    <Button type="button" size="sm" className="h-6 shrink-0 text-[10px]" onClick={() => pauseLaunderSite(read.racketId)}>
                      Pause washing here
                    </Button>
                  ) : (
                    <span className="shrink-0 text-[10px] text-muted-foreground">Paused</span>
                  )}
                </div>
              );
            })
          )}
          {tier === "street" && (
            <p className="text-[10px] text-muted-foreground">A street lawyer misses files and cries wolf now and then.</p>
          )}
        </Section>

        <Section title="Retainer" voice={tier ? undefined : "Put me on the books and I'll keep the heat off you."}>
          {tier && (
            <p className="text-[10px] text-muted-foreground">
              {RETAINERS[tier].label} retainer through week {(state.lawyerRetainer?.until ?? turn) - 1}. Heat −
              {RETAINERS[tier].heatDecay} a week, {Math.round(RETAINERS[tier].discount * 100)}% off case work.
            </p>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            {RETAINER_ORDER.map((t) => {
              const spec = RETAINERS[t];
              const fee = retainerFee(state, t);
              const current = tier === t;
              const below = tier != null && RETAINER_ORDER.indexOf(t) < RETAINER_ORDER.indexOf(tier);
              return (
                <div
                  key={t}
                  className={`flex flex-col rounded border p-1.5 text-[10px] ${current ? "border-money/60 bg-money/10" : "border-panel-border bg-panel/30"}`}
                >
                  <div className="text-[11px] font-semibold">{spec.label}</div>
                  <div className="text-muted-foreground">
                    Heat −{spec.heatDecay}/wk · {Math.round(spec.discount * 100)}% off
                  </div>
                  <div className="mt-1 flex-1 text-muted-foreground">{spec.blurb}</div>
                  <Button
                    type="button"
                    size="sm"
                    variant={current ? "secondary" : "default"}
                    className="mt-1.5 h-6 text-[10px]"
                    disabled={current || below || dirtyMoney < fee}
                    onClick={() => hireRetainer(t)}
                  >
                    {current ? "Retained" : `${tier ? "Upgrade" : "Hire"} · ${formatMoney(fee)}`}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">{RETAINER_WEEKS} weeks, dirty cash up front.</p>
        </Section>

        <Section title="Money trouble">
          <div>
            <div className="text-[11px] font-medium">Bail out the books</div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              He takes dirty cash and sends back a clean check for half, at his rate. It brings the clean books to zero
              and no further. Heat +{LAWYER_HEAT}. He won&apos;t answer again for {LAWYER_COOLDOWN_TURNS} weeks.
            </p>
            {bailout.available ? (
              <Button type="button" size="sm" className="mt-1.5 h-7 text-[11px]" onClick={() => callLawyer()}>
                Hand him {formatMoney(bailout.dirtySpent)} · check for {formatMoney(bailout.cleanReturn)}
              </Button>
            ) : bailout.inTheRed ? (
              <p className="mt-1 text-[10px] text-amber-300">{lawyerBlockReason(bailout)}</p>
            ) : (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Only when clean cash is below −$3,000 and the fronts can&apos;t cover the hole.
              </p>
            )}
          </div>
          <div className="border-t border-panel-border/60 pt-2">
            <div className="text-[11px] font-medium">Clean cash in a hurry</div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              He keeps 35% of the first $5,000 and 65% of the rest, at his rate. Heat falls 1 for every $4,000, up to 5.
              At $8,000 and above the family and the street both feel it. Once a week. At least {formatMoney(WASH_MIN)}.
            </p>
            {washUsed ? (
              <p className="mt-1 text-[10px] text-muted-foreground">He already washed a pile this week.</p>
            ) : (
              <>
                <input
                  id="rush-wash"
                  type="number"
                  min={WASH_MIN}
                  step={100}
                  value={washText}
                  onChange={(e) => setWashText(e.target.value)}
                  placeholder="Dirty cash to hand him"
                  className="mt-1.5 h-7 w-full rounded border border-panel-border bg-panel/60 px-2 text-[11px]"
                />
                {wash && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    He keeps {formatMoney(wash.cut)}. Clean back {formatMoney(wash.clean)}.
                    {wash.heatOff > 0 ? ` Heat −${wash.heatOff}.` : " Heat does not move."}
                    {wash.loyalty > 0
                      ? ` Loyalty −${wash.loyalty} across the family. Street −${wash.loyalty}.`
                      : " The family shrugs it off."}
                  </p>
                )}
                {washTooMuch && <p className="mt-1 text-[10px] text-amber-300">That is more dirty cash than you hold.</p>}
                <Button
                  type="button"
                  size="sm"
                  className="mt-1.5 h-7 text-[11px]"
                  disabled={!wash || washTooMuch}
                  onClick={() => rushWash(washAmount)}
                >
                  Wash it
                </Button>
              </>
            )}
          </div>
        </Section>
      </div>
    </PanelShell>
  );
}
