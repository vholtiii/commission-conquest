# Commission Conquest — Game Mechanics

## Core loop

1. **Player phase** — recruit, assign crew, build/upgrade rackets, plan hits, bribe, capture districts
2. **End turn** — resolve ready hits → rival AI → deliveries → economy → heat → events → relation decay → victory check

## Turn pipeline (`src/engine/turnPipeline.ts`)

Order of resolution each `endTurn`:

1. Tick pending operations (surveillance / hits)
2. Rival AI turns for all non-player families
3. Process delivery routes (hijack / seize / complete)
4. Economy (production, sales, upkeep, laundering capacity)
5. Heat decay + bribe effects + threshold consequences
6. Draw an event if conditions match
7. Soft decay of relations
8. Victory / defeat check
9. Advance calendar and turn counter; append turn log

## Crew (`src/engine/crew.ts`)

Roles: associate → soldier → capo / hitman → underboss / consigliere → boss (succession).

Skills: muscle, stealth, smarts, charm, driving (0–100 scale with role bias).

Traits: marksman, wheelman, hothead, rat_risk, bookkeeper, made_man, ghost, enforcer, smooth_talker — each modifies hit odds, income, loyalty, or heat.

Assignments: idle | garrison | racket | delivery | operation | surveillance.

### XP & levels

`xpForLevel(l) = (l − 1) × 120`, max level 10. Level-ups bump the two top role-biased skills +2.

Sources: hit (+10 / +15 on kill), delivery complete (+5), per-turn assignment (garrison +2, racket manager +3, surveillance +3).

### Promotions (paid clean cash)

| From | To | Cost | Gates |
|------|-----|------|-------|
| associate | soldier | $300 | Lv≥2, loyalty≥40 |
| soldier | capo | $1,200 | Lv≥3, loyalty≥55 |
| soldier | hitman | $1,000 | hits≥3, muscle≥45 |
| hitman | capo | $1,500 | Lv≥4, hits≥6, loyalty≥55 |
| capo | underboss | $2,500 | Lv≥5, loyalty≥65, hits≥2, seat empty |
| capo | consigliere | $2,500 | Lv≥4, smarts≥50, loyalty≥65, seat empty |

Underboss → boss is succession only (not a button).

### Succession (`src/engine/succession.ts`)

When a boss dies, a ready underboss (active, loyalty≥60, Lv≥5, held rank ≥2 turns) takes the chair. Player succession: respect −10, family loyalty −5. No ready heir: player loses; rival turf gets `leadershipVacuum: 2`. Rival families start with an underboss; AI may promote a capo into the empty seat (~30%/turn).

Recruitment pool refreshes each turn (and can be bought early). Dead crew can receive funerals to soften loyalty hits.

## Economy (`src/engine/economy.ts` + `src/engine/liquor.ts`)

Racket types: still, brewery, warehouse, speakeasy, gambling, brothel, loan_shark, plus legit businesses (laundromat, deli, barber, restaurant, trucking).

- **Racket slots = buildings**: each district's max rackets (2–6) comes from how many building blocks it owns on the city grid (`buildingBlocks / 3`, clamped). Bigger blocks hold more rackets and earn more.
- Unmanaged rackets earn **70%**; assigned managers restore 100% + bookkeeper/smooth_talker income traits
- Rival AI pays builds from `rivalTreasury` (seeded at start, credited each economy turn)

### Liquor logistics

Crates live in per-racket `stock` (level-scaled caps). The **Liquor** panel lists **warehouse districts only**. Global `liquorStock` is a derived total for compatibility.

| Site | Cap/lvl | Role |
|------|---------|------|
| Still | 30 | Produces `5 + 3L` crates/turn into own stock; overflow spills to same-district warehouses |
| Brewery | 50 | Produces `8 + 4L` |
| Warehouse | 100 × manager cap mult | **Liquor hub.** Pure storage. Buy target, send/receive deliveries. Needs an assigned manager |
| Speakeasy | 40 | Pulls from warehouses then producers (same district); sells `5 + 2L` at `$15 + 5L`. Dry earns 25% base. Districts without a warehouse stay on the dry trickle |

