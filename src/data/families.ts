import type { FamilyDef } from "@/types/game";
import { FAMILY_HEX } from "@/types/game";

export const FAMILIES: FamilyDef[] = [
  {
    name: "Moretti",
    boss: "Dominic \"Silent Dom\" Moretti",
    description: "Old-money muscle wrapped in union contracts — they own the scaffolds and the silence.",
    specialty: "Construction & Labor",
    color: "commission-burgundy",
    hex: FAMILY_HEX.Moretti,
    personality: "economic",
    bonuses: {
      combatBonus: 0.15,
      incomeBonus: 0.1,
      recruitmentDiscount: 0.05,
      heatReduction: 0.1,
    },
    startingTerritory: "manhattan",
  },
  {
    name: "Valenti",
    boss: "Marco \"Silk\" Valenti",
    description: "Flashy waterfront operators who move freight, favors, and headlines.",
    specialty: "Shipping & Smuggling",
    color: "commission-gold",
    hex: FAMILY_HEX.Valenti,
    personality: "expansionist",
    bonuses: {
      combatBonus: 0.05,
      incomeBonus: 0.2,
      recruitmentDiscount: 0.1,
    },
    startingTerritory: "brooklyn",
  },
  {
    name: "Ferraro",
    boss: "Louis \"Lucky Lou\" Ferraro",
    description: "Quiet deal-makers with judges, captains, and ward bosses on the ledger.",
    specialty: "Politics & Corruption",
    color: "commission-territory",
    hex: FAMILY_HEX.Ferraro,
    personality: "covert",
    bonuses: {
      combatBonus: 0.1,
      incomeBonus: 0.15,
      recruitmentDiscount: 0.15,
      heatReduction: 0.15,
    },
    startingTerritory: "bronx",
  },
  {
    name: "Salvati",
    boss: "Nick \"Harbor\" Salvati",
    description: "Cross-borough runners who live on back roads, warehouses, and midnight boats.",
    specialty: "Narcotics & Smuggling",
    color: "commission-neutral",
    hex: FAMILY_HEX.Salvati,
    personality: "smuggler",
    bonuses: {
      combatBonus: 0.2,
      incomeBonus: 0.05,
      recruitmentDiscount: 0,
      hitBonus: 0.05,
    },
    startingTerritory: "queens",
  },
  {
    name: "Rinaldi",
    boss: "Vince \"Red\" Rinaldi",
    description: "Street enforcers who settle arguments with bats, bullets, and bad tempers.",
    specialty: "Protection & Enforcement",
    color: "destructive",
    hex: FAMILY_HEX.Rinaldi,
    personality: "volatile",
    bonuses: {
      combatBonus: 0.25,
      incomeBonus: 0,
      recruitmentDiscount: 0,
      hitBonus: 0.1,
    },
    startingTerritory: "staten",
  },
];

export function getFamilyDef(name: FamilyDef["name"]): FamilyDef {
  const def = FAMILIES.find((f) => f.name === name);
  if (!def) throw new Error(`Unknown family: ${name}`);
  return def;
}

export const ALL_FAMILY_NAMES = FAMILIES.map((f) => f.name);
