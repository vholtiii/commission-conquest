import { useGameStore } from "@/engine/store";
import { reelOnScreen } from "@/engine/screen";
import { FAMILY_HEX } from "@/types/game";
import type { CrewMember, CrewSkills } from "@/types/game";
import { crewCurriculum, crewOf, crewSlots, pendingCrewRequests } from "@/engine/crews";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PortraitAvatar from "@/ui/PortraitAvatar";
import { titleCase } from "../formatters";

const SKILL_LABELS: Record<keyof CrewSkills, string> = {
  muscle: "Muscle",
  stealth: "Stealth",
  smarts: "Smarts",
  charm: "Charm",
  driving: "Driving",
};

/** A capo asking to bring a man into his crew. One at a time, before the event card. */
export default function CrewRequestModal() {
  const crewRequests = useGameStore((s) => s.crewRequests);
  const crew = useGameStore((s) => s.crew);
  const activeEvent = useGameStore((s) => s.activeEvent);
  const pendingHitResult = useGameStore((s) => s.pendingHitResult);
  const dealCards = useGameStore((s) => s.pendingDealSettlements?.length ?? 0);
  const reel = useGameStore(reelOnScreen);
  const answer = useGameStore((s) => s.answerCrewRequest);

  // Let the reel, hit results, events and deal cards take the screen first.
  if (reel || activeEvent || pendingHitResult || dealCards > 0) return null;
  const req = pendingCrewRequests({ crewRequests })[0];
  if (!req) return null;

  const capo = crew.find((c) => c.id === req.capoId);
  const candidate = crew.find((c) => c.id === req.candidateId);
  if (!capo || !candidate) return null;

  if (req.kind === "walk") {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
        <div className="panel-surface-elevated w-[420px] rounded-lg border p-5">
          <div className="flex items-center gap-3">
            <PortraitAvatar
              seed={candidate.portraitSeed}
              size={44}
              ringColor={FAMILY_HEX[candidate.family]}
              role={candidate.role}
              family={candidate.family}
              alt={candidate.name}
            />
            <div className="min-w-0">
              <h2 className="font-display text-lg text-steel-light">{candidate.name} wants out</h2>
              <p className="text-[11px] text-muted-foreground">{titleCase(candidate.role)} · Loyalty {candidate.loyalty}</p>
            </div>
          </div>
          <p className="mt-3 text-sm italic text-foreground/85">&ldquo;{req.pitch}&rdquo;</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Let him go and he takes his skills to a rival. Talk him down and he stays, but he remembers.
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => answer(req.id, "later")}>
              Later
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => answer(req.id, "reject")}>
              Talk him down
            </Button>
            <Button className="flex-1" onClick={() => answer(req.id, "approve")}>
              Let him go
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const teaches = crewCurriculum(capo);
  const members = crewOf(crew, capo.id);
  const slots = crewSlots(capo);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[480px] rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <PortraitAvatar
            seed={capo.portraitSeed}
            size={44}
            ringColor={FAMILY_HEX[capo.family]}
            role={capo.role}
            family={capo.family}
            alt={capo.name}
          />
          <div className="min-w-0">
            <h2 className="font-display text-lg text-steel-light">{capo.name} wants a word</h2>
            <p className="text-[11px] text-muted-foreground">
              {titleCase(capo.role)} · crew {members.length}/{slots}
              {members.length > 0 && ` · ${members.map((m) => m.name.split(" ").pop()).join(", ")}`}
            </p>
          </div>
        </div>

        <p className="mt-3 text-sm italic text-foreground/85">&ldquo;{req.pitch}&rdquo;</p>

        <div className="mt-4 rounded-md border border-panel-border bg-panel/50 p-3">
          <div className="flex items-center gap-2">
            <PortraitAvatar
              seed={candidate.portraitSeed}
              size={32}
              ringColor={FAMILY_HEX[candidate.family]}
              role={candidate.role}
              family={candidate.family}
              alt={candidate.name}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{candidate.name}</div>
              <div className="text-[10px] text-muted-foreground">
                {titleCase(candidate.role)} · Lv {candidate.level} · Loyalty {candidate.loyalty}
                {candidate.role === "associate" && (
                  <Badge className="ml-1.5 bg-money/20 text-[8px] text-money">Made soldier on entry</Badge>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-[11px]">
            <span className="text-muted-foreground">Skill</span>
            <span className="text-right text-muted-foreground">{lastWord(candidate)}</span>
            <span className="text-right text-muted-foreground">{lastWord(capo)}</span>
            {(Object.keys(SKILL_LABELS) as (keyof CrewSkills)[]).map((k) => {
              const learning = teaches.includes(k);
              return (
                <SkillRow
                  key={k}
                  label={SKILL_LABELS[k]}
                  a={candidate.skills[k]}
                  b={capo.skills[k]}
                  learning={learning}
                />
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            In the crew he learns <span className="text-steel-light">{teaches.map((k) => SKILL_LABELS[k]).join(" and ")}</span> from
            the capo, picks up a little smarts and charm over time, and his loyalty follows the capo&apos;s.
            Loose, he stays sharper on the street for casing.
          </p>
        </div>

        <div className="mt-4 flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => answer(req.id, "later")}>
            Later
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => answer(req.id, "reject")}>
            No
          </Button>
          <Button
            className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
            onClick={() => answer(req.id, "approve")}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

function lastWord(c: CrewMember): string {
  return c.name.replace(/"[^"]*"\s*/g, "").trim().split(/\s+/).pop() ?? c.name;
}

function SkillRow({ label, a, b, learning }: { label: string; a: number; b: number; learning: boolean }) {
  return (
    <>
      <span className={learning ? "text-steel-light" : ""}>
        {label}
        {learning && <span className="ml-1 text-money">↑</span>}
      </span>
      <span className="text-right">{a}</span>
      <span className="text-right text-muted-foreground">{b}</span>
    </>
  );
}
