import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import { stopAll } from "@/audio/sfx";
import type {
  FamilyName,
  GameSettings,
  GameState,
  HitApproach,
  HitCinematic,
  PanelId,
  RacketType,
} from "@/types/game";
import { RACKET_LABELS } from "@/types/game";
import { buildInitialState, startGame } from "./initialState";
import { endTurn, resolvePlayerHits } from "./turnPipeline";
import { familyHeadless } from "./jail";
import { emptyVictory, finalTurnFor, seedRivalInfluence } from "./victory";
import { buildCityLayout, racketBlockFor } from "./cityLayout";
import { buildHitCinematic, planHit } from "./hitOps";
import { createRng, hashString } from "./rng";
import {
  assignCrew,
  canPromote,
  generateRecruitmentPool,
  promoteCrew,
  funeralLoyaltyHit,
} from "./crew";
import { recruitPrice, recruitTier } from "./recruiting";
import {
  createRacket,
  upgradeRacket,
  findDeliveryPath,
  racketIncome,
  incomeFlavor,
  racketPayment,
  formatPaymentParts,
  RACKET_BUILD_COST,
  isLegitBusiness,
  isRacketFrozen,
  isLaunderSiteSetUp,
  launderCap,
  normalizeTerritoryRackets,
  pruneLaunderPlan,
  migrateLaunderSites,
} from "./economy";
import {
  districtStorage,
  emptyLiquorLedger,
  hasManagedWarehouse,
  makeManagerLookup,
  shipmentSeizureChance,
  supplierPrice,
  totalCrates,
  withdrawCrates,
} from "./liquor";
import { ensureTerritorySlots, maxRacketsFor, allowedRacketTypes, lotTier, lotTierHint } from "./territoryValue";
import { attemptBribe } from "./bribes";
import { applyEventChoice } from "./events";
import {
  breakPact,
  canDiplomacy,
  hasPact,
  resolveDiplomacy,
  type DiplomacyAction,
} from "./diplomacy";
import { captureAllowance, resolveCapture } from "./capture";
import {
  answerCrewRequest,
  canJoinCrew,
  joinCrew,
  leaveCrew,
  type CrewRequestAnswer,
} from "./crews";
import {
  answerCounter,
  answerInvite,
  answerPassage,
  answerTable,
  applyHostFallout,
  classifyMeeting,
  proposeSitdown,
  resultForMeeting,
  type AgendaPick,
  type InviteAnswer,
  type PassageAnswer,
  type SitdownParty,
  type TableAnswer,
} from "./sitdowns";
import { breakDeal, fulfilLiquorDeal, inTruce } from "./deals";
import {
  cancelSupplyRoute,
  establishSupplyRoute,
  reopenPassageTalks,
  setRouteRunHot,
  toggleSupplyRoute,
} from "./supplyRoutes";
import { isMessageTargetRole, routeDisputeWith } from "./passage";
import type {
  AgendaTerms,
  PassageTerms,
  SitdownCinematic,
  SitdownVenue,
  SupplyRoutePreview,
} from "@/types/game";
import { normalizeIntel } from "./intel";
import { hitCrewIds } from "@/data/hitApproaches";
import type { CrewRole } from "@/types/game";
import {
  LOCATION_REASON_LABEL,
  resolveCrewLocation,
  resolveCrewTerritoryId,
} from "./crewLocation";
import { bossPresentIn, presenceBuildCost } from "./bossPresence";

export { resolveCrewTerritoryId } from "./crewLocation";

function pathToVenue(
  state: GameState,
  family: FamilyName,
  venueId: string,
  origin: string | undefined,
): string[] | null {
  if (!origin || origin === venueId) return null;
  return findDeliveryPath(state.territories, origin, venueId, family, true) ?? [origin, venueId];
}

/** Drives for sit-downs that were held (or aborted) this turn. */
function buildSitdownCinematics(state: GameState): SitdownCinematic[] {
  const player = state.playerFamily;
  if (!player) return [];
  const out: SitdownCinematic[] = [];
  for (const s of state.sitdowns ?? []) {
    if (s.heldTurn !== state.turn) continue;
    if (s.proposer !== player && s.other !== player) continue;
    if (s.status !== "held" && s.status !== "at_table" && s.status !== "aborted") continue;
    const family = s.proposer === player ? s.other : s.proposer;
    // An open table (passage or agenda) fills its result when terms settle.
    const passageOpen = s.status === "at_table";
    out.push({
      sitdownId: s.id,
      family,
      venueTerritoryId: s.venueTerritoryId,
      playerPath: pathToVenue(state, player, s.venueTerritoryId, s.travelFrom?.[player]),
      rivalPath: pathToVenue(state, family, s.venueTerritoryId, s.travelFrom?.[family]),
      purpose: s.purpose,
      outcome: classifyMeeting(state, s),
      result: passageOpen ? undefined : resultForMeeting(state, s),
    });
  }
  return out;
}

function turfLabel(state: GameState, territoryId: string): string {
  const t = state.territories.find((x) => x.id === territoryId);
  if (!t) return "";
  if (!t.owner) return `${t.name} · unclaimed`;
  return t.owner === state.playerFamily
    ? `${t.name} · your turf`
    : `${t.name} · ${t.owner} turf`;
}

const FOCUS_DISTANCE = 15;

function focusOnTerritory(
  state: GameState,
  territoryId: string,
): { x: number; z: number; distance: number } | null {
  const center = buildCityLayout(state.territories, state.seed).centers.find(
    (c) => c.territoryId === territoryId,
  );
  if (!center) return null;
  return { x: center.worldX, z: center.worldZ, distance: FOCUS_DISTANCE };
}

function focusOnRacket(
  state: GameState,
  territoryId: string,
  racketId: string,
): { x: number; z: number; distance: number } | null {
  const territory = state.territories.find((t) => t.id === territoryId);
  const layout = buildCityLayout(state.territories, state.seed);
  const index = territory?.rackets.findIndex((r) => r.id === racketId) ?? -1;
  const block = index >= 0 ? racketBlockFor(layout, territoryId, index) : null;
  if (block) return { x: block.worldX, z: block.worldZ, distance: FOCUS_DISTANCE };
  return focusOnTerritory(state, territoryId);
}

function flyTo(
  state: GameState,
  territoryId: string | null,
  focus?: { x: number; z: number; distance: number } | null,
): Partial<GameState> {
  if (!territoryId) return { flyToFocus: null };
  return {
    selectedTerritoryId: territoryId,
    flyToTerritoryId: territoryId,
    flyToNonce: (state.flyToNonce ?? 0) + 1,
    flyToFocus: focus ?? null,
  };
}

