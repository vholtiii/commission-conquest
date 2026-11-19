import { describe, expect, it, vi } from "vitest";
import { buildInitialState, startGame } from "@/engine/initialState";
import { candidateActions, chooseGoal, cityLeader } from "@/engine/ai/aiPlanner";
import { mindOf, withMind } from "@/engine/ai/minds";
import { signRivalPact } from "@/engine/ai/rivalDiplomacy";
import {
  aiPetition,
  askSeats,
  canPetition,
  caseAgainst,
  castVotes,
  petitionMargin,
  pledgeSeat,
  previewSeats,
  seatLean,
} from "@/engine/commission";
import { countHouseBlock, exposedCash, tickRivalCountHouse } from "@/engine/countHouse";
import { createRng } from "@/engine/rng";
import { getRelation, setRelation } from "@/engine/relations";
import { runAiTurn } from "@/engine/rivalAI";
import {
  checkVictory,
  CLEAN_SHARE,
  cleanShareNeeded,
  cleanShareOk,
  clearsBar,
  EASY_CLEAN_SHARE,
  EASY_SUMMIT_RATIO,
  familiesPressingSuddenDeath,
  HARD_PLAYER_EXTRA,
  playerWeeksNeeded,
  raceStatus,
  runaways,
  streakBreakLine,
  streakBreaks,
  summitRatio,
  summitThreats,
  summitWatchWeeks,
  trackStanding,
  weeksNeeded,
} from "@/engine/victory";
import type { AiGoal, FamilyName, GameState } from "@/types/game";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock("@/audio/sfx", () => ({ stopAll: vi.fn(), coins: vi.fn() }));

function game(): GameState {
  return startGame(buildInitialState(4, { startMode: "classic" }), "Moretti");
}

function goal(partial: Partial<AiGoal> & Pick<AiGoal, "kind">): AiGoal {
  return { since: 12, step: 0, failures: 0, score: 3, ...partial };
}

describe("runaways", () => {
  it("keeps clearsBar on the same numbers and names the level", () => {
    const base = game();
    const ahead: GameState = {
      ...base,
      turn: 12,
      influence: 200,
      rivalInfluence: { ...base.rivalInfluence, Ferraro: 40, Valenti: 40, Salvati: 40, Rinaldi: 40 },
      victory: { ...base.victory, influenceLeadTurns: 0 },
    };
    expect(clearsBar(ahead, "Moretti", "influence")).toBe(true);
    expect(familiesPressingSuddenDeath(ahead)).toContain("Moretti");
    expect(runaways(ahead).find((r) => r.family === "Moretti" && r.track === "influence")?.level).toBe("watch");

    const live: GameState = { ...ahead, victory: { ...ahead.victory, influenceLeadTurns: 1 } };
    expect(runaways(live).find((r) => r.family === "Moretti" && r.track === "influence")?.level).toBe("pressing");
    expect(runaways(leadHalf(live)).find((r) => r.family === "Moretti" && r.track === "influence")?.level).toBe("critical");

    const watching = {
      ...ahead,
      influence: Math.floor(trackStanding(ahead, "Moretti", "influence").bar * 0.85),
      victory: { ...ahead.victory, influenceLeadTurns: 0 },
    };
    expect(runaways(watching).find((r) => r.family === "Moretti" && r.track === "influence")?.level).toBe("watch");
    expect(clearsBar(watching, "Moretti", "influence")).toBe(false);
  });
});

function leadHalf(state: GameState): GameState {
  return { ...state, victory: { ...state.victory, influenceLeadTurns: 3 } };
}