**Warehouse managers** (smarts + bookkeeper +20, score 0–100):
- No manager: −12% stock/turn pilferage; cannot buy, send, or receive deliveries
- Score &lt; 50: up to −10%/turn pilferage (scales with deficit); no bonuses
- Score ≥ 50: up to +30% capacity and −25% raid odds; no pilferage

Profit vs mismanagement:
- **Backed up**: overflow dumped at $4/crate + 1 heat / 10 crates (no warehouse = dump)
- **Pilferage**: unmanaged/weak managers lose crates every turn
- **Idle capacity**: $0.10 per empty warehouse slot / turn
- **Exposed stash**: +1 heat / 100 crates above a 50-crate allowance (×2 if unguarded)
- **Buy whisky**: dirty-first cash into a **managed** warehouse; arrives next turn; seizure chance 6% (+10% if heat > 50; bribes cut it). No refund on seize
- **Deliveries**: source and dest must both have managed warehouses; deposit into warehouse (speakeasy pulls next turn); overflow street-sold at `$12–20`. Hijack/seize lose crates (+2/+4 heat)
- **Police raid**: at most one / turn, weighted by stash size; manager raidMult applies; seizes 50% of district crates, freezes warehouses 1 turn, +6 heat
- **Rival theft**: unguarded shakedowns can steal crates (`valueScore + crates×5` weighting)
- **Events** move real inventory: crackdown burns/seizes % of stock; speakeasy fire burns that joint's stock; Canadian shipment adds crates (no free dirty payout); dock strike can delay pending shipments; Bad Batch / Rival Truck add dump/haul choices. Choice logs + liquor ledger update
- Ledger + turn log summarize liquor $ and heat each turn (including `shrunk` pilferage)

Clean cash pays bribes, property, and promotions; upkeep prefers clean first.

### Laundering

Dirty cash does not auto-convert. **Set up** a legit business as a laundering site (District panel, Rackets list, or Launder panel) — free, takes one turn for the books to open. Only set-up sites appear in the routing list; route standing orders through the **Launder** panel (per-business $/turn). **Stop** clears the site and its plan; re-setup takes another turn. Starting laundromat/deli begin already ready.

| Business | Build | Clean income/lvl | Cap/lvl | Cut |
|----------|-------|------------------|---------|-----|
| Laundromat | $1500 | $60 | $500 | 10% |
| Corner Deli | $1200 | $70 | $300 | 10% |
| Barber Shop | $900 | $40 | $200 | 8% |
| Restaurant | $2500 | $120 | $600 | 15% |
| Trucking Co. | $3200 | $150 | $900 | 18% |

- Cap = `capPerLevel × level × managerCapMult × earlyGameMult` (×1.5 through turn 5). Bookkeeper +25% cap / −25% audit odds; smarts adds more.
- **Fill order**: under-cap sites fill first; when dirty runs short the greediest over-cap site starves.
- Over-wash audit chance: `(0.35×over + 0.15×scrutiny) × heatMult × bribeMult × managerAuditMult`, capped at 65%. Heat above 40 raises odds; chiefs bribe ×0.7, mayor ×0.5.
- Freeze on audit: over &lt; 0.5 → 1 turn + half seized; &lt; 1.5 → 2 turns + full; else 3 turns + full. Heat +4/+8/+12. Frozen businesses earn nothing and cannot upgrade.
- **Suggest safe spread** fills every set-up, unfrozen site to its cap without exceeding current dirty cash.
- Rival rumors: ~4%/turn (×1.5 at heat ≥ 60) a rival legit site freezes 2 turns and their treasury takes a hit.

**Build / upgrade funding**:

| Flavor | Types | Pays with |
|--------|-------|-----------|
| Clean | laundromat, deli, barber, restaurant, trucking | Clean money only |
| Dirty | gambling, brothel, loan_shark | Dirty money only |
| Mixed | still, brewery, warehouse, speakeasy | Either pool (dirty first, clean covers the rest) |

## Territory value (`src/engine/territoryValue.ts`)

District value is how many rackets you can build there — derived from the Voronoi city layout for the game seed.

- Rival AI weights racket builds toward districts with open slots, expands toward high `valueScore` (slots × 200 + baseIncome + income strategic bonus) relative to softness, and garrisons big blocks preferentially.
- **Shakedown**: economic / expansionist / volatile rivals can skim an adjacent enemy district that has rackets but no active garrison (~60% success, half of racket income stolen; 25% chance to drop the top racket one level). Guard your rackets.

