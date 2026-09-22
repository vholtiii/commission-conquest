import type { LucideIcon } from "lucide-react";
import {
  Beer,
  Building2,
  Cigarette,
  Dice5,
  FlaskConical,
  Landmark,
  Warehouse,
  CircleDollarSign,
  Shirt,
  Sandwich,
  Scissors,
  UtensilsCrossed,
  Truck,
  Shield,
} from "lucide-react";
import type { RacketType } from "@/types/game";

export interface RacketVisual {
  color: string;
  emissive: string;
  sign: string;
  Icon: LucideIcon;
}

export const RACKET_VISUALS: Record<RacketType, RacketVisual> = {
  still: {
    color: "#8B5A2B",
    emissive: "#c4783a",
    sign: "STILL",
    Icon: FlaskConical,
  },
  brewery: {
    color: "#A67C52",
    emissive: "#d4a574",
    sign: "BREW",
    Icon: Beer,
  },
  warehouse: {
    color: "#5C6B7A",
    emissive: "#8a9aab",
    sign: "STORE",
    Icon: Warehouse,
  },
  speakeasy: {
    color: "#C9A227",
    emissive: "#ffd666",
    sign: "CLUB",
    Icon: Cigarette,
  },
  gambling: {
    color: "#2D8A4E",
    emissive: "#4ade80",
    sign: "CARDS",
    Icon: Dice5,
  },
  brothel: {
    color: "#B83280",
    emissive: "#f472b6",
    sign: "HOUSE",
    Icon: Landmark,
  },
  loan_shark: {
    color: "#D4A017",
    emissive: "#fbbf24",
    sign: "LOANS",
    Icon: CircleDollarSign,
  },
  laundromat: {
    color: "#A8C5D4",
    emissive: "#d6e8f0",
    sign: "WASH",
    Icon: Shirt,
  },
  deli: {
    color: "#C4B08A",
    emissive: "#e8d9b8",
    sign: "DELI",
    Icon: Sandwich,
  },
  barber: {
    color: "#B8A0A8",
    emissive: "#e0c8d0",
    sign: "CUTS",
    Icon: Scissors,
  },
  restaurant: {
    color: "#C9A88A",
    emissive: "#efd4b4",
    sign: "EATS",
    Icon: UtensilsCrossed,
  },
  trucking: {
    color: "#8A9A8A",
    emissive: "#b8c8b8",
    sign: "FREIGHT",
    Icon: Truck,
  },
  safehouse: {
    color: "#5E6770",
    emissive: "#9aa3ab",
    sign: "HIDEOUT",
    Icon: Shield,
  },
};

export function racketIcon(type: RacketType): LucideIcon {
  return RACKET_VISUALS[type]?.Icon ?? Building2;
}
