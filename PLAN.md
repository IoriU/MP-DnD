# Dungeon Delvers: Plan

Tracking what we build. Tick boxes as work lands; update the status in the roadmap table.

**Status:** 🟢 done · 🟡 in progress · ⚪ not started · 🧪 experiment (may be dropped) · ⏸️ parked

## Ground rules

- **$0 forever.** Free, open-source tools only. Host on our own PC. No paid APIs or hosting.
- **No public DNS needed.** Players connect over LAN, Tailscale, or a Cloudflare quick tunnel.
- **The server is the rulebook.** It rolls every die and validates every move. Clients only send intents.
- **AI never makes the rules.** LLMs only narrate; events and encounters are handwritten templates. The server checks and applies everything.
- **The game never waits on AI.** Anything AI-driven runs in the background and has a non-AI fallback.
- **Assets must be CC0, or CC-BY with credit** listed in `CREDITS.md`.
- **Balance numbers live in `shared/rules.ts`** (XP, rewards, monsters), so tuning never needs a code dive.
- **Balance comes last** (decided 2026-10-18). We don't tune numbers until the classes, items and skills are in; that happens in the Balance pass (Phase 13). Until then, bot runs are only for catching crashes and bugs.
- **Auto-play can do everything a player can.** Every new mechanic (skills, positioning, elements, items) must be usable by the auto-play AI, so bot testing keeps working as the game grows.

## The game we're building

A co-op tactical roguelike: a **Slay the Spire–style run map** with **BG3-style turn-based fights**, for a group of friends.

| Decision | Choice | Decided |
|---|---|---|
| Run structure | 3 acts. Each act is a branching node map; the party votes on the path. | 2026-10-18 |
| Nodes | ⚔️ Combat · 💀 Elite · ❓ Event · 🛒 Shop · 🔥 Rest · 💰 Treasure · 👑 Boss (plus ambush variants) | 2026-10-18 |
| Events & encounters | **Handwritten templates, no LLM.** Events are scripted scenes with fixed choices; fights come from named encounter templates per act that scale with party size and map row. | 2026-10-18 |
| Battles | Each node is a room-sized tactical map. The whole party is always in the fight. HP carries over between nodes. | 2026-10-18 |
| Progression | **Keep levels.** XP from fights; the killing blow gets a bonus (friendly kill-steal competition). Each level-up = pick 1 of 3 upgrades. | 2026-10-18 |
| Skill kinds | Three kinds. **Cantrips** use cooldowns (reset every fight). **Spells** spend slots (refill only at rests) and are much stronger. **Passives** are always on. Every class has all three, flavored per class. | 2026-10-18 |
| Skill tiers | Every cantrip, spell and passive has its own tiers: I → II (stronger) → III (**branch**: choose A or B). Split hotbar plus limited passive slots. Separate upgrade pools. | 2026-10-18 |
| Rest | Each hero chooses **Long Rest** (heal + restore all slots) or **Train** (upgrade a cantrip or spell). | 2026-10-18 |
| Elements | DOS2-style surfaces, clouds and status combos (fire, water, ice, lightning, poison, oil). Friendly fire on, with previews. | 2026-10-18 |
| Items | Equipment, consumables, relics; can be given to teammates. | 2026-10-18 |
| Elites | Elite traits. Reward: a party blessing *or* an NPC ally. | 2026-10-18 |
| Positioning | Advantage/disadvantage, auto-facing, back attacks, flanking. | 2026-10-18 |
| Stealth | Approach choice (sneak/charge), surprise rounds, Rogue Hide, ambush nodes. No sneaking-around gameplay. | 2026-10-18 |
| Run length | 3 acts → needs save/resume across sessions. | 2026-10-18 |

**XP rules (starting numbers, all tunable)**
- Each monster has an XP value.
- **Shared base:** every hero still standing in the fight gets an equal share.
- **Killing blow bonus:** the killer gets extra XP on top. This is the kill-steal dynamic.
- **Assist XP:** anyone who damaged the monster gets a small share.
- **Support XP:** healing, reviving and buffing allies earns XP, so the Cleric keeps up.
- **Catch-up:** heroes below the party's highest level gain bonus XP.
- The HUD shows each hero's kills and XP, and the end-of-fight screen calls out "💀 Kill steal!" moments.

**Upgrade pools**