describe("the planner's track", () => {
  it("names the track a family is running away on", () => {
    const state: GameState = {
      ...game(),
      turn: 12,
      influence: 220,
      rivalInfluence: { Ferraro: 30, Valenti: 30, Salvati: 30, Rinaldi: 30 },
    };
    const lead = cityLeader(state, "Ferraro");
    expect(lead?.leader).toBe("Moretti");
    expect(lead?.track).toBe("influence");
  });

  it("offers a trailing rival court and a petition on standing, and build and hijack on wealth", () => {
    const base = game();
    const standing: GameState = {
      ...base,
      turn: 14,
      influence: 220,
      rivalInfluence: { ...base.rivalInfluence, Ferraro: 40 },
      rivalTreasury: { ...base.rivalTreasury, Ferraro: 8_000 },
    };
    const containStanding = goal({ kind: "contain_leader", target: "Moretti", track: "influence" });
    const onStanding = candidateActions(standing, "Ferraro", containStanding);
    expect(onStanding.some((a) => a.kind === "court")).toBe(true);
    // The seats have no quarrel with a leader that far ahead: the family doesn't waste the call.
    expect(onStanding.some((a) => a.kind === "petition")).toBe(false);

    let soured = standing;
    for (const seat of ["Valenti", "Salvati", "Rinaldi"] as FamilyName[]) {
      soured = { ...soured, relations: setRelation(setRelation(soured.relations, seat, "Ferraro", 90), seat, "Moretti", -90) };
    }
    expect(petitionMargin(soured, "Ferraro", "Moretti", "ruling")).toBeGreaterThan(0);
    expect(candidateActions(soured, "Ferraro", containStanding).some((a) => a.kind === "petition")).toBe(true);

    // The table hears one call at a time, and not from a family that just called.
    const waiting: GameState = {
      ...soured,
      diplomacy: { ...soured.diplomacy, rivalCallCooldown: { Ferraro: soured.turn + 3 } },
    };
    expect(canPetition(waiting, "Ferraro", "Moretti")).toBe(false);
    expect(candidateActions(waiting, "Ferraro", containStanding).some((a) => a.kind === "petition")).toBe(false);
    const busy = aiPetition(soured, "Valenti", "Rinaldi", "ruling", createRng(1)).state;
    expect(busy.commissionCall).toBeTruthy();
    expect(candidateActions(busy, "Ferraro", containStanding).some((a) => a.kind === "petition")).toBe(false);

    const block = standing.territories.find((t) => t.owner === "Moretti");
    const wealthy: GameState = {
      ...standing,
      routes: block
        ? [{ id: "r1", family: "Moretti", driverId: "d", sourceTerritoryId: block.id, destTerritoryId: block.id, path: [block.id], cargo: 1, status: "active" }]
        : [],
    };
    const onWealth = candidateActions(wealthy, "Ferraro", goal({ kind: "contain_leader", target: "Moretti", track: "wealth" }));
    expect(onWealth.some((a) => a.kind === "build")).toBe(true);
    expect(onWealth.some((a) => a.kind === "hijack")).toBe(true);
    expect(onWealth.some((a) => a.kind === "court")).toBe(false);
  });

  it("leaves only catch-up moves when the family is at peace with the leader", () => {
    const base = game();
    const quiet = signRivalPact(
      {
        ...base,
        turn: 14,
        influence: 220,
        rivalInfluence: { ...base.rivalInfluence, Ferraro: 40 },
        rivalTreasury: { ...base.rivalTreasury, Ferraro: 8_000 },
      },
      "Ferraro",
      "Moretti",
      "truce",
      6,
    ).state;
    const actions = candidateActions(quiet, "Ferraro", goal({ kind: "contain_leader", target: "Moretti", track: "influence" }));
    expect(actions.some((a) => a.kind === "court")).toBe(true);
    expect(actions.some((a) => a.kind === "petition")).toBe(false);
    expect(actions.some((a) => a.kind === "hit" && a.targetFamily === "Moretti")).toBe(false);
  });

  it("follows the leader onto a new track without dropping the plan", () => {
    const base = game();
    const rich: GameState = {
      ...base,
      turn: 14,
      money: 400_000,
      rivalTreasury: { ...base.rivalTreasury, Ferraro: 8_000 },
    };
    expect(cityLeader(rich, "Ferraro")?.track).toBe("wealth");
    const mind = mindOf(rich, "Ferraro");
    const old = goal({ kind: "contain_leader", target: "Moretti", track: "influence", since: 12, score: 50 });
    const chosen = chooseGoal(withMind(rich, "Ferraro", { ...mind, goal: old }), "Ferraro");
    expect(chosen.goal?.kind).toBe("contain_leader");
    expect(chosen.goal?.since).toBe(12);
    expect(chosen.goal?.track).toBe("wealth");
    expect(mindOf(chosen.state, "Ferraro").goal?.track).toBe("wealth");
  });

  it("never offers the leader court", () => {
    const state: GameState = { ...game(), turn: 14, influence: 220, rivalTreasury: { ...game().rivalTreasury, Moretti: 8_000 } };
    const actions = candidateActions(state, "Moretti", goal({ kind: "contain_leader", target: "Moretti", track: "influence" }));
    expect(actions.some((a) => a.kind === "court")).toBe(false);
  });
});

