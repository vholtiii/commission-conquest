import { useState } from "react";
import { Gavel } from "lucide-react";
import { useGameStore } from "@/engine/store";
import {
  BOSS_PLEA_COST,
  BOSS_PLEA_HEAT,
  BOSS_PLEA_WEEKS,
  COUNSEL_COST,
  COUNSEL_HEAT_DECAY,
  COUNSEL_WEEKS,
  LAWYER_COOLDOWN_TURNS,
  LAWYER_HEAT,
  QUIET_COST,
  QUIET_HEAT,
  QUIET_WANTED,
  STREET_LAWYER_COST,
  STREET_LAWYER_HEAT_DECAY,
  WASH_MIN,
  lawyerBlockReason,
  lawyerOffer,
  streetLawyerQuote,
  washQuote,
} from "@/engine/economy";
import { Button } from "@/components/ui/button";
import PanelShell from "./PanelShell";
import { formatMoney } from "../formatters";

export default function LawyerPanel() {
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const turn = useGameStore((s) => s.turn);
  const lawyerReadyTurn = useGameStore((s) => s.lawyerReadyTurn ?? 0);
  const streetLawyerUntil = useGameStore((s) => s.streetLawyerUntil ?? 0);
  const streetLawyerBailUsed = useGameStore((s) => s.streetLawyerBailUsed ?? false);
  const counselUntil = useGameStore((s) => s.counselUntil ?? 0);
  const lawyerWantedTurn = useGameStore((s) => s.lawyerWantedTurn ?? 0);
  const lawyerBossPleaUntil = useGameStore((s) => s.lawyerBossPleaUntil ?? 0);
  const lawyerWashTurn = useGameStore((s) => s.lawyerWashTurn ?? 0);
  const callLawyer = useGameStore((s) => s.callLawyer);
  const hireStreetLawyer = useGameStore((s) => s.hireStreetLawyer);
  const streetLawyerBail = useGameStore((s) => s.streetLawyerBail);
  const quietWanted = useGameStore((s) => s.quietWanted);
  const pleadBossCase = useGameStore((s) => s.pleadBossCase);
  const hireCounsel = useGameStore((s) => s.hireCounsel);
  const rushWash = useGameStore((s) => s.rushWash);

  const [quietId, setQuietId] = useState("");
  const [washText, setWashText] = useState("");

  const lawyer = lawyerOffer({ ...useGameStore.getState(), lawyerReadyTurn });
  const street = streetLawyerQuote({ turn, dirtyMoney, streetLawyerUntil, streetLawyerBailUsed });
  const jailedOwn = crew.filter(
    (c) => c.family === playerFamily && c.status === "jailed" && c.role !== "boss",
  );
  const wantedOwn = crew.filter(
    (c) => c.family === playerFamily && c.status !== "dead" && c.wanted > 0,
  );
  const boss = crew.find((c) => c.family === playerFamily && c.role === "boss");
  const bossJailed = boss?.status === "jailed";
  const sentence = boss?.jailedUntilTurn ?? 0;
  const pleaSpent =
    bossJailed &&
    lawyerBossPleaUntil > 0 &&
    sentence <= lawyerBossPleaUntil &&
    sentence >= lawyerBossPleaUntil - BOSS_PLEA_WEEKS;
  const counselOn = turn < counselUntil;
  const quietUsed = lawyerWantedTurn === turn;
  const washUsed = lawyerWashTurn === turn;
  const washAmount = Math.floor(Number(washText) || 0);
  const wash = washQuote(washAmount);
  const washTooMuch = wash != null && wash.pile > dirtyMoney;

  return (
    <PanelShell title="Lawyer" subtitle="House counsel and the man on the street" width="w-[400px]">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Gavel className="h-3.5 w-3.5" />
          Dirty {formatMoney(dirtyMoney)} · clean {formatMoney(money)}
        </div>

        <div className="rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="text-xs font-semibold">Call the lawyer</div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            House counsel takes the dirty cash as a retainer and sends back a check for half.
            It brings the clean books to zero and no further. Heat +{LAWYER_HEAT}. He will not
            answer again for {LAWYER_COOLDOWN_TURNS} weeks.
          </p>
          {lawyer.available ? (
            <>
              {lawyer.cleanReturn < lawyer.deficit && (
                <p className="mt-1 text-[10px] text-amber-300">
                  The check leaves clean at {formatMoney(money + lawyer.cleanReturn)}.
                </p>
              )}
              <Button type="button" size="sm" className="mt-2" onClick={() => callLawyer()}>
                Hand him {formatMoney(lawyer.dirtySpent)} · check for {formatMoney(lawyer.cleanReturn)}
              </Button>
            </>
          ) : lawyer.inTheRed ? (
            <p className="mt-1 text-[10px] text-amber-300">{lawyerBlockReason(lawyer)}</p>
          ) : (
            <p className="mt-1 text-[10px] text-muted-foreground">
              He picks up only when clean cash is below −$3,000 and the fronts cannot cover the hole.
            </p>
          )}
        </div>

        <div className="rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="text-xs font-semibold">Quiet a name</div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {formatMoney(QUIET_COST)} dirty. Wanted drops by {QUIET_WANTED}. Heat +{QUIET_HEAT}. Once a week.
          </p>
          {quietUsed ? (
            <p className="mt-1 text-[10px] text-muted-foreground">He already quieted a name this week.</p>
          ) : wantedOwn.length === 0 ? (
            <p className="mt-1 text-[10px] text-muted-foreground">Nobody of yours is wanted.</p>
          ) : (
            <>
              <select
                id="quiet-name"
                value={quietId}
                onChange={(e) => setQuietId(e.target.value)}
                className="mt-2 h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
              >
                <option value="">Pick a name…</option>
                {wantedOwn.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.role}) · wanted {c.wanted}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={!quietId || dirtyMoney < QUIET_COST}
                onClick={() => quietWanted(quietId)}
              >
                Quiet him · {formatMoney(QUIET_COST)} dirty
              </Button>
            </>
          )}
        </div>

        {bossJailed && (
          <div className="rounded border border-panel-border bg-panel/40 p-2.5">
            <div className="text-xs font-semibold">The boss&apos;s case</div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {formatMoney(BOSS_PLEA_COST)} dirty shaves {BOSS_PLEA_WEEKS} weeks off the sentence. Heat +{BOSS_PLEA_HEAT}.
              Once per sentence. The street lawyer will not touch him.
            </p>
            {pleaSpent ? (
              <p className="mt-1 text-[10px] text-muted-foreground">That sentence already had its plea.</p>
            ) : (
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={dirtyMoney < BOSS_PLEA_COST}
                onClick={() => pleadBossCase()}
              >
                Cut two weeks · {formatMoney(BOSS_PLEA_COST)} dirty
              </Button>
            )}
          </div>
        )}

        <div className="rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="text-xs font-semibold">Counsel on retainer</div>
          {counselOn ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              On the books through week {counselUntil - 1}. Heat falls {COUNSEL_HEAT_DECAY} a week.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {formatMoney(COUNSEL_COST)} dirty, {COUNSEL_WEEKS} weeks. Heat falls {COUNSEL_HEAT_DECAY} a week,
                on top of anyone else already cooling it.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={dirtyMoney < COUNSEL_COST}
                onClick={() => hireCounsel()}
              >
                Keep him · {formatMoney(COUNSEL_COST)} dirty
              </Button>
            </>
          )}
        </div>

        <div className="rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="text-xs font-semibold">Clean cash in a hurry</div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            He keeps 35% of the first $5,000 and 65% of the rest. Heat falls 1 for every $4,000, up to 5.
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
                className="mt-2 h-7 w-full rounded border border-panel-border bg-panel/60 px-2 text-[11px]"
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
              {washTooMuch && (
                <p className="mt-1 text-[10px] text-amber-300">That is more dirty cash than you hold.</p>
              )}
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={!wash || washTooMuch}
                onClick={() => rushWash(washAmount)}
              >
                Wash it
              </Button>
            </>
          )}
        </div>

        <div className="rounded border border-panel-border bg-panel/40 p-2.5">
          <div className="text-xs font-semibold">Street lawyer</div>
          {street.onTheBooks ? (
            <>
              <p className="mt-1 text-[10px] text-muted-foreground">
                On the books through week {street.until - 1}. Heat falls {STREET_LAWYER_HEAT_DECAY} extra
                point a week.
                {street.bailOpen
                  ? " He can still walk one man out."
                  : " He already walked someone this retainer."}
              </p>
              {street.bailOpen && jailedOwn.length > 0 && (
                <select
                  id="street-lawyer-bail"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) streetLawyerBail(e.target.value);
                  }}
                  className="mt-2 h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
                >
                  <option value="">Walk a man out…</option>
                  {jailedOwn.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </option>
                  ))}
                </select>
              )}
              {street.bailOpen && jailedOwn.length === 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">Nobody of yours is inside. He will not touch the boss.</p>
              )}
            </>
          ) : (
            <>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {formatMoney(STREET_LAWYER_COST)} dirty, four weeks. Heat falls {STREET_LAWYER_HEAT_DECAY}{" "}
                extra point a week, and he can walk one man out of jail. He will not touch the boss.
              </p>
              {street.canHire ? (
                <Button type="button" size="sm" className="mt-2" onClick={() => hireStreetLawyer()}>
                  Put him on the books · {formatMoney(STREET_LAWYER_COST)} dirty
                </Button>
              ) : (
                <p className="mt-1 text-[10px] text-amber-300">Not enough dirty cash.</p>
              )}
            </>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
