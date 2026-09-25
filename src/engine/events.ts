import type { GameEvent, GameEventChoice, GameState, LiquorLedger } from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { createRng, hashString } from "./rng";
import {
  applyCrateEffect,
  emptyLiquorLedger,
  hasWarehouse,
  mergeLedger,
  totalCrates,
} from "./liquor";
import { jailInCrew } from "./jail";

export interface EventTemplate {
  id: string;
  title: string;
  description: string;
  weight: number;
  minHeat?: number;
  maxHeat?: number;
  minTurn?: number;
  requiresWar?: boolean;
  /** Only fire if player has crates or a warehouse. */
  requiresLiquor?: boolean;
  /** Only fire if player has pending whisky shipments. */
  requiresShipments?: boolean;
  buildChoices: (state: GameState, rng: Rng) => GameEventChoice[];
}

function choice(
  id: string,
  text: string,
  effects: GameEventChoice["effects"],
): GameEventChoice {
  return { id, text, effects };
}

function playerStock(state: GameState): number {
  return totalCrates(state, state.playerFamily);
}

export const EVENT_TEMPLATES: EventTemplate[] = [
  {
    id: "prohibition_crackdown",
    title: "Prohibition Crackdown",
    description: "Governor announces a wave of liquor raids across the boroughs.",
    weight: 8,
    minHeat: 15,
    requiresLiquor: true,
    buildChoices: (state) => {
      const stock = playerStock(state);
      const burn = Math.max(10, Math.ceil(stock * 0.25));
      const seize = Math.max(1, Math.ceil(stock * 0.1));
      return [
        choice("lay_low", `Lay low and burn ${burn} crates`, {
          heat: -8,
          dirtyMoney: -200,
          crates: -burn,
        }),
        choice("bribe_raid", "Pay off precinct captains", {
          money: -500,
          heat: -15,
        }),
        choice("ignore", "Business as usual — risk seizures", {
          heat: 10,
          respect: 5,
          crates: -seize,
        }),
      ];
    },
  },
  {
    id: "union_strike",
    title: "Dockworkers' Strike",
    description: "Longshoremen walk off the job — shipments are backing up.",
    weight: 6,
    minTurn: 3,
    requiresShipments: true,
    buildChoices: () => [
      choice("break_strike", "Send muscle to break the picket", {
        fear: 10,
        heat: 8,
        money: 300,
      }),
      choice("negotiate", "Negotiate a side deal", {
        money: -400,
        respect: 8,
      }),
      choice("wait", "Wait it out — shipments delayed", {
        dirtyMoney: -150,
        shipmentDelay: 1,
      }),
    ],
  },
  {
    id: "rival_offer",
    title: "Backroom Offer",
    description: "A rival capo signals willingness to talk truce.",
    weight: 7,
    buildChoices: (state, rng) => {
      const rivals = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
      const target = rng.pick(rivals);
      return [
        choice("accept_truce", "Accept a temporary truce", {
          relationDelta: { family: target, delta: 20 },
          respect: -5,
        }),
        choice("refuse", "Refuse — weakness invites knives", {
          fear: 5,
          respect: 5,
        }),
        choice("counter", "Counter with a tribute demand", {
          money: 400,
          relationDelta: { family: target, delta: -10 },
        }),
      ];
    },
  },
  {
    id: "informant_rumor",
    title: "Rat in the Ranks",
    description: "Whispers say someone in your crew is feeding tips to the bulls.",
    weight: 9,
    minHeat: 10,
    buildChoices: () => [
      choice("investigate", "Quiet investigation", { money: -200, loyalty: 5 }),
      choice("purge", "Purge suspected associates", {
        fear: 12,
        loyalty: -10,
        heat: 5,
      }),
      choice("ignore_rumor", "Ignore the rumor", { loyalty: -8 }),
    ],
  },
  {
    id: "charity_gala",
    title: "Society Gala",
    description: "You're invited to a Tammany fundraiser — rub elbows or stay away?",
    weight: 5,
    buildChoices: () => [
      choice("attend", "Attend and donate generously", {
        money: -800,
        respect: 15,
        heat: -5,
      }),
      choice("send_rep", "Send a consigliere", { money: -300, respect: 5 }),
      choice("snub", "Snub the invitation", { fear: 3, respect: -5 }),
    ],
  },
  {
    id: "speakeasy_fire",
    title: "Speakeasy Fire",
    description: "A grease fire consumes one of your backroom joints.",
    weight: 6,
    requiresLiquor: true,
    buildChoices: (state, rng) => {
      const speaks = state.territories.flatMap((t) =>
        t.owner === state.playerFamily
          ? t.rackets
              .filter((r) => r.type === "speakeasy")
              .map((r) => ({ territory: t, racket: r }))
          : [],
      );
      const pick =
        speaks.length > 0 ? speaks[rng.int(0, speaks.length - 1)]! : null;
      const burn = pick ? Math.max(1, pick.racket.stock) : 5;
      const name = pick?.territory.name ?? "a joint";
      return [
        choice("rebuild", `Rebuild ${name} quietly (−${burn} crates)`, {
          money: -600,
          dirtyMoney: -100,
          crates: -burn,
        }),
        choice("insurance", `Torch ${name} for insurance (−${burn} crates)`, {
          money: 400,
          heat: 12,
          crates: -burn,
        }),
        choice("abandon", `Walk away from ${name} (−${burn} crates)`, {
          respect: -3,
          crates: -burn,
        }),
      ];
    },
  },
  {
    id: "newspaper_expose",
    title: "Newspaper Exposé",
    description: "A muckraking reporter is digging into waterfront kickbacks.",
    weight: 7,
    minHeat: 20,
    buildChoices: () => [
      choice("bribe_editor", "Bribe the editor", { money: -700, heat: -10 }),
      choice("threaten", "Send a message to the reporter", {
        fear: 8,
        heat: 15,
      }),
      choice("nothing", "Do nothing", { heat: 8, respect: -5 }),
    ],
  },
  {
    id: "import_shipment",
    title: "Canadian Shipment",
    description: "Quebec whisky is available cheap if you can move it fast.",
    weight: 8,
    buildChoices: () => [
      choice("buy_big", "Buy big — fill warehouses (+40 crates)", {
        money: -500,
        crates: 40,
      }),
      choice("buy_small", "Take a small lot (+15 crates)", {
        money: -200,
        crates: 15,
      }),
      choice("pass", "Pass on the deal", {}),
    ],
  },
  {
    id: "hijacked_rival_truck",
    title: "Broken-Down Rival Truck",
    description:
      "A rival's truck broke down on your blocks — crates stacked in the alley.",
    weight: 7,
    requiresLiquor: true,
    buildChoices: (state, rng) => {
      const rivals = ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily);
      const target = rng.pick(rivals);
      const haul = 20 + rng.int(0, 15);
      return [
        choice("take_it", `Take the ${haul} crates`, {
          crates: haul,
          heat: 6,
          relationDelta: { family: target, delta: -10 },
        }),
        choice("ransom", "Ransom the cargo back", {
          dirtyMoney: 400,
          relationDelta: { family: target, delta: -5 },
        }),
        choice("let_it_go", "Let it go", { respect: -3 }),
      ];
    },
  },
  {
    id: "bad_batch",
    title: "Bad Batch",
    description:
      "A still turned out wood alcohol — poison if it hits the streets.",
    weight: 7,
    requiresLiquor: true,
    buildChoices: (state) => {
      const stock = playerStock(state);
      const dump = Math.max(1, Math.ceil(stock * 0.15));
      const cut = Math.max(1, Math.ceil(stock * 0.05));
      return [
        choice("dump_it", `Dump ${dump} crates of the batch`, {
          crates: -dump,
          dirtyMoney: -100,
        }),
        choice("sell_anyway", "Sell it anyway — damn the consequences", {
          dirtyMoney: 600,
          heat: 12,
          respect: -8,
        }),
        choice("cut_it", `Cut it thin (−${cut} crates)`, {
          crates: -cut,
          dirtyMoney: 200,
          heat: 4,
        }),
      ];
    },
  },
  {
    id: "police_shakedown",
    title: "Precinct Shakedown",
    description: "Beat cops demand weekly tribute on your blocks.",
    weight: 10,
    buildChoices: () => [
      choice("pay", "Pay the tribute", { money: -350, heat: -5 }),
      choice("refuse_pay", "Refuse and beef up lookouts", {
        heat: 10,
        fear: 5,
      }),
      choice("bribe_captain", "Go over their heads", {
        money: -600,
        heat: -12,
      }),
    ],
  },
  {
    id: "family_feast",
    title: "San Gennaro Feast",
    description: "The feast draws crowds — and opportunities — to Little Italy.",
    weight: 5,
    buildChoices: () => [
      choice("run_games", "Run rigged carnival games", {
        dirtyMoney: 400,
        heat: 4,
      }),
      choice("protection", "Sell protection to vendors", {
        money: 300,
        fear: 5,
      }),
      choice("stay_away", "Keep a low profile", { heat: -3 }),
    ],
  },
  {
    id: "boss_summons",
    title: "Commission Summons",
    description: "The commission wants words about recent violence.",
    weight: 6,
    requiresWar: true,
    buildChoices: () => [
      choice("apologize", "Apologize and pay restitution", {
        money: -1000,
        respect: 10,
        heat: -8,
      }),
      choice("deflect", "Blame a rival family", { fear: 5, heat: 5 }),
      choice("no_show", "Don't show up", { respect: -15, fear: 10 }),
    ],
  },
  {
    id: "recruit_veteran",
    title: "War Veteran",
    description:
      "A discharged Great War vet seeks work — says he can handle a Thompson.",
    weight: 7,
    buildChoices: () => [
      choice("hire", "Bring him into the crew", { money: -300, loyalty: 5 }),
      choice("trial", "Give him a trial run", { dirtyMoney: 150, heat: 3 }),
      choice("reject", "Turn him away", {}),
    ],
  },
  {
    id: "bank_run",
    title: "Bank Run Rumors",
    description: "Panicked depositors line up outside a partner bank.",
    weight: 4,
    buildChoices: () => [
      choice("withdraw", "Withdraw funds early", { money: 500, respect: -3 }),
      choice("support", "Support the bank quietly", {
        money: -400,
        respect: 10,
      }),
      choice("ignore_bank", "Not your problem", {}),
    ],
  },
  {
    id: "black_market_guns",
    title: "Gun Smuggler",
    description: "A Navy deserter offers a crate of pistols and chopper parts.",
    weight: 6,
    buildChoices: () => [
      choice("buy_guns", "Buy the lot", { money: -450, fear: 8 }),
      choice("sample", "Buy a few pieces", { money: -150, fear: 3 }),
      choice("tip_off", "Tip off the cops anonymously", {
        heat: -10,
        respect: -8,
      }),
    ],
  },
  {
    id: "political_scandal",
    title: "Political Scandal",
    description: "A Tammany alderman is caught with your envelope of cash.",
    weight: 5,
    minHeat: 25,
    buildChoices: () => [
      choice("deny", "Deny everything", { heat: 5, respect: -5 }),
      choice("lawyer_up", "Retain lawyers", { money: -800, heat: -8 }),
      choice("sacrifice", "Sacrifice a capo as fall guy", {
        loyalty: -12,
        heat: -15,
      }),
    ],
  },
  {
    id: "harlem_numbers",
    title: "Numbers Racket Dispute",
    description:
      "Harlem operators claim you're crossing into their policy territory.",
    weight: 6,
    buildChoices: () => [
      choice("share", "Offer a cut", { dirtyMoney: -200, respect: 5 }),
      choice("fight", "Fight for the territory", { fear: 10, heat: 10 }),
      choice("withdraw", "Withdraw from the block", {
        respect: -5,
        heat: -5,
      }),
    ],
  },
  {
    id: "winter_shortage",
    title: "Winter Coal Shortage",
    description: "Freezing tenements — extortion or charity wins hearts?",
    weight: 5,
    minTurn: 5,
    buildChoices: () => [
      choice("extort_coal", "Sell coal at a markup", {
        dirtyMoney: 350,
        fear: 5,
      }),
      choice("donate", "Donate coal for goodwill", {
        money: -400,
        respect: 12,
      }),
      choice("ignore_winter", "Ignore the crisis", { respect: -8 }),
    ],
  },
  {
    id: "federal_informant",
    title: "Federal Informant",
    description: "Word is a made man is wearing a wire for the Bureau.",
    weight: 8,
    minHeat: 50,
    buildChoices: () => [
      choice("silence", "Silence the rat permanently", {
        heat: 20,
        fear: 15,
        loyalty: 5,
      }),
      choice("relocate", "Relocate the suspect", { money: -300, heat: -5 }),
      choice("watch", "Watch and wait", { heat: 5, loyalty: -5 }),
    ],
  },
  {
    id: "lucky_heist",
    title: "Armored Payroll",
    description:
      "A tipster claims a factory payroll moves Friday with light guard.",
    weight: 5,
    buildChoices: () => [
      choice("heist", "Organize the heist", {
        dirtyMoney: 1200,
        heat: 18,
        fear: 10,
      }),
      choice("sell_tip", "Sell the tip to another family", { money: 400 }),
      choice("pass_heist", "Too risky — pass", {}),
    ],
  },
  {
    id: "church_collection",
    title: "Church Collection",
    description:
      "The parish priest asks for a 'donation' to look the other way.",
    weight: 6,
    buildChoices: () => [
      choice("donate_church", "Donate generously", {
        money: -250,
        heat: -8,
        respect: 5,
      }),
      choice("small_donation", "Small donation", { money: -75, heat: -3 }),
      choice("refuse_church", "Refuse", { heat: 5, fear: 3 }),
    ],
  },
];

