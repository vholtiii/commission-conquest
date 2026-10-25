import { describe, expect, it } from "vitest";
import type { GameEvent, GameState, Racket } from "@/types/game";
import { buildInitialState, startGame } from "@/engine/initialState";
import {
  EVENT_TEMPLATES,
  FOLLOWUP_TEMPLATES,
  applyEventChoice,
  buildEvent,
  drawFollowUp,
  type EventTemplate,
} from "@/engine/events";
import { modifierProduct, modifierSum } from "@/engine/eventModifiers";
import { endTurn } from "@/engine/turnPipeline";
import { createRng } from "@/engine/rng";
import { ALL_FAMILY_NAMES } from "@/data/families";

const RAT = new Set(["informant_rumor", "federal_informant"]);

function racket(id: string, territoryId: string, type: Racket["type"], stock: number): Racket {
  return { id, territoryId, type, level: 2, managerId: null, stock, heatGen: 1, upgradeCost: 500 };
}

/** A started game with a speakeasy, a warehouse, crates on the way, a capo and some heat. */
function richState(seed = 11): GameState {
  const game = startGame(buildInitialState(seed), "Moretti");
  const player = game.playerFamily!;
  const home = game.territories.find((t) => t.owner === player)!;
  const territories = game.territories.map((t) =>
    t.id === home.id
      ? {
          ...t,
          rackets: [
            ...t.rackets,
            racket("evt_speak", t.id, "speakeasy", 30),
            racket("evt_ware", t.id, "warehouse", 60),
          ],
        }
      : t,
  );
  let promoted = false;
  const crew = game.crew.map((c) => {
    if (!promoted && c.family === player && c.role === "soldier" && c.status === "active") {
      promoted = true;
      return { ...c, role: "capo" as const };
    }
    return c;
  });
  return {
    ...game,
    turn: 8,
    territories,
    crew,
    heat: { ...game.heat, level: 50 },
    money: 5000,
    dirtyMoney: 5000,
    pendingShipments: [
      { id: "ship_t", crates: 20, destTerritoryId: home.id, arriveTurn: 10, cost: 0 },
    ],
  };
}

/** Everything a choice could touch, without logs or the card itself. */
function footprint(s: GameState): string {
  return JSON.stringify({
    money: s.money,
    dirty: s.dirtyMoney,
    heat: s.heat.level,
    rep: s.reputation,
    rel: s.relations,
    crew: s.crew.map((c) => [c.id, c.status, c.loyalty, c.wanted, c.family]),
    terr: s.territories.map((t) => [t.id, t.heatLevel, t.rackets.map((r) => [r.id, r.stock, r.frozenUntil])]),
    deals: s.deals,
    mods: s.eventModifiers,
    fus: s.pendingFollowUps,
    ships: s.pendingShipments,
    treasury: s.rivalTreasury,
  });
}

function deal(template: EventTemplate, state: GameState, seed: number): GameEvent {
  const rival = ALL_FAMILY_NAMES.find((f) => f !== state.playerFamily)!;
  const isFollow = FOLLOWUP_TEMPLATES.includes(template);
  const ctx = isFollow
    ? { family: rival, territoryId: state.territories.find((t) => t.owner === state.playerFamily)!.id }
    : undefined;
  const event = buildEvent(template, state, createRng(seed), ctx);
  if (!event) throw new Error(`${template.id} could not be dealt`);
  return event;
}