## Hits (`src/engine/hitOps.ts`)

Approaches:

| Approach          | Style                         | Heat | Garrison exposure |
|-------------------|-------------------------------|------|-------------------|
| Ambush            | Stealth + power               | Med  | Full (1.0)        |
| Drive-by          | Fast, louder                  | High | High (0.7)        |
| Car Bomb          | High power                    | Very high | Low (0.25)   |
| Sit-down Betrayal | High stealth if charm strong  | Low–med | Medium (0.35) |

### Odds

- Role skills with **diminishing returns** on extra shooters (`1, 0.6, 0.35, …`)
- Target stealth / boss / ghost traits
- District defense bonus
- **Garrison**: active soldiers of the target family on the district (excludes the mark). Scaled by approach exposure and whether defenders outnumber the exposed hit team
- **Getaway**: BFS hops from origin → target; a wheelman / getaway driver offsets arrest risk. Optional getaway driver on ambush, car bomb, and sit-down
- Surveillance bonus, family hit bonus, heat penalty
- **Tipped off**: −20% if the target family got wind during the pending turn

Team size: each exposed crew beyond 2 adds heat. Bigger teams also put more people in the firefight pool.

### Tip-off

Each turn a hit sits pending, roll tip-off chance from heat, defenders, mark smarts, lookout stealth, and whether you're still casing. Car bomb / sit-down are quieter. Attacker only learns on the result card. If the **player** is the target family, lookouts toast + an amber warning badge on the district.

Rival AI hits now pend 1 turn so you can garrison up.

### Resolution

Outcomes: clean_kill | messy_kill | botched_wounded | botched_arrested | botched_killed | target_escaped.

- Botched branch weights arrest vs death by getaway risk
- Tipped: 35% mark simply never shows (`target_escaped`); botched_killed can read as a trap
- **Firefight**: even on a clean kill, garrison can wound/kill exposed attackers (scaled by exposure, lookout, surveillance, tip-off). Max casualties ≈ half the defenders

Beats: approach → complication → execution → getaway (getaway text changes if garrison returned fire).

Consequences: status changes, vendetta / relation hit, fear + heat, XP, casualty detail (fate + cause), result card UI.

### Blind hits

Strike without naming a mark. Trade-offs:

- −12% odds, tip-off ×0.6, firefight ×0.9 (surprise)
- Engine picks whoever is present (boss weighted highest); empty block → `target_escaped`
- Respect −6, influence −5 (extra −3 if empty), street influence −3; fear ×1.4 on kills / +4 on misses
- Always reveals everyone present afterward ("Spotted" on the result card)

### Fear & influence

- Sit-down betrayal odds gain up to +10% from fear
- Each turn: `influence += respect*0.04 + fear*0.03 + street*0.02 − 2` (0..300)
- Hostile relations decay slower toward neutral when fear ≥ 50
- Bribes weight fear equally with respect (`/400`)

## Intel & fog of war (`src/engine/intel.ts`)

Rival portraits are hidden by default. Map shows family-colored squares only.

**Always visible:** your crew; each rival boss at their HQ (crown badge).

**Reveal sources:**

| Source | Effect | Expiry |
|--------|--------|--------|
| Case district (1 turn lookout) | Records all rivals present; Lookout Report card + district record | Until that crew moves |
| Surveil-first hit | Same when casing finishes (report tagged forHit) | Until move |
| Any resolved hit | Records present rivals | Until move |
| Cops bribe | Whole district faces for 3 turns | Expiry turn |
| Chiefs bribe | Whole family for 7 turns | Expiry turn |

**Lookout reports:** Casing resolves on the next end-turn (tip-off roll + report same turn). Outcome is clean / spotted / spotted_wounded (full intel still recorded when spotted). Report shows faces, garrison, defense, rackets, rival ops staged there, sample ambush odds before→after, and tip-off risk. Persists in `intel.reports[territoryId]` and District / Operations panels.

**Fresh casing bonus (standalone lookout, not Surveil-first):** +6% hit odds when the mark was spotted by surveillance within 2 turns; −3% tip-off chance on that district. Does not stack with the Surveil-first `surveilled` (+12%) flag.

AI shifts garrison ~20%/turn so stale intel expires. Commission panel shows HQ + known/total counts.