interface GameStore extends GameState {
  newGame: (settings?: Partial<GameSettings>) => void;
  selectFamily: (family: FamilyName) => void;
  setPanel: (panel: PanelId) => void;
  selectTerritory: (id: string | null, opts?: { toastLabel?: string; racketId?: string }) => void;
  clearFlyTo: () => void;
  clearHitFx: () => void;
  clearBuildFx: () => void;
  finishCinematic: () => void;
  updateSettings: (partial: Partial<GameSettings>) => void;
  setHitTargetPreview: (id: string | null) => void;
  selectCrew: (id: string | null) => void;
  recruitFromPool: (poolIndex: number) => void;
  refreshRecruitment: () => void;
  promote: (crewId: string, toRole: CrewRole) => void;
  assignMember: (
    crewId: string,
    assignment: GameState["crew"][0]["assignment"]
  ) => void;
  assignManager: (
    territoryId: string,
    racketId: string,
    crewId: string | null
  ) => void;
  buildRacket: (territoryId: string, type: RacketType) => void;
  upgradeRacketAt: (territoryId: string, racketId: string) => void;
  startDelivery: (
    driverId: string,
    sourceId: string,
    destId: string,
    cargo: number
  ) => void;
  buyWhisky: (destTerritoryId: string, crates: number) => void;
  setLaunderAmount: (racketId: string, amount: number) => void;
  clearLaunderPlan: () => void;
  suggestSafeSpread: () => void;
  setupLaunderSite: (territoryId: string, racketId: string) => void;
  stopLaunderSite: (territoryId: string, racketId: string) => void;
  planPlayerHit: (args: {
    targetCrewId?: string;
    targetTerritoryId: string;
    approach: HitApproach;
    shooterIds: string[];
    wheelmanId?: string;
    lookoutId?: string;
    bombMakerId?: string;
    planterId?: string;
    negotiatorId?: string;
    surveilFirst?: boolean;
    blind?: boolean;
    /** "message": a point made over the trucks, aimed at a skilled non-boss. */
    intent?: "message";
  }) => void;
  establishSupplyRoute: (args: {
    sourceTerritoryId: string;
    destTerritoryId: string;
    path: string[];
    cratesPerTurn: number;
    driverId: string;
    escortId?: string;
    runHot: boolean;
  }) => void;
  cancelSupplyRoute: (id: string) => void;
  toggleSupplyRoute: (id: string) => void;
  setRouteRunHot: (id: string, runHot: boolean) => void;
  reopenPassageTalks: (routeId: string) => void;
  /** Draw one standing route on the map (null clears). */
  setSupplyRouteFocus: (id: string | null) => void;
  /** Draw the candidate roads for a route being planned (null clears). */
  setSupplyRoutePreview: (preview: SupplyRoutePreview | null) => void;
  answerPassage: (id: string, answer: PassageAnswer, offer?: PassageTerms) => void;
  caseDistrict: (territoryId: string, crewId: string) => void;
  dismissHitResult: () => void;
  dismissLookoutReport: () => void;
  tryBribe: (
    type: "cops" | "captains" | "chiefs" | "mayor" | "judge",
    targetFamily?: FamilyName,
    targetTerritory?: string
  ) => void;
  chooseEvent: (choiceId: string) => void;
  answerCrewRequest: (requestId: string, answer: CrewRequestAnswer) => void;
  joinCrew: (memberId: string, capoId: string) => void;
  leaveCrew: (memberId: string) => void;
  takeDiplomacy: (action: DiplomacyAction, target: FamilyName) => void;
  proposeSitdown: (target: FamilyName, venue: SitdownVenue, party?: SitdownParty, pick?: AgendaPick) => void;
  /** The player's move at an open agenda table (truce, district, release…). */
  answerTable: (id: string, answer: TableAnswer, offer?: AgendaTerms) => void;
  /** Tear up a deal on purpose. Everyone hears. */
  breakDeal: (dealId: string) => void;
  /** Send the crates a liquor order calls for. */
  fulfilLiquorDeal: (dealId: string) => void;
  dismissDealSettlement: () => void;
  answerSitdownCounter: (id: string, accept: boolean) => void;
  answerSitdownInvite: (
    id: string,
    answer: InviteAnswer,
    venue?: SitdownVenue,
    party?: SitdownParty,
  ) => void;
  dismissSitdownResult: () => void;
  openSitdownTable: () => void;
  beginSitdownExit: () => void;
  completeSitdownCinematic: () => void;
  nextTurn: () => void;
  payFuneral: (deadCrewId: string) => void;
  captureTerritory: (territoryId: string, attackerIds: string[]) => void;
  saveSlot: (slot: number) => void;
  loadSlot: (slot: number) => boolean;
}

const defaultSettings: GameSettings = {
  difficulty: "normal",
  gameLength: "medium",
  aiAggression: 0.55,
  seed: Date.now() % 1_000_000,
  skipCinematics: false,
  rivalCinematics: "brief",
  sfxVolume: 0.7,
};

