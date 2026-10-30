import type { FamilyName, GameState } from "@/types/game";
import type { MapSize } from "./mapSize";

export const SAVE_SLOTS = [1, 2, 3, 4, 5] as const;
export const SAVE_NAME_MAX = 40;

/** What the menu shows for a slot, kept beside the save so the list never parses a whole game. */
export interface SaveSlotInfo {
  slot: number;
  name: string;
  savedAt: number;
  turn: number;
  date: GameState["date"];
  family: FamilyName | null;
  /** Missing on saves written before map size existed. Those are the normal map. */
  mapSize?: MapSize;
}

const gameKey = (slot: number) => `commission_save_${slot}`;
const infoKey = (slot: number) => `commission_save_info_${slot}`;

export function defaultSaveName(state: Pick<GameState, "playerFamily" | "turn">): string {
  return `${state.playerFamily ?? "New"} family, week ${state.turn}`;
}

export function cleanSaveName(name: string | undefined, state: Pick<GameState, "playerFamily" | "turn">): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim().slice(0, SAVE_NAME_MAX);
  return trimmed || defaultSaveName(state);
}

/** A slot's label and when it was written. Older saves without one are read once and labelled. */
export function readSlotInfo(slot: number): SaveSlotInfo | null {
  try {
    const raw = localStorage.getItem(infoKey(slot));
    if (raw) return { ...(JSON.parse(raw) as SaveSlotInfo), slot };
    const game = localStorage.getItem(gameKey(slot));
    if (!game) return null;
    const loaded = JSON.parse(game) as GameState;
    return {
      slot,
      name: defaultSaveName(loaded),
      savedAt: 0,
      turn: loaded.turn ?? 1,
      date: loaded.date,
      family: loaded.playerFamily ?? null,
      mapSize: loaded.settings?.mapSize ?? "normal",
    };
  } catch {
    return null;
  }
}

export function readSaveSlots(): (SaveSlotInfo | null)[] {
  return SAVE_SLOTS.map(readSlotInfo);
}

export function readSlotGame(slot: number): string | null {
  return localStorage.getItem(gameKey(slot));
}

/** Writes the game and its label. On a full disk the old save in that slot is left as it was. */
export function writeSlot(
  slot: number,
  state: GameState,
  name: string | undefined,
): { ok: true; info: SaveSlotInfo } | { ok: false; error: string } {
  const info: SaveSlotInfo = {
    slot,
    name: cleanSaveName(name, state),
    savedAt: Date.now(),
    turn: state.turn,
    date: state.date,
    family: state.playerFamily ?? null,
    mapSize: state.settings.mapSize ?? "normal",
  };
  const previous = localStorage.getItem(gameKey(slot));
  const previousInfo = localStorage.getItem(infoKey(slot));
  try {
    localStorage.setItem(gameKey(slot), JSON.stringify({ ...state, aiTrace: null }));
    localStorage.setItem(infoKey(slot), JSON.stringify(info));
    return { ok: true, info };
  } catch (error) {
    try {
      if (previous === null) localStorage.removeItem(gameKey(slot));
      else localStorage.setItem(gameKey(slot), previous);
      if (previousInfo === null) localStorage.removeItem(infoKey(slot));
      else localStorage.setItem(infoKey(slot), previousInfo);
    } catch {
      // Nothing more to put back.
    }
    const full = error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
    return {
      ok: false,
      error: full
        ? "The browser's save space is full. Delete a slot you don't need and try again."
        : "The browser wouldn't store the save.",
    };
  }
}

export function renameSlot(slot: number, name: string): SaveSlotInfo | null {
  const info = readSlotInfo(slot);
  if (!info) return null;
  const next = { ...info, name: name.replace(/\s+/g, " ").trim().slice(0, SAVE_NAME_MAX) || info.name };
  try {
    localStorage.setItem(infoKey(slot), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function deleteSlot(slot: number): void {
  localStorage.removeItem(gameKey(slot));
  localStorage.removeItem(infoKey(slot));
}
