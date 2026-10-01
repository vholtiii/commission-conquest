import { useEffect, useState } from "react";
import { useGameStore } from "@/engine/store";
import type { AgendaTerms, FamilyName, PassageTerms, SitdownAgenda } from "@/types/game";
import type { AgendaPick } from "@/engine/sitdowns";
import {
  ALLIANCE_WEEKS,
  CUT_DEFAULT_SHARE,
  CUT_DEFAULT_WEEKS,
  CUT_MAX_SHARE,
  CUT_MAX_WEEKS,
  CUT_MIN_SHARE,
  CUT_MIN_WEEKS,
  PLAYER_AGENDAS,
  TRUCE_DEFAULT_WEEKS,
  TRUCE_MAX_WEEKS,
  TRUCE_MIN_WEEKS,
  agendaAvailable,
  agendaBlurb,
  agendaLabel,
  agendaTermsText,
  buyableDistricts,
  contractPrice,
  contractTargets,
  cutDistricts,
  cutOn,
  districtPrice,
  districtTake,
  heldBy,
  openingTerms,
  playerOpening,
  ransomFor,
  routesThroughFamily,
} from "@/engine/agendas";
import { counterAcceptance, openingAsk, termsText, termsValue } from "@/engine/passage";
import { TermRow } from "@/ui/panels/SitdownRequestModal";
import Tip from "@/ui/Tip";

/**
 * The subject of a sit-down: agenda chips, the thing it's about, and the
 * optional number the player walks in with. Used both when proposing a
 * meeting and at an open general table (where "general" isn't a subject).
 * Reports the current pick upward.
 */
