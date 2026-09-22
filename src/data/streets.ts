/** Period-flavored corridor names for the procedural road grid (1920s NYC-ish). */

export const AVENUE_NAMES = [
  "Riverside Ave",
  "11th Ave",
  "10th Ave",
  "9th Ave",
  "8th Ave",
  "7th Ave",
  "Broadway",
  "6th Ave",
  "5th Ave",
  "Madison Ave",
  "Park Ave",
  "Lexington Ave",
  "3rd Ave",
  "2nd Ave",
  "1st Ave",
  "Avenue A",
  "Avenue B",
  "Avenue C",
  "Avenue D",
  "East End Ave",
  "York Ave",
  "FDR Drive",
  "Outer Ave",
  "Harbor Ave",
] as const;

export const STREET_NAMES = [
  "Battery St",
  "Pearl St",
  "Wall St",
  "Pine St",
  "Cedar St",
  "Liberty St",
  "Fulton St",
  "Beekman St",
  "Canal St",
  "Grand St",
  "Broome St",
  "Spring St",
  "Houston St",
  "Bleecker St",
  "14th St",
  "23rd St",
  "34th St",
  "42nd St",
  "57th St",
  "66th St",
  "72nd St",
  "86th St",
  "96th St",
  "110th St",
  "125th St",
  "145th St",
  "155th St",
  "Dyckman St",
  "207th St",
  "Broadway Cut",
] as const;

export function avenueName(corridorIndex: number): string {
  return AVENUE_NAMES[corridorIndex % AVENUE_NAMES.length]!;
}

export function streetName(corridorIndex: number): string {
  return STREET_NAMES[corridorIndex % STREET_NAMES.length]!;
}