describe("event choices", () => {
  const templates = [...EVENT_TEMPLATES.filter((t) => !RAT.has(t.id)), ...FOLLOWUP_TEMPLATES];

  for (const template of templates) {
    it(`${template.id}: every choice changes the game`, () => {
      for (const seed of [1, 2, 3]) {
        const state = richState(seed);
        const event = deal(template, state, seed);
        const withCard = { ...state, activeEvent: event, events: [...state.events, event] };
        for (const c of event.choices) {
          const next = applyEventChoice(withCard, event, c.id);
          expect(footprint(next), `${template.id}/${c.id} seed ${seed}`).not.toBe(footprint(withCard));
          expect(next.activeEvent).toBeNull();
        }
      }
    });
  }

  it("rolls the same gamble the same way from the same seed", () => {
    const state = richState(5);
    const heist = EVENT_TEMPLATES.find((t) => t.id === "lucky_heist")!;
    const event = deal(heist, state, 5);
    const a = applyEventChoice(state, event, "heist");
    const b = applyEventChoice(state, event, "heist");
    expect(footprint(a)).toBe(footprint(b));
    expect(a.turnLog.at(-1)?.text).toBe(b.turnLog.at(-1)?.text);
  });

  it("gambles go both ways across seeds", () => {
    const heist = EVENT_TEMPLATES.find((t) => t.id === "lucky_heist")!;
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const state = { ...richState(5), seed };
      const event = deal(heist, state, seed);
      outcomes.add(applyEventChoice(state, event, "heist").turnLog.at(-1)!.text);
    }
    expect(outcomes.size).toBe(2);
  });

  it("accepting a truce strikes a real deal", () => {
    const state = richState();
    const offer = EVENT_TEMPLATES.find((t) => t.id === "rival_offer")!;
    const event = deal(offer, state, 1);
    const next = applyEventChoice(state, event, "accept_truce");
    const truce = next.deals.find((d) => d.kind === "truce" && d.status === "active");
    expect(truce?.b).toBe(event.ctx?.family);
    expect(truce!.untilTurn! - state.turn).toBeGreaterThanOrEqual(4);
  });

  it("hiring the veteran adds a soldier", () => {
    const state = richState();
    const vet = EVENT_TEMPLATES.find((t) => t.id === "recruit_veteran")!;
    const event = deal(vet, state, 1);
    const next = applyEventChoice(state, event, "hire");
    const mine = (s: GameState) => s.crew.filter((c) => c.family === s.playerFamily).length;
    expect(mine(next)).toBe(mine(state) + 1);
    expect(next.money).toBe(state.money - 300);
  });

  it("sacrificing a capo puts one in jail", () => {
    const state = richState();
    const scandal = EVENT_TEMPLATES.find((t) => t.id === "political_scandal")!;
    const event = deal(scandal, state, 1);
    const next = applyEventChoice(state, event, "sacrifice");
    const jailed = next.crew.filter(
      (c) => c.family === state.playerFamily && c.status === "jailed" && c.role === "capo",
    );
    expect(jailed).toHaveLength(1);
  });

  it("buying guns raises hit odds for six weeks", () => {
    const state = richState();
    const guns = EVENT_TEMPLATES.find((t) => t.id === "black_market_guns")!;
    const next = applyEventChoice(state, deal(guns, state, 1), "buy_guns");
    expect(modifierSum(next, "hitOdds")).toBeCloseTo(0.08);
    expect(modifierSum({ ...next, turn: state.turn + 6 }, "hitOdds")).toBeCloseTo(0.08);
    expect(modifierSum({ ...next, turn: state.turn + 7 }, "hitOdds")).toBe(0);
  });
});

describe("lingering effects", () => {
  it("modifiers run out on their week and say so", () => {
    let state = richState();
    const shake = EVENT_TEMPLATES.find((t) => t.id === "police_shakedown")!;
    state = applyEventChoice(state, deal(shake, state, 1), "pay");
    expect(modifierProduct(state, "raidChance")).toBeCloseTo(0.6);
    for (let i = 0; i < 3; i++) {
      state = endTurn({ ...state, activeEvent: null });
      expect(modifierProduct(state, "raidChance")).toBeCloseTo(0.6);
    }
    state = endTurn({ ...state, activeEvent: null });
    expect(state.eventModifiers ?? []).toHaveLength(0);
    expect(state.turnLog.some((l) => l.text.includes("has run its course"))).toBe(true);
  });

  it("weekly heat modifiers move heat at the end of the week", () => {
    const base = { ...richState(), activeEvent: null };
    const hot: GameState = {
      ...base,
      eventModifiers: [{ id: "m", kind: "heatPerWeek", value: 5, untilTurn: base.turn + 5, label: "Test" }],
    };
    const rng = () => createRng(99);
    expect(endTurn(hot, rng()).heat.level).toBeGreaterThan(endTurn(base, rng()).heat.level);
  });

  it("a follow-up fires on its week, and only then", () => {
    const state = richState();
    const rival = ALL_FAMILY_NAMES.find((f) => f !== state.playerFamily)!;
    const pending = [{ templateId: "retaliation", dueTurn: state.turn + 1, chance: 1, ctx: { family: rival } }];
    const early = drawFollowUp({ ...state, pendingFollowUps: pending }, createRng(1));
    expect(early.event).toBeNull();
    expect(early.pending).toHaveLength(1);
    const due = drawFollowUp({ ...state, turn: state.turn + 1, pendingFollowUps: pending }, createRng(1));
    expect(due.event?.templateId).toBe("retaliation");
    expect(due.event?.description).toContain(rival);
    expect(due.pending).toHaveLength(0);
  });

  it("a choice queues its follow-up", () => {
    const state = richState();
    const gala = EVENT_TEMPLATES.find((t) => t.id === "charity_gala")!;
    const next = applyEventChoice(state, deal(gala, state, 1), "attend");
    expect(next.pendingFollowUps?.[0]).toMatchObject({ templateId: "alderman_favor", dueTurn: state.turn + 3 });
  });

  it("old saves without the new fields still play", () => {
    const state = richState();
    const { eventModifiers: _m, pendingFollowUps: _f, ...old } = state;
    const legacy = old as GameState;
    const church = EVENT_TEMPLATES.find((t) => t.id === "church_collection")!;
    const next = applyEventChoice(legacy, deal(church, legacy, 1), "refuse_church");
    expect(next.pendingFollowUps).toHaveLength(1);
    expect(() => endTurn({ ...legacy, activeEvent: null })).not.toThrow();
  });
});