describe("a call between rivals", () => {
  it("waits a week, counts the pledge, docks the loser, and sanctions a second defiance", () => {
    let state = game();
    state = { ...state, turn: 20, rivalInfluence: { ...state.rivalInfluence, Ferraro: 160, Rinaldi: 160 } };
    for (const seat of ["Moretti", "Valenti", "Salvati"] as FamilyName[]) {
      state = { ...state, relations: setRelation(state.relations, seat, "Ferraro", 80) };
      state = { ...state, relations: setRelation(state.relations, seat, "Rinaldi", -80) };
    }
    const opened = aiPetition(state, "Ferraro", "Rinaldi", "ruling", createRng(1));
    expect(opened.state.commissionCall?.thirdParty).toBe(true);
    expect(opened.state.commissionCall?.phase).toBe("lobby");
    const sameWeek = castVotes(opened.state, createRng(2));
    expect(sameWeek.state.commissionCall?.phase).toBe("lobby");

    const pledged = pledgeSeat({ ...sameWeek.state, turn: 21 }, "caller").state;
    const voted = castVotes(pledged, createRng(3));
    expect(voted.state.commissionCall).toBeNull();
    const ruling = voted.state.commissionHistory?.[0];
    expect(ruling?.verdict).toBe("caller");
    expect(ruling?.accusedAnswer).toBe("refuse");
    expect(voted.state.rivalInfluence?.Rinaldi).toBeLessThan(160);
    expect(voted.state.diplomacy.rivalSanctions?.Rinaldi).toBeUndefined();

    const again = aiPetition(
      { ...voted.state, turn: 30, rivalInfluence: { ...voted.state.rivalInfluence, Ferraro: 160 } },
      "Ferraro",
      "Rinaldi",
      "ruling",
      createRng(4),
    );
    const second = castVotes(pledgeSeat({ ...again.state, turn: 31 }, "caller").state, createRng(5));
    expect(second.state.diplomacy.rivalSanctions?.Rinaldi).toBeGreaterThan(31);
  });
});