| Pool | Contains | Offered at |
|---|---|---|
| Class | New cantrips and spells for your class, upgrades to ones you own (tier III gated by level) | Level-up |
| Common | +Max HP, +AC, small passives, consumables | Level-up (one card) |
| Elite | Rare skills, relics | Elite reward |
| Boss | Capstone skills, legendary relics | Act boss reward |
| Blessings | Party-wide buffs | Elite reward, shrine events |

Offers are weighted toward skills you already have, so builds come together.

**Skill kinds (starting rules, all tunable)**

| Kind | Cost | Power | Refills |
|---|---|---|---|
| Basic attack | Free | Baseline | — |
| ⏱ Cantrip | Cooldown, 1–3 rounds | ~1.5× a basic attack, often with a utility effect | Cooldowns reset at the start of every fight |
| 🔮 Spell | 1 slot (2 for capstone spells) | ~2–3× a cantrip: area attacks, control, big heals | Long Rest, act boss kill, some events/relics/consumables |
| 🔁 Passive | Always on, no cost | Small constant bonuses, or triggers ("on kill", "when healing", "when flanking") | — |

- **Tiers are independent per skill:** I → II (stronger) → III (branch A or B, gated by hero level). A tier III cantrip still only costs a cooldown; a tier I spell still costs a slot.
- **Every class keeps a free basic attack** (the Wizard gets a staff/dagger strike), since cantrips now have cooldowns.
- **Split hotbar:** e.g. 3 cantrips + 3 spells, so neither kind crowds out the other.
- **Passive slots:** e.g. 2 at the start, +1 at a few level milestones. Taking one past the limit means forgetting one.
- **Max slots grow with level.**
- **Cantrips must carry normal fights,** so players don't hoard slots and play nothing. Spells are for elites, bosses and emergencies.
- **Same mechanic, class flavor:**

| Class | ⏱ Cantrips are called | 🔮 Spells are called | Slots are called |
|---|---|---|---|
| Wizard | Cantrips | Spells | Spell slots |
| Cleric | Cantrips | Prayers | Spell slots |
| Fighter | Techniques | Maneuvers | Grit |
| Rogue | Tricks | Exploits | Cunning |

**Example skills (starting ideas)**

| Class | ⏱ Cantrip: I → II → III-A / III-B | 🔮 Spell: I → II → III-A / III-B |
|---|---|---|
| Wizard | **Fire Bolt:** 1d10 → 2d10 → *Inferno* (ignites the tile) / *Splitting* (hits 2 targets) | **Fireball:** 3d6 radius 1 → 4d6 radius 2 → *Meteor* (huge, 2 slots) / *Delayed Blast* (a trap that explodes later) |
| Cleric | **Sacred Flame:** DEX save, 1d8 → 2d8 → *Searing* (blinds) / *Purge* (strips enemy buffs) | **Healing Word:** 1d4+3 → 2d4+3 → *Mass Healing Word* (all allies in range) / *Second Chance* (overheal becomes temporary HP) |
| Fighter | **Shield Bash:** push 1 + daze → push 2 → *Concussive* (stun) / *Bulwark* (taunts nearby enemies) | **Whirlwind:** hit all adjacent → more damage → *Cyclone* (also pulls enemies in) / *Bladestorm* (hits twice) |
| Rogue | **Feint:** your next attack has advantage → costs only a bonus action → *Mark* (the whole party gets advantage on the target) / *Riposte* (counterattack when missed) | **Shadow Step:** teleport behind a target, attack with advantage → longer range → *Assassinate* (auto-crit on surprised targets) / *Smoke Bomb* (smoke cloud, Phase 5) |

**Example passives (starting ideas)**

