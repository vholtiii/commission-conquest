/**
 * Rival families draw the same kind of police attention the player does,
 * on a simpler meter. Vice, hits, captures, and car bombs raise it. It
 * cools every week. Past a point the precinct raids them, and past a
 * hotter point they buy the cops off.
 */
import type { CrewMember, FamilyName, GameState, Racket, Territory, TurnLogEntry } from "@/types/game";
import type { Rng } from "./rng";
import { JAIL_TURNS, jailInCrew } from "./jail";

export const RIVAL_HEAT_CAP = 100;
export const RIVAL_HEAT_DECAY = 4;
/** Raids start here. Chance that week is heat / RIVAL_RAID_DIVISOR. */
export const RIVAL_RAID_AT = 40;
export const RIVAL_RAID_DIVISOR = 200;
/** They start buying cops once it gets this hot. */
export const RIVAL_BRIBE_AT = 50;
export const RIVAL_COP_BRIBE = 500;
export const RIVAL_CAPTAIN_BRIBE = 2000;
/** The opening weeks still pay a small floor so a bad deal doesn't sink a family. */
export const RIVAL_GRACE_TURNS = 10;
export const RIVAL_GRACE_FLOOR = 150;

const VICE = new Set(["speakeasy", "gambling", "brothel", "loan_shark", "still", "brewery"]);

export function attentionLabel(heat: number): "low" | "watched" | "hot" {
  if (heat >= 70) return "hot";
  if (heat >= RIVAL_RAID_AT) return "watched";
  return "low";
}

export function bumpRivalHeat(state: GameState, family: FamilyName, amount: number): GameState {
  if (amount === 0 || family === state.playerFamily) return state;
  const heat = state.rivalHeat ?? {};
  const next = Math.max(0, Math.min(RIVAL_HEAT_CAP, (heat[family] ?? 0) + amount));
  return { ...state, rivalHeat: { ...heat, [family]: next } };
}

function viceGain(territories: Territory[], family: FamilyName): number {
  let levels = 0;
  for (const t of territories) {
    if (t.owner !== family) continue;
    for (const r of t.rackets) {
      if (VICE.has(r.type)) levels += r.level;
    }
  }
  return Math.round(levels / 2);
}

function releaseSentences(crew: CrewMember[], turn: number, player: FamilyName | null): CrewMember[] {
  return crew.map((c) => {
    if (player && c.family === player) return c;
    if (c.role === "boss" || c.status !== "jailed") return c;
    if (c.jailedUntilTurn == null || turn < c.jailedUntilTurn) return c;
    return { ...c, status: "active" as const, jailedUntilTurn: undefined, assignment: { type: "idle" as const } };
  });
}

/**
 * Cool every rival meter, add heat for the vice they run, and maybe raid.
 * A raid freezes one vice joint for a week, or jails a soldier or capo —
 * never the boss — for the usual sentence, then lets him walk.
 */
export function tickRivalHeat(
  state: GameState,
  territories: Territory[],
  crew: CrewMember[],
  rngFor: (family: FamilyName) => Rng,
): { territories: Territory[]; crew: CrewMember[]; rivalHeat: Partial<Record<FamilyName, number>>; logs: TurnLogEntry[] } {
  const logs: TurnLogEntry[] = [];
  let nextCrew = releaseSentences(crew, state.turn, state.playerFamily);
  let nextTerritories = territories;
  const heat: Partial<Record<FamilyName, number>> = { ...(state.rivalHeat ?? {}) };
  const families = new Set<FamilyName>();
  for (const t of territories) {
    if (t.owner && t.owner !== state.playerFamily) families.add(t.owner);
  }

  for (const family of families) {
    const cooled = Math.max(0, (heat[family] ?? 0) + viceGain(territories, family) - RIVAL_HEAT_DECAY);
    const level = Math.min(RIVAL_HEAT_CAP, cooled);
    if (level > RIVAL_RAID_AT) {
      const rng = rngFor(family);
      if (rng.chance(level / RIVAL_RAID_DIVISOR)) {
        const raid = runRaid(nextTerritories, nextCrew, family, state.turn, rng);
        nextTerritories = raid.territories;
        nextCrew = raid.crew;
        if (raid.log) logs.push({ ...raid.log, turn: state.turn, family });
      }
    }
    heat[family] = level;
  }

  return { territories: nextTerritories, crew: nextCrew, rivalHeat: heat, logs };
}

