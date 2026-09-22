import type { Rng } from "./rng";

const FIRST_NAMES = [
  "Vito", "Salvatore", "Angelo", "Dominick", "Frank", "Tony", "Paulie", "Vinny",
  "Joey", "Mikey", "Tommy", "Johnny", "Louie", "Rocco", "Enzo", "Marco",
  "Gino", "Carlo", "Al", "Benny", "Nick", "Eddie", "Bobby", "Jimmy",
  "Antonio", "Francesco", "Giuseppe", "Luigi", "Mario", "Pasquale",
  "Carmine", "Alphonse", "Albert", "Charles", "Joseph", "Michael",
  "Anthony", "Peter", "Richard", "Robert", "Samuel", "Thomas", "William",
  "Dante", "Luca", "Nico", "Santo", "Emilio", "Fabio",
] as const;

const LAST_NAMES = [
  "Moretti", "Valenti", "Ferraro", "Salvati", "Rinaldi",
  "Romano", "Rossi", "Marino", "Conti", "Greco", "Russo", "Bruno",
  "DeLuca", "Esposito", "Ricci", "Santoro", "Vitale", "Bellini",
  "Caruso", "D'Amico", "Fontana", "Gallo", "Lombardi", "Napolitano",
  "Orsini", "Pellegrino", "Quattrochi", "Sorrentino", "Tesoro", "Urbano",
  "Vespa", "Zanetti", "Bianchi", "Costa", "Fabbri", "Giordano",
] as const;

const NICKNAMES = [
  "The Bull", "The Snake", "Silent Dom", "Silk", "Two-Times",
  "The Butcher", "The Ghost", "The Hammer", "The Iceman", "The Professor",
  "The Wolf", "The Fox", "The Count", "The Duke", "The Kid",
  "The Barber", "The Book", "The Driver", "The Mouth", "The Shadow",
  "Harbor", "The Wizard", "The Hat", "The Blade", "The Banker",
  "Red", "Lucky Lou", "No-Nose", "Pretty Boy", "The Quiet One",
] as const;

const SUFFIXES = ["Jr.", "Sr.", "II", "III"] as const;

/** Generate a period-appropriate Italian-American name (fictional) */
export function generateName(rng: Rng, includeNickname = true): string {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  if (includeNickname && rng.chance(0.35)) {
    const nick = rng.pick(NICKNAMES);
    return `${first} "${nick}" ${last}`;
  }
  if (rng.chance(0.15)) {
    return `${first} ${last} ${rng.pick(SUFFIXES)}`;
  }
  return `${first} ${last}`;
}

/** Boss-style formal name */
export function generateBossName(rng: Rng): string {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const nick = rng.pick(NICKNAMES);
  return `${first} "${nick}" ${last}`;
}
