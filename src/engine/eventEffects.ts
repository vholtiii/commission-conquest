/**
 * What an event choice actually does to the family, the street and the other
 * families. `events.ts` holds the cards; this applies them.
 */
import type {
  CrewMember,
  CrewSkills,
  EventEffects,
  EventManPick,
  FamilyName,
  GameEvent,
  GameState,
  TurnLogEntry,
} from "@/types/game";
import { ALL_FAMILY_NAMES } from "@/data/families";
import type { Rng } from "./rng";
import { buildSummonsCinematic } from "./hitOps";
import { removeMan, walkRequestFor } from "./callIn";
import { createRng, hashString } from "./rng";
import { applyCrateEffect, emptyLiquorLedger, mergeLedger } from "./liquor";
import { DISTRICT_HEAT_CAP } from "./economy";
import { jailInCrew, releaseMember } from "./jail";
import { createCrewMember } from "./crew";
import { makeDeal } from "./deals";
import { setRelationDelta } from "./relations";
import { modifierChip, modifierSum } from "./eventModifiers";

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

function log(state: GameState, key: string, text: string, extra?: Partial<TurnLogEntry>): TurnLogEntry {
  return {
    id: `log_evt_${key}_${state.turn}_${state.turnLog.length}`,
    turn: state.turn,
    category: "event",
    text,
    family: state.playerFamily ?? undefined,
    ...extra,
  };
}

function rivalsOf(state: GameState): FamilyName[] {
  const gone = new Set(state.defunctFamilies ?? []);
  return ALL_FAMILY_NAMES.filter((f) => f !== state.playerFamily && !gone.has(f));
}

/** Men below the boss who are free to take the fall, the beating or the job. */
function menOnHand(state: GameState): CrewMember[] {
  return state.crew.filter(
    (c) => c.family === state.playerFamily && c.status === "active" && c.role !== "boss",
  );
}

export function pickMan(
  state: GameState,
  pick: EventManPick,
  rng: Rng,
  event?: Pick<GameEvent, "subjectCrewId" | "ctx">,
): CrewMember | undefined {
  const men = menOnHand(state);
  if (men.length === 0) return undefined;
  const any = () => men[rng.int(0, men.length - 1)];
  switch (pick) {
    case "subject": {
      const id = event?.subjectCrewId ?? event?.ctx?.crewId;
      return men.find((c) => c.id === id) ?? any();
    }
    case "capo": {
      const capos = men.filter((c) => c.role === "capo" || c.role === "underboss");
      return capos.length ? capos[rng.int(0, capos.length - 1)] : any();
    }
    case "soldier": {
      const low = men.filter((c) => c.role === "soldier" || c.role === "associate");
      return low.length ? low[rng.int(0, low.length - 1)] : any();
    }
    case "muscle":
      return [...men].sort((a, b) => b.skills.muscle - a.skills.muscle)[0];
    case "manager": {
      const racketId = event?.ctx?.racketId;
      const managers = new Set(
        state.territories.flatMap((t) =>
          t.owner === state.playerFamily
            ? t.rackets.filter((r) => !racketId || r.id === racketId).map((r) => r.managerId)
            : [],
        ),
      );
      const m = men.filter((c) => managers.has(c.id));
      return m.length ? m[rng.int(0, m.length - 1)] : any();
    }
    case "any":
      return any();
  }
}

function newMan(
  rng: Rng,
  family: FamilyName,
  role: Parameters<typeof createCrewMember>[2],
  bias: keyof CrewSkills,
  name?: string,
): CrewMember {
  const man = createCrewMember(rng, family, role, { name, skillBonus: 5 });
  return {
    ...man,
    skills: { ...man.skills, [bias]: clamp(man.skills[bias] + 20) },
  };
}

/**
 * Apply one bundle of effects. Gambles are rolled by `applyEventChoice`, which
 * calls this once for the shared part and once for the branch that came up.
 */
