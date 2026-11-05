import type { AiMemory, FamilyName, GameState, TurnLogEntry } from "@/types/game";
import { getFamilyDef } from "@/data/families";
import { salience } from "./ai/aiMemory";
import { mindOf, rivalFamilies } from "./ai/minds";

export const OVERHEARD_CAP = 40;

export function overheardKey(family: FamilyName, mem: AiMemory): string {
  return `${family}:${mem.kind}:${mem.actor}:${mem.territoryId ?? ""}:${mem.turn}`;
}

export function phraseOverheard(
  family: FamilyName,
  mem: AiMemory,
  districtName?: string,
): string {
  const name = family;
  const actor = mem.actor;
  switch (mem.kind) {
    case "killed_boss":
      return `${name} still talk about the chair.`;
    case "broke_truce":
      return `${name} still call ${actor} a man who breaks his word.`;
    case "took_turf":
      return `${name} have not forgotten ${districtName ?? "that block"}.`;
    case "hit_us":
      return `${name} are still sore at ${actor}.`;
    case "kept_deal":
      return `${name} say ${actor} kept his word.`;
    case "spared_us":
      return `${name} remember ${actor} let them walk.`;
    case "hit_our_enemy":
      return `${name} still thank ${actor} for that job.`;
    case "shook_us":
      return `${name} have not forgotten who shook them down.`;
    default:
      return `${name} are still talking.`;
  }
}

export function pickOverheard(state: GameState): { family: FamilyName; mem: AiMemory; key: string } | null {
  const spoken = new Set(state.overheardKeys ?? []);
  let best: { family: FamilyName; mem: AiMemory; key: string; score: number } | null = null;
  for (const family of rivalFamilies(state)) {
    const mind = mindOf(state, family);
    const personality = getFamilyDef(family).personality;
    for (const mem of mind.memories) {
      const score = salience(mem, state.turn, personality);
      if (score < 0.2) continue;
      const key = overheardKey(family, mem);
      if (spoken.has(key)) continue;
      if (!best || score > best.score) best = { family, mem, key, score };
    }
  }
  return best ? { family: best.family, mem: best.mem, key: best.key } : null;
}

export function speakOverheard(state: GameState): { state: GameState; log?: TurnLogEntry } {
  const pick = pickOverheard(state);
  if (!pick) return { state };
  const district = pick.mem.territoryId
    ? state.territories.find((t) => t.id === pick.mem.territoryId)?.name
    : undefined;
  const text = phraseOverheard(pick.family, pick.mem, district);
  const log: TurnLogEntry = {
    id: `log_overheard_${state.turn}_${pick.key}`,
    turn: state.turn,
    category: "system",
    text,
    family: state.playerFamily ?? undefined,
  };
  return {
    state: {
      ...state,
      overheardKeys: [...(state.overheardKeys ?? []), pick.key].slice(-OVERHEARD_CAP),
    },
    log,
  };
}
