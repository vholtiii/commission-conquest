# Commission Conquest

Turn-based Prohibition-era mafia strategy game. Lead one of New York's Five Families across a low-poly 3D city, run rackets, plan cinematic hits, and outmaneuver rival AI.

## Quick start

```bash
cd commission-conquest-main
npm install
npm run dev
```

Open http://localhost:3000

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS + shadcn/ui
- Three.js via `@react-three/fiber` v8 + `@react-three/drei` v9
- Zustand (persisted game state)
- Pure TypeScript game engine under `src/engine/`

## What's new (City of Gangsters–style overhaul)

- **3D city map** — procedural low-poly blocks with Voronoi districts, roads, water, district overlays, and HTML markers
- **Named crew** — skills, traits, loyalty, wanted level, promotion, permadeath
- **Hit planner** — Ambush / Drive-by / Car Bomb / Sit-down Betrayal with odds breakdown and multi-beat play-by-play
- **Rival AI** — personality-driven families that expand, retaliate, and wage wars without you
- **Bootlegging economy** — stills, warehouses, speakeasies, deliveries with hijack risk, clean vs dirty money
- **Heat & events** — bribes that actually work, raids/warrants/federal pressure, ~20 event cards

## The Five Families (fictional)

| Family   | Personality   | Specialty              | Start        |
|----------|---------------|------------------------|--------------|
| Moretti  | Economic      | Construction & Labor   | Manhattan    |
| Valenti  | Expansionist  | Shipping & Smuggling   | Brooklyn     |
| Ferraro  | Covert        | Politics & Corruption  | The Bronx    |
| Salvati  | Smuggler      | Narcotics & Smuggling  | Queens       |
| Rinaldi  | Volatile      | Protection & Enforcement | Staten Island |

## How to play

1. Pick a family on the title screen.
2. Click districts on the 3D map to garrison, build rackets, capture, or plan hits.
3. Use the left toolbar for Crew, Rackets, Launder, Lawyer, Liquor, Operations, Corruption, Commission, Race, Log, and Menu (save/load).
4. End the turn with **NEXT TURN** — rivals act, deliveries resolve, income/heat/events tick.

### Victory

Streaks open on week 10. Short games need 5 weeks, medium 6, long 8. On Easy a rival needs two more. On Hard you need two more.

- **Standing** — clear the bar for your game length and lead the next family by about half again. Borough seats feed standing.
- **Wealth** — clean cash in full, dirty cash at 55%, four and an eighth times the next family, and clean cash at least 35% of the pile (20% on Easy).
- **Turf** — hold 40% of the city and half again what the next family holds.
- **Last family standing** — every other family is finished.
- **The summit** — on the last week, lead standing or wealth by 10%, or win the district tie-break. On Easy, being first is enough.

The Race button shows how far you are from each, which rival is closing in, and who is already challenging the leader on that track. A rival who holds a streak wins before the summit. From 80% of a bar the other families answer in the same category: dinners for standing, books and raids for wealth, blocks for turf. On Hard they also plan for the summit: over the last quarter of the game, lead or run close on standing or wealth and they work against it the same way.

### Defeat

- The chair stays empty for five weeks, or the boss never leaves the Tombs with no heir ready
- Both coffers stay empty for three weeks
- A rival finishes a standing, wealth, or turf streak
- The summit names someone else

### What's on the street

- **Count house** — dirty cash above $10,000 sits on a block and can be raided, including by one rival against another
- **Borough seats** — most of a borough is a Commission vote and weekly standing. A call between two rivals waits a week for your seat.
- **Heat** — past 40 it cuts illegal income, for you and for the rivals
- **The race** — one click from the toolbar

## Optional Kenney props

Place CC0 Kenney City Kit / Car Kit `.glb` files in `public/models/kenney/` (see `LICENSE.txt` there). Without them the scene uses procedural cars and lamps.

## Project layout

```
src/engine/   # Pure TS: store, turns, hits, AI, economy, heat, events, city layout
src/scene/    # react-three-fiber city view
src/ui/       # Game shell, bars, roster, panels
src/data/     # Families + territories.json
src/types/    # Shared game types
```

See [GAME_MECHANICS.md](./GAME_MECHANICS.md) for detailed systems.
