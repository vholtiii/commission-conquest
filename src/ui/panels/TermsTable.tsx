import { useEffect, useState } from "react";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type AgendaTerms, type FamilyName, type Sitdown } from "@/types/game";
import {
  ALLIANCE_WEEKS,
  CUT_DEFAULT_SHARE,
  CUT_DEFAULT_WEEKS,
  CUT_MAX_SHARE,
  CUT_MAX_WEEKS,
  CUT_MIN_SHARE,
  CUT_MIN_WEEKS,
  LIQUOR_WEEKS,
  MAX_STANDING_CHIP,
  TABLE_ROUNDS,
  TRUCE_MAX_WEEKS,
  TRUCE_MIN_WEEKS,
  agendaBlurb,
  agendaLabel,
  agendaTell,
  agendaTermsText,
  canAfford,
  counterChance,
  isInsult,
  moodWord,
  sellableDistricts,
} from "@/engine/agendas";
import { hasConsigliere } from "@/engine/diplomacy";
import { familyHq } from "@/engine/crewLocation";
import { Button } from "@/components/ui/button";
import { TermRow } from "@/ui/panels/SitdownRequestModal";

/**
 * An open agenda table: their number, the player's counter, three rounds.
 * Embedded in the letterboxed table during the sit-down cinematic.
 */
