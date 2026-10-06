/**
 * A rumor that someone is talking. The first card starts an affair. A later
 * card says what happened, and asks for a second decision only when he is
 * still in the family and the question is still open.
 */
import type {
  CrewMember,
  CrewSkills,
  GameEvent,
  GameEventChoice,
  GameState,
  RatAffair,
  TurnLogEntry,
} from "@/types/game";
import type { Rng } from "./rng";
import { removeMan, walkRequestFor } from "./callIn";
import { buildSummonsCinematic } from "./hitOps";

const NERVE: CrewSkills = { muscle: 2, stealth: 8, smarts: 6, charm: 6, driving: 4 };
const SKILL_KEYS = ["muscle", "stealth", "smarts", "charm", "driving"] as const;

export function isRatRumor(templateId: string): boolean {
  return templateId === "informant_rumor" || templateId === "federal_informant";
}

/** The eye is on him: a watch or an investigation, until it is settled. */
export function manIsWatched(state: Pick<GameState, "ratAffair">, crewId: string): boolean {
  const a = state.ratAffair;
  if (!a || a.crewId !== crewId) return false;
  return a.kind === "watch" || a.kind === "investigation";
}

/** Sheet call-in and exile, before the follow-up card. */
export function sheetAffairOpen(state: Pick<GameState, "ratAffair">, crewId: string): boolean {
  const a = state.ratAffair;
  return !!a && a.crewId === crewId && a.phase === "open" && manIsWatched(state, crewId);
}

