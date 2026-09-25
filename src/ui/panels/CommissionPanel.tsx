import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import {
  FAMILY_HEX,
  type AgendaTerms,
  type FamilyName,
  type SitdownAgenda,
  type SitdownVenue,
} from "@/types/game";
import {
  HOST_FEE,
  hostOf,
  resolveVenue,
  scheduledSitdowns,
  stanceRead,
  venueAcceptance,
  venueLabel,
  venueTravel,
  type AgendaPick,
  type SitdownParty,
} from "@/engine/sitdowns";
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
} from "@/engine/agendas";
import { activeDeals, dealKindLabel, dealPartner, truceBetween, weeklyCut } from "@/engine/deals";
import { getRelation, relationKey, statusFromScore } from "@/engine/relations";
import {
  canDiplomacy,
  diplomacyHint,
  type DiplomacyAction,
} from "@/engine/diplomacy";
import { emptyIntel, familyHq, hasFreshCasing, isCrewVisible } from "@/engine/intel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PanelShell from "./PanelShell";
import Tip from "@/ui/Tip";
import { titleCase, formatMoney } from "../formatters";
import { familyInfluence, familyWealth, LEAD_TURNS, STREAK_START_TURN } from "@/engine/victory";

const DIPLOMACY_ACTIONS: { id: DiplomacyAction; label: string; war?: boolean }[] = [
  { id: "sitdown", label: "Sit-down" },
  { id: "tribute", label: "Tribute" },
  { id: "demand", label: "Demand" },
  { id: "pact", label: "Pact" },
  { id: "war", label: "War", war: true },
];

const STATUS_COLOR: Record<string, string> = {
  war: "text-heat",
  hostile: "text-heat",
  cold: "text-muted-foreground",
  neutral: "text-muted-foreground",
  truce: "text-steel-light",
  allied: "text-emerald-400",
};