function runRaid(
  territories: Territory[],
  crew: CrewMember[],
  family: FamilyName,
  turn: number,
  rng: Rng,
): { territories: Territory[]; crew: CrewMember[]; log?: Omit<TurnLogEntry, "turn" | "family"> } {
  const vice: { t: Territory; r: Racket }[] = [];
  for (const t of territories) {
    if (t.owner !== family) continue;
    for (const r of t.rackets) {
      if (VICE.has(r.type) && (r.frozenUntil ?? 0) <= turn) vice.push({ t, r });
    }
  }
  const men = crew.filter(
    (c) =>
      c.family === family &&
      c.status === "active" &&
      c.role !== "boss" &&
      (c.role === "soldier" || c.role === "capo" || c.role === "associate"),
  );
  const freeze = vice.length > 0 && (men.length === 0 || rng.chance(0.5));
  if (freeze) {
    const pick = rng.pick(vice);
    return {
      territories: territories.map((t) =>
        t.id !== pick.t.id
          ? t
          : { ...t, rackets: t.rackets.map((r) => (r.id === pick.r.id ? { ...r, frozenUntil: turn + 1 } : r)) },
      ),
      crew,
      log: {
        id: `log_rival_raid_${turn}_${family}`,
        category: "economy",
        text: `The precinct raided ${family}'s ${pick.r.type.replace("_", " ")} in ${pick.t.name}. It is shut for the week.`,
      },
    };
  }
  if (men.length === 0) return { territories, crew };
  const man = rng.pick(men);
  const jailed = jailInCrew(crew, man.id, turn).map((c) =>
    c.id === man.id ? { ...c, jailedUntilTurn: turn + JAIL_TURNS } : c,
  );
  return {
    territories,
    crew: jailed,
    log: {
      id: `log_rival_pinch_${turn}_${family}`,
      category: "economy",
      text: `The precinct pinched ${man.name} of the ${family}. He'll walk in ${JAIL_TURNS} weeks.`,
    },
  };
}

/**
 * A broke family sheds cost. The cheapest associate walks, or the smallest
 * racket nobody is running drops a level. Officers stay.
 */
export function beltTighten(
  territories: Territory[],
  crew: CrewMember[],
  family: FamilyName,
): { territories: Territory[]; crew: CrewMember[]; note: string | null } {
  const associates = crew
    .filter((c) => c.family === family && c.status === "active" && c.role === "associate")
    .sort((a, b) => a.level - b.level || a.loyalty - b.loyalty);
  const keep = crew.filter((c) => c.family === family && c.status === "active").length;
  if (associates.length > 0 && keep > 3) {
    const gone = associates[0]!;
    return {
      territories: territories.map((t) => ({
        ...t,
        garrisonIds: t.garrisonIds.filter((id) => id !== gone.id),
        rackets: t.rackets.map((r) => (r.managerId === gone.id ? { ...r, managerId: undefined } : r)),
      })),
      crew: crew.filter((c) => c.id !== gone.id),
      note: `${family} lets ${gone.name} go. The treasury won't cover him.`,
    };
  }
  let weakest: { tid: string; rid: string; level: number } | null = null;
  for (const t of territories) {
    if (t.owner !== family) continue;
    for (const r of t.rackets) {
      if (r.managerId) continue;
      if (!weakest || r.level < weakest.level) weakest = { tid: t.id, rid: r.id, level: r.level };
    }
  }
  if (!weakest) return { territories, crew, note: null };
  const drop = weakest;
  return {
    crew,
    territories: territories.map((t) => {
      if (t.id !== drop.tid) return t;
      return {
        ...t,
        rackets:
          drop.level <= 1
            ? t.rackets.filter((r) => r.id !== drop.rid)
            : t.rackets.map((r) => {
                if (r.id !== drop.rid) return r;
                const level = r.level - 1;
                const stock = Math.floor((r.stock * level) / r.level);
                return { ...r, level, stock, proofed: Math.min(r.proofed ?? 0, stock) };
              }),
      };
    }),
    note:
      drop.level <= 1
        ? `${family} shutters a joint it can no longer afford.`
        : `${family} lets a joint slip a level. The week's take didn't cover it.`,
  };
}
