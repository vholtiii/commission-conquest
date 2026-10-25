import type {
  CrewMember,
  EventContext,
  EventEffects,
  FamilyName,
  GameEvent,
  GameEventChoice,
  GameState,
  PendingFollowUp,
  Racket,
  RacketType,
  Territory,
} from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { createRng, hashString } from "./rng";
import { DINNER_RAT_GRACE } from "./dinner";
import { hasWarehouse, totalCrates } from "./liquor";
import { applyRatEventChoice, ratRumorChoices } from "./ratAffair";
import { getRelation } from "./relations";
import { applyOutcome } from "./eventEffects";

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
  /** Extra gate for what the card needs to exist (a speakeasy, a rival). */
  eligible?: (state: GameState) => boolean;
  /** Who and where the card is about, fixed when it is drawn. Null: nothing fits. */
  context?: (state: GameState, rng: Rng) => EventContext | null;
  buildChoices: (
    state: GameState,
    rng: Rng,
    subject: RatSubject | undefined,
    ctx: EventContext,
  ) => GameEventChoice[];
  /** Names the man the event is about. Null when nobody fits. */
  subject?: (state: GameState, rng: Rng) => RatSubject | null;
  /** Description once the man is named. */
  blurb?: (name: string) => string;
  /** Description once the place or family is named. */
  describe?: (state: GameState, ctx: EventContext) => string;
}

export interface RatSubject {
  crewId: string;
  isRat: boolean;
}

/** A man in the family the whispers could be about, weighted toward the likely ones. */
function pickSuspect(state: GameState, rng: Rng): RatSubject | null {
  const player = state.playerFamily;
  if (!player) return null;
  const men = state.crew.filter(
    (c) => c.family === player && c.status === "active" && c.role !== "boss",
  );
  if (men.length === 0) return null;
  const weight = (c: CrewMember) =>
    1 +
    Math.max(0, (60 - c.loyalty) / 20) +
    c.wanted / 5 +
    (c.origin && c.origin !== c.family ? 2 : 0) +
    (c.jailedUntilTurn != null ? 1 : 0);
  const total = men.reduce((sum, c) => sum + weight(c), 0);
  let roll = rng.next() * total;
  let picked = men[0]!;
  for (const c of men) {
    roll -= weight(c);
    if (roll <= 0) {
      picked = c;
      break;
    }
  }
  return { crewId: picked.id, isRat: rng.chance(0.65) };
}

function suspectName(state: GameState, subject?: RatSubject): string {
  return state.crew.find((c) => c.id === subject?.crewId)?.name ?? "him";
}

function choice(id: string, text: string, effects: EventEffects): GameEventChoice {
  return { id, text, effects };
}

function playerStock(state: GameState): number {
  return totalCrates(state, state.playerFamily);
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

function owned(state: GameState): Territory[] {
  return state.territories.filter((t) => t.owner === state.playerFamily);
}

function liveRivals(state: GameState): FamilyName[] {
  const gone = new Set(state.defunctFamilies ?? []);
  return ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily && !gone.has(f));
}

function pickOne<T>(rng: Rng, xs: T[]): T | undefined {
  return xs.length ? xs[rng.int(0, xs.length - 1)] : undefined;
}

function pickRacket(
  state: GameState,
  rng: Rng,
  type?: RacketType,
): { territory: Territory; racket: Racket } | undefined {
  const all = owned(state).flatMap((territory) =>
    territory.rackets
      .filter((r) => !type || r.type === type)
      .map((racket) => ({ territory, racket })),
  );
  return pickOne(rng, all);
}

function racketCtx(state: GameState, rng: Rng, type?: RacketType): EventContext | null {
  const hit = pickRacket(state, rng, type);
  return hit ? { territoryId: hit.territory.id, racketId: hit.racket.id } : null;
}

function districtCtx(state: GameState, rng: Rng, pred?: (t: Territory) => boolean): EventContext | null {
  const mine = owned(state);
  const t = pickOne(rng, pred ? mine.filter(pred) : []) ?? pickOne(rng, mine);
  return t ? { territoryId: t.id } : null;
}

function rivalCtx(state: GameState, rng: Rng): EventContext | null {
  const family = pickOne(rng, liveRivals(state));
  return family ? { family } : null;
}

function placeName(state: GameState, ctx: EventContext, fallback = "the block"): string {
  return state.territories.find((t) => t.id === ctx.territoryId)?.name ?? fallback;
}

function racketHit(ctx: EventContext, action: "freeze" | "destroy", turns?: number): EventEffects["racket"] {
  return ctx.territoryId && ctx.racketId
    ? { territoryId: ctx.territoryId, racketId: ctx.racketId, action, turns }
    : undefined;
}

function districtMod(
  ctx: EventContext,
  value: number,
  weeks: number,
  label: string,
): EventEffects["modifier"] {
  return { kind: "income", value, weeks, label, territoryId: ctx.territoryId };
}

function clamp01(n: number, lo = 0.1, hi = 0.9): number {
  return Math.max(lo, Math.min(hi, n));
}

