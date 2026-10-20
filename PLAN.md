# Dungeon Delvers: Plan

Tracking what we build. Tick boxes as work lands; update the status in the roadmap table.

**Status:** 🟢 done · 🟡 in progress · ⚪ not started · 🧪 experiment (may be dropped) · ⏸️ parked · ❌ dropped

## Ground rules

- **$0 forever.** Free, open-source tools only. Host on our own PC. No paid APIs or hosting.
- **No public DNS needed.** Players connect over LAN, Tailscale, or a Cloudflare quick tunnel.
- **The server is the rulebook.** It rolls every die and validates every move. Clients only send intents.
- **No LLM in the game** (decided 2026-10-19). Events, encounters, barks and all other text are handwritten; the monster AI and the bots are scripted. The server checks and applies everything.
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
| Party size | **At least 3 heroes, at most 6.** Bots take the empty seats when the run starts: a solo player gets two bot companions. | 2026-10-19 |
| Party scaling | Past 3 heroes, each extra hero makes the monsters grow on three levers: more of them, more max HP, more damage (`partyScaling`). Elites and bosses grow in HP on their own curve. | 2026-10-19 |
| No LLM | The local-LLM narrator (Phase 10) is dropped, and so are LLM talking NPCs. | 2026-10-19 |

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
| 3 | Save & resume | 🟢 |
| 4 | Positioning & surprise | 🟢 |
| 5 | Elements & surfaces (DOS2-style) | 🟢 |
| 6 | Items, relics, shop & treasure | 🟢 |
| 7 | Elites, blessings & NPC allies | 🟢 |
| 8 | Real art *(independent; can be done anytime)* | 🟢 |
| 9 | Smarter enemy AI + difficulty | 🟢 |
| 10 | ~~AI Dungeon Master (local LLM)~~ | ❌ |
| 11 | Experiments: PPO monsters, bot personalities | 🟢 |
| 12 | Content backlog | 🟡 |
| 13 | Balance pass | 🟡 |

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

## Phase 3: Save & resume 🟢

**Goal:** a 3-act run can span several play sessions and survive a server restart.

**Tasks**
- [x] Save the run to `saves/<code>.json` at every node transition (between fights, not mid-battle). It also saves after level-up picks and potions on the map. Writes are atomic (temp file + rename).
- [x] Lobby: "Continue a saved run" list (party, act, date) on the home screen, with an archive ✕
- [x] Players reclaim their hero by name, or the host assigns them. Open tabs reconnect to their hero on their own; typing your hero's name works from any device; a newcomer can **Play as** an away hero; anyone else joins as a new hero at the party's level. (Instead of the host assigning heroes, each player claims one; away heroes are auto-played until their player returns.)
- [x] Resuming mid-node restarts that node fresh (the same event comes back; a fight is rolled again)
- [x] Old saves are cleaned up or archived after a win or loss (`saves/archive/`, newest 30 kept)

**Done when:** stop the server mid-act, restart it, and the party continues from the same map position with the same heroes.

**Result (2026-10-18):** ✅ `npm run resume-check` plays a bot run, kills the server after 3, 8 or 12 rooms, starts a new one and compares: the same map spot, path choices, gold and heroes (level, XP, HP, skills and tiers, potions, kills, pending picks). It passed all three. Also checked in the browser: an open tab survived a server restart mid-fight and landed in the resumed tavern; the home-screen list, "new hero" joining and the fight replay all worked. 4 new unit tests (72 in total).

**Notes**
- A save holds the run, the heroes at the last safe point, the players, the events seen, and the last 30 log lines. A `version` field allows migrating old saves. Loaded heroes are rebuilt on today's rules (derived stats are recalculated and removed skills dropped), so saves survive most balance changes.
- Anyone who can reach the server sees the save list and can continue or archive a run. Fine among friends; worth knowing before sharing a tunnel link publicly.

---

## Phase 4: Positioning & surprise 🟢

**Goal:** where you stand matters; the Rogue shines.