describe("the same table for everyone", () => {
  it("weighs a rival's ask the way it weighs the player's", () => {
    const state: GameState = { ...game(), turn: 20 };
    expect(previewSeats(state, "tax", "Rinaldi")).toEqual(askSeats(state, "tax", "Moretti", "Rinaldi"));

    // No case: every seat starts against a truce ask, further against a tax, and furthest against a war.
    const truce = askSeats(state, "ruling", "Ferraro", "Rinaldi");
    const tax = askSeats(state, "tax", "Ferraro", "Rinaldi");
    const war = askSeats(state, "war", "Ferraro", "Rinaldi");
    expect(caseAgainst(state, "Ferraro", "Rinaldi")).toBe(false);
    for (const seat of truce) {
      const raw = seatLean(state, seat.family, "Ferraro", "Rinaldi");
      expect(seat.lean).toBeCloseTo(raw - 0.3, 5);
      expect(tax.find((s) => s.family === seat.family)!.lean).toBeLessThanOrEqual(seat.lean - 0.25 + 1e-9);
      expect(war.find((s) => s.family === seat.family)!.lean).toBeCloseTo(raw - 0.6, 5);
    }

    // Bad blood is a case, for a rival as for the player.
    const feud: GameState = { ...state, relations: setRelation(state.relations, "Ferraro", "Rinaldi", -40) };
    expect(caseAgainst(feud, "Ferraro", "Rinaldi")).toBe(true);
    const heard = askSeats(feud, "ruling", "Ferraro", "Rinaldi");
    for (const seat of heard) expect(seat.lean).toBeCloseTo(seatLean(feud, seat.family, "Ferraro", "Rinaldi"), 5);
  });

  it("keeps the player out of a war between rivals unless his seat backed it", () => {
    let state = game();
    state = { ...state, turn: 20, rivalInfluence: { ...state.rivalInfluence, Ferraro: 160, Rinaldi: 160 } };
    for (const seat of ["Valenti", "Salvati"] as FamilyName[]) {
      state = { ...state, relations: setRelation(setRelation(state.relations, seat, "Ferraro", 90), seat, "Rinaldi", -40) };
    }
    state = { ...state, relations: setRelation(state.relations, "Moretti", "Rinaldi", 10) };
    const opened = aiPetition(state, "Ferraro", "Rinaldi", "war", createRng(1)).state;
    expect(opened.commissionCall?.kind).toBe("war");

    const sat = castVotes({ ...opened, turn: 21 }, createRng(2)).state;
    expect(sat.commissionHistory?.[0]?.verdict).toBe("caller");
    expect(getRelation(sat.relations, "Moretti", "Rinaldi")).toBe(10);
    expect(getRelation(sat.relations, "Valenti", "Rinaldi")).toBeLessThanOrEqual(-70);
    expect(sat.pendingRulings ?? []).toEqual([]);

    const backed = castVotes(pledgeSeat({ ...opened, turn: 21 }, "caller").state, createRng(2)).state;
    expect(getRelation(backed.relations, "Moretti", "Rinaldi")).toBeLessThanOrEqual(-70);
  });

  it("drops a call when one of the two families is gone, and hands the standing back", () => {
    let state = game();
    state = { ...state, turn: 20, rivalInfluence: { ...state.rivalInfluence, Ferraro: 160, Rinaldi: 160 } };
    const opened = aiPetition(state, "Ferraro", "Rinaldi", "ruling", createRng(1)).state;
    expect(opened.rivalInfluence?.Ferraro).toBe(135);
    const fallen: GameState = { ...opened, turn: 21, defunctFamilies: [...(opened.defunctFamilies ?? []), "Rinaldi"] };
    const lapsed = castVotes(fallen, createRng(2));
    expect(lapsed.state.commissionCall).toBeNull();
    expect(lapsed.state.rivalInfluence?.Ferraro).toBe(160);
    expect(lapsed.state.commissionHistory ?? []).toEqual([]);
    expect(lapsed.logs[0]?.text).toMatch(/lapses/);
  });
});

