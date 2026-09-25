# Commission Conquest — Game Mechanics

## Core loop

1. **Player phase** — recruit, assign crew, build/upgrade rackets, plan hits, bribe, capture districts
2. **End turn** — resolve ready hits → rival AI → deliveries → economy → heat → events → relation decay → victory check

## Turn pipeline (`src/engine/turnPipeline.ts`)

Order of resolution each `endTurn`:

1. Release held crew; clear expired trips; stage this week's sit-downs (both bosses travel to the venue)
2. Tick pending operations (surveillance / hits) — an armed car bomb on a boss resolves here if he travelled
3. Rival AI turns for all non-player families (including boss visits and sit-down invitations)
4. Resolve the AI's operations
5. Hold sit-downs (or abort them if a boss didn't make it); passage talks go `at_table` for the player to answer
6. Rumor pass — street whispers about pending hits and open cases
7. Process one-off delivery routes (hijack / seize / complete; player hijacks open cases), then standing **supply routes** (tolls, hot stops, the road, the landing), then expire passage deals and re-call talks for routes that need them
8. Economy (production, sales, upkeep, laundering capacity)
9. Heat decay + bribe effects + threshold consequences
10. Draw an event if conditions match
11. Soft decay of relations
12. Cold-case tick — rumor evidence that didn't hold up fades; unsolved cases go cold
13. Snapshot where every living crew member stands (next week's car bombs compare against it)
14. Victory / defeat check; append turn log

The calendar advances at the very start, so everything above happens on the new turn.

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

### Crews (`src/engine/crews.ts`)

A capo runs a crew of soldiers (`CrewMember.capoId`). Slots: 2, or 3 once the capo is level 5. Only soldiers and associates can join; an associate is made a soldier on the way in (no $300 fee). A man already in another crew is spoken for — `canJoinCrew` refuses him ("cut him loose first"), so no capo poaches from another crew, and a pending capo request for a man who has since joined someone else expires at turn start. A leader who dies or loses the rank (capo → underboss), or a soldier who is promoted out of the rank, leaves the crew automatically; a capo made consigliere keeps his men.

**The brass run crews too**, each with a fixed school (`crewCurriculum`) instead of the capo's own top skills:

| Leader | Teaches | Slow drip (every 4 turns) | Racket bonus |
|--------|---------|---------------------------|--------------|
| Capo | his two best skills by value | smarts / charm alternating | yes |
| Boss | **muscle + stealth** — the hitman school | driving (wheel time) | no |
| Consigliere | **smarts + stealth** — thinkers | charm | no |

The boss and consigliere teach through their school, not their own hands: their curriculum is taught as if the teacher had at least 60 in it (`SCHOOL_TEACHER_FLOOR`), so a boss with 30 muscle still turns out shooters. A soldier who makes hitman graduates out of the crew. The boss never files a crew request (he *is* the player) — fill his crew from the Crew panel; the consigliere asks like a capo does. Rival bosses and consiglieri fill their crews in the AI pass, taking the loose men strongest in the skill their crew teaches.

**How men get in**

- **The capo asks.** Each turn every active player capo with an open slot rolls `0.15 + charm/400` to ask for a specific man — favoring loose soldiers/associates whose top skill matches his own or who share his block. The ask is a turn-start pop-up: **Approve / No / Later**. "Later" holds it one more turn, then it expires. Turning the same capo down twice running costs him 3 loyalty.
- **Assign directly** from the Crew panel ("Add a man…" per capo; "Cut loose" per soldier). The Family Roster nests each crew under its leader (boss, consigliere, capo) and keeps the Soldiers group for loose men only; each row carries a promote arrow (lit when a promotion is affordable now) and a man's info sheet is where you garrison him, set him to manage a racket, or promote him. The Crew panel itself is recruitment and crews only.
- Rival capos fill their slots quietly each AI turn from the family's loose soldiers.

**What a crew soldier gets, per turn** (`tickCrewMentoring`, paused while the capo is not active)

- **Mentoring**: for each of the capo's two best skills *by value*, chance `0.15 + max(0, capo − soldier)/250` of +1 (cap 0.6). Uncapped — a student can pass his teacher; growth just slows to the 15% floor. Half rate for the first 6 turns after joining.
- **Management drip**: +1 XP, and every 4th turn +1 smarts or charm (alternating).
- **Loyalty drift**: 1/turn toward the capo's loyalty. A rotten capo rots his crew.

**Loose soldiers** (no capo): +8 stealth / +5 smarts when casing (`casingSkills`), +1 stealth after every clean casing, and none of the management drip. Level-ups keep the soldier muscle/stealth bias.

**Rackets**: a capo managing a racket earns more per working crew soldier (active, not on an operation or casing): `1 + men × (0.04 + (smarts + charm)/2000)` — 4–14% per man depending on the capo. Shown as "+X% crew" on the racket row.

### Boss presence (`src/engine/bossPresence.ts`)

Wherever the boss holds court — his standing block, a sit-down trip notwithstanding (`bossPresenceDistrict` ignores `awayAt`) — the family leans in. Every family gets the economic effects; the intel and log lines are the player's. All numbers live in `BOSS_PRESENCE`.

**On his block**

| Effect | Value |
|--------|-------|
| Racket income | ×1.25; an unmanaged racket runs at full instead of 70% |
| Legit fronts | wash cap ×1.25 (and the audit math uses the raised cap) |
| Stills / breweries | +1 crate per level per turn |
| Speakeasies | +1 crate per level pulled, and they pull as if a managed warehouse were local |
| Warehouses | no pilferage, even unmanaged |
| Build / upgrade | 15% off (`presenceBuildCost`) |
| Hitman school | mentoring chance ×2 (cap 0.9) for his crew soldiers garrisoned there |
| Loyalty rally | every active family man on the block (boss aside) gains +1 loyalty a week; +2 once he has held the block 3 weeks (`bossStay` tracks the stay) |

**Next door**

- Captures launched against a district bordering his block: attack strength ×1.2 (`presenceCaptureMods`, shown as a note on the Capture panel).
- Rival blocks bordering his are read for the week (`intel.districtReveal`), and each rival face there has a 35% chance a week of being named (`known`, source `surveillance`).
- Passage terms at a table next to his block: toll and gift ×0.9 (`bossNextDoorToTable`). Hosting on his own block already costs no trip.

**The cost: HQ goes soft.** While his desk is anywhere but the HQ, the HQ loses its own boss bonus, defends at ×0.8, and rival AI's success roll against it drops by 0.1 (it weighs the HQ as a softer target too). Conversely, a block the boss stands on defends at ×1.25 and rivals need +0.1 on the roll to take it. The District panel shows "HQ is soft" on the HQ and lists the live effects under "While he's here" on his block.

Not done: warehouse storage cap is unchanged by presence (only pilferage and the speakeasy pull benefit).

### Succession (`src/engine/succession.ts`)

When a boss dies, a ready underboss (active, loyalty≥60, Lv≥5, held rank ≥2 turns) takes the chair. Player succession: respect −10, family loyalty −5. No ready heir: player loses; rival turf gets `leadershipVacuum: 2`. Rival families start with an underboss; AI may promote a capo into the empty seat (~30%/turn).

A headless rival family doesn't stay frozen: each turn (50%) an interim boss seizes the chair — underboss, else senior capo, else consigliere, else the best soldier — and the vacuum on their turf clears. Until then the family takes no AI actions and its districts are soft.

Recruitment pool refreshes each turn (and can be bought early). Dead crew can receive funerals to soften loyalty hits.

## Economy (`src/engine/economy.ts` + `src/engine/liquor.ts`)

Racket types: still, brewery, warehouse, speakeasy, gambling, brothel, loan_shark, plus legit businesses (laundromat, deli, barber, restaurant, trucking).

- **Racket slots = buildings**: each district's max rackets (2–6) comes from how many building blocks it owns on the city grid (`buildingBlocks / 3`, clamped). Bigger blocks hold more rackets and earn more. An **empty lot** (no building blocks) has 3 hideout slots — still, warehouse, or safehouse only — placed on its open ground and then spread around the district centre; a **sparse lot** (1–2 blocks) has 2 and also allows loan shark, deli, and trucking. Three districts are fixed empty lots (`emptyLot: true` in `territories.json`): **East Village** (in the park), **Bay Ridge** (south Brooklyn waterfront) and **Woodside** (Brooklyn–Queens border). The city grid lays no buildings on a flagged district's blocks, and empty lots start the game **discovered** — vacant ground is public.
- Unmanaged rackets earn **70%**; assigned managers restore 100% + bookkeeper/smooth_talker income traits
- Rival AI pays builds from `rivalTreasury` (seeded at start, credited each economy turn)

### Liquor logistics

Crates live in per-racket `stock` (level-scaled caps). The **Liquor** panel lists **warehouse districts only**. Global `liquorStock` is a derived total for compatibility.

| Site | Cap/lvl | Role |
|------|---------|------|
| Still | 30 | Produces `5 + 3L` crates/turn into own stock; overflow spills to same-district warehouses |
| Brewery | 50 | Produces `8 + 4L` |
| Warehouse | 100 × manager cap mult | **Liquor hub.** Pure storage. Buy target, send/receive deliveries. Needs an assigned manager |
| Speakeasy | 40 | Pulls from warehouses then producers (same district); sells `5 + 2L` at `$15 + 5L` (+`L` more with a managed warehouse on the block). Dry earns 25% base. Districts without local stock need a **supply route** |

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
- **Deliveries** (one-off): source needs a managed warehouse; destination a managed warehouse **or a speakeasy**. Deposit warehouse-first, then bar; overflow street-sold at `$12–20`. Hijack/seize lose crates (+2/+4 heat). A hijacked player truck opens a case (`openIncidentFromHijack`) and the crates are fenced into the hijacker's treasury at `$12` each
- **Local warehouse perk**: a managed warehouse in the same district as a speakeasy adds `+L` crates/turn to the bar's pull and exempts the bar's stock from stash heat

### Supply routes & passage (`src/engine/supplyRoutes.ts`, `src/engine/passage.ts`)

A **supply route** is a standing order: N crates a week from one of your districts (warehouse/still/brewery with stock) to another with a warehouse or speakeasy. Pick a driver (driving skill and the `wheelman` trait lower risk) and optionally an escort (×0.75 risk, exposed to the shooting). The Liquor panel offers up to four **roads**, least to most risk:

| Hop | Base hijack | Notes |
|-----|-------------|-------|
| Own | 1% | plus district heat ×0.003 |
| Unclaimed | 4% | |
| Deal (passage bought) | 3% + defense/2 | garrison counts at ¼ weight |
| Rival | 10% + defense/2 + 2%/man | garrison only known with live intel; else assumed 2 (shown as a 0–4 range) |
| Hostile / war | 16% + defense/2 + 2%/man | |

Run risk is `1 − Π(1 − hop)` × driver/escort multiplier, clamped 2–75%. Roads are labelled **Safe** (own/unclaimed), **Toll** (every rival crossed has a deal) or **Hot** (someone doesn't).

**Choosing a road.** Each road is the cheapest path under a named **strategy** (`routeOptions`, weighted Dijkstra over `adjacentTerritories`; the destination is always enterable):

| Strategy | Block cost | Reads as |
|----------|-----------|----------|
| **Direct** | 1 everywhere | fewest hops, whatever the turf |
| **Home turf** | own 1, unclaimed 2, anyone else's blocked | never leaves your blocks (skipped if impossible) |
| **Toll road** | own 1, unclaimed 2, deal turf 1.5, undealt rival blocked | only crosses families you've paid |
| **Cold road** | 1 + heat/5 | steers around hot districts |
| **Dodge <family>** | that family's turf blocked | avoids your current **threat** (`threatFamily`: worst war/hostile family holding turf, else the top suspect ≥40% on an unanswered hijack in the last 8 turns); skipped if there is none |
| **Detour** | Direct's middle blocks blocked | a second road that shares nothing with Direct, for when the usual way is watched |

The picker is a row of **strategy chips** in a fixed order (`STRATEGY_ORDER`): you pick *how* to run it, not a path. Strategies that land on the same road share it, so clicking Direct may light Home turf and Cold road too ("Same road as Home turf and Cold road"). A strategy with no road here is greyed out with the reason (`strategyUnavailableReason`: "No road stays on your turf", "Nobody to dodge right now", "Only one road between these districts"…). Between adjacent districts there is only one road — the picker says so and the decision is driver and escort, which sit collapsed on one line ("Jimmy drives · no escort · 10 crates/wk — change") with sensible defaults.

**On the map.** While the road picker is open every road on offer is drawn as a dotted grey line across the district centres and the chosen (or hovered) one in dotted purple (`supplyRoutePreview`); under the chips one block shows the chosen road: badge, odds, hop list, the strategy's blurb and its trade-offs relative to the other roads (`+` lowest odds / shortest / never leaves your turf / their men wave you through; `−` riskiest / long haul / no deal / tolls / hostile turf / uncased blocks — lines the strategy already implies are dropped). Clicking a standing route in the Liquor panel traces it in dotted purple (`supplyRouteFocusId`) and lists its hops; a freshly opened route stays traced. Both clear when the panel closes.

**Passage deals.** Opening a route across turf you have no deal for auto-schedules a **passage sit-down** on their turf two weeks out (your boss travels — a car bomb opportunity). At the table the rival names terms (`openingAsk`): toll per crate, a cut of the crates, a gift up front, and a duration. Hostile standing, smugglers and economic families ask more; respect and fear knock the toll down; a landed message hit of yours (leverage, 6 turns) cuts it to 60%. You **accept**, **counter** (they take it by value ratio + standing, else come 40% of the way toward you — twice, then it's their last word) or **walk** (−5 relation; waiting routes sit, or roll hot if flagged). Deals pay the toll every run (dirty first; two unpaid tolls = breach, −12 relation, passage grudge) and skim the cut. A deal-holder who hijacks you voids the deal (−15 relation, case evidence). Expired deals put the route back to the table automatically. Nothing is negotiated at war.

**Running hot.** Each rival family crossed with no deal rolls a stop (`30% + 10%/extra hop`, ×1.3 hostile, ×0.5 under your leverage): their men take 15–30% of the cargo as "tax", −4 relation, and a **passage grudge** (8 turns). Even an unstopped hot run leaves a grudge half the time. On a hot road the family on the turf is the likely hijacker; on a toll road, outsiders are.

### Message hits

Enough passage grudges (volatile/smuggler 1, expansionist/covert 2, economic 3; 6-turn cooldown per family) and the family sends a **message**: an ambush or drive-by on a skilled non-boss of yours — hitman, consigliere, underboss or a capo Lv3+ — planned as `intent: "message"`, `motive: "route_dispute"`, with no public log; only rumors warn you, and they say so ("not the boss they want"). Standing lost is half a normal hit (−12, −8 more on a kill) and no vendetta is declared. The case opens with scene evidence that it was "meant to be read", nudging every family you've run hot past. Afterwards the grudges are spent and the family invites you to **their** table to settle passage on stiff `demanded` terms (toll ×1.4, gift +$400 +$100/grudge).

You can send one too: in the Hit Planner, with a hitman/consigliere/underboss/senior capo targeted and a live route beef with their family (`routeDisputeWith`: a hijack case ≥40% on them, a deal they broke, or a truck their men taxed in the last 8 turns), tick **Send a message**. Respect swings only +3/−2, street influence +4 on a kill, no vendetta, and a kill gives you 6 turns of leverage: cheaper asks, half as many stops.
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

Beats: approach → complication → execution → getaway (getaway text changes if garrison returned fire). The complication is also a key (`dud`, `patrol`, `trap`, …) so the cinematic can act it out.

### Hit cinematics

**When a job goes.** A fresh hit is planned at one week; surveil-first at two. On the Next Turn that finds one of your hits at one week or less, it goes *before* the rest of the week: the final tip-off roll, the resolution, the reel, then the result card, then the turn's other business (rival jobs, the sit-downs, the digest, any newspaper event — all of which wait for the reel and card). Rival hits resolve inside the week and their reels queue behind yours. A boss car bomb that hasn't gone off stays armed and is retried on the next Next Turn. Resolved jobs stay on the books for eight weeks (hidden from the Operations list) so deals, sit-down classification and the "bleeding" read at the table can still see them.

Each approach plays its own scene, about 6–8 seconds, and the scene branches on the outcome and the complication: a car bomb can be a blast, a dud, the wrong Packard, or a cop on the fender; a drive-by can stall, catch a blocked lane, or take return fire; an ambush can freeze for a patrol or walk into a trap; a sit-down can end in a muffled shot or a flipped table. Stylised figures stand in for the crew. A rival hit on your people plays the same way, tagged Incoming on the result card. Sound effects are synthesised (no asset files) and the Menu volume slider turns them down, including off. Skip and Always skip still jump straight to the card.

**Rival-on-rival hits** in any district you've discovered play too, as a "witnessed" reel: only the last two beats (execution and getaway, about 3–3.5 seconds), headed "Valenti on Ferraro · Red Hook" instead of a phase label, and with no result card at the end. The scene is stripped to the shooters and the mark — no garrison returning fire, no escort, no muscle across the street, no backup in the kitchen — and the parked cars on that block go dark for the reel, so you learn nothing about who else was there beyond what the log line already says. Jobs with nothing to see (the mark never showed, the plant was called off) stay a toast. The reel order each turn is your hits, hits on you, then witnessed ones, then the sit-downs. Menu → "Show rival-on-rival hits" turns them off (`rivalCinematics`), as does Skip hit cinematics; "Skip rival hits" on the caption bar does the same mid-reel.

Consequences: status changes, vendetta / relation hit, fear + heat, XP, casualty detail (fate + cause), result card UI. Everyone staged for the job (shooters, wheelman, lookout, bomb team, negotiator) is released to idle once it resolves; the dead are pulled from garrison lists at end of turn.

### Car bomb on a boss

A boss's car only goes up when he uses it. A `car_bomb` aimed at a boss does not resolve on schedule: the package stays armed (up to `CAR_BOMB_ARMED_MAX_TURNS`, 3) and detonates the first turn his location differs from `lastSiteId` — a garrison move, an AI boss's weekly visit, the drive home afterwards, or a sit-down. It goes off at whatever site he travelled to.

Each waiting turn rolls discovery (`0.15 + 0.10×armed turns`, +0.15 if the district is alerted, −bomb-maker smarts/500, capped 0.75). Found, or still waiting at turn 3: the job fizzles (`target_escaped`), +10 heat, the block goes on alert, relations −10, and the planter is jailed 30% of the time (wanted +1 either way). The crew comes home.

### Sit-downs (`src/engine/sitdowns.ts`)

Both bosses attend in person, so the venue decides who travels. `ours` is held at the player's boss's current site (he stays home — a bomb on his car does nothing), `theirs` at the rival boss's site, `neutral` somewhere neither family owns (both travel).

The rival answers a proposed venue immediately: `theirs` always, `neutral` ~80%, `ours` from respect and standing (war refuses; a rival with a car bomb already planted on the player boss refuses outright — a tell). A refusal comes back as a counter-offer. Cost and cooldown are paid on the proposal; cancelling a counter refunds the influence, not the cash.

AI families invite the player (~8%/turn while relations are cold or hostile; 50% when they have a live package on the player boss, always at their place). The player accepts, counters, or declines (−5 relation).

The meeting is held two turns after scheduling (`SITDOWN_LAG`), so a lookout sent the week it is booked reports back before anyone sits down. If either boss is dead, wounded, jailed or held, it is aborted. Otherwise it rolls the old sit-down odds: relation +15 (+10 if they invited you) on success, +3 on failure, respect +2.

Before the turn's other business, both bosses' cars drive to the venue (skipped when cinematics are off, but the table is never skipped). A general meeting plays a short scripted exchange; a passage meeting is the terms negotiation. Leaving the table opens a result card. Sit-down lines lead that week's digest.

**Who you bring.** Up to two soldiers or capos, plus the consigliere if you toggle him. They travel when your boss does, so they count as defenders and can be caught in a betrayal. Each man past the first makes `ours` / `neutral` 15% less likely to be accepted and costs 4% off the sit-down odds. Each man adds 5% to the other side's tip-off if they try a betrayal. The consigliere keeps the +10% odds and, if you have one, reads an armed car bomb as "awfully eager to host" without naming it.

**Casing the venue.** A fresh casing (or a rival's surveillance job) on a sit-down block adds +20% tip-off to a `sitdown_betrayal` or a `car_bomb` that goes off at that meeting.

**Neutral host.** When the neutral block belongs to a third family, they host. Both sides pay $75 clean; the host's treasury takes the $150. If the table turns violent, the betrayer's standing with the host drops 20, the victim's rises 5, and that host refuses the betrayer for 8 turns.

**Passage sit-downs** (`purpose: "passage"`) skip the odds roll: the bosses sit, the rival names a price, and the sit-down stays `at_table` until the player answers terms at the table (see *Supply routes & passage*). They cost nothing to call, ignore the diplomacy cooldown, and are always held on the rival's turf.

### Agenda tables (`src/engine/agendas.ts`, `src/engine/deals.ts`)

The Sit-down button asks what the meeting is **about** before where. "Ease off" is the old single roll. Everything else is a haggle: the rival names terms, the player accepts, counters or walks, and the table stays `at_table` mid-week until he does. Three counters and they leave (cooldown doubled). Cash is signed from the player's side (positive = he pays; he can pay dirty first).

| Agenda | Who can raise it | The ask |
|--------|------------------|---------|
| Truce | either | 4–12 weeks (they open at 6) of no hits and no captures, either way. Cash sweetener: `300 + 100×(their turf − yours) − 200×bleeding`, +200/+400 when hostile/at war, floor 0. A family that has lost two or more men to you in six weeks wants it and prices it at nothing. |
| A district | either | Sale only, never the house. Price: 8× weekly income + what was built there (`RACKET_BUILD_COST × level`), ×1.4 for a block bordering yours, ×1.3 in their HQ borough. When *they* buy one of yours they offer 80% of that. |
| A man held | either | Ransom `300 + 150×level + role bonus` (underboss/consigliere 700, capo/hitman 400, soldier 150). He's home, idle, the moment the deal strikes. |
| End the vendetta | player | `600 + 150×your turf (+100 per hit they haven't landed, up to 3)` cash and 20 standing. The vendetta drops and relations lift to merely cold. |
| A contract | either | Whoever does the job gets paid when a hit of theirs puts one of the target family down (`terms.obligor` is the shooter). When *they* ask, they pay `800 + 120×target turf` for a kill within 6 weeks. When *you* ask, you pick the mark from families neither of you is at peace with and pay 1.25× that, cash on delivery; a shorter deadline costs more. A contracted rival works the hit every week outside its normal action budget (`tryHit` with the contracted target first) unless it has since given that family its word. A contract that runs out is a breach by whoever owed the body; if they owed it, you pay nothing. |
| Liquor | rival | A speakeasy of theirs under 3 crates while you hold 15+ in warehouses: 10 crates within 2 weeks at 1.5× street price. **Send the crates** on the deal card pulls them from your fullest warehouse; the cash lands then. |
| A cut of the take | either | A share (10–50%, they open at 25%) of one district's weekly take (`baseIncome` + racket income) for 4–16 weeks (they open at 8), paid up front. Buying a cut of theirs costs `1.2 × take × share × weeks`; when they buy a cut of yours they offer 0.8×. Only blocks with rackets that you've discovered, one live cut per block. Each week the owner pays the cut out of the take (`weeklyCut`, at that week's take, so a racket built or lost mid-deal changes it). If you can't cover your week it's a breach; if the block changes hands the cut simply ends. |

**Chips.** A counter can add up to 30 standing (+0.5% acceptance per point, spent only if it strikes), a district of yours thrown in (counts at its price), or a favor owed (+15%; recorded as a `favor` deal until called in). Acceptance is `0.55 + (offer − ask) / max(600, |ask|, |ask cash|)` plus relation status, respect/300, personality (economic +5%, volatile −10%), +5% with your consigliere at the table, +15% for a truce they need. Below 60% of the floor the number is an **insult**: −8 relation, and a volatile family gets up 25% of the time. Otherwise a refused counter pulls their ask 35% toward yours (cash, weeks, crates and share all blend).

**Walking in with a number.** The picker shows what they'll likely ask and lets you set an opener; they answer it the moment the bosses sit (struck on the spot, or met with their ask). A subject that is gone by then (district already taken, man released, vendetta over) makes the talk moot: +3 relation and no result.

**Reading the room.** With your consigliere at the table the terms panel shows the odds they take your number and a tell per agenda; without him you get one word (Agreeable / Listening / Hard / Cold).

**Rival asks.** A rival that invites you may have an agenda (`pickRivalAgenda`, in priority): a truce when it is bleeding; liquor when a speakeasy is dry and you're stocked; a man of theirs you're holding; a border district of yours when it's rich and you're two or more blocks behind; a contract on whoever is pressing sudden death; and, 50% of the time when flush (treasury at least twice the price), a cut of your best block clearing $150+/week. The invite says what they want; the number is settled at the table.

**Favors called in (`src/engine/favors.ts`).** A favor you owe sits open until the family has a use for it; from the second week on, each week it has one there is a 12% chance they collect. In priority: a hit on a family they're feuding with (relation below −20) that neither of you is at peace with — a 6‑week contract at $0; eight crates to a dry speakeasy of theirs within 2 weeks, on the house, if you hold 8+; or one of their men you're holding walks free on the spot. The favor closes and the new obligation shows on the deal card marked "for the favor you owed"; doing it earns the usual +10 relation and nothing else, letting it lapse or breaking it is a breach like any other.

**Settlement cards.** Every deal that closes queues a `DealSettlement` (`GameState.pendingDealSettlements`) and gets a card (`DealSettlementModal`) after the week's reels and sit-down results, before the digest: **Deal honored** (what moved, +10 relation), **Word broken** (who broke it, −25 relation, −20 standing when it was you), **Deal ran out** (truces and cuts), and **Favor called in** (what they want, and that it now sits on your books as an obligation). Player-side actions — Break it, Send the crates — show the card immediately. **See deals** opens the Commission panel.

**Deals.** Truces, contracts, liquor orders, cuts and favors are recorded (`GameState.deals`) and listed in the Commission panel with weeks left. A truce makes rival AI skip you for hits, vendetta hits, message hits and captures, and your own hit planner and capture button refuse ("You gave your word") until you **Break it** from the deal card. Breaking any deal, by anyone: −20 standing, −25 relation with the wronged family, −10 with every other family. A hit that lands on a truce partner (even one planned before the handshake) is a breach by the shooter. Rivals tear up a truce at 1–5%/turn by temperament (volatile highest, doubled while in a vendetta). A job owed and not done by the deadline is a breach by whoever owed it.

### Rumors (`src/engine/rumors.ts`)

Each turn, after the AI has planned, the street may whisper about a pending rival hit on the player (30–80% depending on intel, garrison smarts and the rival's personality) at a fidelity from "vague" up to "who ordered it". Some whispers are false, and open cases draw gossip that nudges the suspect board — wrong names fade after two turns (`tickIncidents`). Rumor lines lead the turn digest. An armed car bomb keeps generating them while it waits.

**Moving the boss.** Any owned district's panel has **Move the boss here** (a garrison assignment on the boss). A hit resolves against where the mark *is*, so a boss moved after a rumor leaves the crew an empty chair (`target_escaped`, "he'd already moved on") — unless the rumor says car bomb: the package rides his car and goes off on the drive, so the counter there is to sit still and let it be found. The district panel flags the boss's district in red while a pending-hit rumor names him or it.

**Moving anyone else.** The same panel has **Send a man here…**, a list of your active men who are free to travel (idle, garrisoned or running a racket elsewhere, and not on a job or a trip). Picking one garrisons him here at once. Every made man's car sits on the west kerb of the avenue nearest his district, queued behind the boss's by rank, and when he changes district the car drives there — down the avenue, along a street, up the next avenue, lamps on — then parks (`CrewSedans.tsx`). Paint is rank: boss black with the family colour and a halo (a shade larger than the rest), underboss and consigliere black with a muted family stripe, capo silver, soldier brown, hitman blacked out with no chrome, no whitewalls and no lamps. Associates have no car. Six cars fit a kerb; the rest are round the corner. Rival cars stay boss-only and follow the visibility rules below.

**Underground.** A boss holding court anywhere but his HQ (and not on a public trip) is underground (`isBossUnderground`). A rival planning a hit on him only has his real address if the job was cased (`surveilled`) or the street leaks it (`BOSS_UNDERGROUND_LEAK`, 40%); otherwise they plan on the HQ everyone knows and find nobody. A crew sent to the wrong kerb has no car to wire, so a car bomb picked for a guessed address becomes an ambush there. The cost is the HQ losing his presence as a defender.

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

**Always visible:** your crew. Rival portraits — bosses included — need real intel (a lookout report, a hit, a bribe, or an active district/family reveal). A rival boss's **black sedan** is the public tell instead: it is parked at the kerb of his HQ (crown badge) and, when he travels (`awayAt` for a sit-down or a weekly visit, logged as "was seen in…"), at that district for the week — but the car alone never shows his face. Street sightings are stored as `known[...]` entries with `source: "sighting"`; they place the car, not the portrait.

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

Bosses travel. Each turn an AI boss has a ~25% chance (expansionist/volatile +10, covert −10, only 5% if a tipped-off car bomb is aimed at his family) to spend the week in another district he owns, weighted toward racket-heavy and leaderless blocks, and drives home the week after. Both legs can spring a car bomb. A headless family stays frozen until an interim boss takes the chair.

When the AI aims a hit at a boss it plans on `believedBossSite`: his real location if he is at his HQ, on a public trip, or the job is cased (covert families case 60% of the time); a boss underground elsewhere is found only on a 40% leak, otherwise the crew is sent to the HQ (and a car bomb picked for that guess is downgraded to an ambush — no car to wire).

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

**One district a week.** Every family (player and AI) can take at most one district per turn (`captureAllowance`, tracked in `GameState.captureTally`). A second grab is allowed only when: the family is expansionist (Valenti, always 2 moves), the target is in leadership vacuum, or the target belongs to a family you're in a vendetta with. Never more than two. The check runs before any pact is broken, and the Capture panel shows "Moves this week: n/limit".

## Heat & bribes (`src/engine/heat.ts`, `bribes.ts`)

Heat rises from hits, captures, failed bribes, and rackets. Decays each turn; bribes add extra decay and generation reduction.

Only the **player's** operations draw heat: racket heat per turn = Σ own `heatGen` × `RACKET_HEAT_SCALE` (0.25); rival rackets, dumps and washes add nothing. A hit heats the player fully when the player ordered it, a third when the player was the mark, and not at all for rival-on-rival work; fear / respect / influence swings only apply to the player's own hits.

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

Length is chosen next to difficulty on a new game (short 30 turns, medium 50, long 80) and locked onto `victory.finalTurn`.

**Sudden death (6 weeks on every length, streaks count from turn 10):** influence at least 200 and 1.5× second place, or wealth (clean + dirty at face value) at least $30,000 and 2× second place. Rivals keep a standing pool (`rivalInfluence`), seeded at 120 and spent when they call a sit-down.

**Summit** on the final turn, after the other checks: lead either track by 10% and you win; trail both by more than 10% and you lose; within 10% on both, more districts than every rival wins, otherwise you lose.

**Lose:** the boss is dead and no underboss can take the chair; the boss's 4-turn jail window expires with no ready underboss; or both cash pools stay negative for 3 weeks.

**Succession:** the underboss keeps his loyalty at the boss's funeral (`funeralLoyaltyHit` skips the heir), so a ready heir stays ready at the moment he is needed. Rivals pay the same $800 the player pays for a recruit, out of their treasury.

**Jail:** only the boss gets a window (`jailedUntilTurn`). A ready underboss becomes acting boss (income, presence, captures; no sit-downs or pacts; loyalty −2). With nobody ready the family is headless (no captures, income −25%, loyalty −4, no diplomacy). Buying the judge ($6,000 + $2,000 × wanted, clean cash; mayor bribe adds about +0.35) can spring him. Failure burns the full price. Everyone else who is jailed stays jailed.

## Persistence

Zustand `persist` to localStorage (`commission-conquest-v2`) plus manual save slots via Menu panel.