**Tasks**
- [x] Advantage/disadvantage (2d20, keep the higher/lower), shown in the log as "🎲7|16→16 (flanking)"
- [x] Auto-facing: units face whatever they last moved toward or attacked. Small facing arrow on each unit.
  - Added during testing: **an enemy stepping next to a creature, or hitting it in melee, makes it turn to face them** (unless it's surprised or stunned, or the mover is hidden). Without this, every hero could walk around any monster for a free backstab every turn, and the bots did exactly that.
- [x] Back attack: attacking from the target's rear arc gives advantage. It also works at range, so archers behind the enemy line get it.
- [x] Flanking: an ally directly opposite the target gives advantage (applies to monsters too)
- [x] Approach choice before combat: **Sneak** (group Stealth check; success = surprise round, failure = monsters get surprise) or **Charge** (normal start). The party votes after seeing the room. Not before bosses or fights started by events.
- [x] Surprise round: surprised creatures skip their first turn (and can't react)
- [x] Rogue skill **Hide** (bonus action): hidden until they attack; the next attack has advantage + Sneak Attack. Can't hide next to an enemy (III-B *Smoke and Mirrors* can); III-A *Shadow Strike* adds +2d6 to the attack from hiding. Monsters ignore hidden heroes while anyone else is in the open.
- [x] Ambush node variant: monsters start with surprise. A random 10% of regular fights past row 2 (hidden on the map); the Alert passive now prevents being surprised.
- [x] **Shove** (bonus action): an opposed Athletics check pushes the target 1–2 tiles. It gets deadly once Phase 5 hazards exist.
- [x] Hover preview: shows "advantage (flanking)" before you attack. Gold dots also mark the tiles you can reach that would flank a monster.

**Done when:** players can set up a flank or backstab on purpose and see the advantage in the dice log.

**Result (2026-10-18):** ✅ The log shows the reasons ("🎲4|17→17 (flanking, from behind)") and the hover preview shows them before you attack.
- **Bot runs** (6 runs of 4 heroes, plus 2-hero and solo parties): 0 stalls, 0 errors and 0 rejected bot actions.
  - In the 4-hero runs, the bots sneaked 88 times (64 successes, 24 spotted), hit 2 ambushes, and rolled with advantage 129 times from flanking and 335 from behind. Hide was used 43 times and Shove 8.
- **Browser check:** the Sneak/Charge card with odds per hero, surprised monsters skipping their turn, facing arrows, the attack preview, and the Actions hotbar row.
- **Tests:** 88 in total. New tests cover facing, the rear arc, flanking, turning to face, the advantage reasons, and the hero AI's flanks, Hide, Shove and approach votes.

**Notes**
- Charge never wins a bot vote: the AI sneaks whenever the group's odds are 50% or better. People may judge it differently, which is the point of the vote.
- Monsters don't seek flanks or backstabs on purpose yet; that's the Phase 9 squad AI. Today they only get them by accident.
- **Balance, parked for Phase 13:** solo heroes now often die in their first fight (a failed sneak means losing the first turn).

---

## Phase 5: Elements & surfaces (DOS2-style) 🟢

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
- [x] Shared types: ground and cloud layers per tile (rounds left, or permanent), props; skills' `element` reacts with the field and `surface` leaves something behind (`shared/surfaces.ts`, `GameState.ground/clouds/props`)
- [x] Interaction engine: one `applyField` with the whole table, chain reactions (burning oil sets off poison, explosions light the oil around them and set off barrels), spreading (fire through connected oil, lightning through connected water and steam), expiry at the start of every round (ice melts into water, electricity fades after a round). The same code previews on the client and plans for the AI.
- [x] Status effects with icons: Wet (half fire damage and can't catch fire; puts out Burning), Chilled → Frozen, Shocked (−2 AC) → Stunned, Burning, Poisoned. A second cold or lightning hit, or one on a Wet creature, freezes or stuns.
- [x] Element sources:
  - [x] skills: Fire Bolt, Ray of Frost, Shocking Grasp, Fireball and every other fire/cold/lightning skill react; new spells **Create Water** (Cleric) and **Grease** (Wizard)
  - [x] skill branches: *Inferno* leaves fire, *Glacial Ray* leaves ice, *Meteor* leaves fire, *Smoke Bomb* (Shadow Step III-B, back from Phase 2) leaves smoke and hides you, *Deep Freeze* freezes
  - [x] room props: oil barrels (hit = spill, fire = explosion), braziers (hit = burning coals), puddles, oil slicks, poison pools, lava
  - [ ] consumables (added in Phase 6)
- [x] Act-themed rooms: oil, barrels and braziers in the Goblin Warrens, water and poison in the Crypt, lava, braziers and some oil in the Dragon's Lair
- [x] Monster resistances (immune, resist, weak, healed by) and elemental monsters: 💣 Goblin Firebomber (its firebombs light oil), 🤮 Bloated Zombie (bursts into poison), 😈 Magma Imp (healed by fire, weak to cold, dies in a pool of fire); undead are immune to poison, the Fire Drake to fire, the Wight's touch is cold
- [x] Rendering: animated pools under the units (fire flickers, water ripples, electrified tiles crackle), clouds above them, props, combo pop-ups ("⚡ Electrified!", "💥 Explosion!"), a frozen look
- [x] Previews: the area, every ally caught in it (red rings, "⚠ Friendly fire"), the tiles that will react and the combo it sets off; props as targets; tile and monster tooltips (resistances, death bursts); a "click again" warning before walking through a hazard
- [x] Smoke test: `tests/surfaces.test.ts` checks every combo in the table and the engine rules; `tests/elements.test.ts` plays scripted scenarios through the real server

**Done when:** every combo in the table works and shows a preview. A playtest produces at least one deliberate team combo per act.

**Result (2026-10-18):** ✅ Every combo in the table works (tested one by one) and the aiming preview shows the area, the allies caught in it and the combo it sets off.
- **Bot runs** (8 runs of 4 heroes, 6 of 2, 3 solo): 0 stalls, 0 errors, 0 rejected bot actions.
  - The 4-hero bots set off **54 combos with their own skills** (22 in act 1, 14 in act 2, 18 in act 3): 25 explosions, 16 oil fires, 15 steam clouds, 11 freezes, 7 frozen puddles, 5 shock stuns, 12 barrel and brazier hits.
  - Friendly fire fell from 10 hits in 4 runs with the old AI to 5 in 8 runs; nobody fed fire to a Magma Imp.
- **Tests:** 210 in total, up from 88 (the engine, scripted fights through the server, and the hero AI on the new battlefield). A fuzz run of 60,000 random steps (every skill, every surface, monster turns, round ticks) found no crashes or broken rules.
- **Browser check:** oil slicks and barrels in act 1, puddles and poison in act 2, lava and braziers in act 3, combo pop-ups, previews with friendly fire, the walk warning.

**Notes**
- Rules decided along the way:
  - a missed attack still splashes its element on the target's tile, so a missed firebomb still lights the oil;
  - a monster's death burst waits until the spell that killed it is done, so a Fire Bolt kill on a Bloated Zombie doesn't detonate its fresh poison (an Inferno kill still does, because it leaves fire);
  - a toppled brazier spares whoever knocked it over;
  - a click-walk goes around hazards if it can, otherwise through as few as it can; the client asks for a second click first;
  - lightning can't stun a creature that's already stunned, so nothing gets stun-locked;
  - area skills (Fireball, Hail of Arrows, Radiant Flame...) hit heroes in the blast, but "around you" skills (Whirlwind, Word of Radiance, Thunderclap) only hit enemies.
- Skills that fire at once (around-you skills, Smoke Bomb's cloud) have no aiming preview yet.
- Bots rarely learn Grease and Create Water, so most bot combos come from fire, frost and lightning on the rooms' own oil, water and barrels. Steering bots toward them is level-up tuning, left for Phase 13.
- Monsters don't use the battlefield on purpose yet (that's Phase 9); they only walk around hazards.
- **Balance, parked for Phase 13:** 4-hero parties still win every run; solo heroes still die in act 1. Explosions (2d6) and lava (2d6) are guesses.

---

## Phase 6: Items, relics, shop & treasure 🟢

**Tasks**
- [x] Inventory per hero: weapon, armor and trinket slots plus an 8-space bag (`shared/items.ts`). A weapon changes your basic attacks whatever your class (extra elemental dice that react with the ground, poison on hit, +damage); armor and trinkets add AC, HP, movement, saves, initiative, resistances, slots, stealth, Shove, Lucky rerolls. Equip, swap and drop any time outside a fight (I opens the bag).
- [x] Consumables: Greater Potion, Ether (a slot back), oil and water flasks, fire/frost/lightning bombs, smoke pellets, stink bombs, scrolls of mass healing and blessing. They are 'item' skills, so the hotbar, the aiming preview and the auto-play AI handle them like any skill; each is used up.
- [x] Relics: 16 party-wide perks (Eagle Eye: first attack each fight has advantage; War Banner: +1 AC for everyone; Alchemist's Kit; elemental stones; Lodestone; Vampire Fang...) and 4 boss relics (Phoenix Feather, Loaded Dice, Crown of Command, Dragon Heart)
- [x] Give items (and potions) to teammates between fights
- [x] 🛒 Shop node: 3 pieces of gear (rarer each act), 3 consumables, a relic, potions; sell for half; services: a lesson (upgrade a cantrip or spell) and forgetting a skill. Gold is the party's purse. Everyone shops at once; auto heroes shop after the people, one purchase each per round.
- [x] 💰 Treasure node: gold and a party vote on one of three relics (an event scene)
- [x] Combat drops: gold, a 30% chance of a common consumable after regular fights, the elite's gear for **whoever lands the killing blow on it**, and a boss relic for each act boss
- [x] Item content: 22 pieces of equipment, 11 consumables (plus the potion), 20 relics; one new event (*A Fallen Adventurer*) gives gear

**Result (2026-10-18):** ✅ Every task above works in play and in bot runs.
- **Bot runs** (14 runs of 4 heroes, 4 of 2, 2 solo): 0 stalls, 0 errors, 0 rejected bot actions.
  - In the last 6 runs of 4 heroes the bots visited 10 shops, bought 28 things and 2 lessons, took 33 relics, equipped gear 43 times, handed gear to a teammate 12 times, claimed 30 elite drops, found 20 consumables, and threw every kind of consumable (17 frost bombs, 15 fire bombs, 8 stink bombs...).
- **Tests:** 238 in total (28 new for items, the shop, relics, treasure, loot and save compatibility).
- **Browser check:** the bag (equip, unequip, give, drop, read-only in fights), the relic row, the shop (buy, sell, lesson with the tier III branch picker, forget, done and the countdown), treasure relic choices, loot in the post-fight notice.

**Notes**
- Rules decided along the way:
  - gold is one party purse, so a friend can buy something for someone else; potions and items can be handed over too;
  - a shop closes 90 s after the first person is done, or 20 s after only people who dropped out are left (a reload doesn't close it);
  - a full bag means a drop goes to whoever has room, and if nobody has, it's sold on the spot;
  - auto heroes put on better gear and pass gear that suits a teammate better between rooms (this also fixed bots never drinking potions between rooms in bot-only games: the vote used to fire first).
- **Balance, parked for Phase 13:** bots end the run with about 600 unspent gold, because shops are rare (about 1 node in 13) and gold keeps coming. Item prices, drop rates and relic strength are all first guesses.

---

## Phase 7: Elites, blessings & NPC allies 🟢

**Tasks**
- [x] Elite traits (`shared/elites.ts`): 🔰 Shielded (a ward soaks a quarter of its HP, back every 3rd round), 🩸 Vampiric (heals half the damage it deals), 😡 Enraged (below half HP: one more attack, +2 damage), 💨 Swift (+3 movement, +5 initiative, +1 AC), 📯 Summoner (an escort every other round, 3 at most) and the auras 🔥 Burning, ❄️ Frost, ⚡ Storm (attacks deal the element, 1d6 to everyone next to it at the start of its turn, the ground around it reacts, immune to the element). One trait in act 1, one or two in act 2, two in act 3, never two auras; the first trait names it ("Burning Hobgoblin Captain").
- [x] Elite reward: the killer still takes its gear; every hero gets an **elite-spoils pick** (the level-up flow with a different pool: a free upgrade to a skill you own, a piece of the act's elite gear, a boon), and the party votes on two blessings or a companion ("free their captive")
- [x] Blessings: 8 party-wide buffs until the end of the act (Valor, Bulwark, Vigor, Arcana, Haste, Fortune, Warding, Renewal); stat blessings ride on the same stat blocks as gear and relics
- [x] NPC allies: 💂 Sellsword, 😇 Acolyte (heals the most hurt hero in range, a downed one first), 🧝 Ranger, 🐕 War Hound. They are monsters with `ally` set, run by the monster AI with the sides swapped, fight for the next 3 fights at full HP, grow with the act, two at most. Friendly fire hits them, and one that falls is gone for good. Flanking, facing and Sneak Attack treat them as party members; monsters target them like heroes.
- [x] Shrine events grant blessings: the Forgotten Shrine's prayer, and a new event *The Twin Statues* (pay for a blessing of battle or of the mind). Another new event, *The Caged Mercenary*, gives a Sellsword ally.

**Result (2026-10-19):** ✅ Every task above works in play and in bot runs.
- **Bot runs** (14 full-length runs of 4 heroes, 14 of 2, 4 solo, plus 6 short ones): 0 stalls, 0 errors, 0 rejected bot actions. In 6 full 4-hero runs: 37 traits rolled on elites (every one of the 8 seen), 18 wards broken, 7 minions summoned, 8 aura hits, 88 elite-spoils picks, 16 blessings, 14 companions (33 hits, 14 kills, 4 fell, 7 went home after their 3 fights).
- **Tests:** 272 in total (34 new for traits, sides, blessings, allies, elite spoils and the reward vote). They found that the War Hound didn't actually hunt archers as its text said (fixed), and made two element tests flaky because test elites now roll random traits (fixed in the test helper).
- **Browser check:** allies' green rings, tooltips (fights left, description) and "is on your side" when you aim at one; elite trait icons, tooltips and the ward strip on the HP bar; the blessing and ally rows in the HUD; "(ally's turn)" in the turn bar; the whole elite flow (the vote, the spoils panel, a gear card into the bag, disabled while the bag is full, the ally in the next fight); a 375 px wide window. Not seen live, only read in code: an ally caught in a friendly-fire preview.

**Notes**
- Rules decided along the way:
  - NPC allies are `kind: 'monster'` entities with `ally: true`, so they reuse monster stat blocks, saves, resistances and the monster AI. "Enemy" now means `isFoe()` everywhere (targeting, flanking, facing, the hero AI); `monsters()` on the server returns foes only.
  - Allies can't be healed or buffed by heroes yet (heal skills target heroes only), and the hero AI only prices friendly fire on them, not hazards under them.
  - A save made during the post-elite vote reopens that vote instead of replaying the fight (new save point kind `reward`).
  - The Acolyte heals anyone under 75% HP: at 60% it never got to, because auto heroes drink a potion first.
  - When an elite also levels a hero up, the level-up card comes first and the spoils right after.
- Fixed on the way: loading a save gave every hero the Dragon Heart's (or any max-HP relic's) HP again, because the hero sheet was rebuilt before the party's relics were put back on it.
- **Balance, parked for Phase 13:** trait numbers, ally stats and growth, how often the reward vote should offer a companion, and whether blessings stack too well with relics are all first guesses.

---

## Phase 8: Real art 🟢 *(independent track)*

**Tasks**
- [x] Claude: shortlist with verified licenses: DawnLike (CC-BY 4.0), 0x72 Dungeon Tileset II (CC0), Dungeon Crawl Stone Soup tiles (CC0), Kenney 1-Bit Pack (CC0). Kenney Tiny Dungeon was dropped (too few creatures). No screenshots: the network at the time blocked the asset sites, so the pick went on descriptions and links.
- [x] **You: picked DawnLike** (16×16, by DragonDePlatino on DawnBringer's palette)
- [x] Downloaded `DawnLike_5.zip` (1.0 MB, the official OpenGameArt file, with your OK) into `client/assets/dawnlike/` (the sheets and the pack's README); `CREDITS.md`, the README and the in-game how-to-play credit it. As the artist asks, his Platino sprite is hidden in the game.
- [x] Sprite mapping table (`client/sprites.ts`): the 4 classes use the pack's commissioned Warrior / Rogue / Mage / Paladin with 4-direction walk cycles; all 23 monsters and 4 NPC allies, walls, floors and decorations per act, props, every item, and the map-node icons
- [x] Wall auto-tiling (4-neighbour, DawnLike's line-art wall pieces), a floor and wall material per act, floor decorations (skulls, cobwebs, vines), barrels and braziers as sprites, flames on burning tiles; the ground pools and clouds stay procedural
- [x] Animation: 2-frame idle for monsters and allies, walk cycles and an idle bob for heroes, a white hit flash, a fade-out on death
- [x] Emoji fallback for anything without a sprite (and if a sheet fails to load); **G** switches between pixel art and the classic emoji look

**Result (2026-10-19):** ✅ The battle scene, the bag, the shop, the hotbar, the spoils cards and the act map all draw DawnLike sprites; every act has its own walls and floor.
- **Checked in the browser:** rooms in all 3 acts (corners, T-junctions, obstacles, lone pillars, the outer border), heroes, monsters, elites, bosses, allies and Platino up close, hit flash and death fade, downed and dead heroes, the bag, shop, hotbar, spoils card and map icons, the **G** toggle, a 375 px window, and the fallback when a sheet is missing. The walk and idle frames were checked by stepping the game by hand (the browser pane was hidden, so animation didn't run on its own).
- **Tests:** 272, unchanged (this phase is client-only).

**Notes**
- Props stand on a floor-looking tile instead of joining the wall auto-tiling: a wall piece under a barrel looked wrong.
- DawnLike walls are thick line-art pieces, so a 2×2 block of wall reads as a small hollow box. That's the pack's look.
- Elites draw at 2.4× and bosses at 2.8× (normal creatures 2×); with the camera's free zoom, pixels are never perfectly even anyway.
- Ideas for later: hero portraits from the walk sheets on the party cards and turn order (still emoji), sprites for relics, blessings and skills.

---

## Phase 9: Smarter enemy AI + difficulty 🟢

**Goal:** monsters fight as a squad, but stay readable and beatable. Scripted "utility AI", no machine learning.

- [x] Squad director (`squadPlan` in `server/monsterai.ts`): the monsters pick their targets together and keep them while they're still a good pick. The client marks each hunted hero with a red 🎯 reticle, and the turn order and party cards name them.
  - **Scales with the party:** bigger parties face more and tougher monsters, so the monsters split into packs (`packsFor`: about one per two heroes, so 2 packs for 3–4 heroes and 3 for 5–6), each hunting its own hero. A 6-hero party doesn't get a whole 6-hero fight dropped on one hero.
  - Each monster joins the nearest pack that still has room, so the packs come out about the same size.
- [x] Roles (`role` on each stat block, shown on the monster tooltip):
  - [x] brute: pushes to the front and holds it (Hobgoblin, Orc, Ogre, Wight, the bosses...)
  - [x] skirmisher (added): circles for flanks and back attacks (Goblin, Wolf, Giant Spider, War Hound)
  - [x] archer: keeps its distance (steps back from melee before it shoots)
  - [x] support: heals or buffs. 3 new monsters with sprites:
    - Goblin Shaman (act 1): heals, Blesses.
    - Necromancer (act 2): heals, Shields.
    - Dragon Priest (act 3): heals, Blesses.
    - Where they show up: the new templates Shaman's Circle and Necromancer's Vigil, the Cult Ritual, the big templates, and some elite escorts. The Acolyte ally uses the same support code.
  - [x] coward (Giant Rat, Kobold): runs below 40% HP for up to 2 turns, then fights cornered. The last monster standing never runs.
- [x] Utility scoring for every reachable tile:
  - Expected damage with advantage (flanking, from behind, and the target turning to face whoever steps next to it).
  - The chance to take the target down, with its pack's target first.
  - Danger by role, hazards on the way, and Sentinel heroes it would walk away from.
  - **Corridor queues:** a friend in the way counts as 3 extra steps, so monsters go round another way when there is one instead of queueing.
- [x] Surface awareness:
  - Walks take the least harm, and a monster won't end in a hazard if a safe tile is as good.
  - **Brutes with `shove` push heroes into fire, lava or poison** (a STR contest, like the heroes' Shove).
  - Fire, cold and lightning attackers go for the hero standing in the oil or water: the hit sets off the whole pool. They **shoot the ground** to blow up gas or light a pool when no hero in it can be hit.
  - Resistances count: fire-immune monsters walk through fire, a Magma Imp likes standing in it, and hits on a resistant hero are worth less.
- [x] Monster barks, handwritten (`server/barks.ts`):
  - Voices: goblins, beasts, the mindless dead, the dread undead, orcs, the ogre, cultists, imps, dragons, and the NPC allies.
  - Triggers: calling a target, running, being cornered, shoving, setting the ground off, healing, buffing.
  - They're shown in italics in the log.
- [x] Difficulty in the lobby: Story / Normal / Hard.
  - The host picks it; it's saved with the run and shown next to the act name.
  - Knobs in `DIFFICULTIES` (shared/rules.ts), for Story / Normal / Hard:
    - Monster HP ×0.75 / 1 / 1.2.
    - Attack −1 / 0 / +1; damage 0 / 0 / +1.
    - Encounter budget ×0.8 / 1 / 1.2.
    - Tactics: Story fights on instinct (the closest hero, no squad); Normal slips back to instinct on 15% of monster turns; Hard never does.
  - **Placeholder numbers until Phase 13.**
- [x] The balance harness reports per difficulty and per party size:
  - `DIFF=all node scripts/balance.ts 12 3,4,5,6 6` gives a wins table by difficulty × party size.
  - It also counts target calls, flees, shoves, ground shots, monster heals and buffs.
- [x] The same AI drives NPC allies:
  - They pick one target of their own (faint green brackets on it).
  - Roles: the Sellsword is a brute that shoves, the Acolyte a support (heals, Blesses heroes), the Ranger an archer, and the War Hound a skirmisher that hunts shooters.
- [x] The hero bots predict who the monsters will go for from the hunted list (server/heroai.ts)

**Result (2026-10-19):** ✅ Monsters fight as packs with roles, and the party can see who they're after.
- **Bot runs** (0 anomalies, 0 rejected actions and 0 server errors in all of them):
  - 18 four-hero runs across the 3 difficulties (12 of them full length).
  - 6 two-hero and 3 solo runs.
  - 36 runs over 1–6 heroes × 3 difficulties after the last fixes. Parties of 3–6 won all of them; solo lost every run; 2 heroes won on Story and Normal but lost on Hard.
  - Seen in play: target calls, flees, shoves (in and held), monster heals and buffs, Acolyte heals.
- **Hand-made boards:**
  - An orc shoves a hero into fire (but takes the back attack when it has one).
  - A cultist goes for the hero in the oil, and blows up a gas cloud it can't otherwise reach.
  - An archer steps back before shooting; a hurt rat runs.
  - The Shaman heals a hurt goblin and Blesses its captain.
  - The squad hunts the hurt wizard; packs split 2/2/2 against 6 heroes.
- **Client:**
  - The lobby picker (host and read-only), the difficulty pill, the 🎯 reticles (3 at once in a 6-hero fight), the role and spell tooltips, and the new sprites.
  - Checked by the client agent in the browser, partly with injected entities.
- **Tests:** 330, all passing (58 new in tests/monsterai.test.ts: hit odds, the squad director and packs, difficulty and slips, taunts, shoves, kiting, cowards, supports, ground shots, hazards, hunting, walking, corridors, barks, the rules data).

**Notes**
- Shots at the ground are rare in real fights: when the party stands in oil, shooting a hero sets it off anyway (as it should). They show up with gas clouds, or when no hero in the pool can be hit.
- Shoves are rare too: they need a hazard right behind a hero, and a back attack often scores better.
- Solo heroes died in act 1 on every difficulty (two rats flanking a level-1 hero is enough, and nobody can revive them). Fixed by the follow-up below: every party now has at least 3 heroes.
- Parties of 3–6 won every run on every difficulty, so Hard needs to bite harder for them. Phase 13; the harness now gives the table to tune against.
- Two bugs the tests caught and that are fixed:
  - A far-off target used to lose out to a nearer one, because its higher weight also multiplied the walking penalty. Now a target that matters more pulls harder; a taunter pulls hardest.
  - A pack could end up empty. Now every pack gets its fair share first.
- Story fights on pure instinct: the shortest way to the closest hero, with no hunting for flanks or backs.

**Follow-up (2026-10-19, your call):**
- [x] **At least 3 heroes** (`MIN_PARTY`): when the run starts, bots take the empty seats, with classes the party doesn't have yet. A solo player gets two bot companions. The tavern says so before the start, and saved runs with fewer heroes get topped up when they continue.
- [x] **Party scaling on three levers** (`partyScaling` in shared/rules.ts, per hero past 3, placeholders for Phase 13):
  - more monsters (encounter budget +15%);
  - more max HP for regular monsters (+10%);
  - more damage for every monster (+10%, as a flat bonus per hit).
  - A 3-hero party's fights are unchanged. Elites and bosses keep their own HP curve (`scaledHp`).
  - The room cap of 6 monsters stops the count from growing in big parties, but HP and damage keep growing.
- [x] The harness records the real party size (smaller sizes are topped up with bots).
- [x] Test: a solo player's party starts with 3 heroes of 3 different classes; the save tests now expect 3 heroes (331 tests).
- **Bot runs:** 24 runs, solo starts (topped up to 3) and 4, 5 and 6 heroes × 3 difficulties; 0 anomalies, 0 rejected actions, 0 server errors. Story and Normal won 15 of 16; Hard won 4 of 8, and big parties now lose there too, which the old count-only scaling never did.

---

## Phase 10: AI Dungeon Master (local LLM) ❌ Dropped

**Dropped 2026-10-19:** we're not using a local LLM. The game's text stays handwritten (events, barks, logs). The original plan is kept below for reference.

**Goal:** an optional, free, offline **narrator** that runs on this laptop (RTX 3050 4 GB VRAM, 16 GB RAM).

**Scope:** the LLM only adds flavor text. **Events and encounters stay handwritten templates** (decided 2026-10-18): the LLM never creates events, fights or choices, and the game plays exactly the same with it switched off.

- [ ] Install Ollama; benchmark a 3–4B and a 7–8B model (speed in tokens/sec, quality, VRAM use)
- [ ] `server/dm.ts`: Ollama client, timeouts, queue, fallback to the handwritten text
- [ ] Narration hooks: room intros, reactions to crits, deaths and kill steals, act and run recaps
- [ ] A rolling "run memory" summary keeps the narration consistent across acts (saved with the run)
- [ ] Lobby toggle; README section on setting up Ollama

---

## Phase 11: Experiments 🟢

Done 2026-10-19. Your picks: Python + PyTorch for the training; plain TypeScript to run the trained policy in the server (no 300 MB onnxruntime-node for hosts); bot personalities and callouts for the companions; and the host chooses the monsters' AI in the lobby.

- [x] **PPO monsters** (`training/`, see `training/README.md`):
  - [x] **Options, not a copy of the rules.** The plan said to build a Python simulator that mirrors `shared/rules.ts`. Instead the real game runs headless in Node (`training/env.ts`), so nothing has to be kept in sync.
    - The scripted AI lists each monster's options with 44 features each (`monsterChoices` in `server/monsterai.ts`), up to 32 options.
    - The policy only ever picks among them, so every move is legal.
  - [x] **Real fights.** Bot runs record the save at each fight's start (`DELVERS_FIGHT_DUMP`); 40 runs gave 718 recorded fights.
    - They cover all 3 acts and difficulties, 3–6 heroes, and regular, elite and boss fights, with the gear and levels the game really produces.
    - Each replay rolls fresh monsters. The heroes are the hero bots.
  - [x] **The trainer** (`training/ppo.py`, PyTorch 2.14 on the CPU, in `training/.venv`):
    - The network scores each option (44 → 64 → 64 → 1) and has a value network for PPO.
    - It first copies the scripted AI (100% agreement after 40k decisions), then trains with PPO: 10 Node workers play 24 fights each at once, about 1,400 fights per update.
  - [x] **Export:** `server/policies/monster-ppo.json`, which the server runs in plain TypeScript (`server/policy.ts`), and `monster-ppo.onnx`, built directly with the onnx package and checked against PyTorch.
  - [x] **Lobby choice:** the host picks 📜 Scripted or 🧠 PPO (trained) next to the difficulty, and the HUD shows 🧠 PPO for a PPO run. The difficulty still sets the monsters' numbers.
  - [x] **Harness:** `MONSTER_AI=all` alternates the two and reports per AI.
  - [x] Self-play heroes vs monsters: not done. The heroes stay scripted; see "Later" below.
- [x] **AI companions: bot personalities and callouts** (`server/companions.ts`). Each bot has a voice:
  - Brakka: gruff. Pip: cheerful. Sister Wren: gentle. Old Tam: grumpy veteran.
  - Vexa: cocky. Grimble: nervous tinkerer. Lady Ash: cool aristocrat. Moss: calm.
  - They talk in the chat log when a fight starts (elites and bosses get their own lines), when they're low on HP or an ally goes down, on revives and heals, on kills and kill steals, on crits, when the monsters start hunting them, on a level-up, and when a fight is won.
  - Only real bots talk. Each says at most one line per round, with at most 2 lines per round overall.

**Result (2026-10-19):** the pipeline works end to end. The trained policy plays as well as the scripted AI, but not better.

| Monster AI, 2,000 recorded fights each | Monsters win | Party losses (±1 s.e.) |
|---|---|---|
| 📜 Scripted | 0.75% | 0.055 (±0.005) |
| 🧠 PPO, run 1 (reward also counts the monsters' own losses) | 0.45% | 0.045 (±0.004) |
| 🧠 PPO, run 2 (reward = pressure on the party): **shipped** | 0.65% | 0.051 (±0.004) |

Party losses per hero: the share of HP lost, 2 if downed, 3 if dead, averaged per fight.

- **Full bot runs through the server:** 24 runs (12 scripted, 12 PPO), 3–6 heroes, all difficulties: 0 anomalies, 0 rejected actions, 0 server errors.
- **Tests:** 353 (+18 companions, +4 policy, including that the shipped weights score their check inputs exactly as PyTorch did).

**Why PPO doesn't win (your diagnosis):**
- **The monsters have almost nothing to coordinate.** They move and hit; flanks, backstabs, the pack target, shoves and heals are all things the scripted AI already scores well one turn ahead. There are no debuffs, no setups that pay off for another monster, and no stacking buffs.
- **The fights are one-sided** (balance waits for Phase 13): bot parties win about 99% and lose about 5% of their HP per fight, so the learning signal is tiny next to the dice.
- **The best checkpoint looked better in 400–1,000-fight checks, but that was noise.** Only the 2,000-fight checks are trustworthy.
- In run 2 the sampled policy drifted toward randomness (entropy up, scripted agreement down to 62%), while greedy play stayed level. The entropy bonus outweighs such a small reward.

**Next:**
- Monster abilities go into Phase 12: debuffs, setups, a help action, stacking buffs and leader orders.
- After Phase 12/13, rerun the pipeline: record fights, then `training/ppo.py`, then export. No new code is needed, unless the option features change; the server refuses a policy that doesn't fit.
- Also worth trying then: train on harder fights (a training-only boost so fights are close) and judge checkpoints on 2,000+ fights.
- **Later (not now, decided 2026-10-19): RL-trained hero bots.** Train the hero side the same way as the monsters: a policy that scores the candidate actions `server/heroai.ts` already lists (move, action and bonus action, skills with aims, potions, revives, shoves), first copying the scripted hero AI, then PPO against the scripted or the PPO monsters. One side trains while the other stays frozen, so results stay measurable. It would make bot teammates and auto-play smarter; humans playing their own heroes wouldn't notice. A bigger job than the monsters: the hero action space is much larger.
- ~~**Talking NPCs:** chat with specific NPCs inside events. The LLM can only call tools we define (`roll_check`, `give_item`, `join_party`, `turn_hostile`).~~ Dropped with Phase 10 (no LLM).

---

## Phase 12: Content backlog 🟡

Started 2026-10-19. Order: the codex first (to see the pools), then monster abilities, then the new classes. Next (decided 2026-10-19): AP and Block, then subclasses, then rewards after every win, then the rest of the list.

- [x] **Codex: a content dashboard** (your ask, 2026-10-19: "view + checks"). `/codex` on the played build, `/codex.html` in dev.
  - Browse every pool: heroes, skills (every tier), items, relics, blessings, monsters, acts and encounters, elites and allies, statuses and surfaces, events.
  - It imports the real game data, so it can't drift. Every entry shows the file and line it lives on (a VS Code link in dev); edits still happen in code.
  - Pool checks: broken references (errors), unused content and missing sprites (warnings), and coverage against the goals below (events and encounters per act, classes). `tests/codex.test.ts` fails on any error.
- [x] **More classes: Barbarian, Ranger, Paladin, Bard** (2026-10-19). 8 classes now, each with a basic attack, 3–4 cantrips, 3–4 spells and 3 class passives, all with tiers I → II → III-A / III-B.
  - 🪓 **Barbarian** (STR, Fury): Rage (new status: + damage on melee hits, half physical damage taken), Reckless Attack (advantage, but you're Marked), Ground Slam (knocks everything around you Prone), Menacing Roar; Brutal Strike, Relentless, Harpoon (drags a monster to you), Earth Splitter.
  - 🏹 **Ranger** (DEX, Focus): Hunter's Mark, Ensnaring Shot (nets a monster), Quick Shot; Lightning Arrow, Hail of Thorns, Herbal Remedy, Steady Aim. Favored Foe: + damage against Marked targets.
  - ⚜️ **Paladin** (WIS for spells, STR weapon, Devotion): Lay on Hands, Compelled Duel (taunts one monster), Radiant Strike, Bulwark; Divine Smite, Healing Hands, Crusader's Mantle. Aura of Protection: + to saves for everyone within 2 tiles.
  - 🎻 **Bard** (INT, Verses): Vicious Mockery, Bardic Inspiration, Thunderwave, Hypnotic Gaze; Healing Ballad, Shatter, Hideous Laughter, Heroic Anthem. Song of Rest: the party heals more after every fight.
  - **Perks:** a passive can be a stat block that adds up like equipment (`SkillStats.perk`, added in `shared/items.ts` statBlocks), so most new passives are pure data: Thick Hide, Danger Sense, Brutal Blows, Natural Explorer, Archery, Divine Health, Defender, Jack of All Trades, Silver Tongue. Only Rage, Favored Foe, Aura of Protection and Song of Rest needed server code.
  - **Deeper old pools:** a third class passive each (Fighting Style, Nimble, Arcane Focus, Devout) and a 4th Fighter cantrip (Trip Attack: Prone).
  - The heroes' new tricks use the monsters' new statuses too: Prone, Netted, Rallied, Taunted on one monster.
  - **Bots** pick a class the party doesn't have that fills a missing role (front line, healer, ranged), at random among those.
  - The Cleric's Lay on Hands branch is renamed Purifying Touch (the Paladin's cantrip has the name now).
  - [ ] Each new class still borrows a commissioned sprite sheet (tinted per class; see client/sprites.ts)
- [x] **Monster abilities** (decided 2026-10-19, after Phase 11 showed monsters that only move and hit leave PPO nothing to learn):
  - [x] Tricks, instead of attacking (`MonsterDef.trick`): 🪢 Kobold's Net (Netted: can't move, ranged attacks have advantage; once a fight), 🫳 Goblin's Dirty Trick (Blinded), 🕸️ Giant Spider's and Broodmother's Web (Webbed: stuck, attacks have advantage, its own have disadvantage, until cut free or burned), 🎯 Dragon Cultist's Brand (Marked)
  - [x] Riders on hits (`MonsterDef.rider`): Wolves and Ogres knock you 🤕 Prone (melee advantage, ranged disadvantage, getting up costs half your movement); a Wight's touch 🩸 Drains max HP until the fight ends (stacks)
  - [x] 👉 Help: any melee monster can get in a hero's face instead of attacking (Distracted: the next attack on them has advantage)
  - [x] Stacking buffs: 📯 Rallied (+1 to hit and damage per stack, up to 3), from the Goblin Shaman and the Charge order
  - [x] Leader orders (Hobgoblin Captain, Orc Warchief and the three bosses), a free shout every 3rd turn: 📯 Charge! (+3 movement and a Rallied stack), 🛡️ Hold the line! (+2 AC), 🎯 Kill that one! (Marked)
  - [x] Drenched: already there (Wet from water: lightning stuns, cold freezes); no new trick needed
  - [x] The scripted squad AI uses them: a set-up is worth what the friends who act before the target's next turn gain from it (`trickValue` in server/monsterai.ts, with the initiative order and pack targets)
  - [x] The hero bots answer: ✂️ Cut Free (everyone, bonus action) for themselves or a friend next to them, and they go for trick-throwers and leaders first
  - [x] Retrain the PPO monsters (training/README.md). The option features changed (44 → 48: the trick and Help kinds, and what an option sets up), so the old policy no longer fit.
    - [x] For now 🧠 PPO ships the imitation stage of run 3 (it copies the scripted AI 100%), so the lobby choice keeps working
    - [x] PPO run 3 (`training/runs/ppo3`, entropy bonus lowered to 0.002 after run 2's drift; stopped at update 33 of 40 by a restart). Best checkpoint vs scripted on 2,000 fights: party losses 0.057 vs 0.058, monsters win 0.80% vs 0.95%: a tie again, so the imitation copy stays. The fights are still too one-sided for PPO; worth another try after the Phase 13 balance pass.
  - Bot runs (3 batches of 18, all difficulties, 3–6 heroes): 0 anomalies, 0 rejected actions, 0 server errors. Per 18 runs: about 55 tricks (half land), 50–65 orders, 26 Cut Frees by the bots, 5–14 knockdowns, 8–20 drains; Help is rare (it only wins next to a big hitter, like Kobolds next to an Ogre).
  - Tests: `tests/abilities.test.ts` (34). It caught a bug: a netted hero could dash out of the net (dash movement now waits until it's free).
- [x] **Action points (AP) instead of action + bonus action** (decided 2026-10-19, DOS2 / Slay the Spire style)
  - [x] 3 AP per turn (`AP_GAIN`). AP you don't spend carries over, but a turn starts with at most 5 (`AP_MAX`). A lost turn (stunned, frozen, surprised, down) gains none but keeps the savings; every fight starts from scratch.
  - [x] Prices follow the old economy: bonus actions cost 1 AP, actions and basic attacks 2, the biggest spells 3 (Fireball, Earth Splitter, Shatter, Hail of Thorns, Guiding Bolt, Brutal Strike, Heroic Anthem). `SkillStats.ap` replaced `cost`, so a tier can change the price (Quick Grease 1, Battle Surge 0). Spell slots and cooldowns stay.
  - [x] Walking up to your speed stays free; 👟 Dash (everyone, 1 AP) adds 3 tiles. Action Surge and Executioner give +2 AP (`gainAp`).
  - [x] Monsters keep their turn as it is (move, one attack, tricks and orders), so the PPO policy keeps working.
  - [x] The hero bots plan their AP (`spend` in server/heroai.ts): the best set of skills for the AP they have (a knapsack; a basic attack can repeat), then the biggest move first, quick skills after. Saving an AP is worth a little (`SAVE_AP` 0.2), so they bank AP when nothing is worth it rather than skipping useful quick skills. They Dash when it's the only way to reach a target with AP left to hit it.
  - [x] HUD: ⚡ AP pips instead of the Action/Bonus pills, the AP cost on every hotbar button (colored 0–3); the codex and the how-to-play show AP.
  - Tests: `tests/ap.test.ts` (7); the old action/bonus checks in 8 test files now check AP.
- [x] **🧱 Block** (decided 2026-10-19, Slay the Spire style): Block soaks damage before temporary HP (and an elite's ward), and lasts until the start of the turn of whoever gave it ("until your next turn"), so a Paladin's Block on a friend holds through the monsters' turns. Kept per giver (`Entity.block`); going down, a new fight, or the giver leaving the fight clears it.
  - [x] Sources: 🧱 Brace (everyone, 1 AP, once per turn: 1d6), Fighter (Bulwark Bash and Iron Wall: Block + level), Paladin (Bulwark gives a friend next to you 2d4 + level), gear that puts up Block at the start of each of your turns (🥏 Buckler 2, 🪖 Splint Mail 2, 🧱 Tower Shield 5), and shields on monsters (Skeleton 2, Hobgoblin Captain 3, Bone Knight 5, the Sellsword ally 2). The Cleric's ranged Block comes with the subclasses.
  - [x] Both AIs count Block, temp HP and wards as HP that has to go first when they aim for kills (the hero bots didn't count wards before either). The hero bots price Block like heals: what it would soak, dearer the more hurt those hits would leave the friend.
  - [x] Shown on party cards (+N 🧱), the HP bars, token tooltips, the log ("🧱 Bob covers Ann: 7 Block until Bob's next turn."), and the codex (monsters with shields).
  - Tests: `tests/block.test.ts` (9). One caught that the bot kill math ignored Block (it would swing at a 4-HP skeleton behind 12 Block).
  - **For Phase 13:** Brace is efficient next to the Shield spell (no slot); Shove now competes with Brace for the spare AP and gets used much less.
- [ ] 🟡 **Subclasses** (decided 2026-10-19): every class picks one of two at level 3, and its offers come from the class pool plus the subclass pool. Your class identities, with the Cleric protecting from range and the Paladin by touch so they don't overlap:

  | Class | Subclass A | Subclass B | Own AP / Block trick |
  |---|---|---|---|
  | Fighter | Weapon Master: damage, cleave, counters | Guardian: Block, self-heal, thorns | Thorns: Block that soaks a melee hit hurts the attacker |
  | Rogue | Assassin: backstab, burst combos, poison | Skirmisher: hit and run, dashes, smoke | 1-AP light attacks (move, stab, retreat) |
  | Wizard | Evoker: big area spells | Elementalist: crowd control and elemental reactions | 3-AP big spells vs cheap setups |
  | Cleric | Life: heals and revives | Order: buffs, Block and AC on allies from range | Protects from range |
  | Barbarian | Berserker: hurt yourself for big damage | Juggernaut: lifesteal, taunt, soaking hits | Blood Price: pay HP for AP |
  | Ranger | Trapper: traps that root or net, volleys | Sharpshooter: long range, big single hits | Traps cost AP now and spring on the monsters' turn |
  | Paladin | Protection: Block on allies next to you, takes hits for them | Devotion: self-sustain, heals by touch | Protects by touch |
  | Bard | Valor: buffs | Whispers: debuffs and crowd control | Inspiration gives an ally +1 AP |

  The skill list you approved (★ = the signature, learned when the subclass is picked; it takes no slot and can't be forgotten). Every skill has tiers I → II → III-A / III-B:

  | Subclass | ★ Signature | Second skill | Passive |
  |---|---|---|---|
  | ⚔️ Weapon Master | Cleave (2 AP cantrip: every enemy next to you) | Precision Strike (1 AP: advantage, +1d8 on the next hit) | Counterattack: a melee miss on you gets hit back |
  | 🛡️ Guardian | Shield Wall (1 AP: 2d6 + level Block, taunts) | Iron Recovery (heal + Block) | Spiked Shield: Block that soaks a melee hit deals it back |
  | 🗡️ Assassin | Envenom (weapon hits poison) | Assassinate (3 AP: crits a target at full HP) | Death Mark: +1d6 Sneak Attack on the Poisoned |
  | 💨 Skirmisher | Quick Stab (a 1-AP basic attack) | Tumble (+4 tiles, +2 AC) | Strike and Fade: the first attack each turn gives +2 movement |
  | ☄️ Evoker | Sculpt Spells (area attacks skip friends) | Meteor (3 AP: 6d6 fire, radius 2) | Empowered Evocation: + damage on spells |
  | ❄️ Elementalist | Frost Nova (chill and push everything around you) | Flash Freeze (cold area: the Wet freeze) | Catalyst: battlefield fire, poison, shocks and blasts you set off deal +50% |
  | 💖 Life | Mass Healing Word (heals and revives everyone near) | Prayer of Healing (big group heal) | Disciple of Life: + healing |
  | ⚖️ Order | Warding Light (1 AP, range 6: Block on a friend) | Command (dazed and prone) | Voice of Authority: a friend you help gets +1 AP |
  | 🩸 Berserker | Blood Price (0 AP: 10% of your max HP for +1 AP) | Frenzy (two swings, then you're Marked) | Bloodlust: + melee damage below half HP |
  | 🦏 Juggernaut | Blood Drinker (melee hits heal you for ¼) | Challenge (taunt and Block) | Unstoppable: no Prone, Netted or Webbed while Raging |
  | 🪤 Trapper | Snare Trap (hidden: the first monster in is Netted) | Barrage (arrows on an area) | Ambusher: + damage on the Netted and Prone |
  | 🎯 Sharpshooter | Aimed Shot (3 AP, range 14) | Piercing Shot (goes on to 2 more) | Deadeye: + damage at 5+ tiles |
  | 🏰 Protection | Intercept (take an attack meant for a friend next to you) | Aegis (Block on you and everyone next to you) | Aura of Warding: friends next to you get Block each turn |
  | 🌟 Devotion | Blessed Smites (Divine Smite heals you for half) | Restoring Touch (heal a friend, and yourself half) | Divine Vitality: + HP every turn |
  | 🎺 Valor | Rousing Inspiration (Inspiration gives +1 AP) | War Chant (Rallied ×2 and Block for everyone near) | Combat Inspiration: inspired friends get +1d4 on hits |
  | 🤫 Whispers | Dissonant Whispers (Frightened: it runs) | Cutting Words (Dazed) | Psychic Blades: + damage on debuffed monsters |

  - Renamed from the draft to avoid clashing with existing names: Bloodthirst → Blood Drinker, Sentinel Aura → Aura of Warding, Holy Vigor → Divine Vitality, Battle Hymn → War Chant, Hit and Run → Strike and Fade, Volley → Barrage. Intercept reuses the Fighter's Bodyguard code. Deadeye gives damage only (no extra range: ranges live on the skill).
  - [x] Data (shared/subclasses.ts, 48 skills), the level-3 pick (a level-up offer of the class's two subclass cards; bots pick at random so runs play both), offers only from your own subclass, the shop can't forget a signature
  - [x] Rules: Honed, Envenomed, Emboldened and Frightened statuses; HP costs, healing yourself, hidden snares (monsters don't see them), thorns, lifesteal, Catalyst, Spell Pierce, Intercept, Counterattack, auras and regeneration, Unstoppable
  - [x] Monster AI: Frightened monsters run from whoever scared them (scripted and PPO alike)
  - [x] Hero bots value them: the new damage passives, Honed and Death Mark in hit math, Envenom, Frightened, snares (placed between a monster and its target), Blood Price's HP
  - [x] UI: subclass cards at level 3 ("Level 3: choose your path"), "Class · Subclass" on hero cards, snares on the board (with a tooltip), the codex (subclasses on the Heroes tab, a subclass filter on Skills, and pool checks: signatures and `sub` tags must match their class)
  - [x] Tests: `tests/subclasses.test.ts` (18). One caught a wrong refusal: a second Blood Price said "Ready in 1 turn" instead of "Only once per turn".
  - [x] Bot runs (with the victory spoils, below)
  - Not shown yet: the subclass in the lobby, the saved-run list and the resume banner (their types carry no subclass).
- [ ] 🟡 **Rewards after every win** (decided 2026-10-19): each hero picks 1 of 3 cards, two skill cards and one item card. Level-ups give HP and power, and the subclass at level 3. Potions drop like Slay the Spire's: 40% after a fight, +10% after each fight without one, −10% after each one that drops.
  - [x] Victory spoils after every won fight, boss included (`makeRewardOffer` in server/progression.ts): two skill cards from the class and subclass pools (now and then a common passive), and an item card: gear the hero isn't wearing or a consumable, rarer as the acts go on (no rares in act 1). A quarter of the time, or when the bag is full, the third card is a boon (+HP, +AC, potions, a slot) instead.
  - [x] Order of picks: elite spoils, then the subclass, then victory spoils. A hero joining mid-run gets a victory pick for every level they missed.
  - [x] Levels give stats only (`levelUps` is now just the subclass pick); old saves' waiting level picks still work.
  - [x] Potions: `POTION_ODDS` 40, ±`POTION_ODDS_STEP` 10, kept in the run (`run.potionOdds`); the hero with the fewest gets it. Regular fights no longer drop a random consumable (the item card replaces it); elites still drop gear for the killer.
  - [x] Bots take victory picks like any other (they value item cards like elite gear, consumables at a flat 3.5). Tests: `tests/rewards.test.ts` (7).
  - [x] UI: the item card ("Goes into your bag"; dimmed when the bag is full), "🏆 Victory spoils: pick one", 🏆 counters on the HUD and party cards, a toast; how-to-play, README and the codex say skills come from victory spoils now
  - [x] Bot runs on the whole new build (AP, Block, subclasses, victory spoils), 12 runs, all difficulties, 3–6 heroes: **12/12 won**, 0 anomalies, 0 rejected actions, 0 server errors, no stuck fights. Per 12 runs: 54 subclass picks, 221 Dashes, 320 Braces, 453 Block given, 8 snares set (3 sprung), 14 Intercepts, 8 Frightened, 44 Blood Prices, 2 thorns, 2 smite heals, 0 Counterattacks (Weapon Masters rarely learned it).
  - An earlier batch on AP + Block alone (12 runs, 900 s limit): 8 won, 4 ran out of time in act 3 (slow, not stuck: more actions per turn). The runs above used a 1500 s limit and finished in 7–14 minutes.
  - **For Phase 13:** there are about twice as many picks per run as before (one per fight instead of one per level). The heroes got much stronger overall: Hard went from 1 win in 4 (AP + Block) to 4 in 4, downs per run on Hard from 7.3 to 4.8.
- [ ] 🟡 **Playtest redesign** (your playtest, 2026-10-19): Fireball one-shots fights, the Paladin's revive makes dying painless, every fight starts the same way, the pools are too shallow for builds, the rarity colors confuse (purple was the elite panel, not "epic"), and the maps are too simple. Built in four steps:
  - [x] **Step 1: revives, death, Fireball, rarity** (2026-10-19)
    - [x] 🤝 Help Up (everyone, 2 AP, a downed friend next to you): back up at 25% of max HP (`HELP_UP_HP`), and 🥴 Groggy: they lose their next turn
    - [x] Healing spells, potions, scrolls and NPC healers still get a downed friend up, also Groggy; cantrip heals can't (`noRevive`, set in `statsAt`), nor do passives, auras and lifesteal. Getting up by your own death saves leaves you fine.
    - [x] 🩹 Injury: a hero who dies (3 failed death saves) is back after the fight with −20% max HP per death (`INJURY_PCT`, up to 3), until the next rest site or act; shown on the party card
    - [x] Fireball falloff (`falloff`, `atEdge`): on a radius 2+ blast (Fireball II, Meteor) the outer ring takes half; tier I's 3×3 is unchanged (its "ring" would be everything but the center)
    - [x] Monsters spread out when a hero can blast an area (`CLUSTER` per friend next to it, `CLUSTER_NEAR` two tiles away, in server/monsterai.ts); the hero bots price the falloff
    - [x] Rarity: the usual colors (grey, green, blue, purple epic, orange legendary), a new epic tier (Archmage Robe, Tower Shield), weighted odds by act (`RARITY_ODDS`: act 1 is 65/28/6/1/0) for victory item cards, shops, events and elite gear (elites: the next act's odds, no commons), and a per-hero pity counter on item cards (`RARITY_PITY`). Relics: common/uncommon/rare at 50/33/17 for treasure and shops (`RELIC_ODDS`). The codex shows the odds.
    - [x] The elite spoils panel is crimson now, so purple only ever means epic
    - Tests: `tests/revive.test.ts` (24). One caught that the Evoker's Meteor (its own spell, not Fireball's Meteor branch) had no falloff.
    - Bot runs (12, all difficulties, 3 and 5 heroes): 11 won, 1 lost on Hard; 0 anomalies, 0 rejected actions, 0 server errors. 15 Help Ups, 31 revives by heals (the bots still prefer a potion: 1 AP), 30 turns lost to Groggy (fewer than revives: a fight that ends, or going down again, clears it), 5 outer-ring hits. Nobody died, so Injury only has its tests so far.
  - [x] **Step 2: battlefields** (2026-10-19)
    - [x] Bigger rooms: 24×16, elites 26×17, bosses 28×18 (a bit under the planned 26×18, so fights don't turn into long walks)
    - [x] Five plans (server/room.ts): scattered rocks, a pillared hall, a wall across the middle with gaps, side halls with doorways, ruins full of low cover. Bosses get rocks or pillars, mirrored. Bridges are left for later (they need a chasm tile).
    - [x] 📦 Low cover, a new tile (`'o'`, `LOW_COVER` in shared/grid.ts): crates, rubble, a broken wall. It blocks movement (`isBlocked`, `canStep`) but not sight.
    - [x] Five deployments (`pickDeployment`): the classic line, scattered (the party comes in by two ways, the monsters in three groups), a pincer (from both ends), surrounded (every ambush), and their camp in the middle with the party coming in from three sides. Regular fights mix line, scattered, pincer and camp; elites never scatter you; bosses wait at the far end. Nobody starts within 3 tiles of the other side, or in a puddle. A log line says which. The sneak vote still only decides who is surprised.
    - [x] 🛡️ Cover, XCOM style (`coverFrom` in shared/tactics.ts): low cover or a prop on the side facing a ranged attacker gives +2 AC (`HALF_COVER`), a wall +5 (`FULL_COVER`); the same on DEX saves against a blast from that side. Melee ignores it, and so does an attacker far enough round the side (flanking). The log shows it ("vs AC 17 (behind a wall)").
    - [x] Both AIs price cover in their hit chances, monsters like cover from heroes who shoot (archers and supports most), and hero bots like cover from monsters who shoot
    - [x] Fixed on the way (found by the tests, older than this step): the room's entity list was the heroes array itself, so every monster spawned joined it. Monster scaling read a growing party size (identical goblins got different stats), ambushes surprised the monsters too, and monsters didn't face the party.
    - [x] Client: low cover drawn as a crate or a boulder (📦 / 🪨 in the classic look); XCOM-style shields on the tile you're about to walk to (a full shield for a wall, a half one for low cover; never arrows, so high ground can look different later); cover in the hover text, the attack preview ("🛡️ Behind a wall: +5 AC") and per monster in a blast's preview; the how-to-play, README and codex rules
    - Left as is: fire and oil can spread onto a crate tile (nobody can stand there, so it only shows)
    - Tests: `tests/battlefield.test.ts` (25), `tests/room.test.ts` updated for the new sizes.
    - Bot runs (12 all difficulties, 3 and 5 heroes, plus 6 on Hard with 5 heroes): 23 won, 1 lost (a fast but real Hard wipe); 0 anomalies, 0 rejected actions, 0 server errors, no stalls; run times about the same as before. In the 6 Hard runs: 161 rolls against cover; starts: 20 scattered, 25 pincer, 31 camp, 4 surrounded (the rest the line).
  - [x] **Step 3: build engines** (your draft, approved 2026-10-19; built 2026-10-20)
    - [x] No subclass pick at level 3: the 48 subclass skills are ordinary class cards now. Old saves keep their subclass label and its slot-free signature.
    - [x] 24 engines, 3 per class (shared/engines.ts): Fighter Weapon Master (crits) / Guardian (Block and thorns) / Duelist (counters); Rogue Assassin (poison stacks) / Skirmisher (many small hits) / Shadow (one big backstab); Wizard Evoker (Arcane Charge) / Elementalist (combos) / Geomancer (terrain); Cleric Life (overhealing) / Order (buffs from range) / Light (Radiance); Barbarian Berserker (low HP) / Juggernaut (lifesteal tank) / Wrecker (knockdowns); Ranger Trapper / Sharpshooter (Focus) / Hunter (marks); Paladin Protection / Devotion / Vengeance (smites); Bard Valor (AP) / Whispers (debuffs) / Crescendo (Verses)
    - [x] 75 new cards (all with tiers I → II → III-A / III-B), each engine with builders, multiplier payoffs and an epic capstone
    - [x] Stacks as statuses whose power is the count: Poison (heroes' Poison now stacks, up to 10; Virulence 15), 🔷 Arcane Charge, 🔆 Radiance, 🧘 Focus, 🎼 Verse, 🎇 Inspired, 🔗 Soul Link. `per` bonuses (`SkillStats.per`) pay per stack: Rupture, Mind Rot, Dawn, Kill Shot, Shield Slam, Crashing Finale.
    - [x] Geomancer terrain: Raise Cover (low cover tiles), Wall of Stone (walls for 3 rounds, or a ring around an enemy), Shatter Ground (rubble), Tremor, Crushing Force (pushed into a wall or a creature: 1d6 per tile it couldn't move)
    - [x] Card rarity like items (`cardRarity`): each rarity gets the act's share of offers with the hero's pity, split over its cards; epics only once you picked 2 cards of the engine; cards of engines you've started lean in (2 picks: twice as likely, 4: three times), upgrades too. Starting cards don't count (`enginePicks`): otherwise every fighter started halfway into Guardian.
    - [x] AP prices can change (`apOf`): Archmage, Pile Driver, Chain of Command, Martyr
    - [x] Engine gear: Keen Whetstone (crit range), Venom Vial (Poison on hits), Spiked Pauldrons (thorns), Bloodstone (lifesteal), Charged Orb (start with Charges), Lute of Echoes (start with Verses), Sunstone (Radiance), and the first legendaries: the Vorpal Blade and the Aegis of the Ancients. Relics: Storm Coil (lightning on the Wet), Plague Censer (stronger Poison).
    - [x] The bots build engines (a card of an engine they own is worth more), price the stacks in their hit math, and use the new actives (Toxic Catalyst, Entrench, Unleash, raised cover, Finale)
    - [x] Client: rarity and engine on every skill card ("⚔️ Weapon Master · you have 2"; epic capstones glow purple), stack counts on statuses (☠5, 🔷3), "Class · Engine" labels (`topEngine`), AP prices from `apOf` on the hotbar; the codex shows engines (per class, by rarity; Engine and Rarity filters; checks: every card real and in its class, none in two engines, 3 engines a class, each with an epic); how-to-play and README
    - Tests: `tests/engines.test.ts` (38); the subclass, rewards and XP tests now check that there's no subclass pick. One caught Unleash adding its dice on every dart of a Magic Missile instead of once per target.
    - Bot runs (12, all difficulties, 3-6 heroes): 12/12 won, 0 anomalies, 0 rejected actions, 0 server errors. Main engines at the end: fighters Guardian 8 / Weapon Master 4, wizards Elementalist 5 / Geomancer 2 / Evoker 1, bards Crescendo 5, clerics Order 4, paladins Protection 4, rogues Shadow 4... Engines at work: 9 Finales, 7 raised covers, 6 crushed against walls, 5 shattered ice, 4 knockdown hits, 2 Unleashes.
    - **For Phase 13:** no Duelist build came out (counters rarely fire on bots), and some payoffs never showed in 12 runs (Toxic Catalyst, Knife Juggler, Conductor's arcs, Madness, Split Shot, Unkillable): check the bots pick and use them. Hard is still won every time.
  - [x] **Step 4: Phase 13 balance** on the finished design (2026-10-20): see Phase 13 below. All that's left is your playtest.
- [x] **🤝 Shared hero turns** (your call, 2026-10-20, BG3 style, built before the playtest): heroes side by side in the turn order play at the same time. Each moves and acts with their own movement and AP, in any order, and ends their own turn; the turn moves on once all of them have. Monsters and NPC allies still act one by one. The point is pace: two people no longer wait for each other when they roll next to each other (about 3 fights in 10 with random initiative). The other option, the whole party acting as one block every round, is kept in reserve in case the pace is still slow.
  - Server: `TurnState.group` (who is acting now) and `TurnState.acts` (each one's movement and AP) replace the single `movesLeft` / `ap`. A hero who loses their turn (down, stunned, groggy) stays part of it without acting and their turn ends with everyone's, so a friend in the same turn who helps them up spends the Groggy on this turn (as when a friend got to them first before).
  - Bots in a shared turn take theirs one after another, in turn order; the people in it play whenever they like. All at once, the bots ran to the same downed friend and at monsters another was about to kill: Hard fell from 50% to about 30% in two batches.
  - A walk stops, with a warning, at a tile that turned dangerous after it was planned (a friend's fire, ice or lightning in the same turn); bots plan again. Without it the first batch had 79% more shock hits.
  - Client: everyone in the shared turn is highlighted in the turn order, ringed on the board and marked on the party cards; "🎲 Your turn, together with Bob!", "👣 6 moves ⚡ 3 AP together with Bob", "Waiting for Ann and Bob". Checked with two players in two browser tabs.
  - Tests: `tests/turns.test.ts` (11); the older tests start one creature's turn at a time (`beginTurn([id])`).
  - Bot runs on the final version: 144 runs, 📖 Story 100%, ⚔️ Normal 79%, 💀 Hard 40% (before shared turns: 96 / 85 / 50%), 0 anomalies, no stuck fights. With the two batches just before the Groggy fix (432 runs): Normal 80%, Hard 45%. Normal may sit a few points lower than before (a downed hero now makes the death save as the shared turn starts, before a friend in it can heal them); one batch of 48 runs swings ±8 points, so this waits for the playtest.
- [ ] More monsters and elites per act; alternate bosses
- [ ] More elements and combos: blood (conducts lightning), curse/bless surfaces, weather events (rain, storms)
- [ ] Traps and interactive room props (doors, levers, collapsing floors)
- [x] **More events and encounter templates** (2026-10-20; the goal was ~15 events and ~8 encounter templates per act)
  - [x] 14 new events (25 in all): 16 in act 1, 17 in act 2, 18 in act 3. Four for every act are Slay the Spire-style trades: the Old Training Hall (2d6 damage for a spoils pick each), the Blood Tailor (gold or gear for an Injury), the Drowned Library (XP, or a spoils pick and an item on an INT check), the Altar of Pacts (a relic for an Injury each). Act 1: the Goblin Toll Bridge, the Goblin Cook, the Kobold Tinkerer (also act 3). Act 2: the Bone Organ, the Grave Robbers, the Ghostly Duelist, the Soul Mirror (also act 3). Act 3: the Spilled Hoard, the Dragon Egg, the Orc Deserter.
  - [x] New event effects: a spoils pick (`spoils`, for everyone or the hero who made the check), an Injury until the next rest site (`injury`), XP (`xp`, levels come at once), a random relic (`relic` without an id), and fights that start as an ambush (`fight.ambush`)
  - [x] 9 new encounter templates (9 per act). Templates can have a twist (`EncounterDef.deploy`, `terrain`): their own start (🏕️ their camp, 🦀 a pincer; an ambush still surrounds you) and extra ground on top of the act's. Act 1: Tunnel Pincer, Oil Cellar, Goblin Campfire. Act 2: Flooded Ossuary, Ghoul Feast, Webbed Corridor. Act 3: Magma Vents, Orc War Camp, Sermon of Flame. The codex shows the twist.
  - Tests: `tests/content.test.ts` (9); the event tests check the new effects.
- [x] **💀 Hard movesets** (your call, 2026-10-20: "on Hard, enemies have more variety"; chosen over veterans late in each act): on Hard every regular monster has one extra move, so Hard is smarter rather than just tankier. Story and Normal keep today's kit.
  - `HARD_MOVES` (shared/rules.ts): each one's Hard version is registered as `<id>_hard` (same name and numbers, plus the move) and spawns in its place on Hard. Built from the existing toolbox, so both monster AIs already use them: act 1 rats Poison, kobolds shove, goblins hamstring (Daze), archers pin you (Pinning Shot), firebombers drop a last bomb when they die, shamans Hex (Marked); act 2 skeletons Shield Bash (Prone), zombies grab (held in place), bloated zombies vomit Poison, wolves howl orders, spiders' venom, and necromancers **Raise Dead** (the one new rule: once a fight, after a friend falls, a Zombie claws its way up next to it, worth no XP); act 3 orcs stagger (Daze), cultists set you Burning, imps spit cinders (Blind), ogres bellow (Daze), priests shout orders.
  - Shown as "💀 On Hard: ..." on the monster's tooltip and in the codex. Hard's description says so.
  - Hard's extra HP went from ×1.3 to ×1.15: three Hard batches of 50 runs at ×1.3 / ×1.15 / ×1.0 won 50% / 48% / 54% (each batch swings ±7 points), with less HP meaning fewer downs per fight.
  - One Bone Knight fight in 150 Hard runs passed 40 rounds (a support-heavy party of 6 kept killing the minions that rise again instead of the boss, and won in the end). Rise Again works as designed; worth watching.
  - Tests: `tests/content.test.ts` (3 more).
  - Bot runs on the final numbers: 144 runs with the new events and encounters too: 📖 Story 96%, ⚔️ Normal 83%, 💀 Hard 33%, 0 anomalies. All four Hard batches with the moves together: 92 of 198 won (46%). Act 2 is Hard's roughest stretch now (wolves that all shout orders, zombies that grab, raised dead): in this batch 14 of 151 act 2 regular fights wiped a Hard party, against 2 of 188 in the ×1.15 batch before it. If Hard feels unfair there, the wolves' orders are the first thing to drop.
- [ ] Sound effects and music (CC0)
- [ ] Touch/mobile controls
- [ ] Unlocks/meta-progression between runs (new classes, starting relics)

---

## Phase 13: Balance pass 🟡

**When:** after the classes, items and skills are in (Phases 2–7 and enough of Phase 12). Before that, balance is deliberately ignored.

Started 2026-10-20, right after the playtest redesign (your call: balance first, then the playtest).

**Targets** (bots playing every hero, scripted monsters): Story about 100% wins, Normal about 85%, Hard about 45%. Losses on Hard should come late rather than at the first fight, and every party size from 3 to 6 should feel the same pressure.

**Where it started** (96 bot runs on the redesign): 95 won, Hard included. After act 1 nothing hurt: in act 3 the heroes hit 8 times in 10 and fights ended in under 3 rounds, and even on Hard the party's lowest HP in an act 3 boss fight averaged 95%. The only losses were Hard parties of 3 wiped in their very first fight (6 rats surrounding level 1 heroes).

- [x] **Measure fast.** `npm run balance-farm` starts several test servers at a high game speed (`DELVERS_SPEED=1000`) and plays a balance client on each: 48 full runs take about 5 minutes instead of 40. The report gained what win rates can't show while the bots win everything:
  - pressure per difficulty, act and fight kind (combat, elite, boss): downs per fight, the party's lowest HP, the HP it starts the fight with, rounds and wipes
  - attack rolls per act: how often the monsters hit and how hard, how often the heroes hit
  - damage share per class (1.00 is an even share), gold per act (in the purse and spent in shops)
  - `OUT=file.json` keeps every run; `scripts/balance-merge.ts` reports on several files together
  - `DELVERS_TUNE` (JSON) overrides the knobs in `shared/rules.ts` (`TUNABLES`) at server start, so several settings can be tried side by side without editing code
- [x] **Monsters grow with the act** (`ACT_SCALING`): act 2 ×1.7 HP, +1 AC, +2 to hit, ×1.6 damage; act 3 ×2.4 HP, +2 AC, +2 to hit, ×2.2 damage. Elites and bosses get less HP (`solo`: ×1.35, ×1.6): with all of it on one body, their fights dragged past 10 rounds.
- [x] **Bosses are a race, each its own way** (your call, 2026-10-20: "not for every boss", "unique so it doesn't feel repetitive"). Before, a boss was a big bag of HP: its fights were the longest in the game (8–9.5 rounds in acts 2–3) and invited turtling. Now:
  - When the boss falls, the rest flee and the fight is won (all bosses), so bursting the boss pays.
  - 👑 Goblin King, 📯 **War Horn**: every 3rd round it calls more goblins and archers (one per two heroes).
  - ☠️ Bone Knight, 🦴 **Rise Again**: its fallen minions get back up 2 rounds later, as long as it stands (no XP the second time).
  - 🐉 Dread Wyrm, 😡 **Wrath**: from round 4 a Fury stack every round, +1 to hit and +10% damage each, its fire breath too. The breath also grows with the act now (it was a flat 3d6 all game).
  - Boss numbers to match (`BOSS`, `BOSS_SIGNATURES`): ×1.2 damage, 0.5 minions per hero, ×0.9 HP against 3 heroes. Shown on the boss's token, in its tooltip, the codex and the how-to-play.
  - The hero bots know: damage on the boss counts extra, killing it counts every minion as killed, and a Rise Again minion's kill counts less.
  - Elites keep a separate damage knob (`ELITE`), left at ×1.
- [x] **Difficulty damage is a multiplier** now (Story ×0.85, Normal ×1, Hard ×1.2), so Hard bites harder later instead of front-loading act 1. Normal: ×1.1 HP, ×1.15 budget; Hard: ×1.3 HP, +1 to hit, ×1.3 budget.
- [x] **The run's first fight is a warm-up** (`WARMUP_BUDGET` ×0.75, always the classic line): no more runs lost before the first choice.
- [x] **Party sizes feel the same** (`PARTY_SCALING`, `SOLO_HP_SCALING`): budgets and elite and boss HP now grow from a 3-hero baseline (budget ×1.4 base, +45% per hero; elites ×1.1, bosses ×1.3, +0.5 per hero). Before, elites had a third more HP per hero against 3 heroes than against 6: bots won 0 of 12 Hard runs with 3 heroes and 10 of 12 with 6. Now the party's lowest HP per fight is the same for 3 to 6 heroes (Normal 79–83%, Hard 68–72%).
- [x] **The after-fight breather** heals 15% (was 20%, `BREATHER`)
- [x] **Rule fixes the runs turned up:**
  - 🔰 **Shielded**'s ward (a quarter of max HP) came back every 3rd round forever. With act-scaled HP, late elites became unkillable (a Fire Drake at full HP after 40 rounds). It comes back once now.
  - 🩸 **Worn down** (new, `MAX_DOWNS`): each time a hero goes down again in the same fight, their death saves start one failure worse, and the 4th fall is death (an Injury after the fight). A monster that kept hitting the same groggy hero, who was hauled back up every turn, made a 176-round fight. ⚠️ A new rule: say if you'd rather not have it.
- [x] **Hero bot fixes:**
  - They walk around walls: they headed for monsters by straight-line distance, so a wall between them and a boss kept two healthy heroes waiting behind it for 40 rounds
  - They don't haul up a friend who would only go down again before their turn, unless that friend is close to dying
  - They count the act's bonus damage when they judge how hard monsters hit
  - They go to the shop when they have gold (they used to skip shops, so gold piled up: about 540 left at the end, now about 350, with 2.5 shop visits and 8 purchases per run)
- [x] **Design goals:** supports keep up (classes end within a level of each other: bards and clerics about 7, rogues and rangers about 7.4); Long Rest vs Train is still a choice (about 65 / 35 now that fights hurt); every engine shows up in bot builds, and within a class the engines deal similar damage (±11%). Nearly every engine payoff fires now that fights last: Unkillable, Split Shot, Knife Juggler, shock arcs, Counterattack (261 per 144 runs) and Finale (243). Madness still never fires.
- [x] XP, slots, gold income and prices: left as they are (levels 7–8 at the end, the shop gets used)
- [x] **📓 Run journal** (your ask, for analyzing the playtest): every run writes its whole story to `saves/journal/<code>-<date>.jsonl` (server/journal.ts): every log line, each fight's numbers (rounds, downs, deaths, the party's HP at the start and lowest, damage per hero), every pick next to the cards that were offered, the path, and the builds at the end. The game never deletes them. `node scripts/journal-report.ts --latest` prints the report.
- [x] **⏱️ Pace in the journal** (2026-10-20, before the playtest): every turn is timed (`turn` lines: who, how long, how many shared it). The report adds each fight's time and seconds per round, time per act, each person's median seconds per turn next to the bots' and the monsters', and how much waiting the shared turns saved. Time away from the game (gaps over 5 minutes) doesn't count.
- [x] **🏁 Outcome screens** (your ask, 2026-10-20: "it's so abrupt, we got moved to the map"): a won fight, an event, a treasure, a rest and the act boss each end on their own screen, over the battlefield after a fight, that lists what happened (gold, healing, loot, potions, level-ups, damage dealt per hero, or what the event's choice did: gold, relics, blessings, injuries...). Everyone picks their spoils there; the map comes when every person has clicked Continue (bots don't count, and a minute after the first click the rest come along; unpicked spoils wait on the map). An event that starts a fight shows its outcome first and the fight starts on Continue. The map's banner no longer repeats what happened; it only introduces a new act.
  - Saves: an outcome screen saves as the map (a restart doesn't replay the fight); an event that leads to a fight keeps the save from before the event, as before.
  - Tests: `tests/outcome.test.ts` (7).
- [x] **🤖 Build and let the AI fight** (your ask, 2026-10-20): with auto-play on, the AI plays your turns, but each spoils or level-up pick waits 10 seconds for you (`PICK_WAIT_MS`), with a countdown on the pick panel, and so does your rest-site choice. Pick in time and it's your pick; the next pick gets its own 10 seconds. The victory screen waits until your picks are made, then moves on by itself. Bots and players who dropped out still pick at once (bot runs are as fast as before).
  - Tests: `tests/autopick.test.ts` (6, on mocked timers).
- [x] **🤖 Pick a bot's class** (your ask, 2026-10-20): in the tavern, the host picks each added bot's class from a dropdown on its row (it starts with a class that fills a gap, as before). A saved run's bots keep their class. Test in `tests/classes.test.ts`.
- [ ] Playtest with real people, then adjust (`node scripts/journal-report.ts --latest` afterwards)

**Result (2026-10-20):** 144 runs on the final numbers, boss signatures included (in brackets: before the boss rework), 0 anomalies, 0 stuck fights:

| | Wins | Lowest party HP: combat / elite / boss (act 3) | Rounds: combat / elite / boss (act 3) |
|---|---|---|---|
| 📖 Story | 96% (100%) | 91% / 89% / 92% | 3.2 / 4.0 / 4.1 |
| ⚔️ Normal | 85% (85%) | 80% / 64% / 77% | 4.4 / 7.0 / 6.2 (8.0) |
| 💀 Hard | 50% (48%) | 68% / 54% / 72% | 5.4 / 7.7 / 7.4 (9.2) |

- Boss fights per act on Normal: 3.9 / 5.7 / 6.2 rounds (were 4.9 / 8.5 / 8.0). The bots put about 70% of their weapon damage on the boss (a little over half against the Bone Knight, whose dead keep getting up).
- On Hard most losses come in act 2 (the Wight, the Spider Broodmother and the Bone Knight); the Goblin King's War Horn is the act 1 wall on Hard.
- A run takes about 1.5 minutes at bot speed. Deaths per run: Normal 0.7, Hard 2.0, so Injury matters now.
- Still uneven: 3-hero parties win a bit less than bigger ones with the same average pressure (one down is a third of the party). Worth watching in the playtest, since you and a friend plus a bot make 3.
- Bots aren't players. Treat these numbers as a starting point for your playtest, not the final word.

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
- **Party size:** at least 3 (bots fill in; decided 2026-10-19). Keep the max at 6, or cap at 4 for balance?
- **Art style:** your pick (Phase 8).
- **Main goal:** a fun game, or also learning RL? This decides how deep Phase 11 goes (LLMs are out, see Phase 10).

## Known issues / tech debt

- Balance is tuned against bot runs (Phase 13); the playtest with real people is still to come.
- Shared hero turns: two people walking at once can block each other's path (the walk just stops; click again).
- `window.delvers` debug handle is exposed in the client (handy, harmless).