describe("rival count-house raids", () => {
  it("leaves the house alone while a pact holds", () => {
    const base = game();
    const victim = "Salvati" as const;
    const house = countHouseBlock(base, victim);
    const door = base.territories.find((t) => house && t.adjacentTerritories.includes(house.id) && t.owner !== victim);
    const near: GameState = {
      ...base,
      turn: 16,
      rivalTreasury: { ...base.rivalTreasury, [victim]: 40_000 },
      territories: door ? base.territories.map((t) => (t.id === door.id ? { ...t, owner: "Ferraro" as FamilyName } : t)) : base.territories,
    };
    const peace = signRivalPact(near, "Ferraro", victim, "truce", 6).state;
    for (let seed = 1; seed < 12; seed++) {
      const tick = tickRivalCountHouse(peace, "Ferraro", createRng(seed), { kind: "contain_leader", target: victim, track: "wealth" });
      expect(tick.logs).toEqual([]);
      expect(tick.state.rivalTreasury?.[victim]).toBe(40_000);
    }
  });

  it("moves the treasury when the house is in reach, and not again inside the cooldown", () => {
    const base = game();
    const victim = "Salvati" as const;
    const house = countHouseBlock(base, victim);
    expect(house).toBeTruthy();
    const far: GameState = {
      ...base,
      turn: 16,
      rivalTreasury: { ...base.rivalTreasury, [victim]: 40_000, Ferraro: 2_000 },
      territories: base.territories.map((t) => (t.owner === "Ferraro" ? { ...t, owner: null } : t)),
    };
    const missed = tickRivalCountHouse(far, "Ferraro", createRng(1), { kind: "contain_leader", target: victim, track: "wealth" });
    expect(missed.state.rivalTreasury?.[victim]).toBe(40_000);

    const door = base.territories.find((t) => house && t.adjacentTerritories.includes(house.id) && t.owner !== victim);
    const near: GameState = {
      ...base,
      turn: 16,
      rivalTreasury: { ...base.rivalTreasury, [victim]: 40_000 },
      territories: door ? base.territories.map((t) => (t.id === door.id ? { ...t, owner: "Ferraro" as FamilyName } : t)) : base.territories,
    };
    expect(exposedCash(near, victim)).toBeGreaterThan(0);
    let hit = tickRivalCountHouse(near, "Ferraro", createRng(2), { kind: "contain_leader", target: victim, track: "wealth" });
    for (let seed = 3; seed < 40 && (hit.state.rivalTreasury?.[victim] ?? 0) >= 40_000; seed++) {
      hit = tickRivalCountHouse(near, "Ferraro", createRng(seed), { kind: "contain_leader", target: victim, track: "wealth" });
    }
    expect(hit.logs[0]?.text ?? "").toMatch(/count house/);
    expect((hit.state.rivalTreasury?.[victim] ?? 0) + (hit.state.rivalTreasury?.Ferraro ?? 0)).toBe(
      (near.rivalTreasury?.[victim] ?? 0) + (near.rivalTreasury?.Ferraro ?? 0),
    );
    expect(hit.state.rivalTreasury?.[victim]).toBeLessThan(40_000);
    const second = tickRivalCountHouse(hit.state, "Ferraro", createRng(9), { kind: "contain_leader", target: victim, track: "wealth" });
    expect(second.state.rivalTreasury?.[victim]).toBe(hit.state.rivalTreasury?.[victim]);
    expect(second.logs).toEqual([]);
  });
});

