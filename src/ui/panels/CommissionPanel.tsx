import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useGameStore } from "@/engine/store";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import {
  FAMILY_HEX,
  type FamilyName,
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
import { agendaLabel } from "@/engine/agendas";
import AgendaPicker from "./AgendaPicker";
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
import { commissionMinutes, minuteAge, minuteFamily, rivalFeuds, seatChips } from "@/engine/commissionMinutes";
import {
  canCallCommission,
  canCallWar,
  COMMISSION_COOLDOWN,
  COMMISSION_INFLUENCE,
  commissionHealth,
  defiances,
  hasCase,
  LOBBY_CASH,
  LOBBY_INFLUENCE,
  lobbyLean,
} from "@/engine/commission";
import PortraitAvatar from "@/ui/PortraitAvatar";

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
  const defunctFamilies = useGameStore((s) => s.defunctFamilies);
  const diplomacy = useGameStore((s) => s.diplomacy);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const intel = useGameStore((s) => s.intel);
  const turn = useGameStore((s) => s.turn);
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
      <CommissionHealthBlock />
      <CommissionCallBlock />
      <Minutes />
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
          const chips = seatChips({ crew, turn, defunctFamilies, diplomacy, playerFamily }, f);
          const finished = (defunctFamilies ?? []).includes(f);

          return (
            <div
              key={relationKey(playerFamily, f)}
              className={`rounded-md border px-3 py-2 ${
                finished
                  ? "border-panel-border/40 bg-panel/20 text-muted-foreground opacity-60"
                  : "border-panel-border bg-panel/50"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: finished ? "#6b7280" : FAMILY_HEX[f] }}
                  />
                  <div>
                    <div className={`text-sm font-medium ${finished ? "text-muted-foreground" : ""}`}>{def.name}</div>
                    <div className="text-[10px] text-muted-foreground">{def.specialty}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {chips.map((chip, i) => (
                    <Badge
                      key={`${chip.kind}_${i}`}
                      variant="outline"
                      className={`text-[10px] ${
                        chip.kind === "new_boss"
                          ? "text-amber-300"
                          : chip.kind === "finished"
                            ? "border-heat/40 text-heat"
                            : "text-muted-foreground"
                      }`}
                    >
                      {chip.kind === "new_boss"
                        ? `${chip.name} · new in the chair`
                        : chip.kind === "headless"
                          ? "No boss"
                          : chip.kind === "finished"
                            ? "Finished — nobody left for the chair"
                            : chip.kind === "jailed"
                            ? `${chip.name} in the Tombs`
                            : chip.kind === "sanctioned"
                              ? "Sanctioned — the table won't sit with you"
                              : `${chip.name} wounded`}
                    </Badge>
                  ))}
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
                  <DefianceBadge target={f} />
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
              {!finished && (
              <div className="mt-2 flex flex-wrap gap-1">
                {DIPLOMACY_ACTIONS.filter((a) => a.id !== "sitdown").map((action) => (
                  <DiplomacyButton
                    key={action.id}
                    action={action}
                    target={f}
                    onAct={takeDiplomacy}
                  />
                ))}
                <CommissionButton target={f} />
                <WarCallButton target={f} />
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
              )}
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
  const [pick, setPick] = useState<AgendaPick | undefined>(undefined);
  const [subjectOk, setSubjectOk] = useState(true);
  const allowed = canDiplomacy(state, "sitdown", target);
  const hint = diplomacyHint(state, "sitdown", target);
  const stance = stanceRead(state, target);
  const player = state.playerFamily;

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

          <AgendaPicker
            target={target}
            onChange={(next, ok) => {
              setPick(next);
              setSubjectOk(ok);
            }}
          />

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
          {s.purpose && s.purpose !== "general" ? ` · ${agendaLabel(s.purpose).toLowerCase()}` : " · open table"} ·{" "}
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

/** What the table has been talking about: hits, chairs changing hands, deals, feuds. */
/** Ask the Commission to sit on the trouble with one rival. */
function CommissionButton({ target }: { target: FamilyName }) {
  const state = useGameStore();
  const callCommission = useGameStore((s) => s.callCommission);
  const check = canCallCommission(state, target);
  const noCase = !hasCase(state, target);
  const health = commissionHealth(state);
  const tip = check.ok
    ? `Costs ${COMMISSION_INFLUENCE} standing. One call every ${COMMISSION_COOLDOWN} weeks. The vote is at the end of the week. ${health.tier}${health.sway >= 0.75 ? " — the seats start on your side." : health.sway < 0.25 ? " — expect to pay for every ear." : "."}${noCase ? " You have no case against them — the seats won't like it." : ""}`
    : check.reason;
  return (
    <Tip wrapDisabled content={tip}>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-6 px-1.5 text-[10px]"
        disabled={!check.ok}
        onClick={() => callCommission(target)}
      >
        Call the Commission
      </Button>
    </Tip>
  );
}

/** A family that ignored a ruling the table still remembers. */
function DefianceBadge({ target }: { target: FamilyName }) {
  const state = useGameStore();
  const ignored = defiances(state, target);
  if (ignored.length === 0) return null;
  return (
    <Tip
      content={`${target} ignored the Commission's ruling ${ignored.length === 1 ? "once" : `${ignored.length} times`} lately. Every refusal makes a message hit from the table likelier — and a boss the table listens to can ask it to go to war.`}
    >
      <Badge variant="outline" className="text-[10px] text-amber-300">
        Ignored the table{ignored.length > 1 ? ` ×${ignored.length}` : ""}
      </Badge>
    </Tip>
  );
}

/** Ask the table to go to war with a family that ignored it. Only shown once they have. */
function WarCallButton({ target }: { target: FamilyName }) {
  const state = useGameStore();
  const callWar = useGameStore((s) => s.callCommissionWar);
  if (defiances(state, target).length === 0) return null;
  const check = canCallWar(state, target);
  const tip = check.ok
    ? `Costs ${COMMISSION_INFLUENCE} standing. The seats vote at the end of the week; those who say yes go to war with ${target} alongside you. A no costs you 3 respect.`
    : check.reason;
  return (
    <Tip wrapDisabled content={tip}>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-6 px-1.5 text-[10px] text-heat"
        disabled={!check.ok}
        onClick={() => callWar(target)}
      >
        Call the table to war
      </Button>
    </Tip>
  );
}

/** The open call: who leans which way, and the week's lobbying. */
function CommissionCallBlock() {
  const call = useGameStore((s) => s.commissionCall);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const crew = useGameStore((s) => s.crew);
  const money = useGameStore((s) => s.money);
  const influence = useGameStore((s) => s.influence);
  const lobby = useGameStore((s) => s.lobbySeat);
  const health = commissionHealth(useGameStore());
  if (!call || call.phase !== "lobby" || call.caller !== playerFamily) return null;
  const shift = (health.sway - 0.5) * 0.4;

  return (
    <div className="mb-3 rounded-md border border-panel-border bg-panel/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {call.kind === "war"
          ? `The Commission weighs war on ${call.accused}`
          : `The Commission sits on the trouble with ${call.accused}`}
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground">
        The vote is counted at the end of the week. Your weight at the table shifts every seat {shift >= 0 ? "+" : ""}
        {shift.toFixed(2)} your way.
      </p>
      <div className="mt-2 space-y-1.5">
        {call.seats.map((seat) => {
          const boss = crew.find((c) => c.family === seat.family && c.role === "boss");
          const lean = Math.max(-1, Math.min(1, seat.lean));
          const bought = call.lobbied[seat.family];
          const word = lean > 0.2 ? "leaning your way" : lean < -0.2 ? `leaning ${call.accused}'s way` : "undecided";
          return (
            <div key={seat.family} className="flex items-center gap-2">
              {boss && (
                <PortraitAvatar
                  seed={boss.portraitSeed}
                  size={28}
                  role="boss"
                  family={boss.family}
                  ringColor={FAMILY_HEX[seat.family]}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-steel-light">{seat.family}</span>
                  <span className="text-muted-foreground">{word}</span>
                </div>
                <div className="mt-0.5 h-1 rounded bg-panel-border">
                  <div
                    className="h-1 rounded"
                    style={{ width: `${((lean + 1) / 2) * 100}%`, background: lean >= 0 ? "#34d399" : "#e85d4c" }}
                  />
                </div>
              </div>
              {bought ? (
                <span className="text-[10px] text-muted-foreground">spoken to</span>
              ) : (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-5 px-1 text-[10px]"
                    disabled={money < LOBBY_CASH}
                    onClick={() => lobby(seat.family, "cash")}
                  >
                    ${LOBBY_CASH}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-5 px-1 text-[10px]"
                    disabled={influence < LOBBY_INFLUENCE}
                    onClick={() => lobby(seat.family, "influence")}
                  >
                    {LOBBY_INFLUENCE} standing
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Minutes() {
  const turnLog = useGameStore((s) => s.turnLog);
  const turn = useGameStore((s) => s.turn);
  const relations = useGameStore((s) => s.relations);
  const playerFamily = useGameStore((s) => s.playerFamily);
  if (!playerFamily) return null;
  const lines = commissionMinutes(turnLog, turn);
  const feuds = rivalFeuds({ relations, playerFamily });
  if (lines.length === 0 && feuds.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border border-panel-border bg-panel/50 px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Minutes</div>
      {lines.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">A quiet few weeks at the table.</p>
      ) : (
        <ul className="space-y-1">
          {lines.map((log) => {
            const fam = minuteFamily(log);
            const hearsay = log.attribution === "suspected" || log.attribution === "unknown";
            return (
              <li key={log.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: fam ? FAMILY_HEX[fam] : "transparent" }}
                />
                <span className={`min-w-0 flex-1 ${hearsay ? "italic text-foreground/80" : ""}`}>{log.text}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{minuteAge(log, turn)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {feuds.length > 0 && (
        <p className="mt-1.5 border-t border-panel-border pt-1.5 text-[10px] text-muted-foreground">
          {feuds
            .map((f) =>
              f.status === "war"
                ? `${f.a} and ${f.b} at war`
                : f.status === "hostile"
                  ? `${f.a} and ${f.b} on bad terms`
                  : `${f.a} allied with ${f.b}`,
            )
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

function CommissionHealthBlock() {
  const state = useGameStore();
  if (!state.playerFamily) return null;
  const health = commissionHealth(state);
  const lean = (health.sway - 0.5) * 0.4;
  const bought = lobbyLean(state);
  const message = Math.max(0, 0.35 - 0.2 * health.sway);
  const rows: { label: string; value: number; max: number; tip: string }[] = [
    {
      label: "Standing",
      value: health.parts.standing,
      max: 30,
      tip: "Lead the table in standing. A call costs 25, and the rest of what the families have banked is the measure.",
    },
    {
      label: "Fear",
      value: health.parts.fear,
      max: 20,
      tip: "A family nobody fears gets talked over. Hits that land, and how the street reads you, raise it.",
    },
    {
      label: "Relations",
      value: health.parts.relations,
      max: 30,
      tip: "The average of how the living families feel about you. Sit-downs, tributes and kept deals move it.",
    },
    {
      label: "Wealth",
      value: health.parts.wealth,
      max: 20,
      tip: "Clean and dirty cash against the richest family. A broke boss doesn't get heard.",
    },
  ];
  return (
    <div className="mb-3 rounded-md border border-panel-border bg-panel/50 px-3 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Commission health</span>
        <span>
          {health.score} · {health.tier}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full bg-steel" style={{ width: `${health.score}%` }} />
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        {rows.map((r) => (
          <Tip key={r.label} content={r.tip}>
            <span>
              {r.label} {r.value}/{r.max}
            </span>
          </Tip>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        Right now: seats lean {lean >= 0 ? "+" : ""}
        {lean.toFixed(2)} your way · lobbying buys +{bought.toFixed(2)} · a refusal draws a message{" "}
        {Math.round(message * 100)}% of the time.
      </p>
    </div>
  );
}

function Standings() {
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const territories = useGameStore((s) => s.territories);
  const victory = useGameStore((s) => s.victory);
  const snapshot = useGameStore();
  const defunct = useGameStore((s) => s.defunctFamilies);
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
        {rows.map((row) => {
          const gone = (defunct ?? []).includes(row.f);
          return (
          <div
            key={row.f}
            className={`flex items-center justify-between gap-2 text-[11px] ${gone ? "opacity-40" : ""}`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: gone ? "#6b7280" : FAMILY_HEX[row.f] }}
              />
              <span className={row.f === playerFamily && !gone ? "text-foreground" : "text-muted-foreground"}>
                {getFamilyDef(row.f).name}
                {gone ? " — finished" : ""}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {row.influence} standing · {formatMoney(row.wealth)} · {row.districts} blocks
            </span>
          </div>
          );
        })}
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
