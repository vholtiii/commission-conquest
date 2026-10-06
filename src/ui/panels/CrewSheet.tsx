import { useState } from "react";
import { toast } from "sonner";
import { useGameStore } from "@/engine/store";
import type { CrewMember, CrewRole, Racket, RacketType, Territory } from "@/types/game";
import { FAMILY_HEX, RACKET_LABELS } from "@/types/game";
import { pathsFromRole, canPromote, xpForLevel } from "@/engine/crew";
import { successionReadinessReasons } from "@/engine/succession";
import {
  canJoinCrew,
  canLeadCrew,
  capoFor,
  crewCurriculum,
  crewOf,
  crewSlots,
  isFreelanceSoldier,
  isSettling,
} from "@/engine/crews";
import { canLieLow, safehouseCapacity } from "@/engine/safehouse";
import {
  associateBuildPayment,
  associateCanBuild,
  canManageRacket,
  needsManager,
  RACKET_BUILD_COST,
} from "@/engine/economy";
import { allowedRacketTypes, maxRacketsFor } from "@/engine/territoryValue";
import { bossPresentIn, presenceBuildCost } from "@/engine/bossPresence";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PortraitAvatar from "@/ui/PortraitAvatar";
import Tip from "@/ui/Tip";
import { pct, riskTip, useArrestRisk } from "@/ui/WantedTag";
import PanelShell from "./PanelShell";
import { formatMoney, titleCase } from "../formatters";
import { callInCosts, callInRead, canCallIn } from "@/engine/callIn";
import { manIsWatched, sheetAffairOpen } from "@/engine/ratAffair";

const SKILL_LABELS: Record<string, string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

