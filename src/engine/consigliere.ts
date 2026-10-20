/**
 * The consigliere's note.
 *
 * From turn 11 he names one job the boss can finish this week. Finishing it
 * pays a little respect. Letting it pass pays nothing, and that target rests
 * so he doesn't ask again next week. The chair is the exception: while it is
 * empty and a capo can take it, he keeps saying so.
 *
 * He only speaks while he is on the street. The week the seat goes empty, the
 * card says so once.
 */
import type { ConsigliereNote, CrewMember, FamilyName, GameState, SitdownAgenda, TurnLogEntry } from "@/types/game";
import { ALL_FAMILY_NAMES, getFamilyDef } from "@/data/families";
import { bleeding } from "./agendas";
import { canPromote, isUnmade } from "./crew";
import { truceBetween } from "./deals";
import { heatForecast, heatLineName } from "./heat";
import { activeDeal, familiesOnPath, passageGrudges } from "./passage";
import { MESSAGE_THRESHOLD } from "./rivalAI";
import { isSuccessionReady } from "./succession";

const RESPECT_PAY = 2;
const MISS_WEEKS = 3;
const DONE_WEEKS = 1;
const OPEN_SITDOWN = new Set(["proposed", "scheduled", "at_table"]);

export interface ConsigliereTick {
  state: GameState;
  logs: TurnLogEntry[];
}

function voice(member: CrewMember): string {
  return member.name.split(" ")[0] || member.name;
}

function freeConsigliere(state: GameState): CrewMember | undefined {
  const player = state.playerFamily;
  if (!player) return undefined;
  return state.crew.find(
    (c) => c.family === player && c.role === "consigliere" && c.status === "active",
  );
}

function resting(rest: Record<string, number>, key: string, turn: number): boolean {
  return (rest[key] ?? 0) > turn;
}

function targetKey(note: ConsigliereNote): string {
  if (note.kind === "heat") return `heat:${note.heatLine}:${note.heatAim}`;
  if (note.kind === "books") return `books:${note.crewId}`;
  if (note.kind === "bleeding" || note.kind === "road") return `${note.kind}:${note.family}`;
  return note.kind;
}

function noteBlocked(rest: Record<string, number>, turn: number, kind: ConsigliereNote["kind"], key: string): boolean {
  return resting(rest, `done:${kind}`, turn) || resting(rest, key, turn);
}

function openTable(state: GameState, family: FamilyName, purpose?: SitdownAgenda): boolean {
  return (state.sitdowns ?? []).some((s) => {
    if (!OPEN_SITDOWN.has(s.status)) return false;
    if (s.proposer !== family && s.other !== family) return false;
    return purpose == null || s.purpose === purpose;
  });
}

function hitThisWeek(state: GameState, family: FamilyName, issuedTurn: number): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  return state.operations.some(
    (o) =>
      o.kind === "hit" &&
      o.family === player &&
      o.targetFamily === family &&
      o.plannedTurn === issuedTurn,
  );
}

function routeCrosses(state: GameState, family: FamilyName): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  return (state.supplyRoutes ?? []).some((r) => {
    if (r.family !== player || r.status === "suspended") return false;
    return familiesOnPath(state, r.path, player).includes(family);
  });
}

function chairOpen(state: GameState): CrewMember | undefined {
  const player = state.playerFamily;
  if (!player) return undefined;
  const ready = state.crew.some((c) => c.family === player && isSuccessionReady(c, state.turn));
  if (ready) return undefined;
  const leaderless = state.interregnum?.family === player;
  return state.crew.find(
    (c) =>
      c.family === player &&
      c.role === "capo" &&
      canPromote(c, "underboss", state.crew, state.money, { leaderless }).ok,
  );
}

function booksReady(state: GameState): CrewMember | undefined {
  const player = state.playerFamily;
  if (!player || state.making) return undefined;
  return state.crew.find(
    (c) =>
      c.family === player &&
      c.status === "active" &&
      isUnmade(c) &&
      canPromote(c, "soldier", state.crew, state.money).ok,
  );
}