describe("Hard", () => {
  const rivals = ["Valenti", "Ferraro", "Salvati", "Rinaldi"] as FamilyName[];
  const every = (n: number) => Object.fromEntries(rivals.map((f) => [f, n])) as Record<FamilyName, number>;

  function at(difficulty: GameState["settings"]["difficulty"], turn: number, over: Partial<GameState> = {}): GameState {
    const base = startGame(buildInitialState(4, { startMode: "classic", difficulty }), "Moretti");
    return {
      ...base,
      turn,
      influence: 120,
      money: 1_000,
      dirtyMoney: 0,
      rivalInfluence: every(100),
      rivalTreasury: every(50_000),
      ...over,
    };
  }

  it("asks the player for two more weeks on a streak, and no more of a rival", () => {
    expect(playerWeeksNeeded(at("normal", 20))).toBe(6);
    expect(playerWeeksNeeded(at("easy", 20))).toBe(6);
    const hard = at("hard", 20);
    expect(playerWeeksNeeded(hard)).toBe(6 + HARD_PLAYER_EXTRA);
    expect(weeksNeeded(hard, "Moretti")).toBe(8);
    expect(weeksNeeded(hard, "Valenti")).toBe(6);

    const ahead = (state: GameState, held: number): GameState => ({
      ...state,
      influence: 220,
      rivalInfluence: every(40),
      victory: { ...state.victory, influenceLeadTurns: held },
    });
    expect(checkVictory(ahead(at("normal", 20), 5)).won).toBe(true);
    const sixth = checkVictory(ahead(hard, 5));
    expect(sixth.won).toBe(false);
    expect(sixth.influenceLeadTurns).toBe(6);
    const eighth = checkVictory(ahead(hard, 7));
    expect(eighth.won).toBe(true);
    expect(eighth.reason).toContain("8 weeks");
    expect(raceStatus(ahead(hard, 5)).tracks.every((t) => t.need === 8)).toBe(true);
  });

  it("sees the summit coming in the last quarter, on Hard only", () => {
    expect(summitWatchWeeks(at("hard", 1))).toBe(12);
    expect(summitWatchWeeks(at("normal", 1))).toBe(0);
    expect(summitWatchWeeks(at("easy", 1))).toBe(0);

    expect(summitThreats(at("hard", 37))).toEqual([]);
    expect(summitThreats(at("normal", 44))).toEqual([]);
    expect(summitThreats(at("hard", 38))).toEqual([{ track: "influence", weeksLeft: 12, window: 12, leading: true, pressure: 1 }]);
    expect(summitThreats(at("hard", 50))[0]?.pressure).toBeCloseTo(2.5);

    // Within ten percent but not clear of the next family: seen, and weighed less.
    const close = summitThreats(at("hard", 38, { influence: 105 }));
    expect(close).toHaveLength(1);
    expect(close[0]?.leading).toBe(false);
    expect(close[0]?.pressure).toBeCloseTo(0.6);
    // Trailing on both: nothing to stop.
    expect(summitThreats(at("hard", 44, { influence: 80 }))).toEqual([]);
    // Both claims, the wider lead first. Rivals count the pile, not how clean it is.
    const both = summitThreats(at("hard", 44, { money: 0, dirtyMoney: 200_000 }));
    expect(both.map((t) => t.track)).toEqual(["wealth", "influence"]);
  });

  it("turns the families on whoever the summit would name, split across his claims", () => {
    const hard = at("hard", 44);
    expect(runaways(hard).some((r) => r.family === "Moretti")).toBe(false);
    const lead = cityLeader(hard, "Ferraro");
    expect(lead?.leader).toBe("Moretti");
    expect(lead?.track).toBe("influence");
    expect(lead?.live).toBe(true);
    expect(lead?.critical).toBe(true);
    expect(lead?.why).toMatch(/summit/);
    expect(cityLeader(at("hard", 39), "Ferraro")?.critical).toBe(false);
    expect(cityLeader(at("normal", 44), "Ferraro")?.leader).not.toBe("Moretti");
    expect(cityLeader(at("hard", 30), "Ferraro")?.leader).not.toBe("Moretti");

    const rich = at("hard", 44, { money: 100_000 });
    const tracks = new Set(rivals.map((f) => cityLeader(rich, f)?.track));
    expect(tracks).toEqual(new Set(["influence", "wealth"]));

    // Half the window gone: it beats the family's own plans.
    const chosen = chooseGoal(hard, "Ferraro");
    expect(chosen.goal?.kind).toBe("contain_leader");
    expect(chosen.goal?.target).toBe("Moretti");
  });

  it("buys more dinners as the summit nears, and says so once", () => {
    const containing = goal({ kind: "contain_leader", target: "Moretti", track: "influence" });
    const court = (state: GameState) => candidateActions(state, "Ferraro", containing).find((a) => a.kind === "court");
    const normal = court(at("normal", 44));
    const hard = court(at("hard", 44));
    expect(normal).toBeTruthy();
    expect(hard!.score).toBeGreaterThan(normal!.score * 1.5);
    expect(hard!.reasons).toContain("the summit is close");

    const week = runAiTurn(at("hard", 44), "Ferraro", createRng(3));
    const line = week.logs.find((l) => l.id === "log_summit_watch_Ferraro_44");
    expect(line?.text).toMatch(/6 left/);
    expect(line?.text).toMatch(/keep your name off it/);
    const next = runAiTurn({ ...week.state, turn: 45 }, "Ferraro", createRng(4));
    expect(next.logs.some((l) => l.id.startsWith("log_summit_watch_"))).toBe(false);
    expect(runAiTurn(at("normal", 44), "Ferraro", createRng(3)).logs.some((l) => l.id.startsWith("log_summit_watch_"))).toBe(false);
  });
});