function isAtWar(state: GameState): boolean {
  if (!state.playerFamily) return false;
  const player = state.playerFamily;
  return Object.entries(state.relations.scores).some(
    ([key, score]) => score <= -60 && key.split("|").includes(player),
  );
}

function playerHasLiquorInfra(state: GameState): boolean {
  if (!state.playerFamily) return false;
  if (playerStock(state) > 0) return true;
  return state.territories.some(
    (t) => t.owner === state.playerFamily && hasWarehouse(t, state.turn),
  );
}

function templateEligible(t: EventTemplate, state: GameState): boolean {
  if (t.minHeat !== undefined && state.heat.level < t.minHeat) return false;
  if (t.maxHeat !== undefined && state.heat.level > t.maxHeat) return false;
  if (t.minTurn !== undefined && state.turn < t.minTurn) return false;
  if (t.requiresWar && !isAtWar(state)) return false;
  if (t.requiresLiquor && !playerHasLiquorInfra(state)) return false;
  if (t.requiresShipments && (state.pendingShipments?.length ?? 0) === 0) {
    return false;
  }
  return true;
}

export function drawEvent(state: GameState, rng: Rng): GameEvent | null {
  if (state.activeEvent) return null;
  if (!state.playerFamily || !state.started) return null;

  const baseChance = 0.22 + state.heat.level / 500;
  if (!rng.chance(baseChance)) return null;

  const eligible = EVENT_TEMPLATES.filter((t) => templateEligible(t, state));
  if (eligible.length === 0) return null;

  const weighted = eligible.map((t) => ({
    t,
    w:
      t.weight *
      (t.id === "rival_offer" && state.reputation.fear >= 60 ? 1.5 : 1),
  }));
  const totalWeight = weighted.reduce((s, x) => s + x.w, 0);
  let roll = rng.next() * totalWeight;
  let picked = weighted[0]!.t;
  for (const item of weighted) {
    roll -= item.w;
    if (roll <= 0) {
      picked = item.t;
      break;
    }
  }

  const choices = picked.buildChoices(state, rng);
  return {
    id: `evt_${picked.id}_${state.turn}`,
    templateId: picked.id,
    title: picked.title,
    description: picked.description,
    choices,
    isActive: true,
  };
}