function bleedingFamily(state: GameState, rest: Record<string, number>): FamilyName | undefined {
  const player = state.playerFamily;
  if (!player) return undefined;
  let best: FamilyName | undefined;
  let most = 1;
  for (const family of ALL_FAMILY_NAMES) {
    if (family === player) continue;
    const lost = bleeding(state, family);
    if (lost < 2 || lost < most) continue;
    if (truceBetween(state, player, family) || openTable(state, family)) continue;
    const key = `bleeding:${family}`;
    if (noteBlocked(rest, state.turn, "bleeding", key)) continue;
    most = lost;
    best = family;
  }
  return best;
}

function roadFamily(state: GameState, rest: Record<string, number>): FamilyName | undefined {
  const player = state.playerFamily;
  if (!player) return undefined;
  for (const family of ALL_FAMILY_NAMES) {
    if (family === player) continue;
    const threshold = MESSAGE_THRESHOLD[getFamilyDef(family).personality] ?? 2;
    if (passageGrudges(state, family).length !== threshold - 1) continue;
    if (!routeCrosses(state, family)) continue;
    if (activeDeal(state, family) || openTable(state, family, "passage")) continue;
    const key = `road:${family}`;
    if (noteBlocked(rest, state.turn, "road", key)) continue;
    return family;
  }
  return undefined;
}

function heatJob(state: GameState, rest: Record<string, number>): ConsigliereNote | undefined {
  const forecast = heatForecast(state);
  if (forecast.weeks !== 1 || !forecast.line) return undefined;
  if (forecast.direction !== "climb" && forecast.direction !== "fall") return undefined;
  const aim = forecast.direction === "climb" ? "stay" : "drop";
  const key = `heat:${forecast.line.level}:${aim}`;
  if (noteBlocked(rest, state.turn, "heat", key)) return undefined;
  const name = heatLineName(forecast.line.level);
  const line =
    aim === "stay"
      ? `Stay under ${name}. It crosses next week.`
      : `Get under ${name}. It lifts if the week stays quiet.`;
  return {
    id: `note_heat_${state.turn}_${forecast.line.level}`,
    kind: "heat",
    issuedTurn: state.turn,
    line,
    heatLine: forecast.line.level,
    heatAim: aim,
    show: "corruption",
  };
}

function pickNote(state: GameState): GameState {
  const player = state.playerFamily;
  if (!player || state.turn <= 10) return { ...state, consigliereNote: null };

  const consigliere = freeConsigliere(state);
  const rest = { ...(state.consigliereRest ?? {}) };
  if (!consigliere) {
    if ((rest.absent ?? 0) > state.turn) return { ...state, consigliereNote: null, consigliereRest: rest };
    rest.absent = 1_000_000;
    return {
      ...state,
      consigliereRest: rest,
      consigliereNote: {
        id: `note_absent_${state.turn}`,
        kind: "absent",
        issuedTurn: state.turn,
        line: "No consigliere. Nobody is reading the street for you.",
      },
    };
  }
  delete rest.absent;

  const capo = chairOpen(state);
  if (capo) {
    return {
      ...state,
      consigliereRest: rest,
      consigliereNote: {
        id: `note_chair_${state.turn}`,
        kind: "chair",
        issuedTurn: state.turn,
        line: `${capo.name} can take the chair.`,
        crewId: capo.id,
        show: "crew",
      },
    };
  }

  const heat = heatJob(state, rest);
  if (heat) return { ...state, consigliereRest: rest, consigliereNote: heat };

  const man = booksReady(state);
  const booksKey = man ? `books:${man.id}` : "";
  if (man && !noteBlocked(rest, state.turn, "books", booksKey)) {
    return {
      ...state,
      consigliereRest: rest,
      consigliereNote: {
        id: `note_books_${state.turn}_${man.id}`,
        kind: "books",
        issuedTurn: state.turn,
        line: `Open the books for ${man.name}.`,
        crewId: man.id,
        show: "crew",
      },
    };
  }

  const bled = bleedingFamily(state, rest);
  if (bled) {
    return {
      ...state,
      consigliereRest: rest,
      consigliereNote: {
        id: `note_bleeding_${state.turn}_${bled}`,
        kind: "bleeding",
        issuedTurn: state.turn,
        line: `${bled} is bleeding. Make peace, or finish it.`,
        family: bled,
        show: "commission",
      },
    };
  }

  const road = roadFamily(state, rest);
  if (road) {
    return {
      ...state,
      consigliereRest: rest,
      consigliereNote: {
        id: `note_road_${state.turn}_${road}`,
        kind: "road",
        issuedTurn: state.turn,
        line: `${road} is one truck from sending a message. Pay for the road, or stay off it.`,
        family: road,
        show: "commission",
      },
    };
  }

  return { ...state, consigliereRest: rest, consigliereNote: null };
}