| Class | 🔁 Passive: I → II → III-A / III-B |
|---|---|
| Wizard | **Elemental Affinity:** +1 damage with one chosen element → +2 → *Overload* (your element combos hit 50% harder) / *Attunement* (immune to your element's surfaces) |
| Cleric | **Blessed Healer:** when you heal an ally, heal yourself for half → full amount → *Beacon* (healed allies gain +1 AC until your next turn) / *Shepherd* (support XP +50%) |
| Fighter | **Sentinel:** enemies that leave your reach provoke a free attack → that attack stops their movement → *Bodyguard* (take a hit meant for an adjacent ally) / *Cleave* (a kill lets you hit another adjacent enemy) |
| Rogue | **Opportunist:** +2 damage against targets below half HP → +4 → *Executioner* (a killing blow refunds your action: the kill-steal king) / *Evasion* (half damage from area attacks, none on a successful save) |
| Common pool | **Tough** (+max HP) · **Alert** (+initiative, can't be surprised) · **Lucky** (reroll a natural 1 once per fight) · **Bloodthirsty** (heal on a killing blow) · **Steady** (+1 to saves) |

## Roadmap

| # | Phase | Status |
|---|---|---|
| 0 | Foundation (v0.1) | 🟢 |
| 1 | Run loop: act map, room battles, 3 acts | 🟢 |
| 1b | Auto-play (AFK mode, bot players, bot testing) | 🟢 |
| 2 | XP, levels & skill system | 🟢 |
| 3 | Save & resume | ⚪ |
| 4 | Positioning & surprise | ⚪ |
| 5 | Elements & surfaces (DOS2-style) | ⚪ |
| 6 | Items, relics, shop & treasure | ⚪ |
| 7 | Elites, blessings & NPC allies | ⚪ |
| 8 | Real art *(independent; can be done anytime)* | ⚪ |
| 9 | Smarter enemy AI + difficulty | ⚪ |
| 10 | AI Dungeon Master (local LLM) | ⚪ |
| 11 | Experiments: RL enemies/companions, talking NPCs | 🧪 |
| 12 | Content backlog | ⚪ |
| 13 | Balance pass | ⚪ |

---

## Phase 0: Foundation (v0.1) 🟢

Built 2026-10-18.

- [x] Web stack: TypeScript, Phaser 4 client, Node + Socket.IO server, Vite build
- [x] Lobby with 4-letter room codes, invite links, reconnecting to your character after a reload
- [x] 4 classes (Fighter, Rogue, Wizard, Cleric) with 5e-style actions, bonus actions and spell slots
- [x] Turn-based combat: initiative, d20 vs AC, crits, Sneak Attack, saves, death saves
- [x] Basic monster AI, boss with a breath weapon, victory/defeat, back to the tavern
- [x] Free hosting options: LAN, Tailscale, `npm run tunnel`
- [x] `npm run smoke` bot playthrough

Phase 1 replaces the free-roaming dungeon and fog of war. The procedural rooms, field of view and pathfinding code are reused for the room maps.

---

## Phase 1: Run loop: act map, room battles, 3 acts 🟢

**Goal:** a full 3-act run on an StS-style node map. The party votes on its path and fights room-sized battles.

**Act map**
- Grid of rows × 7 columns, generated per act. Several paths run bottom → top and never cross (StS-style).
- Node rules:
  - The first row is all combat.
  - No elites in the first few rows.
  - A treasure row midway.
  - The row before the boss is all rest.
  - No two shops or rests in a row.
- About 12 rows per act to start (tunable). 3 acts, each ending in a boss.

**Acts (tentative themes)**
1. **Goblin Warrens:** rats, kobolds, goblins, archers. Boss: Goblin King.
2. **Forgotten Crypt:** skeletons, spiders, wolves. Boss: a Lich or Bone Knight.
3. **Dragon's Lair:** orcs, ogres, cultists. Boss: the Dread Wyrm.

**Voting**
- Each player clicks a reachable node. Votes show as player-colored dots.
- The vote resolves when everyone has voted, or after a timer.
- A majority wins; a tie is broken at random among the tied nodes.

**Tasks**
- [x] Shared types: `RunState` (act, map, current node, votes), `NodeType`, room state
- [x] Act map generator with the node rules, seeded so a run can be reproduced
- [x] Map screen in the client: nodes, paths, icons, current position, votes, the boss at the top
- [x] Voting on the server, with a timer and tie-break
- [x] Room map generator per node type: combat arena (~16×12 with pillars/obstacles), elite arena, boss arena
- [x] Party spawns on one side, monsters on the other
- [x] Rework combat: always party-wide inside a room; the room ends → back to the map. HP persists.
- [x] Monster pools and boss per act; difficulty rises with act and row
- [x] Encounter templates per act (e.g. *Goblin Patrol*, *Wolf Pack*, *Cult Ritual*), filled up to a threat budget; elites come with their own escorts
- [x] Node types (first version):
  - [x] ⚔️ Combat
  - [x] 💀 Elite (harder fight; special rewards come in Phase 7)
  - [x] 👑 Boss
  - [x] 🔥 Rest: heal 30% and restore slots (the Long Rest vs Train choice arrives in Phase 2)
  - [x] 💰 Treasure: gold/potion for now
  - [x] ❓ Event: event template system + handwritten events with choices and fixed effects (8 to start)
- [x] Defeat = party wipe. Victory = act 3 boss down. Run summary screen.
- [x] Remove the old floor/stairs flow and the free-exploration fog of war
- [x] Update the smoke test bots to vote and play through nodes

**Done when:** a party can play act 1 → act 3 boss on the node map, voting at every step. The bots can complete an act with no server errors.

**Result (2026-10-18):** ✅ Bot parties cleared all 3 acts on the full map (about 25 fights, 39 rooms and up to 11 events per run). There were no server errors, stuck votes or frozen turns in about 50 runs. 25 unit tests cover the map generator, rooms, events and encounter templates.

**Notes**
- Temporary levelling until Phase 2 adds XP: the party levelled up after every elite, every boss and every 3rd regular fight. (Replaced by XP in Phase 2.)
- First balance pass done (rooms capped at 6 monsters, fewer boss helpers, a softer Goblin King, and a 20% "catch your breath" heal after every won fight). Real tuning happens with the Phase 1b balance harness.
- Bot balance check after that pass (6 runs, full map): **4 of 6 won all 3 acts** (all three 4-bot runs, one of three 3-bot runs). The losses all came in the first 2–3 fights at level 1. The difficulty curve is lopsided: **the start is too deadly, the late game too easy** (heroes reach level 12 with nobody dying in act 3). Phase 2's XP curve and the Phase 1b harness should fix both ends.
- Shops aren't generated yet (weight 0); they arrive in Phase 6.

---

## Phase 1b: Auto-play 🟢

**Goal:** any player can hand their hero to the AI with one button. The same server-side AI fills empty seats and plays the bot tests.

**Design**
- **🤖 Auto toggle** in the sidebar (plus a hotkey). It works mid-fight. Auto heroes show a 🤖 tag on their party card and in the turn order; switching Auto on or off is logged.
- **Disconnected players are auto-played** instead of having their turns skipped. They go back to manual when they reconnect, unless they had Auto on.
- **Combat:**
  - heal or revive allies (Cleric first), drink potions when low
  - attack the weakest enemy in reach
  - Wizard keeps its distance; Rogue looks for Sneak Attack positions; Fighter steps in front
  - short pauses between actions so humans can follow what happened
- **Between rooms:** drink potions or heal when low.
- **Votes:**
  - While any human (non-auto) player is connected, auto heroes **follow the group** and don't vote, so an AFK player never swings a vote.
  - If everyone is on auto, they vote by simple rules: rest when hurt, elite when healthy, otherwise random.
- **Bot players:** the host can **Add bot** in the lobby to fill a seat. A bot is a server-side player that's always on auto.
- **Shared brain:** the hero AI and the Phase 9 monster AI should share one tactical core (utility scoring), so improvements help both.

**Tasks**
- [x] `server/heroai.ts`: turn planner for heroes (move → act → bonus → end turn), using the same rules and validation as human actions
- [x] Auto flag per player; toggle event; auto-play for disconnected players
- [x] Vote rule for auto players (follow humans; heuristic when everyone is auto)
- [x] Out-of-combat upkeep (potions, heals between rooms)
- [x] Lobby: **Add bot / Remove bot** (host only), bot names and classes
- [x] Client: 🤖 Auto button + hotkey (P), 🤖 tags on party cards and in the turn order
- [x] Replace the client-side bot logic in `scripts/smoke.ts` with "create a room, add bots, start, watch"
- [x] Balance harness on top of it: N full runs at `DELVERS_SPEED=10`, report win rate, act reached and kills per class

**Done when:**
- A full 3-act run completes with every hero on auto and no server errors.
- A human can toggle Auto on and off mid-fight without breaking their turn.
- A disconnected player's hero keeps fighting.

**Result (2026-10-18):** ✅ All three goals checked.
- **All-auto runs:** 20 full runs with no stalls, no server errors and no rejected bot actions.
- **Toggling mid-fight:** tested in the browser.
- **Disconnect test:** after the player dropped, auto-play kept their Fighter attacking and drinking potions.
- **Bug found and fixed:** a downed auto hero that stood back up on a death save froze the room.
- **Tests:** 9 hero AI unit tests (34 in total).

**Balance harness findings** (`npm run balance`, 10× speed, full map):

| Party | Win rate | Where runs end |
|---|---|---|
| 4 heroes | 10 of 12 (83%) | Losses only in act 1, to elites |
| 2 heroes (Fighter + Rogue) | 3 of 12 (25%), after a Mimic nerf (was 0 of 8) | Mostly act 1 elites; Hobgoblin Captain ×4 |

**Takeaway:** the difficulty curve is lopsided. **Act 1 elites are deadly**, but **acts 2–3 never wipe**: heroes average level 11 by the end with the temporary "level every 3 fights" rule. Small parties without a healer are much weaker. **Parked for the Balance pass (Phase 13)**: no tuning until the classes, items and skills are in.

---

## Phase 2: XP, levels & skill system 🟢

**Goal:** level-ups are exciting choices, with a kill-steal flavor.

**Tasks**
- [x] XP on the server: shared base, killing-blow bonus, assists, support XP, catch-up (numbers in `rules.ts`)
- [x] Level curve and level cap; levels grant HP and proficiency automatically
- [x] Skill data model:
  - `kind`: **cantrip** (cooldown) or **spell** (slot cost)
  - tiers I/II/III per skill, with branches A/B at III
  - action economy cost (action/bonus/free)
  - targeting/area, effects, element tag (used by Phase 5)
- [x] Resource system:
  - cantrip cooldowns in rounds, reset at the start of each fight
  - slot pool per hero, flavored per class (Spell slots / Grit / Cunning)
  - max slots by level
- [x] Slot refills: Long Rest, act boss kill (full), and hooks for events/relics/consumables (partial; the event hook exists, relics and consumables come in Phase 6)
- [x] Free basic attack for every class (the Wizard got a Dagger: melee or thrown 4 tiles)
- [x] Convert the current abilities:
  - Fire Bolt, Sacred Flame → cantrips
  - Magic Missile, Healing Word, Second Wind → spells
  - Longsword, Rapier, Shortbow, Mace → basic attacks
  - Cunning Dash → a Rogue cantrip
- [x] Level-up screen: pick 1 of 3 from the class + common pools (new cantrip, new spell, upgrade, passive), weighted toward owned skills. Heroes choose at the same time; nobody waits.
- [x] Split hotbar (~3 cantrips + ~3 spells); taking one past the limit means forgetting one of that kind
- [x] Passive system:
  - trigger hooks: fight start, turn start, on hit, on being hit, on kill, on heal, on save
  - passive slots per level; tiers and branches like other skills
  - at least 2 class passives per class + 5 common passives (the examples above)
- [x] Rest node: each hero picks **Long Rest** (heal 30% + restore all slots) or **Train** (upgrade a cantrip or spell)
- [x] Content: per class, 3–4 cantrips + 3–4 spells; at least 1 branching cantrip and 1 branching spell (starting with the examples above)
- [x] Status effects needed by the skills: burning, poisoned, stunned, dazed, blessed, taunted (expanded in Phase 5)
- [x] HUD:
  - XP bar, kill counter, "💀 Kill steal!" callouts, level-up toast
  - two skill rows: cantrips with cooldown timers, spells with slot pips
- [x] Auto-play (`server/heroai.ts`) can use every new skill, picks level-ups and makes the rest choice (ground rule)

**Done when:**
- XP (including kill bonus, assists and support XP), levels, level-up picks, cooldowns, slots and the rest choice all work in play.
- Bot runs with every hero on auto finish without errors.
- Balance goals (e.g. supports keeping up with killers, Long Rest vs Train being a real choice) are checked in the Balance pass.

**Result (2026-10-18):** ✅ Both functional goals checked; balance is left for Phase 13.
- **Content:** 4 classes × (basic attacks + 3 cantrips + 3 spells + 2 passives) + 5 common passives = 37 upgradable skills, each with tiers I, II, III-A and III-B. All of it is data in `shared/skills.ts`. The server runs active skills generically from their stats, the UI generates their rules text from the same stats, and the hero AI scores them from the same stats. Adding a skill is mostly adding data.
- **Statuses:** Burning, Poisoned, Stunned, Dazed, Blinded, Marked, Taunted, Shielded, Blessed, Focused, Riposte. Advantage and disadvantage exist now (Focused, Marked, Blinded, Shadow Step, Cheap Shot), shown in the log as "🎲7|16→16". Phase 4 builds positioning on top.
- **XP:** each monster's XP is split: 50% shared by the living heroes, +50% for the killing blow, +15% for each other hero who hurt it. Healing (0.5 XP per HP), reviving (+10) and buffing (+3 per ally) also earn XP, and heroes below the party's top level get +25% per level behind. A killing blow on a monster someone else did most of the damage to is logged as a "💀 Kill steal!" and counted per hero.
- **Rest sites:** a new `rest` phase where every hero picks at once. The 30-second timer only starts when a person picks, and anyone undecided takes a Long Rest.
- **Bot runs:** about 25 full runs (parties of 1, 2 and 4) with 0 stalls, 0 server errors and 0 rejected bot actions. Bots used about 80 different skills and branches, took about 150 level-up picks per 6 runs, picked Long Rest and Train about evenly, and every hero ended with 1–2 passives.
- **Browser check:** hotbar rows, range and line-of-sight overlay, Fireball area preview, level-up cards, the rest panel with Train, and a boss kill steal all checked in the UI.
- **Tests:** 68 in total (new: skills, XP and progression, and 23 hero AI tests including property tests over random fights).
- **Rule fix found by the AI agent:** Action Surge's free III-A branch could be chained once per Grit slot in one turn; Action Surge is now once per turn.

**Notes**
- The temporary "level every 3 fights" rule from Phase 1 is gone; levels now come from XP only.
- Area spells don't hurt allies yet. Friendly fire with previews arrives with elements in Phase 5.
- Some Phase 5-flavored branches were adapted to work without surfaces: *Inferno* sets the target Burning instead of igniting the tile, *Concussive Blast* replaced *Delayed Blast*, *Vanish* replaced *Smoke Bomb*, and *Attunement* means fire resistance. Revisit them in Phase 5.
- **Balance observations, parked for Phase 13:** 4-hero bot parties now win every run (heroes end around level 8). Solo heroes die in act 1. XP mostly goes to whoever lands killing blows, as designed; the Fighter and Rogue lead on kills.

---

## Phase 3: Save & resume ⚪

**Goal:** a 3-act run can span several play sessions and survive a server restart.

**Tasks**
- [ ] Save the run to `saves/<code>.json` at every node transition (between fights, not mid-battle)
- [ ] Lobby: "Continue a saved run" list (party, act, date)
- [ ] Players reclaim their hero by name, or the host assigns them
- [ ] Resuming mid-node restarts that node fresh
- [ ] Old saves are cleaned up or archived after a win or loss

**Done when:** stop the server mid-act, restart it, and the party continues from the same map position with the same heroes.

---

## Phase 4: Positioning & surprise ⚪

**Goal:** where you stand matters; the Rogue shines.

**Tasks**
- [x] Advantage/disadvantage (2d20, keep the higher/lower), shown in the log as "🎲 7 | 16" (done in Phase 2, for Feint, Marked and Blinded)
- [ ] Auto-facing: units face whatever they last moved toward or attacked. Small facing arrow on each unit.
- [ ] Back attack: attacking from the target's rear arc gives advantage
- [ ] Flanking: an ally directly opposite the target gives advantage (applies to monsters too)
- [ ] Approach choice before combat: **Sneak** (group Stealth check; success = surprise round, failure = monsters get surprise) or **Charge** (normal start)
- [ ] Surprise round: surprised creatures skip their first turn
- [ ] Rogue skill **Hide** (bonus action): hidden until they attack; the next attack has advantage + Sneak Attack
- [ ] Ambush node variant: monsters start with surprise
- [ ] **Shove** (bonus action): an opposed Athletics check pushes the target 1–2 tiles. It gets deadly once Phase 5 hazards exist.
- [ ] Hover preview: shows "advantage (flanking)" before you attack

**Done when:** players can set up a flank or backstab on purpose and see the advantage in the dice log.

---

## Phase 5: Elements & surfaces (DOS2-style) ⚪

**Goal:** the battlefield itself becomes a weapon. Teams combo elements ("I soak them, you shock them").

**Building blocks**
- **Surfaces** (a tile layer with a duration): water, ice, fire, oil, poison, plus *electrified* variants of water.
- **Clouds** (a gas layer): steam (blocks line of sight), poison cloud, smoke. Steam can be electrified.
- **Creature statuses:**
  - **Wet:** lightning → Stunned, frost → Frozen, resists fire
  - **Burning:** damage each turn, removes Wet
  - **Chilled → Frozen:** skips a turn
  - **Shocked → Stunned**
  - **Poisoned:** damage each turn

**Core combos (start small and readable; extend later)**

| Surface / cloud | + Fire | + Ice | + Lightning | + Water |
|---|---|---|---|---|
| Water | Steam cloud | Ice | Electrified water (stuns anyone standing in it) | — |
| Oil | Fire (big) | — | — | — |
| Poison | **Explosion** + fire | — | — | — |
| Ice | Melts into water | — | — | — |
| Fire | — | Puts it out → water | — | Puts it out → steam |
| Steam | — | — | Electrified steam | — |

**Rules**
- Surface effects apply when a creature enters a tile or starts its turn on one.
- Fire spreads instantly across connected oil.
- Surfaces expire after N rounds.
- **Friendly fire is on.** The hover preview highlights every affected tile and every ally caught in it.
- Pathfinding avoids harmful surfaces by default and warns you if you choose to walk through.
- Monster resistances and immunities by element (skeletons immune to poison, fire creatures heal from fire, ...).

**Tasks**
- [ ] Shared types: surface and cloud layers per tile with durations; an element tag on skills and damage
- [ ] Interaction engine: one `combine(surface, element)` table, chain reactions, spreading, expiry
- [ ] Status effects: Wet, Burning, Chilled/Frozen, Shocked/Stunned, Poisoned, with clear icons on units
- [ ] Element sources:
  - [ ] skills: cantrips like Ray of Frost and Shocking Grasp; slot spells like Fireball and Create Water
  - [ ] skill branches (Fire Bolt III-A *Inferno* leaves fire)
  - [ ] room props: oil barrels, puddles, braziers
  - [ ] consumables (added in Phase 6)
- [ ] Act-themed rooms: oil and lamps in the Goblin Warrens, water and poison in the Crypt, fire and lava in the Dragon's Lair
- [ ] Monster element resistances/immunities, and elemental monsters
- [ ] Rendering: translucent animated surface tiles under units, cloud layer above, combo pop-ups ("⚡ Electrified!")
- [ ] Previews: the area of effect, allies in it, and the reaction it will cause
- [ ] Smoke test: scripted scenarios check each combo in the table

**Done when:** every combo in the table works and shows a preview. A playtest produces at least one deliberate team combo per act.

---

## Phase 6: Items, relics, shop & treasure ⚪

**Tasks**
- [ ] Inventory per hero; equipment slots: weapon, armor, trinket
- [ ] Consumables: potions, scrolls, slot-restoring items (e.g. Ether), elemental throwables (oil flask, water flask, frost/fire bombs)
- [ ] Relics: passive run modifiers (e.g. "the first attack each fight has advantage")
- [ ] Give items to teammates
- [ ] 🛒 Shop node: buy items/relics/potions, remove a skill, gold economy
- [ ] 💰 Treasure node: an item or relic choice
- [ ] Combat drops: gold + a chance of a consumable
- [ ] Item content: ~20 equipment, ~10 consumables, ~15 relics to start

---

## Phase 7: Elites, blessings & NPC allies ⚪

**Tasks**
- [ ] Elite traits: Shielded, Vampiric, Enraged, Swift, Summoner, elemental auras like Burning or Frost (one or two per elite)
- [ ] Elite reward: an elite-pool pick for each hero, plus a party vote: **blessing** or **NPC ally**
- [ ] Blessings: party-wide buffs that last for the act
- [ ] NPC ally: computer-controlled companion for the next N fights (e.g. a rescued mercenary, a cleric acolyte), using the monster AI on the hero side
- [ ] Shrine events can also grant blessings

---

## Phase 8: Real art ⚪ *(independent track)*

**Tasks**
- [ ] Claude: shortlist 3–4 packs with preview screenshots and verified licenses (candidates: Kenney Tiny Dungeon, 0x72 Dungeon Tileset II, Kenney 1-Bit Pack, DawnLike)
- [ ] **You: pick the style**
- [ ] Download the chosen pack (with your OK) into `client/assets/`, and add `CREDITS.md`
- [ ] Sprite mapping table: class / monster / tile / item / map-node icon → sprite
- [ ] Wall auto-tiling, floor variety, room props, surface/cloud visuals (or keep them procedural)
- [ ] Simple animation: idle bob, walk tween, hit flash, death fade
- [ ] Keep the emoji fallback for anything without a sprite yet

---

## Phase 9: Smarter enemy AI + difficulty ⚪

**Goal:** monsters fight as a squad, but stay readable and beatable. Scripted "utility AI", no machine learning.

- [ ] Squad director per fight: a shared focus target and role assignment
- [ ] Roles:
  - [ ] brute: pushes to the front
  - [ ] archer: keeps distance
  - [ ] support: heals or buffs (e.g. Goblin Shaman)
  - [ ] coward: flees at low HP
- [ ] Utility scoring for each move/action: damage, danger, **flanking and back attacks** (from Phase 4), avoiding corridor queues
- [ ] Surface awareness (from Phase 5): avoid hazards, shove heroes into them, ignite oil under the party, use resistances
- [ ] Monster barks in the log (handwritten)
- [ ] Difficulty setting in the lobby: Story / Normal / Hard
- [ ] The balance harness reports results per difficulty (used in the Balance pass)
- [ ] The same AI drives NPC allies (Phase 7)

---

## Phase 10: AI Dungeon Master (local LLM) ⚪

**Goal:** an optional, free, offline **narrator** that runs on this laptop (RTX 3050 4 GB VRAM, 16 GB RAM).

**Scope:** the LLM only adds flavor text. **Events and encounters stay handwritten templates** (decided 2026-10-18): the LLM never creates events, fights or choices, and the game plays exactly the same with it switched off.

- [ ] Install Ollama; benchmark a 3–4B and a 7–8B model (speed in tokens/sec, quality, VRAM use)
- [ ] `server/dm.ts`: Ollama client, timeouts, queue, fallback to the handwritten text
- [ ] Narration hooks: room intros, reactions to crits, deaths and kill steals, act and run recaps
- [ ] A rolling "run memory" summary keeps the narration consistent across acts (saved with the run)
- [ ] Lobby toggle; README section on setting up Ollama

---

## Phase 11: Experiments 🧪

- **RL enemies/companions (PPO):**
  - Python training project in `training/`, with a room-combat simulator that mirrors `shared/rules.ts`
  - Self-play heroes vs monsters
  - Export to ONNX and run it in the server with `onnxruntime-node`
  - Compare against the Phase 9 AI and keep whichever is more fun
- **AI companions:** basic bot players arrive in Phase 1b; this experiment is about making them feel like real teammates (personalities, callouts, smarter RL-trained play).
- **Talking NPCs:** chat with specific NPCs inside events. The LLM can only call tools we define (`roll_check`, `give_item`, `join_party`, `turn_hostile`).

---

## Phase 12: Content backlog ⚪

- [ ] More classes: Ranger, Paladin, Barbarian, Bard
- [ ] More monsters and elites per act; alternate bosses
- [ ] More elements and combos: blood (conducts lightning), curse/bless surfaces, weather events (rain, storms)
- [ ] Traps and interactive room props (doors, levers, collapsing floors)
- [ ] More events and encounter templates (aim for ~15 events and ~8 encounter templates per act)
- [ ] Sound effects and music (CC0)
- [ ] Touch/mobile controls
- [ ] Unlocks/meta-progression between runs (new classes, starting relics)

---

## Phase 13: Balance pass ⚪

**When:** after the classes, items and skills are in (Phases 2–7 and enough of Phase 12). Before that, balance is deliberately ignored.

- [ ] Use `npm run balance` (many full bot runs) to measure win rate, where parties die, and kills/XP/levels per class, for party sizes 1–6
- [ ] Tune the difficulty curve. Known so far: act 1 elites are deadly while acts 2–3 are too easy; small parties without a healer struggle.
- [ ] Tune XP (kill bonus vs shared base), slots per level, rest healing, gold and item prices
- [ ] Check the design goals: supports keep up with killers, Long Rest vs Train is a real choice, every class gets picked
- [ ] Difficulty settings (Phase 9) feel distinct: Story / Normal / Hard
- [ ] Playtest with real people, then adjust

---

## Dropped / parked

- ⏸️ **Local encounters (BG3-style split party):** not needed, since the party is always together on the node map.
- ⏸️ **Free-roaming dungeon with fog of war:** replaced by the act map. Small in-room exploration (chests, traps) may come back in Phase 12.

## Open questions

- **Rows per act / run length:** start at ~12 rows per act. Measure how long an act takes with real players, then tune.
- **XP numbers:** the size of the kill bonus vs the shared base. Tune in the Balance pass.
- **Slot numbers:** slots per level, which spells cost 2, how much an act boss restores. Tune in the Balance pass.
- **Hotbar split:** fixed 3 + 3, or flexible (e.g. 6 total, at least 2 of each)? And how many passive slots?
- **Friendly fire:** on for everyone, or off on the Story difficulty?
- **Level cap** across 3 acts (e.g. 12?).
- **Gold:** personal or shared purse?
- **Vote timer length**, and whether the host can override.
- **Party size:** keep the max at 6, or cap at 4 for balance?
- **Art style:** your pick (Phase 8).
- **Main goal:** a fun game, or also learning RL/LLMs? This decides how deep Phase 11 goes.

## Known issues / tech debt

- Balance is deliberately untuned until the Balance pass (Phase 13).
- Rooms live in memory (fixed by Phase 3).
- `window.delvers` debug handle is exposed in the client (handy, harmless).