/* ------------------------------------------------------------------ */
/* The weekly cards                                                    */
/* ------------------------------------------------------------------ */

export const EVENT_TEMPLATES: EventTemplate[] = [
  {
    id: "prohibition_crackdown",
    title: "Prohibition Crackdown",
    description: "Governor announces a wave of liquor raids across the boroughs.",
    weight: 8,
    minHeat: 15,
    requiresLiquor: true,
    context: (state, rng) => racketCtx(state, rng, "speakeasy") ?? districtCtx(state, rng) ?? {},
    buildChoices: (state, _rng, _s, ctx) => {
      const stock = playerStock(state);
      const burn = Math.max(10, Math.ceil(stock * 0.25));
      const seize = Math.max(5, Math.ceil(stock * 0.25));
      return [
        choice("lay_low", `Lay low and burn ${burn} crates`, {
          heat: -8,
          dirtyMoney: -200,
          crates: -burn,
          modifier: { kind: "raidChance", value: 0.5, weeks: 3, label: "Lying low after the crackdown" },
        }),
        choice("bribe_raid", "Pay off precinct captains", {
          money: -500,
          heat: -15,
          modifier: { kind: "raidChance", value: 0.3, weeks: 4, label: "Precinct captains paid off" },
        }),
        choice("ignore", "Business as usual — risk seizures", {
          respect: 5,
          gamble: {
            odds: 0.5,
            success: { dirtyMoney: 300 },
            fail: {
              crates: -seize,
              heat: 10,
              jailMan: { pick: "manager" },
              territoryHeat: ctx.territoryId ? { territoryId: ctx.territoryId, delta: 4 } : undefined,
            },
            successText: "The raids hit other people's joints. The thirsty came to yours.",
            failText: `Dry agents kicked in the doors at ${placeName(state, ctx)}. Crates seized, a man taken.`,
          },
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
    context: (state, rng) => districtCtx(state, rng, (t) => t.feature === "docks") ?? {},
    buildChoices: (state, _rng, _s, ctx) => [
      choice("break_strike", "Send muscle to break the picket", {
        hint: "Could go wrong",
        gamble: {
          odds: 0.65,
          success: { fear: 10, heat: 6, money: 300 },
          fail: {
            heat: 10,
            shipmentDelay: 1,
            woundMan: { pick: "muscle" },
            modifier: { kind: "shipmentSpeed", value: 1, weeks: 2, label: "Docks backed up after the brawl" },
          },
          successText: "The picket broke. Your crates came off the boats on time.",
          failText: "The longshoremen fought back. A man of yours is laid up and the docks are snarled.",
        },
      }),
      choice("negotiate", "Negotiate a side deal", {
        money: -400,
        respect: 8,
        modifier: districtMod(ctx, 0.1, 4, `Union goodwill in ${placeName(state, ctx, "the docks")}`),
        followUp: { templateId: "union_favor", inTurns: 3, chance: 0.8 },
        hint: "The union may remember it",
      }),
      choice("wait", "Wait it out — shipments delayed", {
        dirtyMoney: -150,
        shipmentDelay: 1,
        modifier: { kind: "shipmentSpeed", value: 1, weeks: 2, label: "Strike-slowed docks" },
      }),
    ],
  },
  {
    id: "rival_offer",
    title: "Backroom Offer",
    description: "A rival capo signals willingness to talk truce.",
    weight: 7,
    eligible: (state) => liveRivals(state).length > 0,
    context: rivalCtx,
    describe: (_s, ctx) => `A ${ctx.family} capo signals willingness to talk truce.`,
    buildChoices: (state, rng, _s, ctx) => {
      const target = ctx.family!;
      const rel = getRelation(state.relations, state.playerFamily!, target);
      const odds = clamp01(0.35 + rel / 200 + state.reputation.fear / 300);
      return [
        choice("accept_truce", `Accept a truce with the ${target}s`, {
          truce: { family: target, weeks: 4 + rng.int(0, 2) },
          relationDelta: { family: target, delta: 20 },
          respect: -5,
        }),
        choice("refuse", "Refuse — weakness invites knives", {
          fear: 5,
          respect: 5,
          relationDelta: { family: target, delta: -5 },
        }),
        choice("counter", "Counter with a tribute demand", {
          gamble: {
            odds,
            success: { money: 400, relationDelta: { family: target, delta: -5 } },
            fail: {
              relationDelta: { family: target, delta: -20 },
              followUp: { templateId: "retaliation", inTurns: 2, chance: 0.85, ctx: { family: target } },
            },
            successText: `The ${target}s paid up, grumbling.`,
            failText: `The ${target}s took the demand as an insult. Expect an answer.`,
          },
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
    subject: pickSuspect,
    blurb: (name) => `Whispers say ${name} is feeding tips to the bulls.`,
    buildChoices: (state, _rng, subject) => ratRumorChoices(suspectName(state, subject)),
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
        modifier: { kind: "heatPerWeek", value: -1, weeks: 5, label: "Friends at Tammany Hall" },
        followUp: { templateId: "alderman_favor", inTurns: 3, chance: 0.75 },
        hint: "An alderman may owe you",
      }),
      choice("send_rep", "Send a consigliere", {
        money: -300,
        respect: 5,
        modifier: { kind: "heatPerWeek", value: -1, weeks: 2, label: "A handshake at the gala" },
      }),
      choice("snub", "Snub the invitation", {
        fear: 3,
        respect: -5,
        followUp: { templateId: "tammany_cold", inTurns: 2, chance: 0.7 },
        hint: "City Hall may take it personally",
      }),
    ],
  },
  {
    id: "speakeasy_fire",
    title: "Speakeasy Fire",
    description: "A grease fire consumes one of your backroom joints.",
    weight: 6,
    requiresLiquor: true,
    eligible: (state) => owned(state).some((t) => t.rackets.some((r) => r.type === "speakeasy")),
    context: (state, rng) => racketCtx(state, rng, "speakeasy"),
    describe: (state, ctx) => `A grease fire tears through your joint in ${placeName(state, ctx)}.`,
    buildChoices: (state, _rng, _s, ctx) => {
      const racket = state.territories
        .find((t) => t.id === ctx.territoryId)
        ?.rackets.find((r) => r.id === ctx.racketId);
      const burn = Math.max(1, racket?.stock ?? 5);
      const name = placeName(state, ctx, "the joint");
      return [
        choice("rebuild", `Rebuild ${name} quietly (−${burn} crates, shut a week)`, {
          money: -600,
          dirtyMoney: -100,
          crates: -burn,
          racket: racketHit(ctx, "freeze", 1),
        }),
        choice("insurance", `Torch ${name} for insurance`, {
          money: 400,
          heat: 12,
          crates: -burn,
          racket: racketHit(ctx, "destroy"),
          gamble: {
            odds: 0.6,
            success: {},
            fail: { followUp: { templateId: "arson_inquiry", inTurns: 2, chance: 1 } },
            successText: "The adjuster signed off. Nobody asked questions.",
            failText: "The adjuster smelled kerosene. The fire marshal is taking an interest.",
          },
        }),
        choice("abandon", `Walk away from ${name}`, {
          respect: -5,
          crates: -burn,
          racket: racketHit(ctx, "destroy"),
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
      choice("bribe_editor", "Bribe the editor", {
        money: -700,
        heat: -10,
        followUp: { templateId: "reporter_returns", inTurns: 4, chance: 0.3 },
      }),
      choice("threaten", "Send a message to the reporter", {
        gamble: {
          odds: 0.55,
          success: { fear: 8, heat: 4 },
          fail: { fear: 4, heat: 25, followUp: { templateId: "front_page", inTurns: 1, chance: 1 } },
          successText: "The reporter took a long vacation upstate. The story died.",
          failText: "The reporter ran the threat on page one. Every cop in the city read it.",
        },
      }),
      choice("nothing", "Do nothing", {
        heat: 4,
        respect: -5,
        modifier: { kind: "heatPerWeek", value: 2, weeks: 3, label: "The papers are watching" },
      }),
    ],
  },
  {
    id: "import_shipment",
    title: "Canadian Shipment",
    description: "Quebec whisky is available cheap if you can move it fast.",
    weight: 8,
    eligible: (state) => owned(state).length > 0,
    context: (state, rng) => rivalCtx(state, rng) ?? {},
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("buy_big", "Buy big — 40 crates next week", {
        money: -500,
        gamble: {
          odds: 0.8,
          success: { shipment: { crates: 40, inTurns: 1 } },
          fail: { heat: 6 },
          successText: "The trucks cleared the border. Forty crates are rolling south.",
          failText: "Hijacked on the Albany road. The money's gone and the troopers are curious.",
        },
      }),
      choice("buy_small", "Take a small lot — 15 crates next week", {
        money: -200,
        shipment: { crates: 15, inTurns: 1 },
      }),
      choice(
        "pass",
        ctx.family ? `Pass — the ${ctx.family}s will take it` : "Pass on the deal",
        ctx.family ? { rival: { family: ctx.family, treasury: 500 } } : { respect: -2 },
      ),
    ],
  },
  {
    id: "hijacked_rival_truck",
    title: "Broken-Down Rival Truck",
    description: "A rival's truck broke down on your blocks — crates stacked in the alley.",
    weight: 7,
    requiresLiquor: true,
    eligible: (state) => liveRivals(state).length > 0,
    context: rivalCtx,
    describe: (_s, ctx) => `A ${ctx.family} truck broke down on your blocks — crates stacked in the alley.`,
    buildChoices: (_state, rng, _s, ctx) => {
      const target = ctx.family!;
      const haul = 20 + rng.int(0, 15);
      return [
        choice("take_it", `Take the ${haul} crates`, {
          crates: haul,
          heat: 6,
          relationDelta: { family: target, delta: -10 },
          followUp: { templateId: "want_it_back", inTurns: 2, chance: 0.7, ctx: { family: target, amount: haul } },
          hint: `The ${target}s will notice`,
        }),
        choice("ransom", "Ransom the cargo back", {
          dirtyMoney: 400,
          relationDelta: { family: target, delta: -5 },
        }),
        choice("let_it_go", "Let it go", {
          respect: -3,
          relationDelta: { family: target, delta: 8 },
        }),
      ];
    },
  },
  {
    id: "bad_batch",
    title: "Bad Batch",
    description: "A still turned out wood alcohol — poison if it hits the streets.",
    weight: 7,
    requiresLiquor: true,
    context: (state, rng) => racketCtx(state, rng, "speakeasy") ?? districtCtx(state, rng) ?? {},
    buildChoices: (state) => {
      const stock = playerStock(state);
      const dump = Math.max(1, Math.ceil(stock * 0.15));
      const cut = Math.max(1, Math.ceil(stock * 0.05));
      return [
        choice("dump_it", `Dump ${dump} crates of the batch`, {
          crates: -dump,
          dirtyMoney: -100,
          respect: 2,
        }),
        choice("sell_anyway", "Sell it anyway — damn the consequences", {
          dirtyMoney: 600,
          heat: 4,
          gamble: {
            odds: 0.5,
            success: {},
            fail: { heat: 6, followUp: { templateId: "poisonings", inTurns: 1, chance: 1 } },
            successText: "Nobody went blind. This time.",
            failText: "Men are turning up in the emergency ward. The batch is being traced.",
          },
        }),
        choice("cut_it", `Cut it thin (−${cut} crates)`, {
          crates: -cut,
          dirtyMoney: 200,
          heat: 4,
          modifier: { kind: "income", value: -0.1, weeks: 2, label: "Word's out the hooch is thin" },
        }),
      ];
    },
  },
  {
    id: "police_shakedown",
    title: "Precinct Shakedown",
    description: "Beat cops demand weekly tribute on your blocks.",
    weight: 10,
    context: (state, rng) => racketCtx(state, rng) ?? {},
    buildChoices: (state, _rng, _s, ctx) => [
      choice("pay", "Pay the tribute", {
        money: -350,
        heat: -5,
        modifier: { kind: "raidChance", value: 0.6, weeks: 3, label: "Beat cops on the payroll" },
      }),
      choice("refuse_pay", "Refuse and beef up lookouts", {
        fear: 5,
        heat: 6,
        gamble: {
          odds: 0.5,
          success: { respect: 3 },
          fail: { heat: 6, racket: racketHit(ctx, "freeze", 2) },
          successText: "The cops grumbled and moved on to easier marks.",
          failText: `The precinct raided ${placeName(state, ctx, "one of your joints")} to make a point.`,
        },
      }),
      choice("bribe_captain", "Go over their heads", {
        money: -600,
        heat: -12,
        modifier: { kind: "heatPerWeek", value: -2, weeks: 4, label: "A captain in your pocket" },
      }),
    ],
  },
  {
    id: "family_feast",
    title: "San Gennaro Feast",
    description: "The feast draws crowds — and opportunities — to Little Italy.",
    weight: 5,
    eligible: (state) => owned(state).length > 0,
    context: (state, rng) => districtCtx(state, rng),
    buildChoices: (state, _rng, _s, ctx) => [
      choice("run_games", "Run rigged carnival games", {
        gamble: {
          odds: 0.7,
          success: { dirtyMoney: 500, heat: 3 },
          fail: { heat: 10, respect: -5, wantedMan: { pick: "any", delta: 2 } },
          successText: "The marks lined up all week. The wheel never stopped on red.",
          failText: "A cop's nephew lost his paycheck at your wheel. Now there's a complaint with a name on it.",
        },
      }),
      choice("protection", `Sell protection to vendors in ${placeName(state, ctx)}`, {
        money: 300,
        fear: 5,
        modifier: districtMod(ctx, 0.15, 3, `Feast vendors paying in ${placeName(state, ctx)}`),
      }),
      choice("stay_away", "Keep a low profile", { heat: -3, crewLoyalty: 3 }),
    ],
  },
  {
    id: "boss_summons",
    title: "Commission Summons",
    description: "The commission wants words about recent violence.",
    weight: 6,
    requiresWar: true,
    context: (state, rng) => {
      const player = state.playerFamily!;
      const enemies = liveRivals(state).filter((f) => getRelation(state.relations, player, f) <= -60);
      const family = pickOne(rng, enemies) ?? pickOne(rng, liveRivals(state));
      return family ? { family } : null;
    },
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("apologize", "Apologize and pay restitution", {
        money: -1000,
        respect: 10,
        heat: -8,
        relations: [{ family: "allRivals", delta: 10 }],
      }),
      choice("deflect", `Blame the ${ctx.family} family`, {
        fear: 5,
        heat: 5,
        relations: [
          { family: "allRivals", delta: 5 },
          { family: ctx.family!, delta: -20 },
        ],
      }),
      choice("no_show", "Don't show up", {
        respect: -15,
        fear: 10,
        relations: [{ family: "allRivals", delta: -10 }],
        followUp: { templateId: "commission_sanction", inTurns: 2, chance: 0.8 },
        hint: "The Commission doesn't forget",
      }),
    ],
  },
  {
    id: "recruit_veteran",
    title: "War Veteran",
    description: "A discharged Great War vet seeks work — says he can handle a Thompson.",
    weight: 7,
    context: (state, rng) => rivalCtx(state, rng) ?? {},
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("hire", "Bring him into the crew", {
        money: -300,
        recruit: { role: "soldier", bias: "muscle" },
      }),
      choice("trial", "Give him a trial run", {
        dirtyMoney: 150,
        gamble: {
          odds: 0.6,
          success: { recruit: { role: "soldier", bias: "muscle" } },
          fail: { heat: 6 },
          successText: "He handled the job clean. He's one of yours now, and he came cheap.",
          failText: "He botched the job and walked. The cops want a word about it.",
        },
      }),
      choice(
        "reject",
        ctx.family ? `Turn him away — the ${ctx.family}s are hiring` : "Turn him away",
        ctx.family ? { rivalRecruit: { family: ctx.family, role: "soldier", bias: "muscle" } } : { respect: -2 },
      ),
    ],
  },
  {
    id: "bank_run",
    title: "Bank Run Rumors",
    description: "Panicked depositors line up outside a partner bank.",
    weight: 4,
    buildChoices: () => [
      choice("withdraw", "Withdraw funds early", {
        money: 500,
        respect: -3,
        modifier: { kind: "income", value: -0.05, weeks: 2, label: "Washing through a shaky bank" },
      }),
      choice("support", "Support the bank quietly", {
        money: -400,
        respect: 10,
        followUp: { templateId: "grateful_banker", inTurns: 3, chance: 0.7 },
        hint: "The banker may remember",
      }),
      choice("ignore_bank", "Not your problem", {
        respect: -2,
        gamble: {
          odds: 0.6,
          success: {},
          fail: { moneyLossFrac: 0.1 },
          successText: "The bank held. Your money's where you left it.",
          failText: "The bank went under with a slice of your clean money inside.",
        },
      }),
    ],
  },
  {
    id: "black_market_guns",
    title: "Gun Smuggler",
    description: "A Navy deserter offers a crate of pistols and chopper parts.",
    weight: 6,
    buildChoices: () => [
      choice("buy_guns", "Buy the lot", {
        money: -450,
        fear: 8,
        modifier: { kind: "hitOdds", value: 0.08, weeks: 6, label: "Navy pistols and chopper parts" },
      }),
      choice("sample", "Buy a few pieces", {
        money: -150,
        fear: 3,
        modifier: { kind: "hitOdds", value: 0.03, weeks: 4, label: "A few clean pieces" },
      }),
      choice("tip_off", "Tip off the cops anonymously", {
        heat: -10,
        respect: -8,
        crewLoyalty: -5,
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
      choice("deny", "Deny everything", {
        respect: -5,
        gamble: {
          odds: 0.5,
          success: { heat: -3 },
          fail: { heat: 15 },
          successText: "The alderman kept his mouth shut. The story died with him.",
          failText: "The alderman talked. The DA has your name in his notebook.",
        },
      }),
      choice("lawyer_up", "Retain lawyers", { money: -800, heat: -8 }),
      choice("sacrifice", "Sacrifice a capo as fall guy", {
        heat: -15,
        jailMan: { pick: "capo" },
        crewLoyalty: -8,
      }),
    ],
  },
  {
    id: "harlem_numbers",
    title: "Numbers Racket Dispute",
    description: "Harlem operators claim you're crossing into their policy territory.",
    weight: 6,
    eligible: (state) => owned(state).length > 0,
    context: (state, rng) =>
      districtCtx(state, rng, (t) =>
        t.adjacentTerritories.some(
          (id) => state.territories.find((x) => x.id === id)?.owner !== state.playerFamily,
        ),
      ),
    describe: (state, ctx) =>
      `Harlem operators claim you're running numbers on their side of ${placeName(state, ctx)}.`,
    buildChoices: (state, _rng, _s, ctx) => {
      const name = placeName(state, ctx);
      return [
        choice("share", "Offer a cut", {
          dirtyMoney: -200,
          respect: 5,
          modifier: districtMod(ctx, -0.1, 4, `Harlem's cut of ${name}`),
        }),
        choice("fight", "Fight for the territory", {
          gamble: {
            odds: 0.55,
            success: { fear: 10, heat: 6, modifier: districtMod(ctx, 0.1, 4, `Policy runners in ${name}`) },
            fail: { heat: 10, woundMan: { pick: "muscle" } },
            successText: `The Harlem runners backed off. ${name}'s policy slips are yours.`,
            failText: "The Harlem crews were ready. One of yours took a beating.",
          },
        }),
        choice("withdraw", "Withdraw from the block", {
          respect: -5,
          heat: -5,
          modifier: districtMod(ctx, -0.2, 4, `Pulled out of the numbers in ${name}`),
        }),
      ];
    },
  },
  {
    id: "winter_shortage",
    title: "Winter Coal Shortage",
    description: "Freezing tenements — extortion or charity wins hearts?",
    weight: 5,
    minTurn: 5,
    context: (state, rng) => districtCtx(state, rng) ?? {},
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("extort_coal", "Sell coal at a markup", {
        dirtyMoney: 350,
        fear: 5,
        territoryHeat: ctx.territoryId ? { territoryId: ctx.territoryId, delta: 3 } : undefined,
      }),
      choice("donate", "Donate coal for goodwill", {
        money: -400,
        respect: 12,
        modifier: { kind: "recruitQuality", value: 1, weeks: 4, label: "The tenements remember the coal" },
      }),
      choice("ignore_winter", "Ignore the crisis", {
        respect: -8,
        modifier: { kind: "recruitQuality", value: -1, weeks: 4, label: "Cold shoulder from the tenements" },
      }),
    ],
  },
  {
    id: "federal_informant",
    title: "Federal Informant",
    description: "Word is a made man is wearing a wire for the Bureau.",
    weight: 8,
    minHeat: 50,
    subject: pickSuspect,
    blurb: (name) => `Word is ${name} is wearing a wire for the Bureau.`,
    buildChoices: (state, _rng, subject) => ratRumorChoices(suspectName(state, subject)),
  },
  {
    id: "lucky_heist",
    title: "Armored Payroll",
    description: "A tipster claims a factory payroll moves Friday with light guard.",
    weight: 5,
    context: (state, rng) => rivalCtx(state, rng) ?? {},
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("heist", "Organize the heist", {
        gamble: {
          odds: 0.6,
          success: { dirtyMoney: 1200, heat: 18, fear: 10 },
          fail: { heat: 25, fear: 3, jailMan: { pick: "muscle" } },
          successText: "The payroll truck never made it to the factory. $1,200 in the bag.",
          failText: "The guards were Pinkertons. Your best gun is in a cell.",
        },
      }),
      choice(
        "sell_tip",
        ctx.family ? `Sell the tip to the ${ctx.family}s` : "Sell the tip",
        ctx.family ? { money: 400, relationDelta: { family: ctx.family, delta: 10 } } : { money: 400 },
      ),
      choice(
        "pass_heist",
        "Too risky — pass",
        ctx.family ? { rival: { family: ctx.family, treasury: 1000 } } : { heat: -2 },
      ),
    ],
  },
  {
    id: "church_collection",
    title: "Church Collection",
    description: "The parish priest asks for a 'donation' to look the other way.",
    weight: 6,
    buildChoices: () => [
      choice("donate_church", "Donate generously", {
        money: -250,
        heat: -8,
        respect: 5,
        modifier: { kind: "heatPerWeek", value: -1, weeks: 3, label: "The parish looks the other way" },
      }),
      choice("small_donation", "Small donation", { money: -75, heat: -3 }),
      choice("refuse_church", "Refuse", {
        heat: 5,
        fear: 3,
        followUp: { templateId: "sermon", inTurns: 1, chance: 0.8 },
        hint: "Father may say something Sunday",
      }),
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Follow-ups: dealt only when an earlier choice set them in motion    */
/* ------------------------------------------------------------------ */

export const FOLLOWUP_TEMPLATES: EventTemplate[] = [
  {
    id: "union_favor",
    title: "Union Favor",
    description: "The longshoremen haven't forgotten your side deal. A boat's hold has whisky nobody counted.",
    weight: 1,
    buildChoices: () => [
      choice("take_crates", "Take 30 crates off the books", {
        money: -150,
        shipment: { crates: 30, inTurns: 1 },
      }),
      choice("bank_favor", "Keep the favor in your pocket", { respect: 3, crewLoyalty: 2 }),
    ],
  },
  {
    id: "retaliation",
    title: "Retaliation",
    description: "A rival family answers your insult.",
    weight: 1,
    describe: (_s, ctx) => `The ${ctx.family ?? "rival"} family answers your insult. Their men are on your block.`,
    buildChoices: (state, rng, _s, ctx) => {
      const target = ctx.family ?? pickOne(rng, liveRivals(state));
      const racket = pickRacket(state, rng);
      const hit = racket ? { territoryId: racket.territory.id, racketId: racket.racket.id } : {};
      return [
        choice("pay_off", "Pay them to go away", {
          money: -600,
          relationDelta: target ? { family: target, delta: 10 } : undefined,
        }),
        choice("stand_firm", "Stand your ground", {
          fear: 5,
          racket: racketHit(hit, "freeze", 2),
          woundMan: { pick: "any" },
        }),
        choice("hit_back", "Hit back harder", {
          gamble: {
            odds: 0.5,
            success: { fear: 10, relationDelta: target ? { family: target, delta: -10 } : undefined },
            fail: { heat: 10, woundMan: { pick: "muscle" } },
            successText: "Your men got there first. The street saw who runs it.",
            failText: "They were waiting for you. One of yours is in the hospital.",
          },
        }),
      ];
    },
  },
  {
    id: "alderman_favor",
    title: "Alderman's Favor",
    description: "The alderman you met at the gala wants to return the kindness.",
    weight: 1,
    buildChoices: (state) => {
      const inside = state.crew.some(
        (c) => c.family === state.playerFamily && c.status === "jailed" && c.role !== "boss",
      );
      return [
        choice("spring", inside ? "Get one of our men out of the Tombs" : "Have him lose a file", {
          releaseMan: true,
          heat: inside ? 0 : -5,
        }),
        choice("cool_heat", "Have him call off the precincts", {
          heat: -10,
          modifier: { kind: "raidChance", value: 0.7, weeks: 3, label: "The alderman's word with the precincts" },
        }),
      ];
    },
  },
  {
    id: "tammany_cold",
    title: "Tammany Cold Shoulder",
    description: "City Hall remembers the snub. Inspectors are suddenly very thorough.",
    weight: 1,
    buildChoices: () => [
      choice("amends", "Make amends with a fat envelope", { money: -500, respect: 5 }),
      choice("ride_it", "Ride it out", {
        respect: -3,
        modifier: { kind: "heatPerWeek", value: 2, weeks: 4, label: "Tammany's inspectors" },
      }),
    ],
  },
  {
    id: "arson_inquiry",
    title: "Arson Inquiry",
    description: "The fire marshal is asking who bought kerosene the night your joint burned.",
    weight: 1,
    buildChoices: () => [
      choice("pay_marshal", "Pay the marshal", { money: -500, heat: -3 }),
      choice("let_ride", "Let it ride", { heat: 10, wantedMan: { pick: "any", delta: 3 } }),
    ],
  },
  {
    id: "reporter_returns",
    title: "Reporter Returns",
    description: "The reporter you paid off is back, and he wants more.",
    weight: 1,
    buildChoices: () => [
      choice("pay_again", "Pay him again", { money: -500, heat: -5 }),
      choice("scare", "Scare him off for good", {
        gamble: {
          odds: 0.5,
          success: { fear: 6 },
          fail: { heat: 20 },
          successText: "He moved to Chicago. No forwarding address.",
          failText: "He went straight to the DA with everything he had.",
        },
      }),
    ],
  },
  {
    id: "front_page",
    title: "Front Page",
    description: "Your family's name is above the fold. The public wants blood.",
    weight: 1,
    buildChoices: () => [
      choice("lawyers", "Put the lawyers on the paper", { money: -900, heat: -10 }),
      choice("lie_low", "Pull back until it blows over", {
        heat: -5,
        modifier: { kind: "income", value: -0.15, weeks: 3, label: "Lying low after the front page" },
      }),
    ],
  },
  {
    id: "want_it_back",
    title: "They Want It Back",
    description: "A rival family wants payment for the crates you took.",
    weight: 1,
    describe: (_s, ctx) =>
      `The ${ctx.family ?? "rival"} family wants payment for the ${ctx.amount ?? ""} crates you took.`.replace("  ", " "),
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("pay_back", "Pay for the crates", {
        money: -400,
        relationDelta: ctx.family ? { family: ctx.family, delta: 10 } : undefined,
      }),
      choice("refuse_back", "Tell them to go to hell", {
        fear: 5,
        relationDelta: ctx.family ? { family: ctx.family, delta: -15 } : undefined,
        gamble: {
          odds: 0.5,
          success: {},
          fail: { woundMan: { pick: "any" } },
          successText: "They grumbled and went home.",
          failText: "They jumped one of your men outside a cigar store.",
        },
      }),
    ],
  },
  {
    id: "poisonings",
    title: "Poisonings",
    description: "The bad batch hit the street. Men are blind in the hospital and the papers want a name.",
    weight: 1,
    buildChoices: (_state, _rng, _s, ctx) => [
      choice("pay_families", "Pay off the families quietly", { money: -800, respect: -5 }),
      choice("deny_batch", "Deny it was yours", {
        heat: 20,
        respect: -10,
        territoryHeat: ctx.territoryId ? { territoryId: ctx.territoryId, delta: 5 } : undefined,
      }),
    ],
  },
  {
    id: "commission_sanction",
    title: "Commission Sanction",
    description: "You didn't show for the Commission. Now they've named a price.",
    weight: 1,
    buildChoices: (state, rng) => {
      const racket = pickRacket(state, rng);
      const hit = racket ? { territoryId: racket.territory.id, racketId: racket.racket.id } : {};
      return [
        choice("pay_fine", "Pay the fine", { money: -1500, respect: 3 }),
        choice("refuse_fine", "Refuse", {
          relations: [{ family: "allRivals", delta: -10 }],
          racket: racketHit(hit, "freeze", 3),
          fear: 5,
        }),
      ];
    },
  },
  {
    id: "grateful_banker",
    title: "Grateful Banker",
    description: "The bank survived the run. The president hasn't forgotten who stood by him.",
    weight: 1,
    buildChoices: () => [
      choice("repay", "Take your money back with interest", { money: 700 }),
      choice("friend", "Keep him as a friend", {
        respect: 3,
        modifier: { kind: "income", value: 0.1, weeks: 4, label: "A friendly banker washing your money" },
      }),
    ],
  },
  {
    id: "sermon",
    title: "Sunday Sermon",
    description: "Father preached against the men who wouldn't give. Everybody knew who he meant.",
    weight: 1,
    buildChoices: () => [
      choice("make_amends", "Send the donation after all", { money: -300, respect: 3 }),
      choice("shrug", "Shrug it off", {
        respect: -6,
        modifier: { kind: "recruitQuality", value: -1, weeks: 3, label: "The parish turned its back" },
      }),
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

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
  if (t.eligible && !t.eligible(state)) return false;
  if (
    t.subject &&
    !state.crew.some((c) => c.family === state.playerFamily && c.status === "active" && c.role !== "boss")
  ) {
    return false;
  }
  if (
    (t.id === "informant_rumor" || t.id === "federal_informant") &&
    (state.ratAffair ||
      (state.lastDinnerTurn != null && state.turn < state.lastDinnerTurn + DINNER_RAT_GRACE))
  ) {
    return false;
  }
  return true;
}

/** Deal a card from a template, or null when what it needs is missing. */
export function buildEvent(
  template: EventTemplate,
  state: GameState,
  rng: Rng,
  ctxIn?: EventContext,
  idPrefix = "evt",
): GameEvent | null {
  const subject = template.subject?.(state, rng) ?? null;
  if (template.subject && !subject) return null;
  const ctx = ctxIn ?? (template.context ? template.context(state, rng) : {});
  if (!ctx) return null;
  const choices = template.buildChoices(state, rng, subject ?? undefined, ctx);
  const man = subject ? state.crew.find((c) => c.id === subject.crewId) : undefined;
  const description =
    man && template.blurb
      ? template.blurb(man.name)
      : template.describe
        ? template.describe(state, ctx)
        : template.description;
  return {
    id: `${idPrefix}_${template.id}_${state.turn}`,
    templateId: template.id,
    title: template.title,
    description,
    choices,
    isActive: true,
    subjectCrewId: subject?.crewId,
    subjectIsRat: subject?.isRat,
    ctx,
  };
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

  return buildEvent(picked, state, rng);
}

/**
 * The first due follow-up whose roll lands. Misses ahead of it are dropped;
 * anything behind it waits for a quieter week.
 */
export function drawFollowUp(
  state: GameState,
  rng: Rng,
): { event: GameEvent | null; pending: PendingFollowUp[] } {
  const pending = state.pendingFollowUps ?? [];
  if (state.activeEvent || !state.playerFamily || pending.length === 0) {
    return { event: null, pending };
  }
  const rest: PendingFollowUp[] = [];
  let event: GameEvent | null = null;
  for (const fu of pending) {
    if (event || fu.dueTurn > state.turn) {
      rest.push(fu);
      continue;
    }
    if (!rng.chance(fu.chance)) continue;
    const template = FOLLOWUP_TEMPLATES.find((t) => t.id === fu.templateId);
    if (!template) continue;
    event = buildEvent(template, state, rng, fu.ctx, "evt_fu");
  }
  return { event, pending: rest };
}

export function findTemplate(id: string): EventTemplate | undefined {
  return EVENT_TEMPLATES.find((t) => t.id === id) ?? FOLLOWUP_TEMPLATES.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

export function applyEventChoice(
  state: GameState,
  event: GameEvent,
  choiceId: string,
): GameState {
  const selected = event.choices.find((c) => c.id === choiceId);
  if (!selected) return state;

  const rat = applyRatEventChoice(
    state,
    event,
    choiceId,
    createRng(hashString(`${state.seed}:rat:${event.id}:${choiceId}:${state.turn}`)),
  );
  if (rat) return rat;

  const rng = createRng(hashString(`${state.seed}:evt:${event.id}:${choiceId}:${state.turn}`));
  const { gamble, hint: _hint, ...shared } = selected.effects;
  let next = applyOutcome(state, shared, rng, event);

  if (!shared.takeOut && event.subjectIsRat && event.subjectCrewId) {
    const spared = next.crew.find((c) => c.id === event.subjectCrewId);
    next = {
      ...next,
      ratLeakTurn: state.turn + 1,
      ratLeakCrewId: event.subjectCrewId,
      turnLog: [
        ...next.turnLog,
        {
          id: `log_rat_spared_${state.turn}`,
          turn: state.turn,
          category: "heat" as const,
          text: `You let ${spared?.name ?? "him"} be. If he really is talking, the law will hear more.`,
          family: state.playerFamily ?? undefined,
        },
      ],
    };
  }

  if (gamble) {
    const won = rng.chance(gamble.odds);
    next = applyOutcome(next, won ? gamble.success : gamble.fail, rng, event);
    next = {
      ...next,
      turnLog: [
        ...next.turnLog,
        {
          id: `log_evt_outcome_${event.id}_${choiceId}`,
          turn: state.turn,
          category: "event" as const,
          text: won ? gamble.successText : gamble.failText,
          family: state.playerFamily ?? undefined,
          territoryId: event.ctx?.territoryId,
          tone: won ? ("money" as const) : ("warning" as const),
        },
      ],
    };
  }

  return {
    ...next,
    activeEvent: null,
    events: [
      ...state.events.filter((e) => e.id !== event.id),
      { ...event, isActive: false },
    ],
  };
}
