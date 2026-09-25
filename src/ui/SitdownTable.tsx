import { useEffect, useState } from "react";
import { useGameStore } from "@/engine/store";
import { FAMILY_HEX } from "@/types/game";
import { PassageTable } from "@/ui/panels/SitdownRequestModal";
import { TermsTable } from "@/ui/panels/TermsTable";
import { isAgendaTable } from "@/engine/sitdowns";
import PortraitAvatar from "@/ui/PortraitAvatar";
import { Button } from "@/components/ui/button";

/** Letterboxed table. The drive can be skipped; the table cannot. */
export default function SitdownTable() {
  const phase = useGameStore((s) => s.sitdownPhase);
  const cinematic = useGameStore((s) => s.sitdownCinematicQueue?.[0] ?? null);
  const sitdowns = useGameStore((s) => s.sitdowns);
  const territories = useGameStore((s) => s.territories);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const openSitdownTable = useGameStore((s) => s.openSitdownTable);
  const beginSitdownExit = useGameStore((s) => s.beginSitdownExit);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const [shown, setShown] = useState(1);

  // Open tables (passage, agenda) show the negotiation; anything settled plays its lines.
  const script = cinematic?.purpose === "passage" ? [] : (cinematic?.result?.lines ?? []);

  useEffect(() => {
    setShown(1);
  }, [cinematic?.sitdownId]);

  useEffect(() => {
    if (phase !== "table" || script.length === 0 || shown >= script.length) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), 1200);
    return () => window.clearTimeout(id);
  }, [phase, shown, script.length, cinematic?.sitdownId]);

  if (!phase || !cinematic || !playerFamily) return null;
  const sitdown = sitdowns.find((s) => s.id === cinematic.sitdownId);
  const where = territories.find((t) => t.id === cinematic.venueTerritoryId)?.name ?? "a back room";
  const playerBoss = crew.find((c) => c.family === playerFamily && c.role === "boss" && c.status === "active");
  const rivalBoss = crew.find((c) => c.family === cinematic.family && c.role === "boss");
  const travelled = [
    cinematic.playerPath ? "You drove" : "You hosted",
    cinematic.rivalPath ? `${cinematic.family} drove` : `${cinematic.family} hosted`,
  ].join(" · ");
  const host = sitdown?.hostFamily
    ? `Hosted by ${sitdown.hostFamily}${sitdown.hostFamily ? " — $75 each" : ""}`
    : null;
  const rounds = sitdown?.passage?.rounds ?? sitdown?.table?.rounds ?? 0;
  const rivalFrame = rounds >= 2 ? "#6a7c8c" : rounds === 1 ? "#c4b48a" : FAMILY_HEX[cinematic.family];
  const passage = cinematic.purpose === "passage" && sitdown?.status === "at_table" && sitdown.passage;
  const agenda = isAgendaTable(cinematic.purpose) && sitdown?.status === "at_table" && sitdown.table;
  const readyToLeave = passage || agenda ? !!cinematic.result : shown >= script.length;

  return (
    <div className="pointer-events-none absolute inset-0 z-50">
      <div className="absolute inset-x-0 top-0 h-16 bg-black" />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-black" />
      <div className="absolute inset-0 bg-black/35" />

      {phase === "drive" && (
        <div className="pointer-events-auto absolute bottom-20 right-4 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => openSitdownTable()}>
            Skip
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              updateSettings({ skipCinematics: true });
              openSitdownTable();
            }}
          >
            Always skip
          </Button>
        </div>
      )}

      {phase === "table" && (
        <div className="pointer-events-auto absolute inset-x-0 top-20 bottom-20 flex items-center justify-center px-4">
          <div className="panel-surface-elevated w-[min(40rem,100%)] rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              {playerBoss && (
                <PortraitAvatar
                  seed={playerBoss.portraitSeed}
                  size={72}
                  role={playerBoss.role}
                  family={playerBoss.family}
                  isPlayerBoss={playerBoss.isPlayerBoss}
                  ringColor={FAMILY_HEX[playerFamily]}
                />
              )}
              <div className="flex-1 text-center">
                <div className="font-display text-lg text-steel-light">{where}</div>
                <div className="text-[11px] text-muted-foreground">{travelled}</div>
                {host && <div className="text-[11px] text-muted-foreground">{host}</div>}
              </div>
              {rivalBoss && (
                <PortraitAvatar
                  seed={rivalBoss.portraitSeed}
                  size={72}
                  role={rivalBoss.role}
                  family={rivalBoss.family}
                  ringColor={rivalFrame}
                />
              )}
            </div>

            {passage && sitdown ? (
              <div className="mt-3">
                <PassageTable sitdown={sitdown} playerFamily={playerFamily} embedded />
              </div>
            ) : agenda && sitdown ? (
              <div className="mt-3">
                <TermsTable sitdown={sitdown} playerFamily={playerFamily} embedded />
              </div>
            ) : (
              <div className="mt-4 min-h-16 space-y-2">
                {script.slice(0, shown).map((line) => (
                  <p key={line} className="text-sm text-foreground/90">
                    {line}
                  </p>
                ))}
              </div>
            )}

            {readyToLeave && (
              <Button className="mt-4 w-full" onClick={() => beginSitdownExit()}>
                Leave the table
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