export function applyEventChoice(
  state: GameState,
  event: GameEvent,
  choiceId: string,
): GameState {
  const selected = event.choices.find((c) => c.id === choiceId);
  if (!selected) return state;

  const fx = selected.effects;
  let relations = state.relations;
  let crew = state.crew;

  if (fx.relationDelta && state.playerFamily) {
    const { family, delta } = fx.relationDelta;
    const key = [state.playerFamily, family].sort().join("|");
    const current = relations.scores[key] ?? 0;
    relations = {
      scores: {
        ...relations.scores,
        [key]: Math.max(-100, Math.min(100, current + delta)),
      },
    };
  }

  if (fx.crewStatus) {
    crew =
      fx.crewStatus.status === "jailed"
        ? jailInCrew(crew, fx.crewStatus.crewId, state.turn)
        : crew.map((c) =>
            c.id === fx.crewStatus!.crewId
              ? { ...c, status: fx.crewStatus!.status }
              : c,
          );
  }

  let territories = state.territories;
  let dirtyExtra = 0;
  let logs = state.turnLog;
  let ledger: LiquorLedger | null = state.liquorLedger;
  let pendingShipments = state.pendingShipments ?? [];

  if (fx.crates) {
    const rng = createRng(
      hashString(`${state.seed}:evt:${event.id}:${state.turn}`),
    );
    const crateFx = applyCrateEffect(state, fx.crates, rng);
    territories = crateFx.territories;
    dirtyExtra = crateFx.dirtyDelta;
    if (crateFx.log) {
      logs = [...logs, crateFx.log];
    }
    const base = ledger ?? emptyLiquorLedger();
    if (fx.crates > 0) {
      ledger = mergeLedger(base, {
        bought: crateFx.moved,
        cashIn: crateFx.dirtyDelta,
      });
    } else {
      ledger = mergeLedger(base, { dumped: crateFx.moved });
    }
  }

  if (fx.shipmentDelay && fx.shipmentDelay > 0 && pendingShipments.length > 0) {
    pendingShipments = pendingShipments.map((s) => ({
      ...s,
      arriveTurn: s.arriveTurn + fx.shipmentDelay!,
    }));
    logs = [
      ...logs,
      {
        id: `log_evt_delay_${state.turn}`,
        turn: state.turn,
        category: "event",
        text: `Event: shipments delayed ${fx.shipmentDelay} turn${fx.shipmentDelay === 1 ? "" : "s"}.`,
        family: state.playerFamily ?? undefined,
      },
    ];
  }

  if (fx.shipmentLoss && fx.shipmentLoss > 0 && pendingShipments.length > 0) {
    let lost = 0;
    pendingShipments = pendingShipments
      .map((s) => {
        const take = Math.ceil(s.crates * fx.shipmentLoss!);
        lost += take;
        return { ...s, crates: s.crates - take };
      })
      .filter((s) => s.crates > 0);
    const base = ledger ?? emptyLiquorLedger();
    ledger = mergeLedger(base, { seized: lost });
    logs = [
      ...logs,
      {
        id: `log_evt_shiploss_${state.turn}`,
        turn: state.turn,
        category: "event",
        text: `Event: ${lost} crates lost from in-flight shipments.`,
        family: state.playerFamily ?? undefined,
      },
    ];
  }

  return {
    ...state,
    territories,
    pendingShipments,
    money: state.money + (fx.money ?? 0),
    dirtyMoney: state.dirtyMoney + (fx.dirtyMoney ?? 0) + dirtyExtra,
    heat: {
      ...state.heat,
      level: Math.max(0, Math.min(100, state.heat.level + (fx.heat ?? 0))),
    },
    reputation: {
      ...state.reputation,
      respect: Math.max(
        0,
        Math.min(100, state.reputation.respect + (fx.respect ?? 0)),
      ),
      fear: Math.max(0, Math.min(100, state.reputation.fear + (fx.fear ?? 0))),
      loyalty: Math.max(
        0,
        Math.min(100, state.reputation.loyalty + (fx.loyalty ?? 0)),
      ),
    },
    relations,
    crew,
    turnLog: logs,
    liquorLedger: ledger,
    activeEvent: null,
    events: [
      ...state.events.filter((e) => e.id !== event.id),
      { ...event, isActive: false },
    ],
  };
}