export function TermsTable({
  sitdown,
  playerFamily,
  embedded,
}: {
  sitdown: Sitdown;
  playerFamily: FamilyName;
  embedded?: boolean;
}) {
  const territories = useGameStore((s) => s.territories);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const influence = useGameStore((s) => s.influence);
  const answerTable = useGameStore((s) => s.answerTable);

  const family = sitdown.proposer === playerFamily ? sitdown.other : sitdown.proposer;
  const agenda = sitdown.purpose!;
  const ask = sitdown.table!.ask;
  const rounds = sitdown.table!.rounds;
  const where = territories.find((t) => t.id === sitdown.venueTerritoryId)?.name ?? "their back room";

  const [offer, setOffer] = useState<AgendaTerms>(ask);
  const [countering, setCountering] = useState(false);
  // The ask moves after each round; start the next counter from it.
  useEffect(() => {
    setOffer(ask);
  }, [ask]);

  const state = useGameStore.getState();
  const consigliere = hasConsigliere(state) && !!sitdown.bringConsigliere;
  const chance = counterChance(state, family, agenda, ask, offer, { consigliere: sitdown.bringConsigliere });
  const insult = isInsult(state, family, agenda, ask, offer);
  const tell = sitdown.bringConsigliere ? agendaTell(state, family, agenda, ask) : undefined;
  const affordAsk = canAfford(state, ask);
  const affordOffer = canAfford(state, offer);
  const playerPays = ask.cash >= 0;
  const cashStep = Math.abs(ask.cash) >= 1000 ? 100 : 50;
  const hq = familyHq(state, playerFamily);
  const chips = sellableDistricts(state).filter((t) => t.id !== hq && t.id !== ask.territoryId);

  return (
    <div className={embedded ? "" : "absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm"}>
      <div className={embedded ? "w-full" : "panel-surface-elevated w-[480px] rounded-lg border p-5"}>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_HEX[family] }} />
          <h2 className="font-display text-lg text-steel-light">
            {agendaLabel(agenda)} · at the table with {family}
          </h2>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {where} · {agendaBlurb(agenda)}
        </p>

        <div className="mt-3 rounded-md border border-panel-border bg-panel/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {rounds > 0 ? "Their revised terms" : "Their terms"}
          </div>
          <p className="mt-1 text-sm text-foreground">{agendaTermsText(state, agenda, ask)}</p>
          {!affordAsk.ok && <p className="mt-0.5 text-[10px] text-heat">{affordAsk.reason}</p>}
        </div>

        <p className="mt-2 text-[11px] text-steel-light">
          {consigliere ? (
            <>
              Your consigliere: {moodWord(chance).toLowerCase()} —{" "}
              <span className={chance >= 0.5 ? "text-emerald-300" : chance >= 0.25 ? "text-amber-300" : "text-heat"}>
                {Math.round(chance * 100)}% they take your number
              </span>
              .{tell ? ` ${tell}` : ""}
            </>
          ) : (
            <>Across the table they look {moodWord(chance).toLowerCase()}. Bring your consigliere for the odds.</>
          )}
        </p>

        {countering ? (
          <div className="mt-3 space-y-2 rounded-md border border-steel/40 bg-panel/40 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Your counter</div>
            <TermRow
              label={playerPays ? "You pay" : "They pay"}
              value={`$${Math.abs(offer.cash)}`}
              onDec={() =>
                setOffer({
                  ...offer,
                  cash: playerPays ? Math.max(0, offer.cash - cashStep) : Math.min(0, offer.cash + cashStep),
                })
              }
              onInc={() => setOffer({ ...offer, cash: playerPays ? offer.cash + cashStep : offer.cash - cashStep })}
            />
            {agenda === "truce" && (
              <TermRow
                label="Weeks"
                value={`${offer.weeks ?? TRUCE_MIN_WEEKS}`}
                onDec={() => setOffer({ ...offer, weeks: Math.max(TRUCE_MIN_WEEKS, (offer.weeks ?? 6) - 1) })}
                onInc={() => setOffer({ ...offer, weeks: Math.min(TRUCE_MAX_WEEKS, (offer.weeks ?? 6) + 1) })}
              />
            )}
            {(agenda === "alliance" || agenda === "liquor") && (
              <TermRow
                label="Deadline"
                value={`${offer.weeks ?? (agenda === "alliance" ? ALLIANCE_WEEKS : LIQUOR_WEEKS)} weeks`}
                onDec={() => setOffer({ ...offer, weeks: Math.max(1, (offer.weeks ?? 2) - 1) })}
                onInc={() => setOffer({ ...offer, weeks: Math.min(12, (offer.weeks ?? 2) + 1) })}
              />
            )}
            {agenda === "liquor" && (
              <TermRow
                label="Crates"
                value={`${offer.crates ?? 0}`}
                onDec={() => setOffer({ ...offer, crates: Math.max(2, (offer.crates ?? 10) - 2) })}
                onInc={() => setOffer({ ...offer, crates: Math.min(20, (offer.crates ?? 10) + 2) })}
              />
            )}
            {agenda === "racket" && (
              <>
                <TermRow
                  label="Weeks"
                  value={`${offer.weeks ?? CUT_DEFAULT_WEEKS}`}
                  onDec={() => setOffer({ ...offer, weeks: Math.max(CUT_MIN_WEEKS, (offer.weeks ?? CUT_DEFAULT_WEEKS) - 1) })}
                  onInc={() => setOffer({ ...offer, weeks: Math.min(CUT_MAX_WEEKS, (offer.weeks ?? CUT_DEFAULT_WEEKS) + 1) })}
                />
                <TermRow
                  label="Share of the take"
                  value={`${Math.round((offer.share ?? CUT_DEFAULT_SHARE) * 100)}%`}
                  onDec={() =>
                    setOffer({
                      ...offer,
                      share: Math.max(CUT_MIN_SHARE, Math.round(((offer.share ?? CUT_DEFAULT_SHARE) - 0.05) * 20) / 20),
                    })
                  }
                  onInc={() =>
                    setOffer({
                      ...offer,
                      share: Math.min(CUT_MAX_SHARE, Math.round(((offer.share ?? CUT_DEFAULT_SHARE) + 0.05) * 20) / 20),
                    })
                  }
                />
              </>
            )}
            {playerPays && (
              <TermRow
                label="Standing on the table"
                value={`${offer.standing}`}
                onDec={() => setOffer({ ...offer, standing: Math.max(0, offer.standing - 5) })}
                onInc={() =>
                  setOffer({ ...offer, standing: Math.min(MAX_STANDING_CHIP, Math.floor(influence), offer.standing + 5) })
                }
              />
            )}
            {playerPays && agenda !== "territory" && agenda !== "racket" && chips.length > 0 && (
              <label className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Throw in a district</span>
                <select
                  className="rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[11px]"
                  value={offer.territoryId ?? ""}
                  onChange={(e) => setOffer({ ...offer, territoryId: e.target.value || undefined })}
                >
                  <option value="">None</option>
                  {chips.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {playerPays && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={!!offer.favor}
                  onChange={(e) => setOffer({ ...offer, favor: e.target.checked || undefined })}
                />
                Owe them a favor
              </label>
            )}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                {agendaTermsText(state, agenda, offer)}
                {!affordOffer.ok && <span className="text-heat"> · {affordOffer.reason}</span>}
              </span>
              {consigliere ? (
                <span className={chance >= 0.5 ? "text-emerald-300" : chance >= 0.25 ? "text-amber-300" : "text-heat"}>
                  {Math.round(chance * 100)}%
                </span>
              ) : (
                <span>{moodWord(chance)}</span>
              )}
            </div>
            {insult && (
              <p className="text-[10px] text-heat">
                That number is an insult. It costs you with them{consigliere ? ", and they may get up" : ""}.
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Round {rounds + 1} of {TABLE_ROUNDS}. Refuse them {TABLE_ROUNDS} times and they leave the table.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setCountering(false)}>
                Back
              </Button>
              <Button
                className="flex-1"
                disabled={!affordOffer.ok}
                onClick={() => {
                  setCountering(false);
                  answerTable(sitdown.id, "counter", offer);
                }}
              >
                Put it to them
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => answerTable(sitdown.id, "walk")}>
              Walk away
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => setCountering(true)}>
              Counter
            </Button>
            <Button
              className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
              disabled={!affordAsk.ok}
              onClick={() => answerTable(sitdown.id, "accept")}
            >
              Take the deal
            </Button>
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          {playerPays
            ? `You hold ${formatCash(money + dirtyMoney)} and ${Math.floor(influence)} standing. Walking away sours things a little.`
            : "Walking away sours things a little."}
        </p>
      </div>
    </div>
  );
}

function formatCash(n: number): string {
  return `$${Math.max(0, Math.round(n))}`;
}
