import { useState } from "react";
import { Save, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { useGameStore } from "@/engine/store";
import {
  SAVE_NAME_MAX,
  defaultSaveName,
  deleteSlot,
  readSaveSlots,
  renameSlot,
  type SaveSlotInfo,
} from "@/engine/saveSlots";
import type { GameLength, GameSettings } from "@/types/game";
import { districtCount, mapSizeLabel, type MapSize } from "@/engine/mapSize";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { setAmbienceVolume } from "@/audio/ambience";
import { formatDate } from "../formatters";
import PanelShell from "./PanelShell";

function savedWhen(at: number): string {
  if (!at) return "Saved earlier";
  const d = new Date(at);
  return `Saved ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function SaveSlots() {
  const saveSlot = useGameStore((s) => s.saveSlot);
  const loadSlot = useGameStore((s) => s.loadSlot);
  const playerFamily = useGameStore((s) => s.playerFamily);
  const turn = useGameStore((s) => s.turn);
  const [slots, setSlots] = useState(readSaveSlots);
  const [names, setNames] = useState<Record<number, string>>(() =>
    Object.fromEntries(readSaveSlots().map((info, i) => [i + 1, info?.name ?? ""])),
  );
  const [confirm, setConfirm] = useState<{ slot: number; kind: "save" | "load" | "delete" } | null>(null);

  const refresh = () => {
    const next = readSaveSlots();
    setSlots(next);
    setNames((prev) => {
      const out = { ...prev };
      next.forEach((info, i) => {
        if (info) out[i + 1] = info.name;
      });
      return out;
    });
  };
  const suggestion = defaultSaveName({ playerFamily, turn });

  const doSave = (slot: number) => {
    setConfirm(null);
    if (saveSlot(slot, names[slot])) refresh();
  };
  const doLoad = (slot: number) => {
    setConfirm(null);
    loadSlot(slot);
  };
  const doDelete = (slot: number) => {
    setConfirm(null);
    deleteSlot(slot);
    setNames((prev) => ({ ...prev, [slot]: "" }));
    refresh();
  };
  const commitName = (slot: number, info: SaveSlotInfo | null) => {
    if (!info) return;
    const typed = (names[slot] ?? "").trim();
    if (!typed || typed === info.name) {
      setNames((prev) => ({ ...prev, [slot]: info.name }));
      return;
    }
    if (renameSlot(slot, typed)) refresh();
  };

  return (
    <div className="space-y-1.5">
      {slots.map((info, i) => {
        const slot = i + 1;
        const asking = confirm?.slot === slot ? confirm.kind : null;
        return (
          <div key={slot} className="rounded-md border border-panel-border bg-panel/50 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-muted-foreground">Slot {slot}</span>
              <input
                value={names[slot] ?? ""}
                maxLength={SAVE_NAME_MAX}
                placeholder={info ? info.name : suggestion}
                aria-label={`Name for save slot ${slot}`}
                onChange={(e) => setNames((prev) => ({ ...prev, [slot]: e.target.value }))}
                onBlur={() => commitName(slot, info)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (info) setConfirm({ slot, kind: "save" });
                  else doSave(slot);
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-panel-border bg-panel/60 px-2 text-xs placeholder:text-muted-foreground/70 focus:border-steel focus:outline-none"
              />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {info
                ? `${info.family ?? "No family"} · ${mapSizeLabel(info.mapSize)} map · week ${info.turn}${info.date ? ` · ${formatDate(info.date)}` : ""} · ${savedWhen(info.savedAt)}`
                : "Empty. Type a name, then save."}
            </p>

            {asking ? (
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                <span className={asking === "delete" ? "text-heat" : "text-amber-200"}>
                  {asking === "save"
                    ? "Write over this save?"
                    : asking === "load"
                      ? "Load it? Anything since your last save is lost."
                      : "Delete this save?"}
                </span>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    className={`h-6 px-2 text-[11px] ${asking === "delete" ? "bg-heat hover:bg-heat/80" : ""}`}
                    onClick={() => (asking === "save" ? doSave(slot) : asking === "load" ? doLoad(slot) : doDelete(slot))}
                  >
                    {asking === "save" ? "Overwrite" : asking === "load" ? "Load" : "Delete"}
                  </Button>
                  <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  size="sm"
                  className="h-7 flex-1 gap-1 px-2 text-[11px]"
                  disabled={!playerFamily}
                  title={playerFamily ? undefined : "Pick a family before you save."}
                  onClick={() => (info ? setConfirm({ slot, kind: "save" }) : doSave(slot))}
                >
                  <Save className="h-3 w-3" /> Save
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 flex-1 gap-1 px-2 text-[11px]"
                  disabled={!info}
                  onClick={() => setConfirm({ slot, kind: "load" })}
                >
                  <FolderOpen className="h-3 w-3" /> Load
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-heat"
                  disabled={!info}
                  aria-label={`Delete save slot ${slot}`}
                  title="Delete this save"
                  onClick={() => setConfirm({ slot, kind: "delete" })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground">
        The game also keeps itself as you play. Slots are saves you name and come back to.
      </p>
    </div>
  );
}

export default function MenuPanel() {
  const newGame = useGameStore((s) => s.newGame);
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const [difficulty, setDifficulty] = useState<GameSettings["difficulty"]>(settings.difficulty);
  const [gameLength, setGameLength] = useState<GameLength>(settings.gameLength ?? "medium");
  const [mapSize, setMapSize] = useState<MapSize>(settings.mapSize ?? "normal");

  return (
    <PanelShell title="Menu" subtitle="Save, load, or start over">
      <div className="space-y-5">
        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Save Slots</h3>
          <SaveSlots />
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Playback</h3>
          <label className="flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={!!settings.skipCinematics}
              onCheckedChange={(v) => updateSettings({ skipCinematics: !!v })}
            />
            Skip hit cinematics
          </label>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={(settings.rivalCinematics ?? "brief") !== "off"}
              disabled={!!settings.skipCinematics}
              onCheckedChange={(v) => updateSettings({ rivalCinematics: v ? "brief" : "off" })}
            />
            Show rival-on-rival hits (brief)
          </label>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={settings.postFx !== false}
              onCheckedChange={(v) => updateSettings({ postFx: !!v })}
            />
            Post-processing
          </label>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={settings.confirmEndTurn !== false}
              onCheckedChange={(v) => updateSettings({ confirmEndTurn: !!v })}
            />
            Warn about loose ends before ending the week
          </label>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <Checkbox
              checked={!!settings.showAiThinking}
              onCheckedChange={(v) => updateSettings({ showAiThinking: !!v })}
            />
            Show rival thinking (debug)
          </label>
          <div
            role="group"
            aria-label="Graphics quality"
            className="mt-1.5 flex items-center gap-1.5 rounded-md border border-panel-border bg-panel/50 px-3 py-1.5 text-xs"
          >
            <span className="shrink-0 pr-1">Graphics</span>
            {(["auto", "high", "low"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={(settings.graphics ?? "auto") === g}
                title={
                  g === "auto"
                    ? "Balanced; drops to Light if the frame rate dips"
                    : g === "high"
                      ? "Ambient occlusion, soft shadows, sharper image. Needs a strong GPU"
                      : "Fastest: lower resolution, no bloom or anti-aliasing"
                }
                onClick={() => updateSettings({ graphics: g })}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] capitalize ${
                  (settings.graphics ?? "auto") === g
                    ? "border-steel bg-steel/20 text-steel-light"
                    : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                }`}
              >
                {g === "auto" ? "Auto" : g === "high" ? "Sharp" : "Light"}
              </button>
            ))}
          </div>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <span className="shrink-0">Sound effects</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((settings.sfxVolume ?? 0.7) * 100)}
              onChange={(e) => updateSettings({ sfxVolume: Number(e.target.value) / 100 })}
              className="w-full accent-steel"
              aria-label="Sound effects volume"
            />
          </label>
          <label className="mt-1.5 flex items-center gap-2 rounded-md border border-panel-border bg-panel/50 px-3 py-2 text-xs">
            <span className="shrink-0">Ambience</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((settings.ambienceVolume ?? 0.4) * 100)}
              onChange={(e) => {
                const ambienceVolume = Number(e.target.value) / 100;
                updateSettings({ ambienceVolume });
                setAmbienceVolume(ambienceVolume);
              }}
              className="w-full accent-steel"
              aria-label="Ambience volume"
            />
          </label>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">New Game</h3>
          <div className="flex gap-1.5">
            {(["easy", "normal", "hard"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs capitalize ${
                  difficulty === d
                    ? "border-steel bg-steel/20 text-steel-light"
                    : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {(
              [
                ["short", "Short · 30"],
                ["medium", "Medium · 50"],
                ["long", "Long · 80"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setGameLength(id)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] ${
                  gameLength === id
                    ? "border-steel bg-steel/20 text-steel-light"
                    : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1.5" role="group" aria-label="Map size">
            {(
              [
                ["small", "Small"],
                ["normal", "Normal"],
                ["large", "Large"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={mapSize === id}
                onClick={() => setMapSize(id)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] ${
                  mapSize === id
                    ? "border-steel bg-steel/20 text-steel-light"
                    : "border-panel-border bg-panel/50 hover:bg-panel-elevated"
                }`}
              >
                <span className="block">{label}</span>
                <span className="block text-[10px] opacity-80">{districtCount(id)} districts</span>
              </button>
            ))}
          </div>
          <Button
            className="mt-2 w-full gap-2 bg-heat font-ui font-bold uppercase hover:bg-heat/80"
            onClick={() => newGame({ difficulty, gameLength, mapSize })}
          >
            <RotateCcw className="h-4 w-4" /> Start New Game
          </Button>
        </div>
      </div>
    </PanelShell>
  );
}
