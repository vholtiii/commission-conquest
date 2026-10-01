import type { CrewSkills, HitApproach, Operation } from "@/types/game";

export type HitRole =
  | "shooter"
  | "wheelman"
  | "lookout"
  | "bomb_maker"
  | "planter"
  | "negotiator"
  | "backup";

export type HitSkillKey = keyof CrewSkills;

export interface HitRoleSlot {
  role: HitRole;
  label: string;
  hint: string;
  /** Primary skill used for odds / ranking candidates. */
  skill: HitSkillKey;
  multi: boolean;
  required: boolean;
  /** At risk of arrest/death on a botch / firefight. */
  exposed: boolean;
  /** Boss may fill this role (sit-down negotiator). */
  allowBoss?: boolean;
}

export interface HitApproachSpec {
  approach: HitApproach;
  label: string;
  description: string;
  heatHint: number;
  skillsHint: string;
  /** How much district garrison affects odds / return fire (0–1). */
  garrisonExposure: number;
  roles: HitRoleSlot[];
}

const GETAWAY_DRIVER: HitRoleSlot = {
  role: "wheelman",
  label: "Getaway Driver",
  hint: "Optional — cuts arrest risk on long getaways. Extra body adds heat.",
  skill: "driving",
  multi: false,
  required: false,
  exposed: true,
};

export const HIT_APPROACH_SPECS: Record<HitApproach, HitApproachSpec> = {
  ambush: {
    approach: "ambush",
    label: "Ambush",
    description: "Wait in a blind alley and cut them down up close.",
    heatHint: 8,
    skillsHint: "Muscle · Stealth",
    garrisonExposure: 1.0,
    roles: [
      {
        role: "shooter",
        label: "Shooters",
        hint: "Muscle does the killing. Extra bodies add heat and risk.",
        skill: "muscle",
        multi: true,
        required: true,
        exposed: true,
      },
      {
        role: "lookout",
        label: "Lookout",
        hint: "Warns if patrols or backup arrive. Lowers tip-off & firefight risk.",
        skill: "stealth",
        multi: false,
        required: false,
        exposed: true,
      },
      GETAWAY_DRIVER,
    ],
  },
  drive_by: {
    approach: "drive_by",
    label: "Drive-by",
    description: "Roll past slow and empty the magazines from the car.",
    heatHint: 12,
    skillsHint: "Driving · Muscle",
    garrisonExposure: 0.7,
    roles: [
      {
        role: "wheelman",
        label: "Wheelman",
        hint: "Required — the getaway lives or dies with them.",
        skill: "driving",
        multi: false,
        required: true,
        exposed: true,
      },
      {
        role: "shooter",
        label: "Shooters",
        hint: "Gunners in the back seat. Extra bodies add heat.",
        skill: "muscle",
        multi: true,
        required: true,
        exposed: true,
      },
    ],
  },
  car_bomb: {
    approach: "car_bomb",
    label: "Car Bomb",
    description: "Wire a Packard on their usual route. No shootout. On a boss it waits for him to travel.",
    heatHint: 20,
    skillsHint: "Smarts · Stealth",
    garrisonExposure: 0.25,
    roles: [
      {
        role: "bomb_maker",
        label: "Bomb Maker",
        hint: "Builds a clean fuse and charge.",
        skill: "smarts",
        multi: false,
        required: true,
        exposed: false,
      },
      {
        role: "planter",
        label: "Planter",
        hint: "Slips the package onto the mark's car.",
        skill: "stealth",
        multi: false,
        required: true,
        exposed: true,
      },
      {
        role: "lookout",
        label: "Lookout",
        hint: "Watches the street while the plant happens.",
        skill: "stealth",
        multi: false,
        required: false,
        exposed: true,
      },
      GETAWAY_DRIVER,
    ],
  },
  sitdown_betrayal: {
    approach: "sitdown_betrayal",
    label: "Sit-down Betrayal",
    description: "Invite them to talk. Leave them under the table.",
    heatHint: 6,
    skillsHint: "Charm · Muscle",
    garrisonExposure: 0.35,
    roles: [
      {
        role: "negotiator",
        label: "Negotiator",
        hint: "Attends the sit-down. Boss allowed.",
        skill: "charm",
        multi: false,
        required: true,
        exposed: true,
        allowBoss: true,
      },
      {
        role: "backup",
        label: "Hidden Backup",
        hint: "Optional shooters waiting outside. Extra bodies add heat.",
        skill: "muscle",
        multi: true,
        required: false,
        exposed: true,
      },
      GETAWAY_DRIVER,
    ],
  },
  summons: {
    approach: "summons",
    label: "The Call",
    description: "Call one of your own in and have it done in the back room.",
    heatHint: 5,
    skillsHint: "Stealth",
    garrisonExposure: 0,
    roles: [],
  },
};

export function approachSpec(approach: HitApproach): HitApproachSpec {
  return HIT_APPROACH_SPECS[approach];
}

/** All crew IDs assigned to this hit (for XP / assignments). */
export function hitCrewIds(op: Operation): string[] {
  const ids = new Set<string>();
  for (const id of op.shooterIds) ids.add(id);
  if (op.wheelmanId) ids.add(op.wheelmanId);
  if (op.lookoutId) ids.add(op.lookoutId);
  if (op.bombMakerId) ids.add(op.bombMakerId);
  if (op.planterId) ids.add(op.planterId);
  if (op.negotiatorId) ids.add(op.negotiatorId);
  return [...ids];
}

/** Crew at risk of arrest/death on a botched hit or garrison return fire. */
export function exposedCrewIds(op: Operation): string[] {
  const approach = op.approach ?? "ambush";
  const ids: string[] = [];
  switch (approach) {
    case "ambush":
      ids.push(...op.shooterIds);
      if (op.lookoutId) ids.push(op.lookoutId);
      if (op.wheelmanId) ids.push(op.wheelmanId);
      break;
    case "drive_by":
      ids.push(...op.shooterIds);
      if (op.wheelmanId) ids.push(op.wheelmanId);
      break;
    case "car_bomb":
      if (op.planterId) ids.push(op.planterId);
      if (op.lookoutId) ids.push(op.lookoutId);
      if (op.wheelmanId) ids.push(op.wheelmanId);
      break;
    case "sitdown_betrayal":
      if (op.negotiatorId) ids.push(op.negotiatorId);
      ids.push(...op.shooterIds);
      if (op.wheelmanId) ids.push(op.wheelmanId);
      break;
  }
  return [...new Set(ids)];
}

/** Validate required roles are filled for an approach. */
export function missingRequiredRoles(
  approach: HitApproach,
  picks: {
    shooterIds: string[];
    wheelmanId?: string;
    lookoutId?: string;
    bombMakerId?: string;
    planterId?: string;
    negotiatorId?: string;
  },
): string[] {
  const missing: string[] = [];
  const spec = approachSpec(approach);
  for (const slot of spec.roles) {
    if (!slot.required) continue;
    if (slot.multi) {
      if (picks.shooterIds.length === 0) missing.push(slot.label);
    } else {
      const filled =
        (slot.role === "wheelman" && !!picks.wheelmanId) ||
        (slot.role === "lookout" && !!picks.lookoutId) ||
        (slot.role === "bomb_maker" && !!picks.bombMakerId) ||
        (slot.role === "planter" && !!picks.planterId) ||
        (slot.role === "negotiator" && !!picks.negotiatorId);
      if (!filled) missing.push(slot.label);
    }
  }
  return missing;
}
