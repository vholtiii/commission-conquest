import { useGameStore } from "@/engine/store";
import { FAMILY_HEX, type FamilyName } from "@/types/game";
import PortraitAvatar from "@/ui/PortraitAvatar";
import { Button } from "@/components/ui/button";
import { agendaTermsText } from "@/engine/agendas";

/** The Commission's ruling, and the player's chance to accept or refuse it. */
export default function CommissionRulingModal() {
  const ruling = useGameStore((s) => s.pendingRulings?.[0] ?? null);
  const answer = useGameStore((s) => s.answerRuling);
  const crew = useGameStore((s) => s.crew);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const seats = useGameStore((s) => s.commissionCall?.seats);
  const busy = useGameStore(
    (s) =>
      s.cinematicQueue.length > 0 ||
      (s.sitdownCinematicQueue?.length ?? 0) > 0 ||
      s.sitdownPhase != null ||
      !!s.pendingHitResult ||
      !!s.activeEvent,
  );

  if (!ruling || !playerFamily || busy) return null;
  const deadlock = ruling.verdict === "deadlock";
  const war = ruling.kind === "war";
  const winner: FamilyName = ruling.verdict === "accused" ? ruling.accused : ruling.caller;
  const state = useGameStore.getState();
  const bossOf = (family: FamilyName) => crew.find((c) => c.family === family && c.role === "boss");

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="panel-surface-elevated w-[480px] rounded-lg border p-5">
        <div className="flex items-center justify-between gap-2">
          {[ruling.caller, ruling.accused].map((family) => {
            const boss = bossOf(family);
            return boss ? (
              <PortraitAvatar
                key={family}
                seed={boss.portraitSeed}
                size={52}
                role="boss"
                family={boss.family}
                isPlayerBoss={boss.isPlayerBoss}
                ringColor={FAMILY_HEX[family]}
              />
            ) : (
              <span key={family} />
            );
          })}
        </div>
        <h2 className="mt-2 text-center font-display text-lg text-steel-light">
          {war
            ? ruling.verdict === "caller"
              ? `The Commission goes to war with ${ruling.accused}`
              : deadlock
                ? "The Commission deadlocks on war"
                : "The Commission won't go to war"
            : deadlock
              ? "The Commission deadlocks"
              : `The Commission rules for ${winner}`}
        </h2>
        <p className="text-center text-[11px] text-muted-foreground">
          {war
            ? `You asked for guns on ${ruling.accused} · ${ruling.forCaller} for war, ${ruling.against} against`
            : `${ruling.caller} called it on ${ruling.accused} · ${ruling.forCaller} for the caller, ${ruling.against} against`}
        </p>

        <div className="mt-3 space-y-1">
          {(seats ?? []).map((seat) => (
            <p key={seat.family} className="text-[12px] text-foreground/90">
              <span className="text-steel-light">{seat.family}</span>
              {seat.vote === "abstain" || !seat.vote
                ? " abstains"
                : (seat.vote === "caller") === (ruling.caller === playerFamily)
                  ? " sides with you"
                  : " sides against you"}
              {seat.line ? ` — “${seat.line}”` : ""}
            </p>
          ))}
        </div>

        {!deadlock && !war && (
          <p className="mt-3 text-sm text-emerald-400">
            {agendaTermsText(state, "truce", ruling.terms)}
          </p>
        )}
        {war && ruling.verdict === "caller" && (
          <p className="mt-3 text-sm text-heat">
            {ruling.forRuling.length > 0 ? `${ruling.forRuling.join(", ")} put their guns behind you.` : ""} {ruling.accused} is at
            war with every seat that voted yes.
          </p>
        )}
        {war && ruling.verdict !== "caller" && (
          <p className="mt-3 text-[11px] text-heat">
            You asked the table for a war it wouldn't give. That costs face — 3 respect and a little more bad blood with{" "}
            {ruling.accused}.
          </p>
        )}

        {war ? (
          <Button className="mt-4 w-full" onClick={() => answer("accept")}>
            {ruling.verdict === "caller" ? "Guns up" : "Leave the table"}
          </Button>
        ) : deadlock ? (
          <Button className="mt-4 w-full" onClick={() => answer("accept")}>
            The table settles nothing
          </Button>
        ) : (
          <>
            <p className="mt-3 text-[11px] text-heat">
              Refusing the table has consequences. The seats that ruled for this take it badly, and the table may send
              a message to one of your men.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                className="flex-1 bg-emerald-700 font-ui font-bold uppercase hover:bg-emerald-600"
                onClick={() => answer("accept")}
              >
                Accept the ruling
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => answer("refuse")}>
                Refuse
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
