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
3. Use the left toolbar for Crew, Rackets, Operations, Corruption, Commission, Log, and Menu (save/load).
4. End the turn with **NEXT TURN** — rivals act, deliveries resolve, income/heat/events tick.

### Victory

- Control **60%** of districts, **or**
- Eliminate all rival bosses, **or**
- Hold Commission chairmanship for **10** turns

### Defeat

- Your boss is killed/jailed, **or**
- You go bankrupt (clean and dirty cash both below zero)

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
