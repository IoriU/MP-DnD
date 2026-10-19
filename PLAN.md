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

Started 2026-10-19. Order: the codex first (to see the pools), then monster abilities, then the rest of the list.

- [x] **Codex: a content dashboard** (your ask, 2026-10-19: "view + checks"). `/codex` on the played build, `/codex.html` in dev.
  - Browse every pool: heroes, skills (every tier), items, relics, blessings, monsters, acts and encounters, elites and allies, statuses and surfaces, events.
  - It imports the real game data, so it can't drift. Every entry shows the file and line it lives on (a VS Code link in dev); edits still happen in code.
  - Pool checks: broken references (errors), unused content and missing sprites (warnings), and coverage against the goals below (events and encounters per act, classes). `tests/codex.test.ts` fails on any error.
- [ ] More classes: Ranger, Paladin, Barbarian, Bard
  - The codex also shows the current pools are thin: every class has only 2 class passives (a hero holds 2 at level 1, so no choice there), and the Fighter has exactly 3 cantrips and 3 spells (the hotbar limits). New classes should come with deeper pools, and the old ones need more passives.
- [x] **Monster abilities** (decided 2026-10-19, after Phase 11 showed monsters that only move and hit leave PPO nothing to learn):
  - [x] Tricks, instead of attacking (`MonsterDef.trick`): 🪢 Kobold's Net (Netted: can't move, ranged attacks have advantage; once a fight), 🫳 Goblin's Dirty Trick (Blinded), 🕸️ Giant Spider's and Broodmother's Web (Webbed: stuck, attacks have advantage, its own have disadvantage, until cut free or burned), 🎯 Dragon Cultist's Brand (Marked)
  - [x] Riders on hits (`MonsterDef.rider`): Wolves and Ogres knock you 🤕 Prone (melee advantage, ranged disadvantage, getting up costs half your movement); a Wight's touch 🩸 Drains max HP until the fight ends (stacks)
  - [x] 👉 Help: any melee monster can get in a hero's face instead of attacking (Distracted: the next attack on them has advantage)
  - [x] Stacking buffs: 📯 Rallied (+1 to hit and damage per stack, up to 3), from the Goblin Shaman and the Charge order
  - [x] Leader orders (Hobgoblin Captain, Orc Warchief and the three bosses), a free shout every 3rd turn: 📯 Charge! (+3 movement and a Rallied stack), 🛡️ Hold the line! (+2 AC), 🎯 Kill that one! (Marked)
  - [x] Drenched: already there (Wet from water: lightning stuns, cold freezes); no new trick needed
  - [x] The scripted squad AI uses them: a set-up is worth what the friends who act before the target's next turn gain from it (`trickValue` in server/monsterai.ts, with the initiative order and pack targets)
  - [x] The hero bots answer: ✂️ Cut Free (everyone, bonus action) for themselves or a friend next to them, and they go for trick-throwers and leaders first
  - [ ] Retrain the PPO monsters (training/README.md). The option features changed (44 → 48: the trick and Help kinds, and what an option sets up), so the old policy no longer fit.
    - [x] For now 🧠 PPO ships the imitation stage of run 3 (it copies the scripted AI 100%), so the lobby choice keeps working
    - [ ] PPO run 3 (`training/runs/ppo3`, entropy bonus lowered to 0.002 after run 2's drift), then a 2,000-fight comparison and export
  - Bot runs (3 batches of 18, all difficulties, 3–6 heroes): 0 anomalies, 0 rejected actions, 0 server errors. Per 18 runs: about 55 tricks (half land), 50–65 orders, 26 Cut Frees by the bots, 5–14 knockdowns, 8–20 drains; Help is rare (it only wins next to a big hitter, like Kobolds next to an Ogre).
  - Tests: `tests/abilities.test.ts` (34). It caught a bug: a netted hero could dash out of the net (dash movement now waits until it's free).
- [ ] More monsters and elites per act; alternate bosses
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

- [ ] Use `npm run balance` (many full bot runs) to measure win rate, where parties die, and kills/XP/levels per class, for party sizes 3–6
- [ ] Tune the difficulty curve. Known so far: act 1 elites are deadly while acts 2–3 are too easy; small parties without a healer struggle; 3–6 hero parties win every run even on Hard (Phase 9).
- [ ] Tune XP (kill bonus vs shared base), slots per level, rest healing, gold and item prices
- [ ] Check the design goals: supports keep up with killers, Long Rest vs Train is a real choice, every class gets picked
- [ ] Difficulty settings (Phase 9) feel distinct: Story / Normal / Hard, for every party size 3–6. `DIFF=all node scripts/balance.ts N 3,4,5,6` gives the table; the knobs are `DIFFICULTIES`, `PARTY_SCALING`, `scaledHp` and `packsFor` in shared/rules.ts
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
- **Party size:** at least 3 (bots fill in; decided 2026-10-19). Keep the max at 6, or cap at 4 for balance?
- **Art style:** your pick (Phase 8).
- **Main goal:** a fun game, or also learning RL? This decides how deep Phase 11 goes (LLMs are out, see Phase 10).

## Known issues / tech debt

- Balance is deliberately untuned until the Balance pass (Phase 13).
- `window.delvers` debug handle is exposed in the client (handy, harmless).