function noteKept(state: GameState, note: ConsigliereNote, judgedHeat: number): boolean {
  const player = state.playerFamily;
  if (!player) return false;
  if (note.kind === "chair") {
    return state.crew.some(
      (c) =>
        c.family === player &&
        c.role === "underboss" &&
        (c.status === "active" || c.status === "wounded"),
    );
  }
  if (note.kind === "heat") return note.heatLine != null && judgedHeat < note.heatLine;
  if (note.kind === "books") {
    if (!note.crewId) return false;
    if (state.making?.crewId === note.crewId) return true;
    const man = state.crew.find((c) => c.id === note.crewId);
    return !!man && man.traits.includes("made_man");
  }
  if (note.kind === "bleeding" && note.family) {
    return (
      !!truceBetween(state, player, note.family) ||
      openTable(state, note.family) ||
      hitThisWeek(state, note.family, note.issuedTurn)
    );
  }
  if (note.kind === "road" && note.family) {
    return (
      !!activeDeal(state, note.family) ||
      openTable(state, note.family, "passage") ||
      !routeCrosses(state, note.family)
    );
  }
  return false;
}

function praise(state: GameState, note: ConsigliereNote): string {
  const consigliere = freeConsigliere(state);
  const who = consigliere ? voice(consigliere) : "The consigliere";
  if ((note.kind === "bleeding" || note.kind === "road") && note.family) {
    return `${who}: well handled with ${note.family}. Respect +${RESPECT_PAY}.`;
  }
  if (note.kind === "chair") return `${who}: the chair is covered. Respect +${RESPECT_PAY}.`;
  if (note.kind === "books") return `${who}: the books are open. Respect +${RESPECT_PAY}.`;
  return `${who}: the heat stayed where it should. Respect +${RESPECT_PAY}.`;
}

/**
 * Settle the note the player was looking at, then name at most one for the
 * week ahead. `judgedHeat` is the level after a quiet week's cooling, before
 * a raid can push it back up.
 */
export function tickConsigliere(state: GameState, judgedHeat = state.heat.level): ConsigliereTick {
  if (!state.playerFamily || state.turn <= 10) return { state, logs: [] };

  const note = state.consigliereNote;
  let current = state;
  const logs: TurnLogEntry[] = [];
  if (note && note.kind !== "absent") {
    const rest = { ...(current.consigliereRest ?? {}) };
    if (noteKept(current, note, judgedHeat)) {
      if (note.kind !== "chair") rest[`done:${note.kind}`] = current.turn + DONE_WEEKS;
      current = {
        ...current,
        consigliereRest: rest,
        consigliereNote: null,
        reputation: {
          ...current.reputation,
          respect: Math.min(100, current.reputation.respect + RESPECT_PAY),
        },
      };
      logs.push({
        id: `log_consigliere_${note.id}`,
        turn: current.turn,
        category: "diplomacy",
        text: praise(current, note),
        family: current.playerFamily ?? undefined,
      });
    } else {
      if (note.kind !== "chair") rest[targetKey(note)] = current.turn + MISS_WEEKS;
      current = { ...current, consigliereRest: rest, consigliereNote: null };
    }
  } else if (note) {
    current = { ...current, consigliereNote: null };
  }

  return { state: pickNote(current), logs };
}
