import { useEffect, useState } from "react";
import { useGameStore } from "@/engine/store";
import {
  FAMILY_HEX,
  type FamilyName,
  type PassageTerms,
  type Sitdown,
  type SitdownVenue,
} from "@/types/game";
import { hasFreshCasing } from "@/engine/intel";
import {
  HOST_FEE,
  pendingSitdowns,
  stanceRead,
  venueAcceptance,
  venueLabel,
  venueTravel,
  type SitdownParty,
} from "@/engine/sitdowns";
import { counterAcceptance, termsText, termsValue } from "@/engine/passage";
import { agendaLabel, agendaTermsText } from "@/engine/agendas";
import { isAgendaTable } from "@/engine/sitdowns";
import { currentRumors } from "@/engine/rumors";
import { Button } from "@/components/ui/button";

const VENUES: SitdownVenue[] = ["ours", "theirs", "neutral"];

/**
 * A rival family's invitation to the table, their counter to one of ours, or
 * an open passage negotiation. One at a time, before the week's other business.
 */
export default function SitdownRequestModal() {
  const sitdowns = useGameStore((s) => s.sitdowns);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const rumors = useGameStore((s) => s.rumors);
  const turn = useGameStore((s) => s.turn);
  const territories = useGameStore((s) => s.territories);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const pendingReports = useGameStore((s) => s.pendingReports);
  const sitdownPhase = useGameStore((s) => s.sitdownPhase);
  const sitdownQueue = useGameStore((s) => s.sitdownCinematicQueue?.length ?? 0);
  const sitdownCards = useGameStore((s) => s.pendingSitdownResults?.length ?? 0);
  const dealCards = useGameStore((s) => s.pendingDealSettlements?.length ?? 0);
  const answerInvite = useGameStore((s) => s.answerSitdownInvite);
  const answerCounter = useGameStore((s) => s.answerSitdownCounter);
  const [countering, setCountering] = useState(false);
  const [party, setParty] = useState<SitdownParty>({ entourageIds: [], bringConsigliere: false });

  if (
    activeEvent ||
    pendingHitResult ||
    sitdownPhase ||
    sitdownQueue > 0 ||
    sitdownCards > 0 ||
    dealCards > 0 ||
    (pendingReports?.length ?? 0) > 0
  ) {
    return null;
  }
  if (!playerFamily) return null;

  const sitdown = pendingSitdowns({ sitdowns, playerFamily }).find((s) => s.status !== "at_table");
  if (!sitdown) return null;

  const state = useGameStore.getState();
  const incoming = sitdown.proposer !== playerFamily;
  const family = incoming ? sitdown.proposer : sitdown.other;
  const offered: SitdownVenue = incoming ? sitdown.venue : sitdown.counterVenue ?? sitdown.venue;
  const where =
    territories.find((t) => t.id === sitdown.venueTerritoryId)?.name ?? "a back room";
  const travel = venueTravel(state, family, offered);
  const passage = sitdown.purpose === "passage";
  const agenda = isAgendaTable(sitdown.purpose) && sitdown.table ? sitdown.purpose! : null;

  const street = currentRumors({ rumors, turn }).filter(
    (r) => r.kind === "pending_hit" && (r.fidelity === "how" || r.fidelity === "from_whom" || r.family === family),
  );

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[440px] rounded-lg border p-5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_HEX[family] }} />
          <h2 className="font-display text-lg text-steel-light">
            {incoming
              ? passage
                ? `${family} wants to talk about your trucks`
                : agenda
                  ? `${family} wants to talk: ${agendaLabel(agenda).toLowerCase()}`
                  : `${family} wants a sit-down`
              : `${family} counters`}
          </h2>
        </div>

        <p className="mt-3 text-sm text-foreground/90">
          {incoming
            ? passage
              ? sitdown.passage?.demanded
                ? `${family} has made their point. They want you at ${where} in two weeks to settle passage through their turf — on their terms.`
                : `${family} has noticed your trucks on their blocks. They propose meeting in two weeks at ${where} to set a price for passage.`
              : agenda
                ? `${family} proposes meeting in two weeks at ${where} — ${venueLabel(offered)}. What they want: ${agendaTermsText(state, agenda, sitdown.table!.ask)}. The number gets settled at the table.`
                : `${family} proposes meeting in two weeks at ${where} — ${venueLabel(offered)}.`
            : `${family} won't take your terms. They'll meet at ${where} — ${venueLabel(offered)}.`}
        </p>

        <TravelNote travels={travel.playerTravels} where={where} />
        <StanceLine family={family} />
        {sitdown.hostFamily && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Hosted by {sitdown.hostFamily} — ${HOST_FEE} each. Blood at their table is not forgiven.
          </p>
        )}
        <PartyPicker party={party} onChange={setParty} />

        {street.length > 0 && (
          <div className="mt-3 rounded-md border border-heat/40 bg-heat/10 p-2">
            <div className="text-[10px] uppercase tracking-wide text-heat">Word on the street</div>
            {street.map((r) => (
              <p key={r.id} className="mt-1 text-[11px] italic text-foreground/80">
                {r.text}
              </p>
            ))}
          </div>
        )}

        {countering ? (
          <div className="mt-4 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Move it where?
            </div>
            {VENUES.filter((v) => v !== offered).map((v) => (
              <VenueChoice
                key={v}
                venue={v}
                family={family}
                onPick={(venue) => {
                  setCountering(false);
                  answerInvite(sitdown.id, "counter", venue, party);
                }}
              />
            ))}
            <Button variant="ghost" className="w-full" onClick={() => setCountering(false)}>
              Back
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() =>
                incoming ? answerInvite(sitdown.id, "decline") : answerCounter(sitdown.id, false)
              }
            >
              {incoming ? "Decline" : "Walk away"}
            </Button>
            {incoming && (
              <Button variant="secondary" className="flex-1" onClick={() => setCountering(true)}>
                Counter
              </Button>
            )}
            <Button
              className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
              onClick={() =>
                incoming ? answerInvite(sitdown.id, "accept", undefined, party) : answerCounter(sitdown.id, true)
              }
            >
              Accept
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Passage terms                                                       */
/* ------------------------------------------------------------------ */

export function PassageTable({ sitdown, playerFamily, embedded }: { sitdown: Sitdown; playerFamily: FamilyName; embedded?: boolean }) {
  const territories = useGameStore((s) => s.territories);
  const supplyRoutes = useGameStore((s) => s.supplyRoutes ?? []);
  const money = useGameStore((s) => s.money);
  const dirtyMoney = useGameStore((s) => s.dirtyMoney);
  const answerPassage = useGameStore((s) => s.answerPassage);

  const family = sitdown.proposer === playerFamily ? sitdown.other : sitdown.proposer;
  const ask = sitdown.passage!.ask;
  const rounds = sitdown.passage!.rounds;
  const lastWord = rounds >= 2;
  const route = supplyRoutes.find((r) => r.id === sitdown.passage?.routeId);
  const crates = route?.cratesPerTurn ?? 10;
  const where = territories.find((t) => t.id === sitdown.venueTerritoryId)?.name ?? "their back room";

  const [offer, setOffer] = useState<PassageTerms>(ask);
  const [countering, setCountering] = useState(false);
  // The ask moves after each round; start the next counter from it.
  useEffect(() => {
    setOffer(ask);
  }, [ask]);

  const state = useGameStore.getState();
  const chance = counterAcceptance(state, family, ask, offer, crates);
  const canPayGift = (t: PassageTerms) => t.gift <= Math.max(0, dirtyMoney) + Math.max(0, money);
  const weekly = (t: PassageTerms) =>
    Math.ceil(crates * t.tollPerCrate) + Math.floor(crates * t.cratesCut) * 12;

  return (
    <div className={embedded ? "" : "absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm"}>
      <div className={embedded ? "w-full" : "panel-surface-elevated w-[480px] rounded-lg border p-5"}>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_HEX[family] }} />
          <h2 className="font-display text-lg text-steel-light">At the table with {family}</h2>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {where} · passage for {route ? `${crates} crates a week, ${nameOf(territories, route.sourceTerritoryId)} → ${nameOf(territories, route.destTerritoryId)}` : "your trucks"}
        </p>

        <div className="mt-3 rounded-md border border-panel-border bg-panel/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {lastWord ? "Their last word" : rounds > 0 ? "Their revised ask" : "Their ask"}
          </div>
          <p className="mt-1 text-sm text-foreground">{termsText(ask)}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            ≈ ${weekly(ask)}/week on the road{ask.gift > 0 ? ` + $${ask.gift} now` : ""}
            {!canPayGift(ask) && <span className="text-heat"> · you can't cover the gift</span>}
          </p>
        </div>

        {countering && !lastWord ? (
          <div className="mt-3 space-y-2 rounded-md border border-steel/40 bg-panel/40 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Your counter</div>
            <TermRow
              label="Toll per crate"
              value={`$${offer.tollPerCrate}`}
              onDec={() => setOffer({ ...offer, tollPerCrate: Math.max(0, offer.tollPerCrate - 1) })}
              onInc={() => setOffer({ ...offer, tollPerCrate: offer.tollPerCrate + 1 })}
            />
            <TermRow
              label="Cut of the crates"
              value={`${Math.round(offer.cratesCut * 100)}%`}
              onDec={() => setOffer({ ...offer, cratesCut: Math.max(0, Math.round((offer.cratesCut - 0.05) * 100) / 100) })}
              onInc={() => setOffer({ ...offer, cratesCut: Math.min(0.3, Math.round((offer.cratesCut + 0.05) * 100) / 100) })}
            />
            <TermRow
              label="Gift up front"
              value={`$${offer.gift}`}
              onDec={() => setOffer({ ...offer, gift: Math.max(0, offer.gift - 100) })}
              onInc={() => setOffer({ ...offer, gift: offer.gift + 100 })}
            />
            <TermRow
              label="Runs for"
              value={offer.durationTurns === null ? "open-ended" : `${offer.durationTurns} weeks`}
              onDec={() =>
                setOffer({
                  ...offer,
                  durationTurns:
                    offer.durationTurns === null ? 16 : Math.max(4, offer.durationTurns - 2),
                })
              }
              onInc={() =>
                setOffer({
                  ...offer,
                  durationTurns:
                    offer.durationTurns === null
                      ? null
                      : offer.durationTurns >= 16
                        ? null
                        : offer.durationTurns + 2,
                })
              }
            />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                ≈ ${weekly(offer)}/week · worth {Math.round((termsValue(offer, crates) / Math.max(1, termsValue(ask, crates))) * 100)}% of their ask
              </span>
              <span className={chance >= 0.5 ? "text-emerald-300" : chance >= 0.25 ? "text-amber-300" : "text-heat"}>
                {Math.round(chance * 100)}% they take it
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Round {rounds + 1} of 2. If they refuse they come down a little; refuse twice and it's take it or leave it.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setCountering(false)}>
                Back
              </Button>
              <Button
                className="flex-1"
                disabled={!canPayGift(offer)}
                onClick={() => {
                  setCountering(false);
                  answerPassage(sitdown.id, "counter", offer);
                }}
              >
                Put it to them
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => answerPassage(sitdown.id, "walk")}>
              Walk away
            </Button>
            {!lastWord && (
              <Button variant="secondary" className="flex-1" onClick={() => setCountering(true)}>
                Counter
              </Button>
            )}
            <Button
              className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
              disabled={!canPayGift(ask)}
              onClick={() => answerPassage(sitdown.id, "accept")}
            >
              Take the deal
            </Button>
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          Walking away sours things a little. Routes waiting on this deal will sit — or run hot, if you told them to.
        </p>
      </div>
    </div>
  );
}

function nameOf(territories: { id: string; name: string }[], id: string): string {
  return territories.find((t) => t.id === id)?.name ?? id;
}

export function TermRow({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDec}
          className="h-6 w-6 rounded border border-panel-border bg-panel/60 text-sm leading-none hover:border-steel-light"
        >
          −
        </button>
        <span className="w-24 text-center text-foreground">{value}</span>
        <button
          type="button"
          onClick={onInc}
          className="h-6 w-6 rounded border border-panel-border bg-panel/60 text-sm leading-none hover:border-steel-light"
        >
          +
        </button>
      </span>
    </div>
  );
}