export default function CrewSheet() {
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const crew = useGameStore((s) => s.crew);
  const money = useGameStore((s) => s.money);
  const turn = useGameStore((s) => s.turn);
  const payFuneral = useGameStore((s) => s.payFuneral);
  const promote = useGameStore((s) => s.promote);
  const assignMember = useGameStore((s) => s.assignMember);
  const lieLow = useGameStore((s) => s.lieLow);
  const assignManager = useGameStore((s) => s.assignManager);
  const buildRacketForAssociate = useGameStore((s) => s.buildRacketForAssociate);
  const joinCrew = useGameStore((s) => s.joinCrew);
  const leaveCrew = useGameStore((s) => s.leaveCrew);
  const setPanel = useGameStore((s) => s.setPanel);
  const focusReason = useGameStore((s) => s.focusReason);
  const selectCrew = useGameStore((s) => s.selectCrew);
  const territories = useGameStore((s) => s.territories);
  const selectedTerritoryId = useGameStore((s) => s.selectedTerritoryId);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const callInOwn = useGameStore((s) => s.callInOwn);
  const moveRatOut = useGameStore((s) => s.moveRatOut);
  const ratAffair = useGameStore((s) => s.ratAffair);
  const making = useGameStore((s) => s.making);
  const lastCallInTurn = useGameStore((s) => s.lastCallInTurn);
  const streetLawyerUntil = useGameStore((s) => s.streetLawyerUntil ?? 0);
  const streetLawyerBailUsed = useGameStore((s) => s.streetLawyerBailUsed ?? false);
  const streetLawyerBail = useGameStore((s) => s.streetLawyerBail);
  const familyDinner = useGameStore((s) => s.familyDinner);
  const ratLeakCrewId = useGameStore((s) => s.ratLeakCrewId);
  const [callInArmedFor, setCallInArmedFor] = useState<string | null>(null);

  const member = crew.find((c) => c.id === selectedCrewId);
  if (!member) return null;

  const isDead = member.status === "dead";
  const isOwn = member.family === playerFamily;
  const here = territories.find((t) => t.id === selectedTerritoryId);
  const turf = here
    ? !here.owner
      ? "unclaimed"
      : here.owner === playerFamily
        ? "your turf"
        : `${here.owner} turf`
    : null;

  const nextXp = xpForLevel(Math.min(10, member.level + 1));
  const currXp = xpForLevel(member.level);
  const xpProgress =
    member.level >= 10
      ? 100
      : Math.min(100, ((member.xp - currXp) / Math.max(1, nextXp - currXp)) * 100);

  const paths = isOwn && member.status === "active" ? pathsFromRole(member.role) : [];
  const successionReasons =
    member.role === "underboss" ? successionReadinessReasons(member, turn) : null;

  const capo = capoFor(crew, member);
  const learning = capo ? crewCurriculum(capo) : [];
  const ledCrew = canLeadCrew(member) ? crewOf(crew, member.id) : [];
  const crewLine = capo
    ? `Under ${capo.name}${capo.role === "boss" ? " (the boss's shooters)" : capo.role === "consigliere" ? " (the consigliere's school)" : ""} since turn ${member.crewSinceTurn ?? "?"} — learning ${learning
        .map((k) => SKILL_LABELS[k])
        .join(" & ")}${isSettling(member, turn) ? " (still settling in)" : ""}`
    : isFreelanceSoldier(member)
      ? "Loose soldier — sharp on the street, learns stealth from clean casing"
      : canLeadCrew(member)
        ? `Runs a crew of ${ledCrew.length}/${crewSlots(member)} — teaches ${crewCurriculum(member)
            .map((k) => SKILL_LABELS[k])
            .join(" & ")}${member.role === "boss" ? " (hitman school)" : member.role === "consigliere" ? " (thinkers)" : ""}`
        : null;

  return (
    <PanelShell
      title={member.name}
      subtitle={`${titleCase(member.role)} — ${member.family}${
        member.origin && member.origin !== member.family ? ` · came over from the ${member.origin}` : ""
      }`}
      onClose={() => setPanel("none")}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <PortraitAvatar
            seed={member.portraitSeed}
            size={56}
            ringColor={FAMILY_HEX[member.family]}
            role={member.role}
            family={member.family}
            isPlayerBoss={member.isPlayerBoss}
            alt={member.name}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant={isDead ? "destructive" : "outline"} className="text-[10px]">
                {member.status}
              </Badge>
              {member.isPlayerBoss && (
                <Badge className="bg-money/20 text-[10px] text-money">Boss</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Level {member.level} &middot; {member.hits} hits
            </p>
            <div className="mt-1">
              <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                <span>XP</span>
                <span>
                  {member.level >= 10 ? "MAX" : `${member.xp} / ${nextXp}`}
                </span>
              </div>
              <Progress value={xpProgress} className="h-1.5" />
            </div>
          </div>
        </div>

        {here && focusReason && (
          <div className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/60 px-2 py-1.5 text-[11px]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: here.owner ? FAMILY_HEX[here.owner] : "#7a7f87" }}
            />
            <span className="text-foreground">{here.name}</span>
            <span className="text-muted-foreground">· {turf}</span>
            <span className="ml-auto text-muted-foreground">{focusReason}</span>
          </div>
        )}

        {isOwn && member.status === "jailed" && member.role !== "boss" && (
          <div className="rounded border border-panel-border bg-panel/40 p-2.5">
            <div className="text-xs font-semibold">Street lawyer</div>
            {turn < streetLawyerUntil && !streetLawyerBailUsed ? (
              <Button
                type="button"
                size="sm"
                className="mt-2"
                onClick={() => streetLawyerBail(member.id)}
              >
                Walk him out
              </Button>
            ) : (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {turn < streetLawyerUntil
                  ? "He already walked someone this retainer."
                  : "He is off the books."}
              </p>
            )}
          </div>
        )}

        {crewLine && !(isOwn && canLeadCrew(member)) && (
          <div className="rounded-md border border-panel-border bg-panel/60 px-2 py-1.5 text-[11px] text-muted-foreground">
            {crewLine}
            {ledCrew.length > 0 && (
              <span className="text-foreground"> · {ledCrew.map((m) => m.name.split(" ").pop()).join(", ")}</span>
            )}
          </div>
        )}

        {isOwn && canLeadCrew(member) && (
          <CrewManageBlock
            leader={member}
            crew={crew}
            members={ledCrew}
            onJoin={(id) => {
              joinCrew(id, member.id);
              const man = crew.find((c) => c.id === id);
              toast.success(
                man
                  ? `${man.name} joins ${member.role === "boss" ? "your" : `${member.name}'s`} crew`
                  : "Man added to the crew",
              );
            }}
            onLeave={(id) => {
              const man = crew.find((c) => c.id === id);
              leaveCrew(id);
              toast.message(man ? `${man.name} cut loose` : "Cut loose");
            }}
            onSelect={(id) => selectCrew(id)}
          />
        )}

        {isOwn && member.status === "active" && (
          <PostBlock
            member={member}
            crew={crew}
            territories={territories}
            turn={turn}
            isBoss={member.role === "boss" || !!member.isPlayerBoss}
            onGarrison={(territoryId, name) => {
              assignMember(member.id, { type: "garrison", territoryId });
              toast.success(`${member.name} garrisons ${name}`);
            }}
            onLieLow={(territoryId) => lieLow(member.id, territoryId)}
            onManage={(territoryId, racketId, label) => {
              assignManager(territoryId, racketId, member.id);
              toast.success(`${member.name} takes over ${label}`);
            }}
            onIdle={() => {
              assignMember(member.id, { type: "idle" });
              toast.success(`${member.name} stands down`);
            }}
            onBuild={(territoryId, type) => buildRacketForAssociate(member.id, territoryId, type)}
          />
        )}

        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <StatBox label="Loyalty" value={member.loyalty} />
          <WantedBox member={member} />
          <StatBox label="XP" value={member.xp} />
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Skills</h3>
          <div className="space-y-1.5">
            {Object.entries(member.skills).map(([key, val]) => (
              <div key={key}>
                <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
                  <span>
                    {SKILL_LABELS[key] ?? key}
                    {learning.includes(key as keyof typeof member.skills) && (
                      <span className="ml-1 text-money" title="Learning from his capo">↑</span>
                    )}
                  </span>
                  <span>{val}</span>
                </div>
                <Progress value={Math.min(100, val)} className="h-1.5" />
              </div>
            ))}
          </div>
        </div>

        {member.traits.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Traits</h3>
            <div className="flex flex-wrap gap-1.5">
              {member.traits.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">
                  {titleCase(t)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {successionReasons && (
          <div className="rounded-md border border-panel-border bg-panel/50 p-3">
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              Succession
            </h3>
            {successionReasons.every((r) => r.met) ? (
              <p className="text-xs text-money">Ready to succeed if the boss falls.</p>
            ) : (
              <p className="mb-1 text-xs text-amber-400">Not ready:</p>
            )}
            <ul className="space-y-0.5 text-[11px]">
              {successionReasons.map((r) => (
                <li key={r.label} className={r.met ? "text-money" : "text-muted-foreground"}>
                  {r.met ? "✓" : "○"} {r.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {making?.crewId === member.id && (
          <p className="text-xs text-amber-200">Sitting the week out. The books open next week.</p>
        )}

        {paths.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              Promotion
            </h3>
            <div className="space-y-2">
              {paths.map((path) => {
                const check = canPromote(member, path.to, crew, money);
                return (
                  <div
                    key={path.to}
                    className="rounded-md border border-panel-border bg-panel/50 p-2"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        → {path.to === "soldier" ? "Open the books" : titleCase(path.to as CrewRole)}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!check.ok || (path.to === "soldier" && !!making)}
                        className="h-7 px-2 text-[10px]"
                        onClick={() => promote(member.id, path.to)}
                      >
                        {formatMoney(path.cost)}
                      </Button>
                    </div>
                    <ul className="space-y-0.5 text-[10px]">
                      {check.reasons.map((r) => (
                        <li
                          key={r.label}
                          className={r.met ? "text-money" : "text-muted-foreground"}
                        >
                          {r.met ? "✓" : "○"} {r.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isOwn && manIsWatched({ ratAffair }, member.id) && (
          <WatchBlock
            name={member.name}
            weeksLeft={Math.max(0, (ratAffair?.resolveTurn ?? turn) - turn)}
            drift={ratAffair?.lastDrift}
            canMove={sheetAffairOpen({ ratAffair }, member.id)}
            onMove={() => moveRatOut(member.id)}
          />
        )}

        {isOwn && member.status === "active" && member.role !== "boss" && !member.isPlayerBoss && (
          <CallInBlock
            member={member}
            armed={callInArmedFor === member.id}
            onArm={() => setCallInArmedFor(member.id)}
            onConfirm={() => callInOwn(member.id)}
            watched={sheetAffairOpen({ ratAffair }, member.id)}
            tick={`${lastCallInTurn ?? ""}:${familyDinner?.startTurn ?? ""}:${ratLeakCrewId ?? ""}:${ratAffair?.phase ?? ""}`}
          />
        )}

        {isDead && isOwn && member.putAway && (
          <p className="rounded-md border border-panel-border bg-panel/50 p-3 text-xs text-muted-foreground">
            {member.name} is doing his time upstate. The family has moved on.
          </p>
        )}
        {isDead && isOwn && !member.putAway && !member.leftCity && (
          <div className="rounded-md border border-panel-border bg-panel/50 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Give {member.name} a proper send-off to steady the crew&apos;s nerves.
            </p>
            <Button
              className="w-full bg-steel font-ui font-bold uppercase"
              disabled={money < 500}
              onClick={() => payFuneral(member.id)}
            >
              Hold Funeral ($500)
            </Button>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function WatchBlock({
  name,
  weeksLeft,
  drift,
  canMove,
  onMove,
}: {
  name: string;
  weeksLeft: number;
  drift?: { loyalty: number; wanted: number; heat: number };
  canMove: boolean;
  onMove: () => void;
}) {
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
  return (
    <div className="rounded-md border border-sky-400/40 bg-sky-400/10 p-3">
      <p className="text-xs text-sky-200">
        Being watched. {weeksLeft} week{weeksLeft === 1 ? "" : "s"} left.
      </p>
      {drift ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          This week: loyalty {signed(drift.loyalty)}, wanted {signed(drift.wanted)}, heat from him{" "}
          {signed(drift.heat)}.
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Nothing on him yet. Watch his loyalty, his wanted, and the heat with his name on it.
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {name} is nervous. His skills are down while the eye is on him.
      </p>
      {canMove && (
        <Button className="mt-2 w-full" variant="outline" onClick={onMove}>
          Move him out of the city ($300)
        </Button>
      )}
    </div>
  );
}

function CallInBlock({
  member,
  armed,
  onArm,
  onConfirm,
  tick,
  watched = false,
}: {
  member: CrewMember;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void;
  tick: string;
  watched?: boolean;
}) {
  void tick;
  const snap = useGameStore.getState();
  const gate = canCallIn(snap, member.id);
  const read = callInRead(snap, member);
  const costs = callInCosts(read, member.traits.includes("made_man"));
  const walk = Math.round(costs.walkChance * 100);
  return (
    <div className="rounded-md border border-heat/40 bg-heat/10 p-3">
      <p className="text-xs text-heat">{read.label}.</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Family loyalty −{costs.loyaltyDrop}. Respect −{costs.respectDrop}. {walk}% chance someone asks to walk.
      </p>
      {watched && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          The family's reaction waits on whether the rumor is true.
        </p>
      )}
      {member.traits.includes("made_man") && (
        <p className="mt-1 text-[11px] text-amber-300">He&apos;s a made man. His friends will remember.</p>
      )}
      {!gate.ok && <p className="mt-1 text-[11px] text-muted-foreground">{gate.reason}</p>}
      {!armed ? (
        <Button
          className="mt-2 w-full bg-heat font-ui font-bold uppercase text-white hover:bg-heat/80"
          disabled={!gate.ok}
          onClick={onArm}
        >
          Call him in…
        </Button>
      ) : (
        <Button
          className="mt-2 w-full bg-heat font-ui font-bold uppercase text-white hover:bg-heat/80"
          onClick={onConfirm}
        >
          He doesn&apos;t come back
        </Button>
      )}
    </div>
  );
}

function CrewManageBlock({
  leader,
  crew,
  members,
  onJoin,
  onLeave,
  onSelect,
}: {
  leader: CrewMember;
  crew: CrewMember[];
  members: CrewMember[];
  onJoin: (id: string) => void;
  onLeave: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const slots = crewSlots(leader);
  const candidates = crew.filter((c) => canJoinCrew(crew, c.id, leader.id).ok);
  const school =
    leader.role === "boss"
      ? "Boss's crew — shooters"
      : leader.role === "consigliere"
        ? "Consigliere's crew — thinkers"
        : "Capo's crew";
  const teaches = crewCurriculum(leader);

  return (
    <div className="space-y-1.5 rounded-md border border-panel-border bg-panel/60 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-foreground">
          {school} · {members.length}/{slots}
        </span>
        <span className="text-[10px] text-muted-foreground">
          Teaches {teaches.map((k) => SKILL_LABELS[k]).join(" & ")}
        </span>
      </div>
      {members.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          Nobody in this crew yet. Add a loose soldier or associate below.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {members.map((m) => (
          <span
            key={m.id}
            className="flex items-center gap-1 rounded border border-panel-border bg-panel/60 px-1.5 py-0.5 text-[10px]"
          >
            <button type="button" onClick={() => onSelect(m.id)} className="hover:underline">
              {m.name.split(" ").pop()}
            </button>
            {m.status !== "active" && (
              <span className="text-muted-foreground">({m.status})</span>
            )}
            <button
              type="button"
              title="Cut loose"
              onClick={() => onLeave(m.id)}
              className="text-muted-foreground hover:text-heat"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {leader.status === "active" && members.length < slots && (
        candidates.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onJoin(e.target.value);
            }}
            className="h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
          >
            <option value="">Add a man to the crew…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.role === "associate" ? " (associate → soldier)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            No loose soldiers or associates free to join. Cut a man loose from another crew first, or recruit.
          </p>
        )
      )}
      {leader.status === "active" && members.length >= slots && (
        <p className="text-[10px] text-muted-foreground">
          Crew is full{leader.level < 5 ? " — level up for another slot" : ""}.
        </p>
      )}
    </div>
  );
}

function postLine(member: CrewMember, territories: Territory[], turn: number): string {
  const a = member.assignment;
  const place = (id?: string) => territories.find((t) => t.id === id)?.name ?? "unknown";
  if (member.awayAt && member.awayAt.untilTurn > turn) return "Away this week";
  if (a.type === "garrison" && a.territoryId) return `Garrisoned in ${place(a.territoryId)}`;
  if (a.type === "safehouse" && a.territoryId) return `Laid low in the ${place(a.territoryId)} safehouse`;
  if (a.type === "racket") {
    const t = territories.find((x) => x.id === a.territoryId);
    const r = t?.rackets.find((x) => x.id === a.racketId);
    const label = r ? RACKET_LABELS[r.type] : "a racket";
    return `Running ${label} in ${place(a.territoryId)}`;
  }
  if (a.type === "delivery") return "Out on a delivery";
  if (a.type === "operation") return "Out on a job";
  if (a.type === "surveillance") return "Casing a district";
  return "Idle";
}

function busyReason(member: CrewMember, turn: number): string | null {
  if (member.awayAt && member.awayAt.untilTurn > turn) {
    return member.awayAt.reason === "sitdown"
      ? "He's committed to a sit-down this week."
      : "He's already on the road this week.";
  }
  if (member.assignment.type === "operation") return "He's out on a job. It clears when the job resolves.";
  if (member.assignment.type === "surveillance") return "He's casing a district. The report comes in next week.";
  if (member.assignment.type === "delivery") return "He's on a delivery. He comes back when the truck does.";
  return null;
}

function PostBlock({
  member,
  crew,
  territories,
  turn,
  isBoss,
  onGarrison,
  onLieLow,
  onManage,
  onIdle,
  onBuild,
}: {
  member: CrewMember;
  crew: CrewMember[];
  territories: Territory[];
  turn: number;
  isBoss: boolean;
  onGarrison: (territoryId: string, name: string) => void;
  onLieLow: (territoryId: string) => void;
  onManage: (territoryId: string, racketId: string, label: string) => void;
  onIdle: () => void;
  onBuild: (territoryId: string, type: RacketType) => void;
}) {
  const owned = territories.filter((t) => t.owner === member.family);
  const held = busyReason(member, turn);
  const hideouts = owned.filter((t) => safehouseCapacity(t, turn) > 0);
  const laidLowValue =
    member.assignment.type === "safehouse" ? member.assignment.territoryId ?? "" : "";
  const garrisonValue =
    member.assignment.type === "garrison" ? member.assignment.territoryId ?? "" : "";
  const racketValue =
    member.assignment.type === "racket" && member.assignment.racketId
      ? `${member.assignment.territoryId}:${member.assignment.racketId}`
      : "";
  const rackets: { territory: Territory; racket: Racket }[] = owned.flatMap((t) =>
    t.rackets.filter((r) => needsManager(r.type)).map((r) => ({ territory: t, racket: r })),
  );
  const money = useGameStore((s) => s.money);
  const routes = useGameStore((s) => s.routes);
  const operations = useGameStore((s) => s.operations);
  const canManage = canManageRacket(member, member.family);
  const buildChoices =
    member.role === "associate"
      ? owned.flatMap((t) => {
          if (t.rackets.length >= maxRacketsFor(t)) return [];
          const bossHere = bossPresentIn(
            { crew, territories, routes, operations, playerFamily: member.family, turn },
            member.family,
            t.id,
          );
          return allowedRacketTypes(t)
            .filter((type) => associateCanBuild(type))
            .map((type) => {
              const cost = presenceBuildCost(RACKET_BUILD_COST[type] ?? 2000, bossHere);
              return { territory: t, type, cost, affordable: !!associateBuildPayment(type, cost, money) };
            });
        })
      : [];
  const racketChoices = canManage
    ? rackets
    : rackets.filter(({ territory, racket }) => `${territory.id}:${racket.id}` === racketValue);

  return (
    <div className="space-y-1.5 rounded-md border border-panel-border bg-panel/60 px-2 py-1.5">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Post</h3>
      <p className="text-[11px] text-foreground">{postLine(member, territories, turn)}</p>
      {held ? (
        <Tip content={held}>
          <p className="text-[10px] text-muted-foreground">Tied up — posting waits until that clears.</p>
        </Tip>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Tip content="Garrison counts toward the district's defence and earns +2 XP a week. On the boss's block he picks up the presence bonuses too.">
            <select
              value={garrisonValue}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const name = territories.find((t) => t.id === id)?.name ?? id;
                onGarrison(id, name);
              }}
              className="h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
            >
              <option value="">Garrison…</option>
              {owned.map((t) => (
                <option key={t.id} value={t.id}>
                  Garrison — {t.name}
                </option>
              ))}
            </select>
          </Tip>
          {hideouts.length > 0 && (
            <Tip content="Inside a safehouse he sheds wanted every week and a rival crew has to case the block before they can find him — a higher-level house is harder to hit him in. If the family is hit on that block or next door, he comes out shooting. He's off the street while he's down: no guarding, no rackets, and a boss inside gives up his presence bonuses.">
              <select
                value={laidLowValue}
                onChange={(e) => {
                  if (e.target.value) onLieLow(e.target.value);
                }}
                className="h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
              >
                <option value="">Lie low…</option>
                {hideouts.map((t) => {
                  const check = canLieLow({ crew, territories, turn }, member, t.id);
                  const current = laidLowValue === t.id;
                  return (
                    <option key={t.id} value={t.id} disabled={!check.ok && !current}>
                      Lie low — {t.name}
                      {current ? " (inside)" : !check.ok && check.reason ? ` (${check.reason.replace(/\.$/, "").toLowerCase()})` : ""}
                    </option>
                  );
                })}
              </select>
            </Tip>
          )}
          {member.role === "associate" && (
            <Tip content="He pays the whole bill in clean cash. A still, brewery, warehouse, or speakeasy is clean too — dirty cash stays put. Gambling, a brothel, and a loan shark take dirty money, so they are not his to build.">
              <select
                value=""
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) return;
                  const splitAt = value.indexOf(":");
                  const territoryId = value.slice(0, splitAt);
                  const type = value.slice(splitAt + 1) as RacketType;
                  const hit = buildChoices.find((row) => row.territory.id === territoryId && row.type === type);
                  if (!hit?.affordable) return;
                  onBuild(territoryId, type);
                }}
                className="h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
              >
                <option value="">Build a racket…</option>
                {buildChoices.map(({ territory, type, cost, affordable }) => (
                  <option key={`${territory.id}:${type}`} value={`${territory.id}:${type}`} disabled={!affordable}>
                    {RACKET_LABELS[type]} — {territory.name} ({formatMoney(cost)} clean)
                    {affordable ? "" : " — short"}
                  </option>
                ))}
              </select>
            </Tip>
          )}
          {(canManage || member.assignment.type === "racket") && (
            <Tip content="A manager lifts the unmanaged income penalty. A warehouse with a manager stops losing crates out the back. A legit front (deli, laundry, etc.) also sheds a little wanted each week — slower than lying low in a safehouse.">
              <select
                value={racketValue}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) return;
                  if (value === "idle") {
                    onIdle();
                    return;
                  }
                  const [territoryId, racketId] = value.split(":");
                  const hit = rackets.find(
                    (row) => row.territory.id === territoryId && row.racket.id === racketId,
                  );
                  if (!hit) return;
                  onManage(
                    hit.territory.id,
                    hit.racket.id,
                    `${RACKET_LABELS[hit.racket.type]} in ${hit.territory.name}`,
                  );
                }}
                className="h-7 w-full rounded border border-panel-border bg-panel/60 px-1 text-[11px]"
              >
                <option value="">Manage a racket…</option>
                <option value="idle">Stand down — idle</option>
                {racketChoices.map(({ territory, racket }) => {
                  const other =
                    racket.managerId && racket.managerId !== member.id
                      ? crew.find((c) => c.id === racket.managerId)
                      : undefined;
                  return (
                    <option key={racket.id} value={`${territory.id}:${racket.id}`}>
                      {RACKET_LABELS[racket.type]} — {territory.name}
                      {other ? ` (replaces ${other.name.split(" ").pop()})` : ""}
                    </option>
                  );
                })}
              </select>
            </Tip>
          )}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded bg-panel/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

/** Wanted with the weekly arrest odds in parentheses; green when something is pulling them down. */
function WantedBox({ member }: { member: CrewMember }) {
  const risk = useArrestRisk(member);
  const covered = risk.reducers.length > 0;
  return (
    <Tip content={riskTip(risk)}>
      <div className="rounded bg-panel/50 px-2 py-1.5">
        <div className="text-[10px] text-muted-foreground">Wanted</div>
        <div className="font-semibold">
          <span className="text-heat">{member.wanted}</span>{" "}
          <span className={covered ? "text-emerald-400" : risk.listed ? "text-heat" : "text-muted-foreground"}>
            ({pct(risk)})
          </span>
        </div>
        {covered && (
          <div className="mt-0.5 text-[9px] leading-tight text-emerald-400">
            {risk.reducers.map((r) => `${r.label} ${r.effect}`).join(" · ")}
          </div>
        )}
      </div>
    </Tip>
  );
}