export default function CommissionPanel() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const relations = useGameStore((s) => s.relations);
  const vendettas = useGameStore((s) => s.vendettas);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
  const influence = useGameStore((s) => s.influence);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const pacts = useGameStore((s) => s.diplomacy?.pacts);
  const deals = useGameStore((s) => s.deals);
  const takeDiplomacy = useGameStore((s) => s.takeDiplomacy);
  const proposeSitdown = useGameStore((s) => s.proposeSitdown);
  const sitdowns = useGameStore((s) => s.sitdowns);
  const [sitdownFor, setSitdownFor] = useState<FamilyName | null>(null);

  if (!playerFamily) return null;
  const rivals = ALL_FAMILY_NAMES.filter((f) => f !== playerFamily);
  const locState = {
    crew,
    territories,
    routes,
    operations,
    playerFamily,
    intel: intel ?? emptyIntel(),
    turn,
  };

  return (
    <PanelShell title="The Commission" subtitle="Standing among the families">
      <Standings />
      <p className="mb-2 text-[11px] text-muted-foreground">
        Your standing {Math.round(influence)} · wealth {formatMoney(money + dirtyMoney)}
      </p>
      <ScheduledSitdowns />
      <Deals />
      <div className="space-y-2">
        {rivals.map((f) => {
          const score = getRelation(relations, playerFamily, f);
          const status = statusFromScore(score);
          const def = getFamilyDef(f);
          const inVendetta = vendettas.includes(f);
          const truce = truceBetween({ deals: deals ?? [], turn, playerFamily }, playerFamily, f);
          const hq = familyHq(locState, f);
          const hqName = territories.find((t) => t.id === hq)?.name ?? "—";
          const familyCrew = crew.filter(
            (c) => c.family === f && (c.status === "active" || c.status === "wounded"),
          );
          const known = familyCrew.filter((c) => isCrewVisible(locState, c)).length;
          const familyOpen = (intel?.familyReveal?.[f] ?? 0) > turn;
          const totalLabel = familyOpen ? String(familyCrew.length) : "?";
          const pactUntil = pacts?.[f];
          const pactLeft =
            pactUntil != null && turn < pactUntil ? pactUntil - turn : null;
          const meeting = (sitdowns ?? []).some(
            (s) => s.status === "scheduled" && (s.proposer === f || s.other === f),
          );

          return (
            <div
              key={relationKey(playerFamily, f)}
              className="rounded-md border border-panel-border bg-panel/50 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_HEX[f] }} />
                  <div>
                    <div className="text-sm font-medium">{def.name}</div>
                    <div className="text-[10px] text-muted-foreground">{def.specialty}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {pactLeft != null && (
                    <Badge variant="outline" className="text-[10px] text-emerald-400">
                      Allied · {pactLeft}t
                    </Badge>
                  )}
                  {truce && truce.untilTurn != null && (
                    <Badge variant="outline" className="text-[10px] text-steel-light">
                      Truce · {truce.untilTurn - turn}w
                    </Badge>
                  )}
                  {inVendetta && (
                    <Badge variant="outline" className="flex items-center gap-1 text-[10px] text-heat">
                      <AlertTriangle className="h-3 w-3" /> Vendetta
                    </Badge>
                  )}
                  <span className={`text-xs font-semibold ${STATUS_COLOR[status]}`}>
                    {titleCase(status)} ({score})
                  </span>
                </div>
              </div>
              <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                <span>HQ: {hqName}</span>
                <span>
                  Known men: {known} / {totalLabel}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {DIPLOMACY_ACTIONS.filter((a) => a.id !== "sitdown").map((action) => (
                  <DiplomacyButton
                    key={action.id}
                    action={action}
                    target={f}
                    onAct={takeDiplomacy}
                  />
                ))}
                <SitdownButton
                  target={f}
                  open={sitdownFor === f}
                  busy={!!meeting}
                  onToggle={() => setSitdownFor(sitdownFor === f ? null : f)}
                  onPick={(venue, party, pick) => {
                    setSitdownFor(null);
                    proposeSitdown(f, venue, party, pick);
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

const VENUES: SitdownVenue[] = ["ours", "theirs", "neutral"];

/** Sit-downs need a venue: it decides which boss has to travel. */
function SitdownButton({
  target,
  open,
  busy,
  onToggle,
  onPick,
}: {
  target: FamilyName;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onPick: (venue: SitdownVenue, party: SitdownParty, pick?: AgendaPick) => void;
}) {
  const state = useGameStore();
  const caseDistrict = useGameStore((s) => s.caseDistrict);
  const [men, setMen] = useState<string[]>([]);
  const [bringConsigliere, setBringConsigliere] = useState(false);
  const [agenda, setAgenda] = useState<SitdownAgenda>("general");
  const [subject, setSubject] = useState<string>("");
  const [withNumber, setWithNumber] = useState(false);
  const [opening, setOpening] = useState<AgendaTerms | null>(null);
  const allowed = canDiplomacy(state, "sitdown", target);
  const hint = diplomacyHint(state, "sitdown", target);
  const stance = stanceRead(state, target);
  const player = state.playerFamily;

  // What the talk is about, and what they'd open with.
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
  const agendaTable = agenda !== "general";
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
  const pick: AgendaPick | undefined = agendaTable
    ? { agenda, seed, opening: withNumber && myOpening ? myOpening : undefined }
    : undefined;
  const cashStep = theirAsk && Math.abs(theirAsk.cash) >= 1000 ? 100 : 50;
  // [min, max, default] weeks for the agendas that run for a stretch.
  const weekRange: [number, number, number] =
    agenda === "alliance"
      ? [2, 12, ALLIANCE_WEEKS]
      : agenda === "racket"
        ? [CUT_MIN_WEEKS, CUT_MAX_WEEKS, CUT_DEFAULT_WEEKS]
        : [TRUCE_MIN_WEEKS, TRUCE_MAX_WEEKS, TRUCE_DEFAULT_WEEKS];

  function chooseAgenda(next: SitdownAgenda) {
    setAgenda(next);
    setSubject("");
    setOpening(null);
    setWithNumber(false);
  }
  const bench = state.crew.filter(
    (c) =>
      c.family === player &&
      c.status === "active" &&
      c.role !== "boss" &&
      c.role !== "consigliere" &&
      c.assignment.type === "idle",
  );
  const consigliere = state.crew.find(
    (c) => c.family === player && c.role === "consigliere" && c.status === "active",
  );
  const party: SitdownParty = { entourageIds: men, bringConsigliere };
  const lookout = bench.find((c) => !men.includes(c.id));
  return (
    <div className="flex flex-col gap-1">
      <Tip wrapDisabled content={busy ? "A sit-down with them is already set" : hint}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 px-1.5 text-[10px]"
          disabled={!allowed.ok || busy}
          onClick={onToggle}
        >
          Sit-down
        </Button>
      </Tip>
      {open && (
        <div className="mt-1 w-56 space-y-1 rounded-md border border-panel-border bg-panel/80 p-1.5">
          <p className="px-1 text-[10px] text-steel-light">
            {stance.mood}. {stance.wants} Odds {Math.round(stance.odds * 100)}%.
          </p>
          {stance.tell && <p className="px-1 text-[10px] text-heat">{stance.tell}</p>}
          {consigliere && (
            <label className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={bringConsigliere}
                onChange={(e) => setBringConsigliere(e.target.checked)}
              />
              Bring {consigliere.name.split(" ").slice(-1)[0]}
            </label>
          )}
          {bench.slice(0, 6).map((c) => (
            <label key={c.id} className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={men.includes(c.id)}
                onChange={() =>
                  setMen((cur) =>
                    cur.includes(c.id) ? cur.filter((id) => id !== c.id) : cur.length >= 2 ? cur : [...cur, c.id],
                  )
                }
              />
              {c.name.split(" ").slice(-1)[0]} · {c.role}
            </label>
          ))}
          {men.length > 1 && (
            <p className="px-1 text-[10px] text-heat">Showing up heavy. They notice.</p>
          )}

          <div className="mt-1 border-t border-panel-border pt-1">
            <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">About</div>
            <div className="mt-0.5 flex flex-wrap gap-1 px-1">
              {PLAYER_AGENDAS.map((a) => {
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
                <p className="text-muted-foreground">They answer it the moment the bosses sit.</p>
              </div>
            )}
          </div>

          <div className="mt-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">Where</div>
          {VENUES.map((venue) => {
            const travel = venueTravel(state, target, venue);
            const chance = Math.round(venueAcceptance(state, target, venue, men.length) * 100);
            const host = hostOf(state, target, venue);
            const venueId = resolveVenue(state, target, venue);
            const cased = venueId ? hasFreshCasing(state, venueId) : false;
            const rivalOwned =
              !!venueId &&
              state.territories.find((t) => t.id === venueId)?.owner !== player &&
              !!state.territories.find((t) => t.id === venueId)?.owner;
            return (
              <div key={venue} className="rounded px-1.5 py-1 hover:bg-panel-border">
                <button
                  type="button"
                  disabled={!subjectOk}
                  onClick={() => onPick(venue, party, pick)}
                  className="flex w-full flex-col text-left disabled:opacity-40"
                >
                  <span className="flex items-center justify-between text-[11px]">
                    <span>{venueLabel(venue)}</span>
                    <span className="text-muted-foreground">{chance}%</span>
                  </span>
                  <span className={`text-[10px] ${travel.playerTravels ? "text-heat" : "text-muted-foreground"}`}>
                    {travel.playerTravels
                      ? "Your boss travels — a package on his car goes with him"
                      : "Your boss stays home"}
                  </span>
                  {host && (
                    <span className="text-[10px] text-muted-foreground">
                      Hosted by {host} — ${HOST_FEE} each
                    </span>
                  )}
                  {venueId && (
                    <span className="text-[10px] text-muted-foreground">
                      {cased ? "Venue cased" : "Venue not cased"}
                    </span>
                  )}
                </button>
                {venueId && rivalOwned && !cased && lookout && (
                  <button
                    type="button"
                    className="text-[10px] text-steel-light hover:underline"
                    onClick={() => caseDistrict(venueId, lookout.id)}
                  >
                    Case it
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Arrangements struck at the table that still bind. */
function Deals() {
  const deals = useGameStore((s) => s.deals);
  const turn = useGameStore((s) => s.turn);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const territories = useGameStore((s) => s.territories);
  const breakDeal = useGameStore((s) => s.breakDeal);
  const fulfilLiquorDeal = useGameStore((s) => s.fulfilLiquorDeal);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!playerFamily) return null;
  const live = activeDeals({ deals: deals ?? [], turn, playerFamily });
  if (live.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Deals</div>
      {live.map((d) => {
        const other = dealPartner({ playerFamily }, d);
        const left = d.untilTurn == null ? null : d.untilTurn - turn;
        const theyOwe = !!d.obligor && d.obligor !== playerFamily;
        const forFavor = d.terms.calledIn ? " — for the favor you owed" : "";
        const detail =
          d.kind === "truce"
            ? "guns down both ways"
            : d.kind === "alliance"
              ? theyOwe
                ? `they hit ${d.terms.targetFamily} — you pay $${d.terms.cash} when it's done`
                : `hit ${d.terms.targetFamily}${forFavor || ` — $${-d.terms.cash} on the job`}`
              : d.kind === "liquor"
                ? `${d.terms.crates} crates to ${territories.find((t) => t.id === d.terms.destTerritoryId)?.name ?? "their speakeasy"}${forFavor || ` — $${-d.terms.cash} on delivery`}`
                : d.kind === "cut"
                  ? `${Math.round((d.terms.share ?? 0) * 100)}% of ${territories.find((t) => t.id === d.terms.territoryId)?.name ?? "the block"} — $${weeklyCut({ territories }, d)}/wk ${theyOwe ? "to you" : "to them"}`
                  : "they'll call it in when they need something";
        return (
          <div key={d.id} className="rounded-md border border-panel-border bg-panel/50 px-2 py-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span>
                <span className="h-2 w-2 rounded-full" style={{ background: FAMILY_HEX[other] }} />{" "}
                {dealKindLabel(d.kind)} with {other}
              </span>
              <span className="text-muted-foreground">
                {left == null ? "open" : left <= 1 ? "last week" : `${left} weeks left`}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">{detail}</div>
            <div className="mt-1 flex gap-2">
              {d.kind === "liquor" && d.obligor === playerFamily && (
                <button
                  type="button"
                  className="text-[10px] text-emerald-400 hover:underline"
                  onClick={() => fulfilLiquorDeal(d.id)}
                >
                  Send the crates
                </button>
              )}
              {confirm === d.id ? (
                <>
                  <span className="text-[10px] text-heat">Every family hears. Standing −20.</span>
                  <button
                    type="button"
                    className="text-[10px] text-heat hover:underline"
                    onClick={() => {
                      setConfirm(null);
                      breakDeal(d.id);
                    }}
                  >
                    Break it
                  </button>
                  <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => setConfirm(null)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-heat hover:underline"
                  onClick={() => setConfirm(d.id)}
                >
                  Break it…
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Meetings already on the books, shown once above the families. */
function ScheduledSitdowns() {
  const sitdowns = useGameStore((s) => s.sitdowns);
  const territories = useGameStore((s) => s.territories);
  const turn = useGameStore((s) => s.turn);
  const scheduled = scheduledSitdowns({ sitdowns });
  if (scheduled.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {scheduled.map((s) => (
        <p key={s.id} className="text-[11px] text-steel-light">
          Sit-down with {s.proposer === useGameStore.getState().playerFamily ? s.other : s.proposer}
          {s.purpose && s.purpose !== "general" ? ` · ${agendaLabel(s.purpose).toLowerCase()}` : ""} ·{" "}
          {territories.find((t) => t.id === s.venueTerritoryId)?.name ?? "a back room"} ·{" "}
          {s.heldTurn <= turn + 1
            ? "next week"
            : s.heldTurn === turn + 2
              ? "in two weeks — time to case it"
              : `turn ${s.heldTurn}`}
        </p>
      ))}
    </div>
  );
}

function Standings() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const territories = useGameStore((s) => s.territories);
  const victory = useGameStore((s) => s.victory);
  const snapshot = useGameStore();
  if (!playerFamily) return null;
  const left = Math.max(0, (victory?.finalTurn ?? 50) - turn);
  const rows = ALL_FAMILY_NAMES.map((f) => ({
    f,
    influence: Math.round(familyInfluence(snapshot, f)),
    wealth: familyWealth(snapshot, f),
    districts: territories.filter((t) => t.owner === f).length,
  })).sort((a, b) => b.influence - a.influence || b.wealth - a.wealth);

  return (
    <div className="mb-3 rounded-md border border-panel-border bg-panel/50 px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>The table</span>
        <span>
          {left === 0
            ? "Summit this week"
            : `${left} week${left === 1 ? "" : "s"} to the summit`}
        </span>
      </div>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.f} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: FAMILY_HEX[row.f] }} />
              <span className={row.f === playerFamily ? "text-foreground" : "text-muted-foreground"}>
                {getFamilyDef(row.f).name}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {row.influence} standing · {formatMoney(row.wealth)} · {row.districts} blocks
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        {turn < STREAK_START_TURN
          ? `Sudden death opens turn ${STREAK_START_TURN}`
          : `Sudden death ${victory?.influenceLeadTurns ?? 0}/${LEAD_TURNS} standing · ${victory?.wealthLeadTurns ?? 0}/${LEAD_TURNS} wealth`}
        {(victory?.bankruptTurns ?? 0) > 0 ? ` · broke ${victory.bankruptTurns}/3` : ""}
      </p>
    </div>
  );
}

function DiplomacyButton({
  action,
  target,
  onAct,
}: {
  action: { id: DiplomacyAction; label: string; war?: boolean };
  target: FamilyName;
  onAct: (action: DiplomacyAction, target: FamilyName) => void;
}) {
  const state = useGameStore();
  const hint = diplomacyHint(state, action.id, target);
  const allowed = canDiplomacy(state, action.id, target).ok;
  return (
    <Tip wrapDisabled content={hint}>
      <Button
        type="button"
        size="sm"
        variant={action.war ? "outline" : "secondary"}
        className={`h-6 px-1.5 text-[10px] ${action.war ? "text-heat" : ""}`}
        disabled={!allowed}
        onClick={() => onAct(action.id, target)}
      >
        {action.label}
      </Button>
    </Tip>
  );
}