## Rival AI (`src/engine/rivalAI.ts`)

Personalities:

- **economic** (Moretti) — rackets and money
- **expansionist** (Valenti) — take neutral / weak districts
- **covert** (Ferraro) — hits, bribes, low heat
- **smuggler** (Salvati) — deliveries and warehouses
- **volatile** (Rinaldi) — aggression and vendettas

AI budget scales with difficulty / `aiAggression`. Rivals fight each other; vendettas escalate retaliation.

## Economy (`src/engine/economy.ts` + `src/engine/liquor.ts`)

See the primary Economy section above for liquor logistics (per-site stock, speakeasy supply, buy whisky, raids, ledger). Legit businesses earn clean income and wash dirty cash via the Launder panel.

**Build / upgrade funding** (same pool rules for both):

| Flavor | Types | Pays with |
|--------|-------|-----------|
| Clean | laundromat, deli, barber, restaurant, trucking | Clean money only |
| Dirty | gambling, brothel, loan_shark | Dirty money only |
| Mixed | still, brewery, warehouse, speakeasy | Either pool (dirty first, clean covers the rest) |

Clean cash pays bribes, property, and promotions; upkeep prefers clean first.

## Territory capture (`src/engine/capture.ts`)

Capture opens a squad picker (idle crew + any garrison already on that block). First pick leads and garrisons on success; others keep their prior assignments. Odds ≈ P(atk×U(0.8,1.2) > def×U(0.8,1.2)) where atk = squad muscle × combat bonus and def = (defender muscle + 40) × (1 + defenseBonus) × 0.7 under leadership vacuum. Fail: +4 heat. Success: flip owner, wound old garrison, +8 heat, +3 fear, +2 street influence.

## Heat & bribes (`src/engine/heat.ts`, `bribes.ts`)

Heat rises from hits, captures, failed bribes, and rackets. Decays each turn; bribes add extra decay and generation reduction.

Thresholds:

- 20 — street patrols
- 40 — raids (income penalty)
- 60 — warrants (jailed risk for high-wanted crew)
- 80 — federal investigation

Bribe tiers: cops / captains / chiefs / mayor (cost, duration, success rate modified by respect/fear/heat).

## Events (`src/engine/events.ts`)

~20 authored templates (informant, judge, Commission summons, union strike, truce offer, family loan, etc.). Drawn from heat, war state, and turn count. Choices apply money/heat/reputation/relation/crew status deltas.

## 3D city (`src/engine/cityLayout.ts`, `src/scene/`)

48×36 block grid. Voronoi assignment from territory `x/y` seeds. Roads between blocks; Hudson / East River / harbor water mask. Instanced procedural buildings with borough height bias. District overlays tinted by owner. HTML markers for rackets/crew/heat. Camera fly-to on selection. Optional Kenney GLBs with procedural fallback.

**Strategic bird's-eye view:** Zooming past ~75 camera distance smoothly tilts toward top-down, pushes fog back, and fades in a flat tile layer over the city (Overview button on the left toolbar jumps there / returns). Camera pitch is distance-driven: ~66° oblique at closest zoom, flattening to top-down at overview height. Discovered districts show owner color + name; unclaimed use a hatched style; undiscovered stay grey unknown tiles (fog of war). Under the district tiles, muted borough tints, boundary lines, and large borough name labels show city geography regardless of discovery. Amber crowns mark each family HQ / boss (your boss crown follows him when he leaves HQ). Normal HTML markers hide while overview is active; click a tile to fly in and exit.

**Racket map feedback:** Player build/upgrade FX wait ~0.8s for the camera fly-in, then play a 1.8s burst (gold rise for builds, type-colored double pulse + "Lv N" chip for upgrades). Racket buildings use type-tinted bodies with emissive floor bands = level; newly built/upgraded rackets keep a pulsing halo and NEW/UPGRADED tag until the next turn. District markers show type icons and a gold pulse when something changed this turn.

## Victory / defeat

**Win:** ≥60% districts owned, or all rival bosses dead, or Commission chair held 10 turns (respect ≥70, fear ≥50, ≥35% territory).

**Lose:** player boss dead/jailed, or money and dirtyMoney both &lt; 0.

## Persistence

Zustand `persist` to localStorage (`commission-conquest-v2`) plus manual save slots via Menu panel.