function StanceLine({ family }: { family: FamilyName }) {
  const state = useGameStore();
  const read = stanceRead(state, family);
  return (
    <p className="mt-2 text-[11px] text-steel-light">
      {read.mood}. {read.wants} Odds {Math.round(read.odds * 100)}%.
      {read.tell ? ` ${read.tell}` : ""}
    </p>
  );
}

function PartyPicker({
  party,
  onChange,
}: {
  party: SitdownParty;
  onChange: (party: SitdownParty) => void;
}) {
  const crew = useGameStore((s) => s.crew);
  const player = useGameStore((s) => s.playerFamily);
  const bench = crew.filter(
    (c) =>
      c.family === player &&
      c.status === "active" &&
      c.role !== "boss" &&
      c.role !== "consigliere" &&
      c.assignment.type === "idle",
  );
  const consigliere = crew.find(
    (c) => c.family === player && c.role === "consigliere" && c.status === "active",
  );
  const men = party.entourageIds ?? [];
  return (
    <div className="mt-3 space-y-1">
      {consigliere && (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={!!party.bringConsigliere}
            onChange={(e) => onChange({ ...party, bringConsigliere: e.target.checked })}
          />
          Bring your consigliere
        </label>
      )}
      {bench.slice(0, 6).map((c) => (
        <label key={c.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={men.includes(c.id)}
            onChange={() =>
              onChange({
                ...party,
                entourageIds: men.includes(c.id)
                  ? men.filter((id) => id !== c.id)
                  : men.length >= 2
                    ? men
                    : [...men, c.id],
              })
            }
          />
          {c.name.split(" ").slice(-1)[0]} · {c.role}
        </label>
      ))}
    </div>
  );
}

function TravelNote({ travels, where }: { travels: boolean; where: string }) {
  return (
    <p className={`mt-2 text-[11px] ${travels ? "text-heat" : "text-muted-foreground"}`}>
      {travels
        ? `Your boss drives to ${where}. Any package on his car goes with him.`
        : "Held on your turf — your boss stays home."}
    </p>
  );
}

function VenueChoice({
  venue,
  family,
  onPick,
}: {
  venue: SitdownVenue;
  family: FamilyName;
  onPick: (venue: SitdownVenue) => void;
}) {
  const state = useGameStore.getState();
  const chance = Math.round(venueAcceptance(state, family, venue === "ours" ? "theirs" : "ours") * 100);
  const travel = venueTravel(state, family, venue);
  return (
    <button
      type="button"
      onClick={() => onPick(venue)}
      className="flex w-full items-center justify-between rounded-md border border-panel-border bg-panel/50 px-3 py-1.5 text-left text-[11px] hover:border-steel-light"
    >
      <span>
        {venueLabel(venue)}
        <span className="ml-1.5 text-muted-foreground">
          {travel.playerTravels ? "· you travel" : "· you stay home"}
        </span>
      </span>
      <span className="text-muted-foreground">{chance}% they take it</span>
    </button>
  );
}