export function applyOutcome(
  state: GameState,
  fx: Omit<EventEffects, "gamble">,
  rng: Rng,
  event: GameEvent,
): GameState {
  const player = state.playerFamily;
  if (!player) return state;
  let s: GameState = { ...state };
  const logs: TurnLogEntry[] = [];
  let heatExtra = 0;
  let fearExtra = 0;

  /* Relations -------------------------------------------------------- */
  if (fx.relationDelta) {
    s.relations = setRelationDelta(s.relations, player, fx.relationDelta.family, fx.relationDelta.delta);
  }
  for (const r of fx.relations ?? []) {
    const fams = r.family === "allRivals" ? rivalsOf(s) : [r.family];
    for (const f of fams) s.relations = setRelationDelta(s.relations, player, f, r.delta);
  }
  if (fx.truce) {
    s = makeDeal(s, "truce", fx.truce.family, { cash: 0, standing: 0, weeks: fx.truce.weeks }, {
      weeks: fx.truce.weeks,
      rng,
    }).state;
    logs.push(log(s, "truce", `A truce with the ${fx.truce.family} family holds for ${fx.truce.weeks} weeks.`));
  }

  /* Crew ------------------------------------------------------------- */
  if (fx.crewStatus) {
    const { crewId, status } = fx.crewStatus;
    s.crew =
      status === "jailed"
        ? jailInCrew(s.crew, crewId, s.turn)
        : s.crew.map((c) => (c.id === crewId ? { ...c, status } : c));
  }
  const crewLoyalty = (fx.crewLoyalty ?? 0) + (fx.loyalty ?? 0);
  if (crewLoyalty) {
    s.crew = s.crew.map((c) =>
      c.family === player && c.status === "active" && c.role !== "boss"
        ? { ...c, loyalty: clamp(c.loyalty + crewLoyalty) }
        : c,
    );
  }
  if (fx.recruit) {
    const man = { ...newMan(rng, player, fx.recruit.role, fx.recruit.bias, fx.recruit.name), roleSinceTurn: s.turn };
    s.crew = [...s.crew, man];
    logs.push(log(s, "recruit", `${man.name} joins the family.`, { crewId: man.id }));
  }
  if (fx.rivalRecruit) {
    const man = newMan(rng, fx.rivalRecruit.family, fx.rivalRecruit.role, fx.rivalRecruit.bias);
    s.crew = [...s.crew, man];
    logs.push(log(s, "rival_recruit", `${man.name} went to work for the ${fx.rivalRecruit.family} family instead.`));
  }
  if (fx.jailMan) {
    const man = pickMan(s, fx.jailMan.pick, rng, event);
    if (man) {
      s.crew = jailInCrew(s.crew, man.id, s.turn);
      logs.push(log(s, "jail", `${man.name} was picked up and sent to the Tombs.`, { crewId: man.id, tone: "warning" }));
    }
  }
  if (fx.woundMan) {
    const man = pickMan(s, fx.woundMan.pick, rng, event);
    if (man) {
      s.crew = s.crew.map((c) =>
        c.id === man.id ? { ...c, status: "wounded" as const, assignment: { type: "idle" as const } } : c,
      );
      logs.push(log(s, "wound", `${man.name} came home bloodied and is laid up.`, { crewId: man.id, tone: "warning" }));
    }
  }
  if (fx.wantedMan) {
    const man = pickMan(s, fx.wantedMan.pick, rng, event);
    if (man) {
      s.crew = s.crew.map((c) =>
        c.id === man.id ? { ...c, wanted: clamp(c.wanted + fx.wantedMan!.delta, 0, 10) } : c,
      );
      logs.push(log(s, "wanted", `The bulls have ${man.name}'s name now.`, { crewId: man.id }));
    }
  }
  if (fx.releaseMan) {
    const inside = s.crew.filter((c) => c.family === player && c.status === "jailed" && c.role !== "boss");
    const man = inside[0];
    if (man) {
      s.crew = releaseMember(s.crew, man.id);
      logs.push(log(s, "release", `A word from the alderman, and ${man.name} walks out of the Tombs.`, { crewId: man.id }));
    } else {
      heatExtra -= 5;
    }
  }

  if (fx.takeOut) {
    const id = fx.takeOut.crewId;
    const victim = s.crew.find((c) => c.id === id && c.status !== "dead");
    if (victim) {
      const before = s.crew;
      const removed = removeMan(s, id);
      s = {
        ...s,
        crew: removed.crew,
        territories: removed.territories,
        operations: removed.operations,
        supplyRoutes: removed.supplyRoutes,
      };
      const rat = event.subjectIsRat === true;
      heatExtra += rat ? -10 : 5;
      fearExtra += 8;
      if (!rat) {
        s.crew = s.crew.map((c) =>
          c.family === player && c.id !== id && c.status === "active"
            ? { ...c, loyalty: Math.max(0, c.loyalty - 10) }
            : c,
        );
        const roll = createRng(hashString(`${s.seed}:walk:${id}:${s.turn}`));
        if (roll.chance(0.4)) {
          const ask = walkRequestFor(state, before, victim);
          if (ask) s.crewRequests = [...(s.crewRequests ?? []), ask];
        }
      }
      logs.push(...removed.logs, {
        id: `log_takeout_${id}_${s.turn}`,
        turn: s.turn,
        category: "hit" as const,
        text: rat
          ? `${victim.name} was the rat. It's done, and the heat eases off.`
          : `${victim.name} wasn't the rat. The family knows it.`,
        family: player,
      });
      s.pendingSummons = buildSummonsCinematic(s, victim, !rat);
    }
  }

  /* Rackets and districts -------------------------------------------- */
  if (fx.racket) {
    const { territoryId, racketId, action, turns } = fx.racket;
    const t = s.territories.find((x) => x.id === territoryId);
    const r = t?.rackets.find((x) => x.id === racketId);
    if (t && r) {
      if (action === "freeze") {
        const until = s.turn + (turns ?? 1);
        s.territories = s.territories.map((x) =>
          x.id === territoryId
            ? { ...x, rackets: x.rackets.map((y) => (y.id === racketId ? { ...y, frozenUntil: Math.max(y.frozenUntil ?? 0, until) } : y)) }
            : x,
        );
        logs.push(log(s, "freeze", `The ${r.type} in ${t.name} is shut for ${turns ?? 1} week${(turns ?? 1) === 1 ? "" : "s"}.`, { territoryId, tone: "warning" }));
      } else {
        s.territories = s.territories.map((x) =>
          x.id === territoryId ? { ...x, rackets: x.rackets.filter((y) => y.id !== racketId) } : x,
        );
        s.crew = s.crew.map((c) =>
          c.assignment?.racketId === racketId ? { ...c, assignment: { type: "idle" as const } } : c,
        );
        if (s.launderPlan?.[racketId] != null) {
          const { [racketId]: _gone, ...rest } = s.launderPlan;
          s.launderPlan = rest;
        }
        logs.push(log(s, "destroy", `The ${r.type} in ${t.name} is gone.`, { territoryId, tone: "warning" }));
      }
    }
  }
  if (fx.territoryHeat) {
    const { territoryId, delta } = fx.territoryHeat;
    s.territories = s.territories.map((t) =>
      t.id === territoryId ? { ...t, heatLevel: clamp((t.heatLevel ?? 0) + delta, 0, DISTRICT_HEAT_CAP) } : t,
    );
  }

  /* Rivals ----------------------------------------------------------- */
  if (fx.rival) {
    const { family, treasury } = fx.rival;
    if (treasury) {
      s.rivalTreasury = { ...s.rivalTreasury, [family]: (s.rivalTreasury?.[family] ?? 0) + treasury };
      logs.push(log(s, "rival_gain", `The ${family} family took the score you passed on.`));
    }
  }

  /* Liquor ----------------------------------------------------------- */
  let dirtyExtra = 0;
  if (fx.crates) {
    const crateRng = createRng(hashString(`${s.seed}:evt:${event.id}:${s.turn}:${fx.crates}`));
    const crateFx = applyCrateEffect(s, fx.crates, crateRng);
    s.territories = crateFx.territories;
    dirtyExtra += crateFx.dirtyDelta;
    if (crateFx.log) logs.push(crateFx.log);
    const base = s.liquorLedger ?? emptyLiquorLedger();
    s.liquorLedger =
      fx.crates > 0
        ? mergeLedger(base, { bought: crateFx.moved, cashIn: crateFx.dirtyDelta })
        : mergeLedger(base, { dumped: crateFx.moved });
  }
  if (fx.shipment) {
    const dest =
      s.territories.find((t) => t.owner === player && t.rackets.some((r) => r.type === "warehouse")) ??
      s.territories.find((t) => t.owner === player);
    if (dest) {
      const slow = Math.max(0, Math.round(modifierSum(s, "shipmentSpeed")));
      s.pendingShipments = [
        ...(s.pendingShipments ?? []),
        {
          id: `ship_evt_${event.id}_${rng.int(100, 999)}`,
          crates: fx.shipment.crates,
          destTerritoryId: dest.id,
          arriveTurn: s.turn + Math.max(1, fx.shipment.inTurns) + slow,
          cost: 0,
        },
      ];
      logs.push(log(s, "ship", `${fx.shipment.crates} crates are on the way to ${dest.name}.`, { territoryId: dest.id }));
    }
  }
  const pending = s.pendingShipments ?? [];
  if (fx.shipmentDelay && fx.shipmentDelay > 0 && pending.length > 0) {
    s.pendingShipments = pending.map((p) => ({ ...p, arriveTurn: p.arriveTurn + fx.shipmentDelay! }));
    logs.push(log(s, "delay", `Shipments delayed ${fx.shipmentDelay} turn${fx.shipmentDelay === 1 ? "" : "s"}.`));
  }
  if (fx.shipmentLoss && fx.shipmentLoss > 0 && (s.pendingShipments ?? []).length > 0) {
    let lost = 0;
    s.pendingShipments = (s.pendingShipments ?? [])
      .map((p) => {
        const take = Math.ceil(p.crates * fx.shipmentLoss!);
        lost += take;
        return { ...p, crates: p.crates - take };
      })
      .filter((p) => p.crates > 0);
    s.liquorLedger = mergeLedger(s.liquorLedger ?? emptyLiquorLedger(), { seized: lost });
    logs.push(log(s, "shiploss", `${lost} crates lost from in-flight shipments.`));
  }

  /* Lingering -------------------------------------------------------- */
  if (fx.modifier) {
    const { weeks, ...m } = fx.modifier;
    s.eventModifiers = [
      ...(s.eventModifiers ?? []),
      { ...m, id: `mod_${event.id}_${m.kind}_${rng.int(1000, 9999)}`, untilTurn: s.turn + 1 + weeks },
    ];
    logs.push(
      log(s, "mod", `${m.label}: ${modifierChip(m)} for ${weeks} week${weeks === 1 ? "" : "s"}.`, {
        territoryId: m.territoryId,
      }),
    );
  }
  if (fx.followUp) {
    s.pendingFollowUps = [
      ...(s.pendingFollowUps ?? []),
      {
        templateId: fx.followUp.templateId,
        dueTurn: s.turn + fx.followUp.inTurns,
        chance: fx.followUp.chance,
        ctx: { ...event.ctx, ...fx.followUp.ctx },
      },
    ];
  }

  /* Ledger lines ----------------------------------------------------- */
  const moneyLoss = fx.moneyLossFrac ? Math.floor(Math.max(0, s.money) * fx.moneyLossFrac) : 0;
  if (moneyLoss > 0) logs.push(log(s, "moneyloss", `The bank folded with $${moneyLoss} of yours inside.`, { tone: "warning" }));

  return {
    ...s,
    money: s.money + (fx.money ?? 0) - moneyLoss,
    dirtyMoney: s.dirtyMoney + (fx.dirtyMoney ?? 0) + dirtyExtra,
    heat: { ...s.heat, level: clamp(s.heat.level + (fx.heat ?? 0) + heatExtra) },
    reputation: {
      ...s.reputation,
      respect: clamp(s.reputation.respect + (fx.respect ?? 0)),
      fear: clamp(s.reputation.fear + (fx.fear ?? 0) + fearExtra),
    },
    turnLog: [...s.turnLog, ...logs],
  };
}
