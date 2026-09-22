/** Photorealistic portrait assets for crew / bosses */

export const CREW_PORTRAITS = [
  "/portraits/portrait-crew-01.png",
  "/portraits/portrait-crew-02.png",
  "/portraits/portrait-crew-03.png",
  "/portraits/portrait-crew-04.png",
  "/portraits/portrait-crew-05.png",
  "/portraits/portrait-crew-06.png",
] as const;

export const BOSS_PORTRAITS: Record<string, string> = {
  Moretti: "/portraits/portrait-boss-moretti.png",
  Valenti: "/portraits/portrait-boss-valenti.png",
  Ferraro: "/portraits/portrait-boss-ferraro.png",
  Salvati: "/portraits/portrait-boss-salvati.png",
  Rinaldi: "/portraits/portrait-boss-rinaldi.png",
};

export function portraitForSeed(seed: number): string {
  const idx = Math.abs(seed | 0) % CREW_PORTRAITS.length;
  return CREW_PORTRAITS[idx]!;
}

export function portraitForCrew(opts: {
  seed: number;
  role?: string;
  family?: string;
  isPlayerBoss?: boolean;
}): string {
  if ((opts.role === "boss" || opts.isPlayerBoss) && opts.family && BOSS_PORTRAITS[opts.family]) {
    return BOSS_PORTRAITS[opts.family]!;
  }
  return portraitForSeed(opts.seed);
}
