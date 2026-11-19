import { useGameStore } from "@/engine/store";
import { raceStatus, runaways, summitRatio, summitThreats, summitWatchWeeks, type WinTrack } from "@/engine/victory";
import { boroughSeats } from "@/engine/boroughSeats";
import { countHouseBlock, exposedCash } from "@/engine/countHouse";
import { familiesPressingSuddenDeath } from "@/engine/victory";
import { ALL_FAMILY_NAMES } from "@/data/families";
import { formatMoney } from "../formatters";
import PanelShell from "./PanelShell";

const TRACK_LABEL: Record<WinTrack, string> = { influence: "Standing", wealth: "Wealth", turf: "Turf" };
const TRACK_HOW: Record<WinTrack, string> = {
  influence: "buying standing and calling the table",
  wealth: "building books and bleeding the take",
  turf: "taking blocks",
};

function WhoIsChallenging() {
  const state = useGameStore();
  const noticed = runaways(state);
  const rows = (["influence", "wealth", "turf"] as WinTrack[]).map((track) => {
    const leader = noticed.find((r) => r.track === track);
    const leaning = ALL_FAMILY_NAMES.filter((f) => {
      const goal = state.aiMinds?.[f]?.goal;
      return goal?.kind === "contain_leader" && goal.track === track && goal.target === leader?.family;
    });
    return { track, leader, leaning };
  }).filter((row) => row.leader && row.leaning.length > 0);
  // On Hard the table also works against whoever the summit would name.
  const player = state.playerFamily;
  const summit = summitThreats(state)
    .map((claim) => ({
      claim,
      leaning: ALL_FAMILY_NAMES.filter((f) => {
        const goal = state.aiMinds?.[f]?.goal;
        return goal?.kind === "contain_leader" && goal.track === claim.track && goal.target === player;
      }),
    }))
    .filter((row) => row.leaning.length > 0 && !rows.some((r) => r.track === row.claim.track && r.leader?.family === player));
  if (rows.length === 0 && summit.length === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">Nobody is leaning on a leader.</p>;
  }
  return (
    <ul className="mt-1 space-y-1">
      {rows.map((row) => (
        <li key={row.track} className="text-xs">
          {TRACK_LABEL[row.track]}: {row.leaning.join(", ")} on {row.leader?.family}, {TRACK_HOW[row.track]}.
        </li>
      ))}
      {summit.map((row) => (
        <li key={`summit-${row.claim.track}`} className="text-xs">
          Summit, {TRACK_LABEL[row.claim.track].toLowerCase()}: {row.leaning.join(", ")} on you, {TRACK_HOW[row.claim.track]}.
        </li>
      ))}
    </ul>
  );
}

export default function RacePanel() {
  const setPanel = useGameStore((s) => s.setPanel);
  const state = useGameStore();
  if (!state.playerFamily) return null;
  const race = raceStatus(state);
  const seats = boroughSeats(state);
  const mine = seats.filter((s) => s.holder === state.playerFamily);
  const nearest = seats
    .filter((s) => s.holder !== state.playerFamily)
    .sort((a, b) => a.gap - b.gap)[0];
  const house = countHouseBlock(state, state.playerFamily);
  const exposed = exposedCash(state, state.playerFamily);
  const pressing = familiesPressingSuddenDeath(state);
  const watch = summitWatchWeeks(state);

  return (
    <PanelShell title="The race" onClose={() => setPanel("none")}>
      <p className="mb-3 text-[11px] text-muted-foreground">
        {race.summitWeeks === 0 ? "Summit this week." : `${race.summitWeeks} weeks to the summit.`}{" "}
        Named today: {race.namedToday}. {race.closest}
        {watch > 0
          ? race.summitWeeks <= watch
            ? " The families are planning for the summit: lead or run close, and they come for it."
            : ` The families start planning for the summit ${watch} weeks out.`
          : ""}
        {summitRatio(state) <= 1 ? " On Easy the summit names whoever is first; no margin needed." : ""}
      </p>
      <div className="space-y-3">
        {race.tracks.map((track) => {
          const pct = Math.max(0, Math.min(100, track.bar <= 0 ? 0 : (track.value / track.bar) * 100));
          return (
            <div key={track.track}>
              <div className="flex items-baseline justify-between text-xs">
                <span>{track.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {track.track === "wealth" ? formatMoney(track.value) : track.value} / {track.track === "wealth" ? formatMoney(track.bar) : track.bar}
                  {" · "}
                  {track.streak}/{track.need}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-panel">
                <div className="h-full bg-steel" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {track.missing}
                {track.secondName ? ` · next is ${track.secondName}` : ""}
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-4">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Who is challenging</h3>
        <WhoIsChallenging />
      </div>
      <div className="mt-4">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Rival clocks</h3>
        {race.rivals.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Nobody is on a streak.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {race.rivals.map((row) => (
              <li key={`${row.family}-${row.track}`} className="text-xs">
                {row.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 text-xs">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Borough seats</h3>
        <p className="mt-1 text-muted-foreground">
          You hold {mine.length}: {mine.map((s) => s.borough).join(", ") || "none"}.
          {nearest ? ` ${nearest.gap} more block${nearest.gap === 1 ? "" : "s"} for the ${nearest.borough} seat.` : ""}
        </p>
      </div>
      <div className="mt-4 text-xs text-muted-foreground">
        <h3 className="text-[10px] uppercase tracking-wide text-foreground">What can pull a leader down</h3>
        <p className="mt-1">
          {exposed > 0 && house ? `${formatMoney(exposed)} is exposed in ${house.name}.` : "No cash is sitting in a count house."}
          {pressing.length > 0 ? ` Pressing the table: ${pressing.join(", ")}.` : ""}
          {" A bordering block is a capture. A case is a Commission call."}
        </p>
      </div>
    </PanelShell>
  );
}