export default function AgendaPicker({
  target,
  atTable = false,
  onChange,
}: {
  target: FamilyName;
  atTable?: boolean;
  onChange: (pick: AgendaPick | undefined, ready: boolean) => void;
}) {
  const state = useGameStore();
  const player = state.playerFamily;
  const [agenda, setAgenda] = useState<SitdownAgenda>(() => {
    if (!atTable) return "general";
    const s = useGameStore.getState();
    return PLAYER_AGENDAS.find((a) => a !== "general" && agendaAvailable(s, target, a).ok) ?? "truce";
  });
  const [subject, setSubject] = useState("");
  const [withNumber, setWithNumber] = useState(false);
  const [opening, setOpening] = useState<AgendaTerms | null>(null);
  const [passageNumber, setPassageNumber] = useState<PassageTerms | null>(null);

  const districts = agenda === "territory" ? buyableDistricts(state, target) : [];
  const held = agenda === "release" && player ? heldBy(state, target, player) : [];
  const marks = agenda === "alliance" ? contractTargets(state, target) : [];
  const blocks = agenda === "racket" ? cutDistricts(state, target).filter((t) => !cutOn(state, t.id)) : [];
  const seed: Partial<AgendaTerms> | undefined =
    agenda === "territory"
      ? { territoryId: subject || districts[0]?.id }
      : agenda === "release"
        ? { crewId: subject || held[0]?.id }
        : agenda === "alliance"
          ? { targetFamily: (subject as FamilyName) || marks[0], obligor: target }
          : agenda === "racket"
            ? { territoryId: subject || blocks[0]?.id }
            : undefined;
  const agendaTable = agenda !== "general" && agenda !== "passage";
  const routes = agenda === "passage" ? routesThroughFamily(state, target) : [];
  const route = routes.find((r) => r.id === subject);
  const crates = route?.cratesPerTurn ?? 10;
  const passageAsk = agenda === "passage" ? openingAsk(state, target, { crates }) : null;
  const passageOffer = passageNumber ?? passageAsk;
  const subjectOk =
    agenda === "territory" || agenda === "racket"
      ? !!seed?.territoryId
      : agenda === "release"
        ? !!seed?.crewId
        : agenda === "alliance"
          ? !!seed?.targetFamily
          : true;
  const theirAsk = agendaTable && subjectOk ? openingTerms(state, target, agenda, seed) : null;
  const myOpening = opening ?? (agendaTable && subjectOk ? playerOpening(state, target, agenda, seed) : null);
  const pick: AgendaPick | undefined =
    agenda === "passage"
      ? {
          agenda,
          routeId: subject || undefined,
          passageOpening: withNumber && passageOffer ? passageOffer : undefined,
        }
      : agendaTable
        ? { agenda, seed, opening: withNumber && myOpening ? myOpening : undefined }
        : undefined;
  const cashStep = theirAsk && Math.abs(theirAsk.cash) >= 1000 ? 100 : 50;
  const weekRange: [number, number, number] =
    agenda === "alliance"
      ? [2, 12, ALLIANCE_WEEKS]
      : agenda === "racket"
        ? [CUT_MIN_WEEKS, CUT_MAX_WEEKS, CUT_DEFAULT_WEEKS]
        : [TRUCE_MIN_WEEKS, TRUCE_MAX_WEEKS, TRUCE_DEFAULT_WEEKS];

  const choices = atTable ? PLAYER_AGENDAS.filter((a) => a !== "general") : PLAYER_AGENDAS;

  // Report upward. The signature keeps a parent that stores the result from
  // re-rendering this into a fresh object every pass.
  const signature = JSON.stringify({
    agenda,
    seed,
    withNumber,
    cash: myOpening?.cash,
    weeks: myOpening?.weeks,
    standing: myOpening?.standing,
    share: myOpening?.share,
    subjectOk,
    routeId: subject,
    passage: passageOffer,
  });
  useEffect(() => {
    onChange(pick, subjectOk);
    // `pick` is derived from `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  function chooseAgenda(next: SitdownAgenda) {
    setAgenda(next);
    setSubject("");
    setOpening(null);
    setPassageNumber(null);
    setWithNumber(false);
  }

  return (
    <div className="mt-1 border-t border-panel-border pt-1">
      <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {atTable ? "Raise a subject" : "About"}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-1 px-1">
        {choices.map((a) => {
          const can = a === "general" ? { ok: true } : agendaAvailable(state, target, a);
          return (
            <Tip key={a} wrapDisabled content={can.ok ? agendaBlurb(a) : can.reason ?? ""}>
              <button
                type="button"
                disabled={!can.ok}
                onClick={() => chooseAgenda(a)}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  agenda === a
                    ? "border-steel-light text-foreground"
                    : "border-panel-border text-muted-foreground hover:border-steel-light"
                } disabled:opacity-40`}
              >
                {agendaLabel(a)}
              </button>
            </Tip>
          );
        })}
      </div>
      {agenda === "territory" && districts.length > 0 && (
        <select
          className="mt-1 w-full rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[10px]"
          value={seed?.territoryId ?? ""}
          onChange={(e) => {
            setSubject(e.target.value);
            setOpening(null);
          }}
        >
          {districts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · ${districtPrice(state, t)}
            </option>
          ))}
        </select>
      )}
      {agenda === "release" && held.length > 0 && (
        <select
          className="mt-1 w-full rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[10px]"
          value={seed?.crewId ?? ""}
          onChange={(e) => {
            setSubject(e.target.value);
            setOpening(null);
          }}
        >
          {held.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.role} · ~${ransomFor(c)}
            </option>
          ))}
        </select>
      )}
      {agenda === "alliance" && marks.length > 0 && (
        <select
          className="mt-1 w-full rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[10px]"
          value={seed?.targetFamily ?? ""}
          onChange={(e) => {
            setSubject(e.target.value);
            setOpening(null);
          }}
        >
          {marks.map((f) => (
            <option key={f} value={f}>
              {f} · ~${Math.round(contractPrice(state, f) * 1.25)}
            </option>
          ))}
        </select>
      )}
      {agenda === "racket" && blocks.length > 0 && (
        <select
          className="mt-1 w-full rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[10px]"
          value={seed?.territoryId ?? ""}
          onChange={(e) => {
            setSubject(e.target.value);
            setOpening(null);
          }}
        >
          {blocks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · ${districtTake(t)}/wk
            </option>
          ))}
        </select>
      )}
      {agenda === "passage" && (
        <select
          className="mt-1 w-full rounded border border-panel-border bg-panel/60 px-1 py-0.5 text-[10px]"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            setPassageNumber(null);
          }}
        >
          <option value="">Any trucks · 10 crates</option>
          {routes.map((r) => {
            const from = state.territories.find((t) => t.id === r.sourceTerritoryId)?.name ?? r.sourceTerritoryId;
            const to = state.territories.find((t) => t.id === r.destTerritoryId)?.name ?? r.destTerritoryId;
            return (
              <option key={r.id} value={r.id}>
                {from} → {to} · {r.cratesPerTurn}/wk
              </option>
            );
          })}
        </select>
      )}
      {passageAsk && (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">They'll likely ask: {termsText(passageAsk)}.</p>
      )}
      {agenda === "passage" && passageOffer && (
        <label className="mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={withNumber}
            onChange={(e) => {
              setWithNumber(e.target.checked);
              if (e.target.checked && passageAsk) setPassageNumber(passageAsk);
            }}
          />
          Walk in with a number
        </label>
      )}
      {agenda === "passage" && withNumber && passageOffer && passageAsk && (
        <div className="mt-1 space-y-1 px-1">
          <TermRow
            label="Toll per crate"
            value={`$${passageOffer.tollPerCrate}`}
            onDec={() => setPassageNumber({ ...passageOffer, tollPerCrate: Math.max(0, passageOffer.tollPerCrate - 1) })}
            onInc={() => setPassageNumber({ ...passageOffer, tollPerCrate: passageOffer.tollPerCrate + 1 })}
          />
          <TermRow
            label="Cut of the crates"
            value={`${Math.round(passageOffer.cratesCut * 100)}%`}
            onDec={() =>
              setPassageNumber({
                ...passageOffer,
                cratesCut: Math.max(0, Math.round((passageOffer.cratesCut - 0.05) * 20) / 20),
              })
            }
            onInc={() =>
              setPassageNumber({
                ...passageOffer,
                cratesCut: Math.min(0.3, Math.round((passageOffer.cratesCut + 0.05) * 20) / 20),
              })
            }
          />
          <TermRow
            label="Gift up front"
            value={`$${passageOffer.gift}`}
            onDec={() => setPassageNumber({ ...passageOffer, gift: Math.max(0, passageOffer.gift - 50) })}
            onInc={() => setPassageNumber({ ...passageOffer, gift: passageOffer.gift + 50 })}
          />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Runs for</span>
            <span className="flex gap-1">
              {([4, 8, 12, null] as const).map((d) => (
                <button
                  key={d ?? "open"}
                  type="button"
                  onClick={() => setPassageNumber({ ...passageOffer, durationTurns: d })}
                  className={`rounded border px-1.5 py-0.5 text-[10px] ${
                    passageOffer.durationTurns === d
                      ? "border-steel-light text-foreground"
                      : "border-panel-border text-muted-foreground"
                  }`}
                >
                  {d == null ? "open" : `${d}wk`}
                </button>
              ))}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            ≈ ${Math.round(termsValue(passageOffer, crates) / (passageOffer.durationTurns ?? 10))}/week · worth{" "}
            {Math.round((termsValue(passageOffer, crates) / Math.max(1, termsValue(passageAsk, crates))) * 100)}% of their
            ask · {Math.round(counterAcceptance(state, target, passageAsk, passageOffer, crates) * 100)}% they take it.
          </p>
          <p className="text-[10px] text-muted-foreground">
            {atTable ? "They answer it the moment you put it down." : "They answer it the moment the bosses sit."}
          </p>
        </div>
      )}
      {theirAsk && (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">
          They'll likely ask: {agendaTermsText(state, agenda, theirAsk)}.
        </p>
      )}
      {agendaTable && myOpening && (
        <label className="mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={withNumber} onChange={(e) => setWithNumber(e.target.checked)} />
          Walk in with a number
        </label>
      )}
      {agendaTable && withNumber && myOpening && (
        <div className="mt-1 space-y-0.5 px-1 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{myOpening.cash >= 0 ? "You pay" : "They pay"}</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="h-5 w-5 rounded border border-panel-border"
                onClick={() =>
                  setOpening({
                    ...myOpening,
                    cash: myOpening.cash >= 0 ? Math.max(0, myOpening.cash - cashStep) : myOpening.cash + cashStep,
                  })
                }
              >
                −
              </button>
              <span className="w-14 text-center">${Math.abs(myOpening.cash)}</span>
              <button
                type="button"
                className="h-5 w-5 rounded border border-panel-border"
                onClick={() =>
                  setOpening({
                    ...myOpening,
                    cash: myOpening.cash >= 0 ? myOpening.cash + cashStep : myOpening.cash - cashStep,
                  })
                }
              >
                +
              </button>
            </span>
          </div>
          {agenda === "vendetta" && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Standing</span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() => setOpening({ ...myOpening, standing: Math.max(0, myOpening.standing - 5) })}
                >
                  −
                </button>
                <span className="w-14 text-center">{myOpening.standing}</span>
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() => setOpening({ ...myOpening, standing: Math.min(30, myOpening.standing + 5) })}
                >
                  +
                </button>
              </span>
            </div>
          )}
          {(agenda === "truce" || agenda === "alliance" || agenda === "racket") && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{agenda === "alliance" ? "Deadline (weeks)" : "Weeks"}</span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() =>
                    setOpening({ ...myOpening, weeks: Math.max(weekRange[0], (myOpening.weeks ?? weekRange[2]) - 1) })
                  }
                >
                  −
                </button>
                <span className="w-14 text-center">{myOpening.weeks ?? weekRange[2]}</span>
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() =>
                    setOpening({ ...myOpening, weeks: Math.min(weekRange[1], (myOpening.weeks ?? weekRange[2]) + 1) })
                  }
                >
                  +
                </button>
              </span>
            </div>
          )}
          {agenda === "racket" && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Share</span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() =>
                    setOpening({
                      ...myOpening,
                      share: Math.max(CUT_MIN_SHARE, Math.round(((myOpening.share ?? CUT_DEFAULT_SHARE) - 0.05) * 20) / 20),
                    })
                  }
                >
                  −
                </button>
                <span className="w-14 text-center">{Math.round((myOpening.share ?? CUT_DEFAULT_SHARE) * 100)}%</span>
                <button
                  type="button"
                  className="h-5 w-5 rounded border border-panel-border"
                  onClick={() =>
                    setOpening({
                      ...myOpening,
                      share: Math.min(CUT_MAX_SHARE, Math.round(((myOpening.share ?? CUT_DEFAULT_SHARE) + 0.05) * 20) / 20),
                    })
                  }
                >
                  +
                </button>
              </span>
            </div>
          )}
          <p className="text-muted-foreground">
            {atTable ? "They answer it the moment you put it down." : "They answer it the moment the bosses sit."}
          </p>
        </div>
      )}
    </div>
  );
}