/** 60% at smarts 20, 85% at smarts 80. */
export function readAccuracy(smarts: number): number {
  const t = Math.max(0, Math.min(1, (smarts - 20) / 60));
  return 0.6 + 0.25 * t;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function choice(id: string, text: string, effects: GameEventChoice["effects"] = {}): GameEventChoice {
  return { id, text, effects };
}

export function ratRumorChoices(name: string): GameEventChoice[] {
  return [
    choice("call_in", `Call him in — ${name} doesn't come back`, { fear: 14 }),
    choice("relocate", `Move ${name} out of the city`, { money: -300 }),
    choice("investigate", "Open an investigation", { money: -200, fear: -6 }),
    choice("lie", `Feed ${name} a lie`),
    choice("watch", "Watch and wait", { loyalty: 3 }),
  ];
}

function log(state: GameState, id: string, text: string, category: TurnLogEntry["category"] = "event"): TurnLogEntry {
  return { id, turn: state.turn, category, text, family: state.playerFamily ?? undefined };
}

function man(state: GameState, id: string): CrewMember | undefined {
  return state.crew.find((c) => c.id === id);
}

function patchCrew(state: GameState, id: string, fn: (c: CrewMember) => CrewMember): CrewMember[] {
  return state.crew.map((c) => (c.id === id ? fn(c) : c));
}

function applyNerve(skills: CrewSkills): { skills: CrewSkills; debt: CrewSkills } {
  const next = { ...skills };
  const debt: CrewSkills = { muscle: 0, stealth: 0, smarts: 0, charm: 0, driving: 0 };
  for (const k of SKILL_KEYS) {
    const drop = Math.min(NERVE[k], Math.max(0, next[k]));
    next[k] = next[k] - drop;
    debt[k] = drop;
  }
  return { skills: next, debt };
}

function liftNerve(skills: CrewSkills, debt: CrewSkills, extraCharm = 0): CrewSkills {
  const next = { ...skills };
  for (const k of SKILL_KEYS) {
    next[k] = clamp(next[k] + (debt[k] ?? 0));
  }
  next.charm = clamp(next.charm + extraCharm);
  return next;
}

function rep(
  state: GameState,
  d: { respect?: number; fear?: number; loyalty?: number },
  heat = 0,
  money = 0,
): Pick<GameState, "reputation" | "heat" | "money"> {
  return {
    money: state.money + money,
    heat: { ...state.heat, level: clamp(state.heat.level + heat) },
    reputation: {
      ...state.reputation,
      respect: clamp(state.reputation.respect + (d.respect ?? 0)),
      fear: clamp(state.reputation.fear + (d.fear ?? 0)),
      loyalty: clamp(state.reputation.loyalty + (d.loyalty ?? 0)),
    },
  };
}

function resultCard(state: GameState, title: string, description: string, crewId?: string, isRat?: boolean): GameEvent {
  return {
    id: `evt_rat_result_${state.turn}_${crewId ?? "x"}_${title.length}`,
    templateId: "rat_result",
    title,
    description,
    choices: [choice("leave", "Leave it")],
    isActive: true,
    subjectCrewId: crewId,
    subjectIsRat: isRat,
  };
}

function followCard(
  state: GameState,
  title: string,
  description: string,
  choices: GameEventChoice[],
  affair: RatAffair,
): GameEvent {
  return {
    id: `evt_rat_follow_${state.turn}_${affair.crewId}`,
    templateId: "rat_follow",
    title,
    description,
    choices,
    isActive: true,
    subjectCrewId: affair.crewId,
    subjectIsRat: affair.isRat,
  };
}

function closeEvent(state: GameState, event: GameEvent, next: GameEvent | null): GameState {
  const events = [
    ...state.events.filter((e) => e.id !== event.id && e.id !== next?.id),
    { ...event, isActive: false },
    ...(next ? [next] : []),
  ];
  return { ...state, events, activeEvent: next };
}

function openCard(state: GameState, card: GameEvent): GameState {
  return {
    ...state,
    activeEvent: card,
    events: [...state.events.filter((e) => e.id !== card.id), card],
  };
}

function clearLeakIf(state: GameState, crewId: string): Pick<GameState, "ratLeakTurn" | "ratLeakCrewId" | "ratLeakWeeks" | "ratLeakSilent"> {
  if (state.ratLeakCrewId !== crewId) {
    return {
      ratLeakTurn: state.ratLeakTurn,
      ratLeakCrewId: state.ratLeakCrewId,
      ratLeakWeeks: state.ratLeakWeeks,
      ratLeakSilent: state.ratLeakSilent,
    };
  }
  return { ratLeakTurn: undefined, ratLeakCrewId: undefined, ratLeakWeeks: undefined, ratLeakSilent: undefined };
}

function consigliere(state: GameState): CrewMember | undefined {
  return state.crew.find(
    (c) => c.family === state.playerFamily && c.role === "consigliere" && c.status === "active",
  );
}

function killMan(state: GameState, id: string): { state: GameState; victim: CrewMember } | null {
  const victim = man(state, id);
  if (!victim || victim.status === "dead") return null;
  const removed = removeMan(state, id, { quiet: true });
  return {
    victim,
    state: {
      ...state,
      crew: removed.crew,
      territories: removed.territories,
      operations: removed.operations,
      supplyRoutes: removed.supplyRoutes,
      turnLog: [...state.turnLog, ...removed.logs],
    },
  };
}

function exileMan(state: GameState, id: string): { state: GameState; victim: CrewMember } | null {
  const killed = killMan(state, id);
  if (!killed) return null;
  return {
    victim: killed.victim,
    state: {
      ...killed.state,
      crew: killed.state.crew.map((c) => (c.id === id ? { ...c, leftCity: true } : c)),
    },
  };
}

/** Day-one call-in. He dies either way. Fear +14, then the rat bill or the harsh bill. */
function dayOneCall(state: GameState, event: GameEvent, rng: Rng): GameState {
  const id = event.subjectCrewId ?? "";
  const isRat = event.subjectIsRat === true;
  const killed = killMan(state, id);
  if (!killed) return closeEvent(state, event, null);
  const { victim } = killed;
  let next = killed.state;
  const bill = isRat
    ? { heat: -25, respect: 12, fear: 14, loyalty: 8 }
    : { heat: 25, respect: -22, fear: 14, loyalty: -20 };
  next = { ...next, ...rep(next, bill, bill.heat) };
  let crewRequests = next.crewRequests ?? [];
  if (!isRat && rng.chance(0.7)) {
    const ask = walkRequestFor(next, state.crew, victim);
    if (ask) crewRequests = [...crewRequests, ask];
  }
  const text = isRat
    ? `${victim.name} was the rat. Heat −25. Respect +12. Fear +14. Family loyalty +8.`
    : `${victim.name} was clean. Heat +25. Respect −22. Fear +14. Family loyalty −20.${crewRequests.length > (state.crewRequests ?? []).length ? " Someone wants to walk." : ""}`;
  const card = resultCard(next, "He's Gone", text, id, isRat);
  const entry = log(next, `log_rat_call_${id}_${next.turn}`, text, "hit");
  return closeEvent(
    {
      ...next,
      crewRequests,
      ratAffair: null,
      lastCallInTurn: next.turn,
      pendingSummons: buildSummonsCinematic(next, victim, !isRat),
      ...clearLeakIf(next, id),
      turnLog: [...next.turnLog, entry],
    },
    event,
    card,
  );
}

/** Day-one exile, and exile from an open investigation. $300 either way. */
function dayOneExile(state: GameState, id: string, isRat: boolean, event: GameEvent | null): GameState {
  const exiled = exileMan(state, id);
  if (!exiled) return event ? closeEvent(state, event, null) : state;
  const { victim } = exiled;
  let next = { ...exiled.state, ...rep(exiled.state, {}, 0, -300) };
  const bill = isRat
    ? { heat: -18, respect: 8, fear: 4, loyalty: 0 }
    : { heat: 0, respect: -20, fear: 0, loyalty: -16 };
  next = { ...next, ...rep(next, bill, bill.heat) };
  const text = isRat
    ? `You put ${victim.name} on a train. He was the rat. Heat −18. Respect +8. Fear +4. The leak never starts.`
    : `You put ${victim.name} on a train. He was clean. Respect −20. Family loyalty −16. The seat is empty.`;
  const card = resultCard(next, "Out of the City", text, id, isRat);
  const entry = log(next, `log_rat_exile_${id}_${next.turn}`, text);
  const settled = {
    ...next,
    ratAffair: null,
    ...clearLeakIf(next, id),
    turnLog: [...next.turnLog, entry],
  };
  return event ? closeEvent(settled, event, card) : openCard(settled, card);
}

function startWatch(state: GameState, event: GameEvent): GameState {
  const id = event.subjectCrewId ?? "";
  const subject = man(state, id);
  if (!subject) return closeEvent(state, event, null);
  const nerved = applyNerve(subject.skills);
  const federal = event.templateId === "federal_informant";
  const affair: RatAffair = {
    crewId: id,
    isRat: event.subjectIsRat === true,
    kind: "watch",
    startTurn: state.turn,
    resolveTurn: state.turn + 3,
    federal,
    skillDebt: nerved.debt,
    phase: "open",
  };
  const text = `You stand by ${subject.name}. His loyalty +10. Family loyalty +3. An eye goes on his name for three weeks.`;
  return closeEvent(
    {
      ...state,
      ...rep(state, { loyalty: 3 }),
      crew: patchCrew(state, id, (c) => ({
        ...c,
        loyalty: clamp(c.loyalty + 10),
        skills: nerved.skills,
      })),
      ratAffair: affair,
      turnLog: [...state.turnLog, log(state, `log_rat_watch_${id}_${state.turn}`, text)],
    },
    event,
    null,
  );
}

function startInvestigation(state: GameState, event: GameEvent): GameState {
  const id = event.subjectCrewId ?? "";
  const subject = man(state, id);
  if (!subject) return closeEvent(state, event, null);
  const nerved = applyNerve(subject.skills);
  const affair: RatAffair = {
    crewId: id,
    isRat: event.subjectIsRat === true,
    kind: "investigation",
    startTurn: state.turn,
    resolveTurn: state.turn + 1,
    federal: event.templateId === "federal_informant",
    skillDebt: nerved.debt,
    phase: "open",
  };
  const text = `The consigliere starts on ${subject.name}. $200. Fear −6. ${subject.name}'s loyalty −8. The eye stays on him for a week.`;
  return closeEvent(
    {
      ...state,
      ...rep(state, { fear: -6 }, 0, -200),
      crew: patchCrew(state, id, (c) => ({
        ...c,
        loyalty: clamp(c.loyalty - 8),
        skills: nerved.skills,
      })),
      ratAffair: affair,
      turnLog: [...state.turnLog, log(state, `log_rat_inv_${id}_${state.turn}`, text)],
    },
    event,
    null,
  );
}

function startLie(state: GameState, event: GameEvent): GameState {
  const id = event.subjectCrewId ?? "";
  const subject = man(state, id);
  if (!subject) return closeEvent(state, event, null);
  const affair: RatAffair = {
    crewId: id,
    isRat: event.subjectIsRat === true,
    kind: "lie",
    startTurn: state.turn,
    resolveTurn: state.turn + 1,
    federal: event.templateId === "federal_informant",
    skillDebt: { muscle: 0, stealth: 0, smarts: 0, charm: 0, driving: 0 },
    phase: "open",
  };
  const text = `You tell only ${subject.name} about a shipment that does not exist.`;
  return closeEvent(
    {
      ...state,
      ratAffair: affair,
      turnLog: [...state.turnLog, log(state, `log_rat_lie_${id}_${state.turn}`, text)],
    },
    event,
    null,
  );
}

/** First card, a follow-up card, or the result card. Null when this event is not a rat affair. */
export function applyRatEventChoice(state: GameState, event: GameEvent, choiceId: string, rng: Rng): GameState | null {
  if (event.templateId === "rat_result") {
    if (choiceId !== "leave") return state;
    return closeEvent(state, event, null);
  }
  if (event.templateId === "rat_follow") {
    return applyFollow(state, event, choiceId, rng);
  }
  if (!isRatRumor(event.templateId)) return null;
  if (choiceId === "call_in") return dayOneCall(state, event, rng);
  if (choiceId === "relocate") return dayOneExile(state, event.subjectCrewId ?? "", event.subjectIsRat === true, event);
  if (choiceId === "investigate") return startInvestigation(state, event);
  if (choiceId === "lie") return startLie(state, event);
  if (choiceId === "watch") return startWatch(state, event);
  return null;
}

function applyFollow(state: GameState, event: GameEvent, choiceId: string, rng: Rng): GameState {
  const affair = state.ratAffair;
  if (!affair || choiceId === "leave") return closeEvent(state, event, null);
  if (choiceId === "follow_clear") return clearHim(state, event, affair);
  if (choiceId === "follow_call") return followCall(state, event, affair, rng);
  if (choiceId === "follow_exile") return followExile(state, event, affair);
  return state;
}

function clearHim(state: GameState, event: GameEvent, affair: RatAffair): GameState {
  const subject = man(state, affair.crewId);
  const name = subject?.name ?? "He";
  let crew = state.crew;
  if (subject && subject.status !== "dead") {
    crew = patchCrew(state, affair.crewId, (c) => ({
      ...c,
      skills: liftNerve(c.skills, affair.skillDebt, affair.isRat ? 0 : 8),
      loyalty: clamp(c.loyalty + (affair.isRat ? 0 : 14)),
    }));
  }
  if (!affair.isRat) {
    const text = `You clear ${name}. He was clean. His skills come back, charm +8 past that, his loyalty +14, respect +10. The eye comes off.`;
    const next = {
      ...state,
      crew,
      ...rep(state, { respect: 10 }),
      ratAffair: null,
      turnLog: [...state.turnLog, log(state, `log_rat_clear_${affair.crewId}_${state.turn}`, text)],
    };
    return closeEvent(next, event, resultCard(next, "Cleared", text, affair.crewId, false));
  }
  const text = `You clear ${name}. He was the rat. Respect −20. Heat +30. Wanted +3 across the family. He keeps talking for eight weeks.`;
  const next: GameState = {
    ...state,
    crew: crew.map((c) =>
      c.family === state.playerFamily && c.status === "active" ? { ...c, wanted: c.wanted + 3 } : c,
    ),
    ...rep(state, { respect: -20 }, 30),
    ratAffair: null,
    ratLeakTurn: state.turn + 1,
    ratLeakCrewId: affair.crewId,
    ratLeakWeeks: 8,
    ratLeakSilent: true,
    turnLog: [...state.turnLog, log(state, `log_rat_falseclear_${affair.crewId}_${state.turn}`, text, "heat")],
  };
  return closeEvent(next, event, resultCard(next, "You Vouched for Him", text, affair.crewId, true));
}

function followCall(state: GameState, event: GameEvent, affair: RatAffair, rng: Rng): GameState {
  const id = affair.crewId;
  const killed = killMan(state, id);
  if (!killed) return closeEvent({ ...state, ratAffair: null }, event, null);
  const { victim } = killed;
  let next = killed.state;
  let text: string;
  let walk = false;
  if (affair.kind === "lie" && affair.isRat) {
    next = { ...next, ...rep(next, { respect: 16, fear: 14, loyalty: 8 }, -35) };
    text = `You were right to test him. ${victim.name} was the rat. Heat −35. Respect +16. Fear +14. Family loyalty +8.`;
  } else if (affair.kind === "watch") {
    next = { ...next, ...rep(next, { loyalty: -4 }, -10) };
    text = `The family already heard. ${victim.name} was the rat. Heat −10. Family loyalty −4.`;
  } else if (affair.isRat) {
    next = { ...next, ...rep(next, { respect: 10, fear: 10, loyalty: -2 }, -22) };
    const right = affair.readSaysRat === true;
    text = right
      ? `The consigliere was right. ${victim.name} was the rat. Heat −22. Respect +10. Fear +10. Family loyalty −2.`
      : `You didn't take the advice. ${victim.name} was the rat. Heat −22. Respect +10. Fear +10. Family loyalty −2.`;
  } else {
    next = { ...next, ...rep(next, { respect: -22, fear: 14, loyalty: -20 }, 25) };
    walk = true;
    const wrong = affair.readSaysRat === true;
    text = wrong
      ? `The consigliere was wrong. ${victim.name} was clean. Heat +25. Respect −22. Fear +14. Family loyalty −20.`
      : `${victim.name} was clean. Heat +25. Respect −22. Fear +14. Family loyalty −20.`;
  }
  let crewRequests = next.crewRequests ?? [];
  if (walk && rng.chance(0.7)) {
    const ask = walkRequestFor(next, state.crew, victim);
    if (ask) {
      crewRequests = [...crewRequests, ask];
      text += " Someone wants to walk.";
    }
  }
  const card = resultCard(next, "He's Gone", text, id, affair.isRat);
  return closeEvent(
    {
      ...next,
      crewRequests,
      ratAffair: null,
      lastCallInTurn: next.turn,
      pendingSummons: buildSummonsCinematic(next, victim, !affair.isRat),
      ...clearLeakIf(next, id),
      turnLog: [...next.turnLog, log(next, `log_rat_followcall_${id}_${next.turn}`, text, "hit")],
    },
    event,
    card,
  );
}

function followExile(state: GameState, event: GameEvent, affair: RatAffair): GameState {
  const id = affair.crewId;
  if (affair.kind === "watch") {
    const exiled = exileMan(state, id);
    if (!exiled) return closeEvent({ ...state, ratAffair: null }, event, null);
    const next = { ...exiled.state, ...rep(exiled.state, { loyalty: -4 }, -10) };
    const text = `The family already heard. You put ${exiled.victim.name} on a train. Heat −10. Family loyalty −4.`;
    return closeEvent(
      {
        ...next,
        ratAffair: null,
        ...clearLeakIf(next, id),
        turnLog: [...next.turnLog, log(next, `log_rat_followex_${id}_${next.turn}`, text)],
      },
      event,
      resultCard(next, "Out of the City", text, id, true),
    );
  }
  if (affair.kind === "lie" && affair.isRat) {
    const exiled = exileMan(state, id);
    if (!exiled) return closeEvent({ ...state, ratAffair: null }, event, null);
    const next = { ...exiled.state, ...rep(exiled.state, { respect: 12 }, -28) };
    const text = `You put ${exiled.victim.name} on a train with proof he was talking. Heat −28. Respect +12.`;
    return closeEvent(
      {
        ...next,
        ratAffair: null,
        ...clearLeakIf(next, id),
        turnLog: [...next.turnLog, log(next, `log_rat_proofex_${id}_${next.turn}`, text)],
      },
      event,
      resultCard(next, "Out of the City", text, id, true),
    );
  }
  const settled = dayOneExile({ ...state, ratAffair: null }, id, affair.isRat, null);
  return closeEvent(settled, event, settled.activeEvent);
}

/** Call him in or move him out from his sheet while the eye is on him. */
export function sheetRatAction(state: GameState, crewId: string, action: "call" | "exile", rng: Rng): GameState | null {
  if (!sheetAffairOpen(state, crewId)) return null;
  const affair = state.ratAffair!;
  if (action === "exile") {
    return dayOneExile(state, crewId, affair.isRat, null);
  }
  const killed = killMan(state, crewId);
  if (!killed) return { ...state, ratAffair: null };
  const { victim } = killed;
  let next = killed.state;
  let text: string;
  let walk = false;
  if (affair.isRat) {
    next = { ...next, ...rep(next, { loyalty: -4 }, -10) };
    text = `You caught it off his numbers. ${victim.name} was the rat. Heat −10. Family loyalty −4.`;
  } else {
    next = { ...next, ...rep(next, { respect: -22, fear: 14, loyalty: -20 }, 25) };
    walk = true;
    text = `${victim.name} was clean. Heat +25. Respect −22. Fear +14. Family loyalty −20.`;
  }
  let crewRequests = next.crewRequests ?? [];
  if (walk && rng.chance(0.7)) {
    const ask = walkRequestFor(next, state.crew, victim);
    if (ask) {
      crewRequests = [...crewRequests, ask];
      text += " Someone wants to walk.";
    }
  }
  const card = resultCard(next, "He's Gone", text, crewId, affair.isRat);
  return openCard(
    {
      ...next,
      crewRequests,
      ratAffair: null,
      lastCallInTurn: next.turn,
      pendingSummons: buildSummonsCinematic(next, victim, !affair.isRat),
      ...clearLeakIf(next, crewId),
      turnLog: [...next.turnLog, log(next, `log_rat_sheet_${crewId}_${next.turn}`, text, "hit")],
    },
    card,
  );
}

function driftWatch(state: GameState, affair: RatAffair): { state: GameState; logs: TurnLogEntry[] } {
  const subject = man(state, affair.crewId);
  if (!subject || subject.status === "dead") {
    const text = "The watch ends. He's already gone.";
    const card = resultCard(state, "The Watch Ends", text, affair.crewId, affair.isRat);
    return {
      state: openCard({ ...state, ratAffair: null }, card),
      logs: [log(state, `log_rat_gone_${state.turn}`, text)],
    };
  }
  if (affair.isRat) {
    const wanted = affair.federal ? 3 : 2;
    const drift = { loyalty: -4, wanted, heat: 3 };
    const crew = patchCrew(state, affair.crewId, (c) => ({
      ...c,
      loyalty: clamp(c.loyalty - 4),
      wanted: Math.max(0, c.wanted + wanted),
    }));
    const text = `You're watching ${subject.name}. Loyalty down 4, wanted up ${wanted}, heat from him +3.`;
    return {
      state: {
        ...state,
        crew,
        ...rep(state, {}, 3),
        ratAffair: { ...affair, lastDrift: drift },
      },
      logs: [log(state, `log_rat_drift_${affair.crewId}_${state.turn}`, text)],
    };
  }
  const drift = { loyalty: 2, wanted: 0, heat: 0 };
  const text = `You're watching ${subject.name}. He looks steady. Loyalty up 2.`;
  return {
    state: {
      ...state,
      crew: patchCrew(state, affair.crewId, (c) => ({ ...c, loyalty: clamp(c.loyalty + 2) })),
      ratAffair: { ...affair, lastDrift: drift },
    },
    logs: [log(state, `log_rat_drift_${affair.crewId}_${state.turn}`, text)],
  };
}

function resolveAffair(state: GameState, affair: RatAffair, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const subject = man(state, affair.crewId);
  if (!subject || subject.status === "dead") {
    const text = "The question died with him.";
    const card = resultCard(state, "It's Over", text, affair.crewId, affair.isRat);
    return {
      state: openCard({ ...state, ratAffair: null }, card),
      logs: [log(state, `log_rat_gone_${state.turn}`, text)],
    };
  }
  if (affair.kind === "watch") {
    if (affair.isRat) {
      const heat = affair.federal ? 25 : 20;
      const text = `${subject.name} was wearing a wire. Respect −15. Heat +${heat}. The family knows. Call him in or put him on a train: heat −10, family loyalty −4.`;
      const revealed: RatAffair = { ...affair, phase: "revealed" };
      const card = followCard(
        state,
        "He Was Wearing a Wire",
        text,
        [
          choice("follow_call", "Call him in", { heat: -10, loyalty: -4 }),
          choice("follow_exile", "Move him out of the city", { heat: -10, loyalty: -4 }),
        ],
        revealed,
      );
      const next = { ...state, ...rep(state, { respect: -15 }, heat), ratAffair: revealed };
      return { state: openCard(next, card), logs: [log(next, `log_rat_miss_${state.turn}`, text, "heat")] };
    }
    const text = `The rumor on ${subject.name} dies. He was clean. Respect +4. Charm +4 past where it was, his loyalty +6. The eye comes off.`;
    const crew = patchCrew(state, affair.crewId, (c) => ({
      ...c,
      skills: liftNerve(c.skills, affair.skillDebt, 4),
      loyalty: clamp(c.loyalty + 6),
    }));
    const next = {
      ...state,
      crew,
      ...rep(state, { respect: 4 }),
      ratAffair: null,
      turnLog: state.turnLog,
    };
    const card = resultCard(next, "The Rumor Dies", text, affair.crewId, false);
    return {
      state: openCard(next, card),
      logs: [log(next, `log_rat_cleanwatch_${state.turn}`, text)],
    };
  }
  if (affair.kind === "lie") {
    if (affair.isRat) {
      const text = `The law hit the shipment you described to ${subject.name}. Heat +22. He was talking.`;
      const revealed: RatAffair = { ...affair, phase: "revealed" };
      const card = followCard(
        state,
        "The Fake Shipment",
        text,
        [
          choice("follow_call", "Call him in"),
          choice("follow_exile", "Move him out of the city"),
        ],
        revealed,
      );
      const next = { ...state, ...rep(state, {}, 22), ratAffair: revealed };
      return { state: openCard(next, card), logs: [log(next, `log_rat_sting_${state.turn}`, text, "heat")] };
    }
    const text = `The fake sat there and nobody came. ${subject.name} was clean. Heat +8. His loyalty −10. He knows he was tested.`;
    const next = {
      ...state,
      ...rep(state, {}, 8),
      crew: patchCrew(state, affair.crewId, (c) => ({ ...c, loyalty: clamp(c.loyalty - 10) })),
      ratAffair: null,
    };
    return {
      state: openCard(next, resultCard(next, "Nobody Came", text, affair.crewId, false)),
      logs: [log(next, `log_rat_lieclean_${state.turn}`, text)],
    };
  }
  const reader = consigliere(state);
  const smarts = reader?.skills.smarts ?? 20;
  const accurate = rng.chance(readAccuracy(smarts));
  const readSaysRat = accurate ? affair.isRat : !affair.isRat;
  const who = reader?.name ?? "Your consigliere";
  let crew = state.crew;
  if (affair.isRat) {
    crew = patchCrew(state, affair.crewId, (c) => ({ ...c, wanted: c.wanted + 1 }));
  }
  const revealed: RatAffair = { ...affair, phase: "revealed", readSaysRat };
  const text = readSaysRat
    ? `${who} says ${subject.name} is talking.`
    : `${who} says the rumor on ${subject.name} is empty.`;
  const choices = readSaysRat
    ? [
        choice("follow_call", "Call him in"),
        choice("follow_exile", "Move him out of the city"),
      ]
    : [
        choice("follow_clear", "Clear him"),
        choice("follow_exile", "Move him out of the city"),
        choice("follow_call", "Call him in anyway"),
      ];
  const card = followCard(state, "The Consigliere's Read", text, choices, revealed);
  const next = { ...state, crew, ratAffair: revealed };
  return { state: openCard(next, card), logs: [log(next, `log_rat_read_${state.turn}`, text)] };
}

/**
 * End of the week, before a random event is drawn. Drifts a watch, or deals
 * the follow-up card when the week has come.
 */
export function advanceRatAffair(state: GameState, rng: Rng): { state: GameState; logs: TurnLogEntry[] } {
  const affair = state.ratAffair;
  if (!affair || affair.phase !== "open") return { state, logs: [] };
  if (state.activeEvent) return { state, logs: [] };
  if (state.turn < affair.resolveTurn) {
    if (affair.kind !== "watch") return { state, logs: [] };
    return driftWatch(state, affair);
  }
  return resolveAffair(state, affair, rng);
}