function cloneState(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      ...buildInitialState(defaultSettings.seed, defaultSettings),

      newGame: (settings) => {
        const merged = {
          ...defaultSettings,
          ...settings,
          seed: settings?.seed ?? Date.now() % 1_000_000,
        };
        set({ ...buildInitialState(merged.seed, merged) });
      },

      selectFamily: (family) => {
        set({ ...startGame(get(), family) });
      },

      setPanel: (panel) =>
        set((s) => ({
          activePanel: panel,
          hitTargetPreviewId: panel === "hit_planner" ? s.hitTargetPreviewId : null,
          supplyRouteFocusId: panel === "warehouse" ? s.supplyRouteFocusId : null,
          supplyRoutePreview: panel === "warehouse" ? s.supplyRoutePreview : null,
        })),

      selectTerritory: (id, opts) => {
        const s = get();
        const focus =
          id && opts?.racketId ? focusOnRacket(s, id, opts.racketId) : null;
        set({
          ...flyTo(s, id, focus),
          selectedTerritoryId: id,
          selectedCrewId: null,
          hitTargetPreviewId: null,
          supplyRouteFocusId: null,
          supplyRoutePreview: null,
          focusReason: null,
          activePanel: id
            ? "district"
            : s.activePanel === "district"
              ? "none"
              : s.activePanel,
        });
        if (id && opts?.toastLabel) {
          toast(opts.toastLabel, { description: turfLabel(s, id) });
        }
      },

      clearFlyTo: () => set({ flyToTerritoryId: null, flyToFocus: null }),
      clearHitFx: () => set({ hitFxTerritoryId: null }),
      clearBuildFx: () => set({ buildFx: null }),
      updateSettings: (partial) =>
        set((s) => ({ settings: { ...s.settings, ...partial } })),
      setHitTargetPreview: (id) => set({ hitTargetPreviewId: id }),
      finishCinematic: () => {
        const s = get();
        const [current, ...rest] = s.cinematicQueue;
        if (!current) return;
        stopAll();
        if (current.perspective === "witnessed") {
          // Somebody else's business: no result card. If that was the last
          // reel and meetings are waiting, the sit-down starts now.
          const start = rest.length === 0 && (s.sitdownCinematicQueue?.length ?? 0) > 0;
          set({
            cinematicQueue: rest,
            pendingHitResult: null,
            pendingHitCinematic: null,
            hitFxTerritoryId: null,
            sitdownPhase: start ? (s.settings.skipCinematics ? "table" : "drive") : s.sitdownPhase,
          });
          return;
        }
        set({
          cinematicQueue: rest,
          pendingHitResult: current.result,
          pendingHitCinematic: current,
          hitFxTerritoryId: null,
        });
      },
      selectCrew: (id) => {
        const s = get();
        if (!id) {
          set({ selectedCrewId: null, focusReason: null });
          return;
        }
        const member = s.crew.find((c) => c.id === id);
        const loc = resolveCrewLocation(s, id);
        const reason = LOCATION_REASON_LABEL[loc.reason];
        set({
          selectedCrewId: id,
          activePanel: "crew_sheet",
          focusReason: reason,
          ...flyTo(s, loc.territoryId, loc.territoryId ? focusOnTerritory(s, loc.territoryId) : null),
        });
        if (member && loc.territoryId) {
          toast(`Following ${member.name.split(" ").slice(-1)[0]}`, {
            description: `${turfLabel(s, loc.territoryId)} — ${reason.toLowerCase()}`,
          });
        }
      },

      recruitFromPool: (poolIndex) => {
        const s = get();
        if (!s.playerFamily) return;
        const recruit = s.recruitmentPool[poolIndex];
        if (!recruit) return;
        const cost = recruitPrice(recruit, s.playerFamily);
        if (s.money < cost) return;
        const hired = {
          ...recruit,
          family: s.playerFamily,
          id: `crew_${s.seed}_${s.crew.length}_${Date.now()}`,
        };
        set({
          money: s.money - cost,
          crew: [...s.crew, hired],
          recruitmentPool: s.recruitmentPool.filter((_, i) => i !== poolIndex),
          turnLog: [
            ...s.turnLog,
            {
              id: `log_recruit_${Date.now()}`,
              turn: s.turn,
              category: "system",
              text: `Recruited ${hired.name} for $${cost}.`,
              family: s.playerFamily,
            },
          ],
        });
      },

      refreshRecruitment: () => {
        const s = get();
        if (!s.playerFamily || s.money < 200) return;
        const rng = createRng(s.seed + s.turn * 997 + 3);
        set({
          money: s.money - 200,
          recruitmentPool: generateRecruitmentPool(rng, s.playerFamily, 5, recruitTier(s.reputation.respect)),
        });
      },

      promote: (crewId, toRole) => {
        const s = get();
        const member = s.crew.find((c) => c.id === crewId);
        if (!member || member.family !== s.playerFamily) return;
        const check = canPromote(member, toRole, s.crew, s.money);
        if (!check.ok) {
          toast.error("Cannot promote", {
            description: check.reasons.filter((r) => !r.met).map((r) => r.label).join(" · "),
          });
          return;
        }
        set({
          money: s.money - check.cost,
          crew: promoteCrew(s.crew, crewId, toRole, s.turn),
        });
        toast.success(`${member.name} promoted to ${toRole.replace("_", " ")}`, {
          description: `−$${check.cost}`,
        });
      },

      assignMember: (crewId, assignment) => {
        const s = get();
        set({
          crew: assignCrew(s.crew, crewId, assignment),
          territories: s.territories.map((t) => {
            let garrisonIds = t.garrisonIds.filter((id) => id !== crewId);
            if (assignment.type === "garrison" && assignment.territoryId === t.id) {
              garrisonIds = [...garrisonIds, crewId];
            }
            // Clear manager if reassigned away from racket
            const rackets = t.rackets.map((r) =>
              r.managerId === crewId && assignment.type !== "racket"
                ? { ...r, managerId: null }
                : r,
            );
            return { ...t, garrisonIds, rackets };
          }),
        });
      },

      assignManager: (territoryId, racketId, crewId) => {
        const s = get();
        if (!s.playerFamily) return;
        const t = s.territories.find((x) => x.id === territoryId);
        const racket = t?.rackets.find((r) => r.id === racketId);
        if (!t || !racket || t.owner !== s.playerFamily) return;

        let crew = s.crew;
        // Free previous manager
        if (racket.managerId) {
          const prev = crew.find((c) => c.id === racket.managerId);
          if (prev && (!crewId || prev.id !== crewId)) {
            crew = assignCrew(crew, prev.id, { type: "idle" });
          }
        }

        if (crewId) {
          const member = crew.find((c) => c.id === crewId);
          if (
            !member ||
            member.family !== s.playerFamily ||
            member.status !== "active" ||
            member.role === "boss" ||
            member.assignment.type === "operation" ||
            member.assignment.type === "surveillance"
          ) {
            return;
          }
          crew = assignCrew(crew, crewId, {
            type: "racket",
            territoryId,
            racketId,
          });
        }

        set({
          crew,
          territories: s.territories.map((terr) => {
            let garrisonIds = terr.garrisonIds;
            if (crewId) garrisonIds = garrisonIds.filter((id) => id !== crewId);
            const rackets = terr.rackets.map((r) => {
              if (r.id === racketId) return { ...r, managerId: crewId };
              if (crewId && r.managerId === crewId) return { ...r, managerId: null };
              return r;
            });
            return { ...terr, garrisonIds, rackets };
          }),
        });
      },

      buildRacket: (territoryId, type) => {
        const s = get();
        if (!s.playerFamily) return;
        const t = s.territories.find((x) => x.id === territoryId);
        if (!t || t.owner !== s.playerFamily) return;
        const slots = maxRacketsFor(t);
        if (t.rackets.length >= slots) {
          toast.error(`No room — ${slots}/${slots} rackets`);
          return;
        }
        if (!allowedRacketTypes(t).includes(type)) {
          toast.error(lotTierHint(lotTier(t)) || "This lot cannot hold that racket");
          return;
        }
        const bossHere = bossPresentIn(s, s.playerFamily, territoryId);
        const cost = presenceBuildCost(RACKET_BUILD_COST[type] ?? 2000, bossHere);
        const pay = racketPayment(type, cost, s.money, s.dirtyMoney);
        if (!pay) {
          toast.error("Not enough cash for this racket");
          return;
        }
        const racket = createRacket(`rkt_${Date.now()}`, territoryId, type, 1, s.turn);
        const income = racketIncome(racket, 0, null, undefined, bossHere);
        const flavor = incomeFlavor(type);
        const paid = formatPaymentParts(pay) + (bossHere ? " · boss's discount" : "");
        set({
          money: s.money - pay.clean,
          dirtyMoney: s.dirtyMoney - pay.dirty,
          territories: s.territories.map((x) =>
            x.id === territoryId ? { ...x, rackets: [...x.rackets, racket] } : x
          ),
          buildFx: {
            territoryId,
            racketId: racket.id,
            nonce: Date.now(),
            kind: "build",
            type,
            level: 1,
          },
          ...flyTo(s, territoryId),
        });
        const legitHint = isLegitBusiness(type)
          ? " · Set it up as a laundering site from the district panel"
          : "";
        toast.success(`${RACKET_LABELS[type]} opened in ${t.name}`, {
          description: `+$${income}/turn ${flavor} income (${bossHere ? "boss on the block" : "unmanaged"})${paid ? ` · ${paid}` : ""}${legitHint}`,
        });
      },

      upgradeRacketAt: (territoryId, racketId) => {
        const s = get();
        const t = s.territories.find((x) => x.id === territoryId);
        const r = t?.rackets.find((x) => x.id === racketId);
        if (!t || !r || t.owner !== s.playerFamily) return;
        if (r.level >= 5) return;
        if (isRacketFrozen(r, s.turn)) {
          toast.error("Business is frozen by Treasury audit");
          return;
        }
        const bossHere = !!s.playerFamily && bossPresentIn(s, s.playerFamily, territoryId);
        const pay = racketPayment(r.type, presenceBuildCost(r.upgradeCost, bossHere), s.money, s.dirtyMoney);
        if (!pay) {
          toast.error("Not enough cash to upgrade");
          return;
        }
        const upgraded = upgradeRacket(r, s.turn);
        const paid = formatPaymentParts(pay) + (bossHere ? " · boss's discount" : "");
        set({
          money: s.money - pay.clean,
          dirtyMoney: s.dirtyMoney - pay.dirty,
          territories: s.territories.map((x) =>
            x.id === territoryId
              ? {
                  ...x,
                  rackets: x.rackets.map((rr) => (rr.id === racketId ? upgraded : rr)),
                }
              : x
          ),
          buildFx: {
            territoryId,
            racketId,
            nonce: Date.now(),
            kind: "upgrade",
            type: r.type,
            level: upgraded.level,
          },
          ...flyTo(s, territoryId),
        });
        toast.success(`${RACKET_LABELS[r.type]} upgraded to Lv ${upgraded.level}`, {
          description: `${t.name} — +$${racketIncome(upgraded)}/turn${paid ? ` · ${paid}` : ""}`,
        });
      },

      startDelivery: (driverId, sourceId, destId, cargo) => {
        const s = get();
        if (!s.playerFamily) return;
        if (cargo <= 0) {
          toast.error("Need at least 1 crate");
          return;
        }
        const path = findDeliveryPath(s.territories, sourceId, destId, s.playerFamily, true);
        if (!path || path.length < 2) {
          toast.error("No route between those districts");
          return;
        }
        const src = s.territories.find((t) => t.id === sourceId);
        if (!src || src.owner !== s.playerFamily) {
          toast.error("Source must be your district");
          return;
        }
        const dest = s.territories.find((t) => t.id === destId);
        if (!dest || dest.owner !== s.playerFamily) {
          toast.error("Destination must be your district");
          return;
        }
        const lookup = makeManagerLookup(s.crew, s.playerFamily);
        if (!hasManagedWarehouse(src, lookup, s.turn)) {
          toast.error("Source needs a managed warehouse");
          return;
        }
        if (
          !hasManagedWarehouse(dest, lookup, s.turn) &&
          !dest.rackets.some((r) => r.type === "speakeasy")
        ) {
          toast.error("Destination needs a managed warehouse or a speakeasy");
          return;
        }
        const wd = withdrawCrates(src, cargo, s.turn);
        if (wd.moved < cargo) {
          toast.error(`Only ${wd.moved} crates available in ${src.name}`);
          return;
        }
        const route = {
          id: `route_${Date.now()}`,
          family: s.playerFamily,
          driverId,
          sourceTerritoryId: sourceId,
          destTerritoryId: destId,
          path,
          cargo: wd.moved,
          status: "active" as const,
        };
        const destName = dest.name;
        set({
          territories: s.territories.map((t) =>
            t.id === sourceId ? wd.territory : t,
          ),
          liquorStock: Math.max(0, s.liquorStock - wd.moved),
          routes: [...s.routes, route],
          crew: assignCrew(s.crew, driverId, {
            type: "delivery",
            routeId: route.id,
            territoryId: sourceId,
          }),
        });
        toast.message("Delivery en route", {
          description: `${wd.moved} crates: ${src.name} → ${destName}`,
        });
      },

      buyWhisky: (destTerritoryId, crates) => {
        const s = get();
        if (!s.playerFamily) return;
        const amount = Math.max(5, Math.round(crates / 5) * 5);
        const dest = s.territories.find((t) => t.id === destTerritoryId);
        if (!dest || dest.owner !== s.playerFamily) {
          toast.error("Pick one of your districts");
          return;
        }
        const lookup = makeManagerLookup(s.crew, s.playerFamily);
        if (!hasManagedWarehouse(dest, lookup, s.turn)) {
          toast.error("Assign a manager to that warehouse first");
          return;
        }
        const { free } = districtStorage(dest, s.turn, lookup);
        if (free < 5) {
          toast.error("No free warehouse space");
          return;
        }
        const qty = Math.min(amount, free);
        const price = supplierPrice(s.seed, s.turn, s.heat.level);
        const cost = qty * price;
        const pay = racketPayment("warehouse", cost, s.money, s.dirtyMoney);
        if (!pay) {
          toast.error(`Need $${cost} (dirty or clean)`);
          return;
        }
        const seizeP = shipmentSeizureChance(s.heat.level, s.bribes);
        const ship = {
          id: `ship_${Date.now()}`,
          crates: qty,
          destTerritoryId,
          arriveTurn: s.turn + 1,
          cost,
        };
        set({
          money: s.money - pay.clean,
          dirtyMoney: s.dirtyMoney - pay.dirty,
          pendingShipments: [...(s.pendingShipments ?? []), ship],
        });
        const paid = formatPaymentParts(pay);
        toast.message(`Whisky ordered — ${qty} crates`, {
          description: `Arrives next turn · ${paid} · ${(seizeP * 100).toFixed(0)}% seizure risk`,
        });
      },

      setLaunderAmount: (racketId, amount) => {
        const s = get();
        const rounded = Math.max(0, Math.round(amount / 50) * 50);
        set({
          launderPlan: {
            ...(s.launderPlan ?? {}),
            [racketId]: rounded,
          },
        });
      },

      clearLaunderPlan: () => set({ launderPlan: {} }),

      suggestSafeSpread: () => {
        const s = get();
        if (!s.playerFamily) return;
        const sites: { id: string; cap: number }[] = [];
        for (const t of s.territories) {
          if (t.owner !== s.playerFamily) continue;
          const bossHere = bossPresentIn(s, s.playerFamily, t.id);
          for (const r of t.rackets) {
            if (!isLegitBusiness(r.type) || isRacketFrozen(r, s.turn)) continue;
            if (!isLaunderSiteSetUp(r)) continue;
            const manager = r.managerId
              ? s.crew.find((c) => c.id === r.managerId && c.status === "active")
              : null;
            sites.push({ id: r.id, cap: launderCap(r, manager, s.turn, bossHere) });
          }
        }
        if (sites.length === 0) {
          toast.message("No laundering sites set up yet", {
            description: "Set up a legit business as a laundering site first.",
          });
          return;
        }
        sites.sort((a, b) => b.cap - a.cap);
        let remaining = s.dirtyMoney;
        const plan: Record<string, number> = {};
        for (const site of sites) {
          if (remaining <= 0) {
            plan[site.id] = 0;
            continue;
          }
          const amount = Math.min(site.cap, remaining);
          const rounded = Math.round(amount / 50) * 50;
          plan[site.id] = rounded;
          remaining -= rounded;
        }
        set({ launderPlan: plan });
        toast.message("Safe spread applied", {
          description: "Each set-up business set to its safe wash cap.",
        });
      },

      setupLaunderSite: (territoryId, racketId) => {
        const s = get();
        if (!s.playerFamily) return;
        const t = s.territories.find((x) => x.id === territoryId);
        const r = t?.rackets.find((x) => x.id === racketId);
        if (!t || !r || t.owner !== s.playerFamily) return;
        if (!isLegitBusiness(r.type)) {
          toast.error("Only legit businesses can launder cash");
          return;
        }
        if (isLaunderSiteSetUp(r)) {
          toast.message("Already set up as a laundering site");
          return;
        }
        if (isRacketFrozen(r, s.turn)) {
          toast.error("Business is frozen by Treasury audit");
          return;
        }
        const manager = r.managerId
          ? s.crew.find((c) => c.id === r.managerId && c.status === "active")
          : null;
        const readyTurn = s.turn + 1;
        const cap = launderCap(r, manager, s.turn, bossPresentIn(s, s.playerFamily, territoryId));
        set({
          territories: s.territories.map((x) =>
            x.id === territoryId
              ? {
                  ...x,
                  rackets: x.rackets.map((rr) =>
                    rr.id === racketId
                      ? { ...rr, launderReadyTurn: readyTurn }
                      : rr,
                  ),
                }
              : x,
          ),
          launderPlan: {
            ...(s.launderPlan ?? {}),
            [racketId]: cap,
          },
        });
        toast.message(`Books opening at ${RACKET_LABELS[r.type]}`, {
          description: `Washing starts next turn · queued $${cap}`,
        });
      },

      stopLaunderSite: (territoryId, racketId) => {
        const s = get();
        if (!s.playerFamily) return;
        const t = s.territories.find((x) => x.id === territoryId);
        const r = t?.rackets.find((x) => x.id === racketId);
        if (!t || !r || t.owner !== s.playerFamily) return;
        if (!isLaunderSiteSetUp(r)) return;
        const nextPlan = { ...(s.launderPlan ?? {}) };
        delete nextPlan[racketId];
        set({
          territories: s.territories.map((x) =>
            x.id === territoryId
              ? {
                  ...x,
                  rackets: x.rackets.map((rr) => {
                    if (rr.id !== racketId) return rr;
                    const { launderReadyTurn: _drop, ...rest } = rr;
                    return rest;
                  }),
                }
              : x,
          ),
          launderPlan: nextPlan,
        });
        toast.message(`${RACKET_LABELS[r.type]} no longer laundering`, {
          description: t.name,
        });
      },

      planPlayerHit: (args) => {
        const s = get();
        if (!s.playerFamily) return;
        const territory = s.territories.find((t) => t.id === args.targetTerritoryId);
        const rivalFamily =
          (args.targetCrewId
            ? s.crew.find((c) => c.id === args.targetCrewId)?.family
            : null) ??
          (territory?.owner && territory.owner !== s.playerFamily ? territory.owner : null);
        if (!rivalFamily) return;
        if (!args.blind && !args.targetCrewId) return;
        if (inTruce(s, s.playerFamily, rivalFamily)) {
          toast.error("You gave your word", {
            description: `A truce holds with ${rivalFamily}. Break it from the Commission panel first.`,
          });
          return;
        }

        const target = args.targetCrewId
          ? s.crew.find((c) => c.id === args.targetCrewId)
          : undefined;

        if (args.intent === "message") {
          if (!target || !isMessageTargetRole(target)) {
            toast.error("A message goes to a hitman, consigliere, underboss or senior capo — not the boss, not a soldier.");
            return;
          }
          if (!routeDisputeWith(s, rivalFamily)) {
            toast.error(`No route beef with ${rivalFamily} to make a point about.`);
            return;
          }
        }

        const assignedIds = hitCrewIds({
          id: "draft",
          family: s.playerFamily,
          kind: "hit",
          targetTerritoryId: args.targetTerritoryId,
          targetFamily: rivalFamily,
          approach: args.approach,
          shooterIds: args.shooterIds,
          wheelmanId: args.wheelmanId,
          lookoutId: args.lookoutId,
          bombMakerId: args.bombMakerId,
          planterId: args.planterId,
          negotiatorId: args.negotiatorId,
          surveilled: false,
          pendingTurns: 1,
          resolved: false,
        });

        const originLead = assignedIds[0]
          ? s.crew.find((c) => c.id === assignedIds[0])
          : undefined;
        const originTerritoryId =
          (originLead && resolveCrewTerritoryId(s, originLead.id)) ||
          s.territories.find((t) => t.owner === s.playerFamily && t.isStrategic)?.id ||
          s.territories.find((t) => t.owner === s.playerFamily)?.id ||
          args.targetTerritoryId;

        const rng = createRng(
          s.seed + s.turn * 77 + (args.targetCrewId?.length ?? territory?.name.length ?? 3),
        );
        const op = planHit(
          s,
          {
            family: s.playerFamily,
            targetCrewId: args.blind ? undefined : args.targetCrewId,
            targetTerritoryId: args.targetTerritoryId,
            originTerritoryId,
            targetFamily: rivalFamily,
            approach: args.approach,
            shooterIds: args.shooterIds,
            wheelmanId: args.wheelmanId,
            lookoutId: args.lookoutId,
            bombMakerId: args.bombMakerId,
            planterId: args.planterId,
            negotiatorId: args.negotiatorId,
            surveilled: false,
            pendingTurns: args.surveilFirst ? 2 : 1,
            blind: !!args.blind,
            intent: args.intent,
            motive: args.intent === "message" ? "route_dispute" : undefined,
          },
          rng,
        );
        let crew = s.crew;
        for (const id of assignedIds) {
          crew = assignCrew(crew, id, {
            type: args.surveilFirst ? "surveillance" : "operation",
            operationId: op.id,
            territoryId: args.targetTerritoryId,
          });
        }
        const label = args.blind
          ? `Blind hit on ${territory?.name ?? "district"}`
          : target?.name ?? "target";
        const brokePact = hasPact(s, s.playerFamily, rivalFamily);
        const committed = brokePact ? breakPact(s, rivalFamily) : s;
        set({
          ...committed,
          operations: [...committed.operations, op],
          crew,
          activePanel: "none",
          hitTargetPreviewId: null,
          turnLog: [
            ...committed.turnLog,
            {
              id: `log_plan_${op.id}`,
              turn: s.turn,
              category: "hit",
              text: args.surveilFirst
                ? `Surveillance started on ${label}. Hit pending.`
                : args.blind
                  ? `Blind hit on ${territory?.name ?? "district"} is set for next turn.`
                  : `Hit on ${label} is set for next turn.`,
              family: s.playerFamily,
            },
          ],
        });
        toast.message(
          args.intent === "message"
            ? "Message ordered"
            : args.surveilFirst
              ? "Surveillance ordered"
              : args.blind
                ? "Blind hit planned"
                : "Hit planned",
          { description: `${label} — route marked on the map` },
        );
        if (brokePact) {
          toast.warning(`You broke your word with ${rivalFamily}.`);
        }
      },

      establishSupplyRoute: (args) => {
        const s = get();
        if (!s.playerFamily) return;
        const rng = createRng(hashString(`${s.seed}:supply:${s.turn}:${args.path.join(">")}`));
        const result = establishSupplyRoute(s, args, rng);
        if (result.error || !result.route) {
          toast.error(result.error ?? "Couldn't open that route");
          return;
        }
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, ...result.logs].slice(-200),
          // Keep the new road on the map once the picker closes.
          supplyRouteFocusId: result.route.id,
          supplyRoutePreview: null,
        });
        const src = s.territories.find((t) => t.id === args.sourceTerritoryId)?.name;
        const dest = s.territories.find((t) => t.id === args.destTerritoryId)?.name;
        if (result.route.status === "negotiating") {
          toast.warning("Route waits on passage", {
            description: `${result.route.awaitingFamilies.join(", ")} asked to the table in two weeks. Your boss travels.`,
          });
        } else {
          toast.success("Supply route open", {
            description: `${args.cratesPerTurn} crates a week: ${src} → ${dest}${
              result.route.awaitingFamilies.length ? " — running hot" : ""
            }`,
          });
        }
      },

      cancelSupplyRoute: (id) => {
        const s = get();
        set({
          ...cancelSupplyRoute(s, id),
          supplyRouteFocusId: s.supplyRouteFocusId === id ? null : s.supplyRouteFocusId,
        });
        toast.message("Supply route closed");
      },

      setSupplyRouteFocus: (id) => set({ supplyRouteFocusId: id }),
      setSupplyRoutePreview: (preview) => set({ supplyRoutePreview: preview }),

      toggleSupplyRoute: (id) => {
        const s = get();
        const next = toggleSupplyRoute(s, id);
        set(next);
        const r = next.supplyRoutes.find((x) => x.id === id);
        toast.message(r?.status === "suspended" ? "Route held" : "Route rolling again");
      },

      setRouteRunHot: (id, runHot) => {
        const s = get();
        set(setRouteRunHot(s, id, runHot));
        if (runHot) toast.warning("Running hot", { description: "Their men will tax the truck and remember it." });
      },

      reopenPassageTalks: (routeId) => {
        const s = get();
        const rng = createRng(hashString(`${s.seed}:reopen:${routeId}:${s.turn}`));
        const result = reopenPassageTalks(s, routeId, rng);
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, ...result.logs].slice(-200),
        });
        if (result.logs.length) toast.message(result.logs[result.logs.length - 1]!.text);
        else toast.message("Nobody to talk to on that road.");
      },

      answerPassage: (id, answer, offer) => {
        const s = get();
        const rng = createRng(hashString(`${s.seed}:passage:${id}:${answer}:${s.turn}:${JSON.stringify(offer ?? {})}`));
        const result = answerPassage(s, id, answer, offer, rng);
        const queue = (result.state.sitdownCinematicQueue ?? s.sitdownCinematicQueue ?? []).map((c) =>
          c.sitdownId === id && result.result
            ? { ...c, result: result.result, outcome: result.result.success ? ("handshake" as const) : ("walk" as const) }
            : c,
        );
        const onTable = queue.some((c) => c.sitdownId === id);
        set({
          ...result.state,
          sitdownCinematicQueue: queue,
          pendingSitdownResults:
            result.result && !onTable
              ? [...(result.state.pendingSitdownResults ?? []), result.result]
              : result.state.pendingSitdownResults ?? [],
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
        if (result.struck) toast.success("Passage deal struck", { description: result.log.text });
        else if (answer === "walk") toast.warning(result.log.text);
        else toast.message(result.log.text);
      },

      caseDistrict: (territoryId, crewId) => {
        const s = get();
        if (!s.playerFamily) return;
        const territory = s.territories.find((t) => t.id === territoryId);
        if (!territory?.owner || territory.owner === s.playerFamily) return;
        const lookout = s.crew.find(
          (c) =>
            c.id === crewId &&
            c.family === s.playerFamily &&
            c.status === "active",
        );
        if (!lookout) return;

        const rng = createRng(s.seed + s.turn * 91 + territoryId.length);
        const opId = `op_surv_${rng.int(10000, 99999)}`;
        const op = {
          id: opId,
          family: s.playerFamily,
          kind: "surveillance" as const,
          targetTerritoryId: territoryId,
          targetFamily: territory.owner,
          shooterIds: [] as string[],
          lookoutId: crewId,
          surveilled: false,
          tippedOff: false,
          pendingTurns: 1,
          resolved: false,
        };
        set({
          operations: [...s.operations, op],
          crew: assignCrew(s.crew, crewId, {
            type: "surveillance",
            operationId: opId,
            territoryId,
          }),
          turnLog: [
            ...s.turnLog,
            {
              id: `log_case_${opId}`,
              turn: s.turn,
              category: "hit",
              text: `${lookout.name} is casing ${territory.name}.`,
              family: s.playerFamily,
            },
          ],
        });
        toast.message("Surveillance ordered", {
          description: `${territory.name} — report next turn`,
        });
      },

      dismissHitResult: () => {
        const s = get();
        const start = (s.sitdownCinematicQueue?.length ?? 0) > 0 && s.cinematicQueue.length === 0;
        set({
          pendingHitResult: null,
          pendingHitCinematic: null,
          sitdownPhase: start ? (s.settings.skipCinematics ? "table" : "drive") : s.sitdownPhase,
        });
      },

      dismissLookoutReport: () =>
        set((s) => ({
          pendingReports: (s.pendingReports ?? []).slice(1),
        })),

      tryBribe: (type, targetFamily, targetTerritory) => {
        set(attemptBribe(get(), type, targetFamily, targetTerritory));
      },

      chooseEvent: (choiceId) => {
        const s = get();
        if (!s.activeEvent) return;
        const choice = s.activeEvent.choices.find((c) => c.id === choiceId);
        const logLen = s.turnLog.length;
        const next = applyEventChoice(s, s.activeEvent, choiceId);
        set(next);
        const newLogs = next.turnLog.slice(logLen);
        for (const log of newLogs) {
          if (log.category === "event") {
            toast.message(s.activeEvent.title, { description: log.text });
          }
        }
        if (choice?.effects.shipmentDelay && newLogs.length === 0) {
          toast.message("Shipments delayed", {
            description: `Arrivals pushed back ${choice.effects.shipmentDelay} turn(s).`,
          });
        }
      },

      answerCrewRequest: (requestId, answer) => {
        const s = get();
        const { state: next, message } = answerCrewRequest(s, requestId, answer);
        if (next === s) return;
        set(next);
        if (message) {
          if (answer === "approve") toast.success("Done", { description: message });
          else toast.message(answer === "reject" ? "Turned down" : "Later", { description: message });
        }
      },

      joinCrew: (memberId, capoId) => {
        const s = get();
        const check = canJoinCrew(s.crew, memberId, capoId);
        if (!check.ok) {
          toast.error(check.reason ?? "Can't do that");
          return;
        }
        const member = s.crew.find((c) => c.id === memberId);
        const capo = s.crew.find((c) => c.id === capoId);
        const wasAssociate = member?.role === "associate";
        set({
          crew: joinCrew(s.crew, memberId, capoId, s.turn),
          turnLog: [
            ...s.turnLog,
            {
              id: `log_crewjoin_${memberId}_${s.turn}`,
              turn: s.turn,
              category: "system",
              text: wasAssociate
                ? `${member?.name} was made a soldier and put in ${capo?.name}'s crew.`
                : `${member?.name} joined ${capo?.name}'s crew.`,
              family: s.playerFamily ?? undefined,
            },
          ],
        });
        toast.success(`${member?.name} runs with ${capo?.name} now`);
      },

      leaveCrew: (memberId) => {
        const s = get();
        const member = s.crew.find((c) => c.id === memberId);
        if (!member?.capoId) return;
        set({ crew: leaveCrew(s.crew, memberId) });
        toast.message(`${member.name} is on his own again`);
      },

      takeDiplomacy: (action, target) => {
        const s = get();
        const check = canDiplomacy(s, action, target);
        if (!check.ok) {
          toast.error(check.reason ?? "Cannot do that");
          return;
        }
        const rng = createRng(
          hashString(`${s.seed}:diplo:${action}:${target}:${s.turn}`),
        );
        const result = resolveDiplomacy(s, action, target, rng);
        set(result.state);
        if (result.success) toast.message(result.log.text);
        else toast.warning(result.log.text);
      },

      proposeSitdown: (target, venue, party, pick) => {
        const s = get();
        const rng = createRng(hashString(`${s.seed}:sitdown:${target}:${venue}:${s.turn}`));
        const result = proposeSitdown(s, target, venue, rng, party, pick);
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
        if (result.sitdown) toast.message(result.log.text);
        else toast.error(result.log.text);
      },

      answerTable: (id, answer, offer) => {
        const s = get();
        const rng = createRng(
          hashString(`${s.seed}:table:${id}:${answer}:${s.turn}:${JSON.stringify(offer ?? {})}`),
        );
        const result = answerTable(s, id, answer, offer, rng);
        const queue = (result.state.sitdownCinematicQueue ?? s.sitdownCinematicQueue ?? []).map((c) =>
          c.sitdownId === id && result.result
            ? { ...c, result: result.result, outcome: result.result.success ? ("handshake" as const) : ("walk" as const) }
            : c,
        );
        const onTable = queue.some((c) => c.sitdownId === id);
        set({
          ...result.state,
          sitdownCinematicQueue: queue,
          pendingSitdownResults:
            result.result && !onTable
              ? [...(result.state.pendingSitdownResults ?? []), result.result]
              : result.state.pendingSitdownResults ?? [],
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
        if (result.struck) toast.success("Terms struck", { description: result.log.text });
        else if (answer === "walk" || result.walkedOut) toast.warning(result.log.text);
        else toast.message(result.log.text);
      },

      breakDeal: (dealId) => {
        const s = get();
        if (!s.playerFamily) return;
        const result = breakDeal(s, dealId, s.playerFamily);
        if (!result.log) return;
        // The card says the rest.
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
      },

      fulfilLiquorDeal: (dealId) => {
        const s = get();
        const result = fulfilLiquorDeal(s, dealId);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        set({
          ...result.state,
          turnLog: result.log ? [...result.state.turnLog, result.log].slice(-200) : result.state.turnLog,
        });
      },

      dismissDealSettlement: () =>
        set((s) => ({
          pendingDealSettlements: (s.pendingDealSettlements ?? []).slice(1),
        })),

      answerSitdownCounter: (id, accept) => {
        const s = get();
        const result = answerCounter(s, id, accept);
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
        toast.message(result.log.text);
      },

      answerSitdownInvite: (id, answer, venue, party) => {
        const s = get();
        const rng = createRng(hashString(`${s.seed}:invite:${id}:${answer}:${s.turn}`));
        const result = answerInvite(s, id, answer, venue, rng, party);
        set({
          ...result.state,
          turnLog: [...result.state.turnLog, result.log].slice(-200),
        });
        toast.message(result.log.text);
      },

      dismissSitdownResult: () => {
        const s = get();
        const pending = (s.pendingSitdownResults ?? []).slice(1);
        const more = pending.length === 0 && (s.sitdownCinematicQueue?.length ?? 0) > 0;
        set({
          pendingSitdownResults: pending,
          sitdownPhase: more ? (s.settings.skipCinematics ? "table" : "drive") : null,
        });
      },

      openSitdownTable: () => set({ sitdownPhase: "table" }),

      beginSitdownExit: () => set({ sitdownPhase: "exit" }),

      completeSitdownCinematic: () => {
        const s = get();
        const [current, ...rest] = s.sitdownCinematicQueue ?? [];
        if (!current) {
          set({ sitdownPhase: null });
          return;
        }
        set({
          sitdownCinematicQueue: rest,
          sitdownPhase: null,
          pendingSitdownResults: current.result
            ? [...(s.pendingSitdownResults ?? []), current.result]
            : s.pendingSitdownResults ?? [],
        });
      },

      nextTurn: () => {
        const s = get();
        if (!s.playerFamily || s.activeEvent) return;
        if (s.cinematicQueue.length > 0 || s.pendingHitResult) return;
        if ((s.sitdownCinematicQueue?.length ?? 0) > 0 || s.sitdownPhase) return;
        if ((s.pendingSitdownResults?.length ?? 0) > 0) return;
        if ((s.pendingReports?.length ?? 0) > 0) return;
        let cur: GameState = cloneState(s);
        const queued: HitCinematic[] = [];
        const skip = !!cur.settings.skipCinematics;

        // Our jobs go first, before the week turns, so the reel plays on the
        // city as it stands and the result card follows it.
        const ours = resolvePlayerHits(cur, createRng(cur.seed + cur.turn * 131));
        cur = ours.state;
        for (const { op, result, path } of ours.hits) {
          const strike = result.strikeTerritoryId ?? op.targetTerritoryId;
          const cinematic = buildHitCinematic(cur, op, result, "ours", path);

          if (skip) {
            cur = {
              ...cur,
              pendingHitResult: result,
              pendingHitCinematic: cinematic,
              hitFxTerritoryId: strike,
              flyToTerritoryId: strike,
            };
          } else {
            queued.push(cinematic);
          }
        }

        // Rival AI hit FX: flash + toast for non-player resolved hits this turn
        const logLenBefore = cur.turnLog.length;
        const reportsBefore = cur.pendingReports?.length ?? 0;

        cur = endTurn(cur);

        const newLogs = cur.turnLog.slice(logLenBefore);
        const rivalHitLogs = newLogs.filter(
          (l) => l.category === "hit" && l.family && l.family !== cur.playerFamily
        );
        const tipOffLogs = newLogs.filter((l) => l.id.startsWith("tip_"));
        const newReports = (cur.pendingReports ?? []).slice(reportsBefore);

        // Rival-on-rival reels are optional and never survive a full skip.
        const showWitnessed = !skip && (cur.settings.rivalCinematics ?? "brief") !== "off";
        const incoming = (cur.incomingHitReel ?? []).filter(
          (c) => c.perspective !== "witnessed" || showWitnessed,
        );
        const playedIds = new Set<string>([
          ...queued.map((c) => c.operationId),
          ...incoming.map((c) => c.operationId),
        ]);
        if (skip && !cur.pendingHitResult && incoming[0]) {
          const firstIn = incoming[0];
          cur = {
            ...cur,
            pendingHitResult: firstIn.result,
            pendingHitCinematic: firstIn,
            hitFxTerritoryId: firstIn.targetTerritoryId,
            flyToTerritoryId: firstIn.targetTerritoryId,
          };
        }
        const reel = skip ? [] : [...queued, ...incoming];
        if (reel.length > 0) {
          const first = reel[0]!;
          cur = {
            ...cur,
            cinematicQueue: reel,
            // A witnessed reel skips the approach, so open on the block itself.
            flyToTerritoryId:
              first.perspective === "witnessed" ? first.targetTerritoryId : first.originTerritoryId,
            flyToNonce: (cur.flyToNonce ?? 0) + 1,
            pendingHitResult: null,
            pendingHitCinematic: null,
          };
        }
        cur = { ...cur, incomingHitReel: [] };

        cur = applyHostFallout(cur);
        const meetings = buildSitdownCinematics(cur);
        if (meetings.length > 0) {
          const blocked = reel.length > 0 || !!cur.pendingHitResult;
          cur = {
            ...cur,
            sitdownCinematicQueue: meetings,
            sitdownPhase: blocked ? null : skip ? "table" : "drive",
          };
        }

        set(cur);

        for (const log of tipOffLogs) {
          toast.warning("Lookouts report movement", { description: log.text });
        }
        for (const log of rivalHitLogs) {
          const played = [...playedIds].some((id) => log.id.endsWith(id));
          if (played) continue;
          toast.warning(`${log.family} struck`, { description: log.text });
        }
        for (const report of newReports) {
          const district =
            cur.territories.find((t) => t.id === report.territoryId)?.name ?? "district";
          const desc = `${report.spottedIds.length} men, garrison ${report.garrison}`;
          if (report.outcome === "clean") {
            toast.success(`Lookout report — ${district}`, { description: desc });
          } else {
            toast.warning(`Lookout spotted — ${district}`, { description: desc });
          }
        }
        const shakedownLogs = newLogs.filter(
          (l) => l.category === "ai" && l.text.includes("shook down"),
        );
        for (const log of shakedownLogs) {
          const match = log.text.match(/unguarded (.+)\./);
          toast.warning(`Shakedown — ${match?.[1] ?? "district"}`, {
            description: log.text,
          });
        }
        const raidLogs = newLogs.filter((l) => l.id.startsWith("log_raid_"));
        for (const log of raidLogs) {
          toast.error("Warehouse raid", { description: log.text });
        }
        const shipLogs = newLogs.filter(
          (l) =>
            l.id.startsWith("log_ship_") ||
            l.id.startsWith("log_dump_"),
        );
        for (const log of shipLogs) {
          if (log.id.includes("seize") || log.id.includes("dump")) {
            toast.warning(log.id.includes("dump") ? "Backed up" : "Shipment seized", {
              description: log.text,
            });
          } else {
            toast.message("Shipment", { description: log.text });
          }
        }
        const theftLogs = newLogs.filter(
          (l) => l.category === "ai" && l.text.includes("stole") && l.text.includes("crates"),
        );
        for (const log of theftLogs) {
          toast.warning("Crate theft", { description: log.text });
        }
        if ((cur.liquorLedger?.shrunk ?? 0) > 0) {
          toast.warning("Warehouse pilferage", {
            description: `${cur.liquorLedger!.shrunk} crates walked out the back — assign better managers.`,
          });
        }
        const auditLogs = newLogs.filter((l) => l.id.startsWith("log_audit_"));
        for (const log of auditLogs) {
          toast.error("Treasury audit", { description: log.text });
        }
        const rivalAuditLogs = newLogs.filter((l) =>
          l.id.startsWith("log_rival_audit_"),
        );
        for (const log of rivalAuditLogs) {
          toast.message("Street talk", { description: log.text });
        }
        const nudgeLogs = newLogs.filter((l) => l.id.startsWith("log_launder_nudge_"));
        for (const log of nudgeLogs) {
          toast.warning("Dirty cash piling up", {
            description: log.text,
            action: {
              label: "Launder",
              onClick: () => get().setPanel("laundering"),
            },
          });
        }
      },

      payFuneral: (deadCrewId) => {
        const s = get();
        if (s.money < 500) return;
        set({
          money: s.money - 500,
          crew: funeralLoyaltyHit(s.crew, deadCrewId),
          reputation: {
            ...s.reputation,
            loyalty: Math.min(100, s.reputation.loyalty + 3),
          },
        });
      },

      captureTerritory: (territoryId, attackerIds) => {
        const s = get();
        if (!s.playerFamily || attackerIds.length < 1) return;
        if (familyHeadless(s, s.playerFamily)) {
          toast.error("Nobody to order the move", {
            description: "The boss is in the Tombs and no underboss is standing in.",
          });
          return;
        }
        const t = s.territories.find((x) => x.id === territoryId);
        if (!t || t.owner === s.playerFamily) return;
        const allowance = captureAllowance(s, s.playerFamily, t);
        if (!allowance.ok) {
          toast.error("Not this week", { description: allowance.blocked });
          return;
        }
        if (t.owner && inTruce(s, s.playerFamily, t.owner)) {
          toast.error("You gave your word", {
            description: `A truce holds with ${t.owner}. Break it from the Commission panel first.`,
          });
          return;
        }
        const brokePact = !!t.owner && hasPact(s, s.playerFamily, t.owner);
        const base = brokePact && t.owner ? breakPact(s, t.owner) : s;
        const rng = createRng(s.seed + s.turn * 44 + territoryId.length);
        const { state: next, success } = resolveCapture(base, territoryId, attackerIds, rng);
        if (!success) {
          set({ ...next, activePanel: "district" });
          toast.error(`Attack on ${t.name} failed`);
          if (brokePact) toast.warning(`You broke your word with ${t.owner}.`);
          return;
        }
        set({
          ...next,
          activePanel: "district",
          ...flyTo(next, territoryId),
        });
        toast.success(`Took ${t.name} by force`);
        if (brokePact) toast.warning(`You broke your word with ${t.owner}.`);
      },

      saveSlot: (slot) => {
        localStorage.setItem(`commission_save_${slot}`, JSON.stringify(cloneState(get())));
      },

      loadSlot: (slot) => {
        const raw = localStorage.getItem(`commission_save_${slot}`);
        if (!raw) return false;
        try {
          const loaded = JSON.parse(raw) as GameState;
          const plan = loaded.launderPlan ?? {};
          let territories = normalizeTerritoryRackets(
            ensureTerritorySlots(
              loaded.territories ?? [],
              loaded.seed ?? defaultSettings.seed,
            ),
          );
          territories = migrateLaunderSites(
            territories,
            plan,
            loaded.playerFamily ?? null,
          );
          set({
            ...loaded,
            territories,
            launderPlan: pruneLaunderPlan(
              plan,
              territories,
              loaded.playerFamily ?? null,
            ),
            launderNudgeShown: loaded.launderNudgeShown ?? false,
            pendingShipments: loaded.pendingShipments ?? [],
            liquorLedger: loaded.liquorLedger
              ? { ...emptyLiquorLedger(), ...loaded.liquorLedger }
              : null,
            buildFx:
              loaded.buildFx && loaded.buildFx.kind && loaded.buildFx.type
                ? loaded.buildFx
                : null,
            cinematicQueue: loaded.cinematicQueue ?? [],
            incomingHitReel: [],
            pendingHitCinematic: loaded.pendingHitCinematic ?? null,
            settings: {
              ...defaultSettings,
              ...loaded.settings,
              skipCinematics: loaded.settings?.skipCinematics ?? false,
              sfxVolume: loaded.settings?.sfxVolume ?? 0.7,
            },
            flyToNonce: loaded.flyToNonce ?? 0,
            flyToFocus: null,
            supplyRouteFocusId: null,
            supplyRoutePreview: null,
            focusReason: loaded.focusReason ?? null,
            intel: normalizeIntel(loaded.intel),
            grudges: loaded.grudges ?? [],
            incidents: loaded.incidents ?? [],
            rumors: loaded.rumors ?? [],
            captureTally: loaded.captureTally ?? { turn: loaded.turn, byFamily: {} },
            crewRequests: loaded.crewRequests ?? [],
            sitdowns: loaded.sitdowns ?? [],
            pendingSitdownResults: [],
            sitdownCinematicQueue: [],
            sitdownPhase: null,
            deals: loaded.deals ?? [],
            pendingDealSettlements: loaded.pendingDealSettlements ?? [],
            supplyRoutes: loaded.supplyRoutes ?? [],
            passageDeals: loaded.passageDeals ?? [],
            passageLeverage: loaded.passageLeverage ?? {},
            messageHitTurns: loaded.messageHitTurns ?? {},
            pendingReports: loaded.pendingReports ?? [],
            rivalTreasury: loaded.rivalTreasury ?? {},
            rivalInfluence: seedRivalInfluence(loaded.rivalInfluence, loaded.playerFamily),
            bribes: {
              cops: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
              captains: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
              chiefs: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
              mayor: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
              ...loaded.bribes,
              judge: loaded.bribes?.judge ?? {
                isActive: false,
                turnsRemaining: 0,
                cost: 0,
                successRate: 0,
              },
            },
            victory: {
              ...emptyVictory(finalTurnFor(loaded.settings?.gameLength)),
              ...loaded.victory,
              finalTurn:
                loaded.victory?.finalTurn || finalTurnFor(loaded.settings?.gameLength),
              influenceLeadTurns: loaded.victory?.influenceLeadTurns ?? 0,
              wealthLeadTurns: loaded.victory?.wealthLeadTurns ?? 0,
              bankruptTurns: loaded.victory?.bankruptTurns ?? 0,
            },
            diplomacy: {
              pacts: loaded.diplomacy?.pacts ?? {},
              cooldowns: loaded.diplomacy?.cooldowns ?? {},
              hostBans: loaded.diplomacy?.hostBans ?? {},
            },
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    {
      name: "commission-conquest-v4",
      partialize: (s) => {
        const copy = { ...s } as Record<string, unknown>;
        const methods = [
          "newGame",
          "selectFamily",
          "setPanel",
          "selectTerritory",
          "clearFlyTo",
          "clearHitFx",
          "clearBuildFx",
          "finishCinematic",
          "updateSettings",
          "setHitTargetPreview",
          "selectCrew",
          "recruitFromPool",
          "refreshRecruitment",
          "promote",
          "assignMember",
          "assignManager",
          "buildRacket",
          "upgradeRacketAt",
          "startDelivery",
          "buyWhisky",
          "setLaunderAmount",
          "clearLaunderPlan",
          "suggestSafeSpread",
          "setupLaunderSite",
          "stopLaunderSite",
          "planPlayerHit",
          "establishSupplyRoute",
          "cancelSupplyRoute",
          "toggleSupplyRoute",
          "setRouteRunHot",
          "reopenPassageTalks",
          "setSupplyRouteFocus",
          "setSupplyRoutePreview",
          "answerPassage",
          "caseDistrict",
          "dismissHitResult",
          "dismissLookoutReport",
          "tryBribe",
          "chooseEvent",
          "answerCrewRequest",
          "joinCrew",
          "leaveCrew",
          "takeDiplomacy",
          "nextTurn",
          "payFuneral",
          "captureTerritory",
          "saveSlot",
          "loadSlot",
        ];
        for (const m of methods) delete copy[m];
        return copy as GameState;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<GameState>;
        const seed = p.seed ?? current.seed ?? defaultSettings.seed;
        const plan = p.launderPlan ?? current.launderPlan ?? {};
        let territories = normalizeTerritoryRackets(
          ensureTerritorySlots(
            (p.territories ?? current.territories) as GameState["territories"],
            seed,
          ),
        );
        territories = migrateLaunderSites(
          territories,
          plan,
          p.playerFamily ?? current.playerFamily ?? null,
        );
        return {
          ...current,
          ...p,
          territories,
          launderPlan: pruneLaunderPlan(
            plan,
            territories,
            p.playerFamily ?? current.playerFamily ?? null,
          ),
          launderNudgeShown: p.launderNudgeShown ?? current.launderNudgeShown ?? false,
          pendingShipments: p.pendingShipments ?? current.pendingShipments ?? [],
          liquorLedger: p.liquorLedger
            ? { ...emptyLiquorLedger(), ...p.liquorLedger }
            : current.liquorLedger ?? null,
          buildFx:
            p.buildFx && p.buildFx.kind && p.buildFx.type
              ? p.buildFx
              : null,
          cinematicQueue: p.cinematicQueue ?? [],
          incomingHitReel: [],
          pendingHitCinematic: p.pendingHitCinematic ?? null,
          hitTargetPreviewId: p.hitTargetPreviewId ?? null,
          supplyRouteFocusId: null,
          supplyRoutePreview: null,
          focusReason: p.focusReason ?? null,
          intel: normalizeIntel(p.intel),
          grudges: p.grudges ?? current.grudges ?? [],
          incidents: p.incidents ?? current.incidents ?? [],
          rumors: p.rumors ?? current.rumors ?? [],
          captureTally:
            p.captureTally ?? current.captureTally ?? { turn: p.turn ?? 0, byFamily: {} },
          crewRequests: p.crewRequests ?? current.crewRequests ?? [],
          sitdowns: p.sitdowns ?? current.sitdowns ?? [],
          pendingSitdownResults: [],
          sitdownCinematicQueue: [],
          sitdownPhase: null,
          deals: p.deals ?? current.deals ?? [],
          pendingDealSettlements: p.pendingDealSettlements ?? [],
          diplomacy: {
            pacts: p.diplomacy?.pacts ?? current.diplomacy?.pacts ?? {},
            cooldowns: p.diplomacy?.cooldowns ?? current.diplomacy?.cooldowns ?? {},
            hostBans: p.diplomacy?.hostBans ?? current.diplomacy?.hostBans ?? {},
          },
          supplyRoutes: p.supplyRoutes ?? current.supplyRoutes ?? [],
          passageDeals: p.passageDeals ?? current.passageDeals ?? [],
          passageLeverage: p.passageLeverage ?? current.passageLeverage ?? {},
          messageHitTurns: p.messageHitTurns ?? current.messageHitTurns ?? {},
          pendingReports: p.pendingReports ?? [],
          rivalTreasury: p.rivalTreasury ?? {},
          rivalInfluence: seedRivalInfluence(p.rivalInfluence, p.playerFamily ?? null),
          bribes: {
            cops: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
            captains: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
            chiefs: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
            mayor: { isActive: false, turnsRemaining: 0, cost: 0, successRate: 0 },
            ...p.bribes,
            judge: p.bribes?.judge ?? {
              isActive: false,
              turnsRemaining: 0,
              cost: 0,
              successRate: 0,
            },
          },
          victory: {
            ...emptyVictory(finalTurnFor(p.settings?.gameLength)),
            ...p.victory,
            finalTurn: p.victory?.finalTurn || finalTurnFor(p.settings?.gameLength),
            influenceLeadTurns: p.victory?.influenceLeadTurns ?? 0,
            wealthLeadTurns: p.victory?.wealthLeadTurns ?? 0,
            bankruptTurns: p.victory?.bankruptTurns ?? 0,
          },
          settings: {
            ...defaultSettings,
            ...(p.settings ?? {}),
            skipCinematics: p.settings?.skipCinematics ?? false,
            sfxVolume: p.settings?.sfxVolume ?? 0.7,
          },
          flyToNonce: p.flyToNonce ?? 0,
          flyToFocus: null,
        };
      },
    }
  )
);