describe("Easy", () => {
  const rivals = ["Valenti", "Ferraro", "Salvati", "Rinaldi"] as FamilyName[];
  const every = (n: number) => Object.fromEntries(rivals.map((f) => [f, n])) as Record<FamilyName, number>;

  /** Every rival at 100 standing and $50,000; the player trails on both unless told otherwise. */
  function at(difficulty: GameState["settings"]["difficulty"], turn: number, over: Partial<GameState> = {}): GameState {
    const base = startGame(buildInitialState(4, { startMode: "classic", difficulty }), "Moretti");
    return {
      ...base,
      turn,
      influence: 60,
      money: 1_000,
      dirtyMoney: 0,
      rivalInfluence: every(100),
      rivalTreasury: every(50_000),
      ...over,
    };
  }

  it("names whoever is first at the summit, with no margin", () => {
    expect(summitRatio(at("easy", 50))).toBe(EASY_SUMMIT_RATIO);
    expect(summitRatio(at("normal", 50))).toBe(1.1);
    expect(summitRatio(at("hard", 50))).toBe(1.1);

    // Five clear on standing: first, but not ten percent clear.
    const ahead = { influence: 105 };
    const easy = checkVictory(at("easy", 50, ahead));
    expect(easy.won).toBe(true);
    expect(easy.reason).toMatch(/names you first in standing/);
    expect(checkVictory(at("normal", 50, ahead)).lost).toBe(true);
    expect(raceStatus(at("easy", 49, ahead)).namedToday).toBe("Moretti on standing");
    expect(raceStatus(at("normal", 49, ahead)).namedToday).toBe("too close to call");

    // Level counts as first. One behind does not.
    expect(checkVictory(at("easy", 50, { influence: 100 })).won).toBe(true);
    expect(checkVictory(at("easy", 50, { influence: 99 })).lost).toBe(true);
  });

  it("asks for a fifth of the pile clean, not thirty-five percent", () => {
    expect(cleanShareNeeded(at("easy", 20))).toBe(EASY_CLEAN_SHARE);
    expect(cleanShareNeeded(at("normal", 20))).toBe(CLEAN_SHARE);
    expect(cleanShareNeeded(at("hard", 20))).toBe(CLEAN_SHARE);

    // A quarter clean: $25,000 clean, $75,000 dirty. Worth $66,250 against $50,000.
    const quarter = { money: 25_000, dirtyMoney: 75_000 };
    expect(cleanShareOk(at("easy", 50, quarter))).toBe(true);
    expect(cleanShareOk(at("normal", 50, quarter))).toBe(false);
    const easy = checkVictory(at("easy", 50, quarter));
    expect(easy.won).toBe(true);
    expect(easy.reason).toMatch(/names you first in wealth/);
    expect(checkVictory(at("normal", 50, quarter)).lost).toBe(true);
    // Under a fifth clean is still too dirty on Easy.
    expect(checkVictory(at("easy", 50, { money: 15_000, dirtyMoney: 85_000 })).lost).toBe(true);

    // The same gate on the streak.
    const pile = { money: 100_000, dirtyMoney: 300_000, rivalTreasury: every(10_000) };
    expect(clearsBar(at("easy", 20, pile), "Moretti", "wealth")).toBe(true);
    expect(clearsBar(at("normal", 20, pile), "Moretti", "wealth")).toBe(false);
    const short = raceStatus(at("easy", 20, { money: 10_000, dirtyMoney: 90_000 })).tracks.find((t) => t.track === "wealth");
    expect(short?.missing).toBe("clean share 10% of 20%");
  });
});

describe("a broken streak", () => {
  it("writes a line when a clock falls back to zero", () => {
    const before = game().victory;
    const after = {
      ...before,
      influenceLeadTurns: 0,
      rivalLeadTurns: { Valenti: { influence: 0, wealth: 0, turf: 0 } },
    };
    const prior = { ...before, influenceLeadTurns: 2, rivalLeadTurns: { Valenti: { influence: 0, wealth: 3, turf: 0 } } };
    const broken = streakBreaks(prior, after, "Moretti");
    expect(broken.map((b) => b.family).sort()).toEqual(["Moretti", "Valenti"]);
    expect(streakBreakLine("Moretti", "influence", 2, "Moretti")).toMatch(/Your run on standing/);
    expect(streakBreakLine("Valenti", "wealth", 3, "Moretti")).toMatch(/Valenti's run on wealth/);
  });
});
