# Dungeon Delvers

A co-op, turn-based roguelike in the browser for 1–6 friends (every party has at least 3 heroes: bots fill the empty seats). The run plays like Slay the Spire: three acts, each a branching map the party votes its way up. The fights play like a tabletop RPG, using simplified D&D 5e rules: d20 attack rolls against AC, initiative, spell slots, death saves and sneak attacks. Turns use action points (AP) like Divinity: Original Sin and Slay the Spire, with Block to soak hits.

Everything here is free: Node.js, Phaser and Socket.IO are open source, the game needs no image assets (it uses drawn tiles and emoji), and you host it from your own PC.

## Quick start

Requires [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
npm run play
```

Open http://localhost:3000, enter a name, pick a class and click **Create a room**. Send the invite link (or the 4-letter room code) to your friends.

## Playing with friends ($0, no domain or DNS needed)

`npm run play` prints the addresses your server is reachable at. Pick whichever option fits:

| Option | Friends need | How |
|---|---|---|
| **Same Wi-Fi / LAN** | Nothing | Share the `http://192.168.x.x:3000` address the server prints. |
| **Tailscale** (most private) | The free [Tailscale](https://tailscale.com) app | Install it on your PC and theirs, invite them to your tailnet (or share your PC from the admin console), then share `http://100.x.x.x:3000`. Nothing is exposed to the public internet. |
| **Cloudflare quick tunnel** (easiest) | Nothing | Keep `npm run play` running and run `npm run tunnel` in a second terminal. Share the `https://<random-words>.trycloudflare.com` link it prints. No account needed. The link changes every time, and anyone who has it can open the game. |

The first time the server runs, Windows asks whether Node.js may use the network. Allow **Private networks** for the LAN and Tailscale options. The tunnel doesn't need it.

The `tunnel` script needs `cloudflared`. Install it with `winget install Cloudflare.cloudflared`, then open a new terminal.

**Always-on hosting (optional):** you can deploy to a free web-service tier such as [Render](https://render.com) (build command `npm install && npm run build`, start command `npm start`). Free tiers usually sleep when idle and take about a minute to wake up, and their terms change, so check the current limits. Their disks are usually wiped on every restart, which deletes saved runs; hosting from your own PC keeps them.

## How to play

New here? Just start: a 💡 tip shows up the first time something new happens (the map, your first turn, a status, an event check, spoils, a stat point, a pit). The sidebar's **How to play** has a six-line quick start, with every rule folded underneath.

- **The map:** each act is a branching map. Click a glowing room to vote for it. When everyone has voted (or 20 seconds after the first vote) the majority wins; ties are rolled.
- **Rooms:**
  - ⚔️ **Combat:** a fight. Each act has 9 kinds of encounter, and some have a twist: you walk into their camp, they come at you from both ends of a tunnel, or the room is soaked in oil, flooded or full of magma.
  - 💀 **Elite:** a tough fight with special traits (see below), worth a lot of XP and a reward for everyone.
  - ❓ **Event:** a scene with choices the party votes on (16 to 18 per act). Some are trades: pay HP, gold or an 🩹 Injury for a spoils pick, a relic or XP.
  - 🔥 **Rest:** each hero picks **Long Rest** (heal 30% and restore every slot) or **Train** (upgrade a cantrip or spell).
  - 💰 **Treasure:** gold and a relic (the party votes on one of three).
  - 🛒 **Shop:** spend the party's gold (see below).
  - 👑 **Boss:** ends the act. Beat all 3 acts to win.
- **After a room:** a won fight, an event, a treasure or a rest ends on its own screen (over the battlefield, after a fight) that says what happened: the gold, the healing, the loot, the level-ups, the damage everyone dealt, or what your choice did. Pick your spoils there; the map comes when everyone has clicked Continue (or a minute after the first person did). Spoils you don't pick wait for you on the map.
- **Fights:**
  - On your turn you get movement (the blue tiles) and **⚡ 3 AP**. Attacks and most spells cost 2 AP, quick skills 1, the biggest spells (Fireball, Shatter...) 3. AP you don't spend carries over, but a turn starts with at most 5. Walking is free, and until you act you can walk anywhere inside the blue area as often as you like (a misclick costs nothing); once you attack, cast or use an item, your remaining movement counts from there. **👟 Dash** (everyone, 1 AP) adds 3 tiles.
  - **🎲 Turn order:** a bar across the top of the battlefield shows everyone in the order they act, starting with whoever is acting now, with a line where the next round starts (hover a portrait for HP and initiative). When a fight starts, the initiative dice roll for a moment first.
  - **🤝 Shared turns:** heroes next to each other in the turn order play at the same time (like Baldur's Gate 3). Each of you moves and acts with your own movement and AP, in any order, and ends your own turn; the monsters wait until all of you have. A monster or an NPC ally always acts alone.
  - **🧱 Block** soaks damage before HP and temporary HP, until the start of the turn of whoever gave it. **Brace** (everyone, 1 AP, once per turn) gives 1d6; Fighter and Paladin skills, some gear and shield-carrying monsters have more.
  - Click a tile to walk, or use WASD / arrow keys (Q E Z C for diagonals). Press **Space** to end your turn.
  - **Attack:** click a monster; your basic weapon attack in range is picked for you.
  - **Skills:** keys **1–9** (or the buttons), then click a highlighted target (or a spot, for area spells). Esc or right-click cancels.
  - **Big rooms, different starts:** fight rooms are 24×16 tiles (elites 26×17, bosses 28×18), with walls, crates and rubble to fight around. Fights start in different ways, and the log says so when it isn't the classic **line** (you on the left, the monsters on the right): **scattered** groups, a **pincer** (the monsters close in from both ends), **surrounded** (every ambush starts like this) or **their camp** (they wait in the middle and you come in from three sides). Bosses always start as a line.
- **Skills:** every class has three kinds, each with its own class flavor (the Fighter's spells are Maneuvers paid with Grit, for example):
  - ⏱ **Cantrips** have a cooldown of a few turns and reset every fight. Use them freely. The Wizard's Fire Bolt has none: it's their everyday ranged attack.
  - 🔮 **Spells** cost slots, which only come back with a Long Rest (or an act boss kill). Much stronger: save them for elites, bosses and emergencies.
  - 🔁 **Passives** are always on.
  - Each skill upgrades I → II → III, and tier III makes you choose one of two branches (Fire Bolt becomes *Inferno* or *Splitting Bolt*).
- **Positioning:**
  - Everyone faces the way they last moved or attacked; an arrow shows which way.
  - Attacks from behind and flanking attacks (a friend directly across the target) have **advantage**. Hover a monster to see it before you attack.
  - A monster turns to face whoever walks up to it or hits it in melee, so backstabs need teamwork: hit it from behind while it's busy with someone else, shoot it in the back, or Hide first.
  - **🛡️ Cover:** crates and rubble (low cover) block movement but not arrows. Standing next to one, or next to a wall, on the side a shooter is coming from makes you harder to hit: +2 AC behind low cover, +5 behind a wall, and the same on DEX saves against blasts from that side. Barrels and braziers count as low cover too. Melee and flanking ignore it. Hover a tile you can walk to and shields mark the sides that have cover (a whole shield for a wall, a half one for low cover); hover a monster to see the cover it has against you.
  - **Shove** (everyone, 1 AP) knocks an enemy back.
- **The battlefield** (elements & surfaces, like Divinity: Original Sin):
  - The ground can hold 💧 water, 🧊 ice, 🔥 fire, 🛢️ oil, ☠️ poison or 🌋 lava, and the air ♨️ steam, 🌫️ smoke or 🤢 poison gas. Steam and smoke block line of sight. Hover a tile to see what's on it.
  - Stepping into fire, poison or lava (or starting your turn there) hurts. Ice can make you slip and lose your move. Water makes you **Wet**.
  - Fire, cold and lightning react with what they touch:

    | On the tile | 🔥 Fire | ❄️ Cold | ⚡ Lightning | 💧 Water |
    |---|---|---|---|---|
    | Water | Steam cloud | Ice | Electrified water: the whole puddle | — |
    | Oil | All the connected oil burns | — | — | Washed away |
    | Poison | **Explosion** + fire | — | — | Washed away |
    | Ice | Melts | — | — | — |
    | Fire | — | Put out | — | Put out (steam) |
    | Steam | — | — | Electrified steam | — |
    | Oil barrel | **Explosion** + burning oil | | | |
  - On creatures, cold **Chills** (half movement) and lightning **Shocks** (−2 AC). A second hit, or one on a **Wet** target, **Freezes** or **Stuns** it. Wet also halves fire damage and puts out Burning.
  - **Friendly fire is on**: area spells like Fireball hit allies in the blast too. The aiming preview shows every tile, every ally caught in it and the combo it will set off.
  - Hit an 🛢️ oil barrel or a 🏮 brazier to spill oil or burning coals. Shoving enemies into fire works too.
  - Each act has its own terrain: oil and lamps in the Goblin Warrens, water and poison in the Crypt, lava in the Dragon's Lair. Some monsters resist elements (hover them), and some leave poison or fire behind when they die.
  - Clicking a tile walks around hazards if it can. If the only way goes through one, the game asks you to click again.
  - New combo skills: the Cleric's **Create Water** (soak them, then shock or freeze them) and the Wizard's **Grease** (then set it on fire).
- **Items** (press **I** for your bag):
  - Every hero has a **weapon**, **armor** and **trinket** slot, plus a bag with 8 spaces. A weapon changes your basic attacks whatever your class: a Flametongue adds fire (and lights oil), a Venom Edge poisons. Armor and trinkets add AC, HP, movement, resistances and more.
  - **Consumables** go on your hotbar after the potion: Greater Potions, Ether (a slot back), oil and water flasks, fire, frost and lightning bombs, smoke pellets, stink bombs and scrolls. Each is used up.
  - Between fights you can equip, swap, give items (and potions) to a teammate, or drop them.
  - **Gold is shared** by the party. You find it in fights, treasure and events.
- **Loot:** the hero who lands the killing blow on an elite takes its gear (another reason to steal kills). Regular fights sometimes drop a consumable, and an act boss leaves a powerful relic behind.
- **Relics** help the whole party for the rest of the run: advantage on your first attack, +1 AC for everyone, potions that heal more, and so on. They come from 💰 treasure (the party votes on one of three), shops and bosses.
- **💀 Elites** have one trait in act 1 and up to two later, shown on their tooltip and in their name (a "Burning Hobgoblin Captain"):
  - 🔰 **Shielded:** a ward soaks the first quarter of its HP, and once broken it comes back one time on the next 3rd round.
  - 🩸 **Vampiric:** heals half the damage it deals.
  - 😡 **Enraged:** below half HP it attacks once more each turn and hits harder.
  - 💨 **Swift:** faster, acts earlier and is harder to hit.
  - 📯 **Summoner:** calls in a minion every other round.
  - 🔥 **Burning**, ❄️ **Frost**, ⚡ **Storm:** its attacks deal that element, it hurts everyone next to it at the start of its turn (and sets off the ground around it: oil burns, water freezes or crackles), and it's immune to that element.
- **Elite rewards:** whoever lands the killing blow takes its gear. Then every hero picks **spoils** (a free skill upgrade, a piece of gear or a boon, on top of the pick after every fight), and the party votes on a **blessing** or a **companion**:
  - **Blessings** help every hero until the end of the act: +1 to hit and damage, +1 AC, +8 max HP, an extra slot, speed, saves, elemental resistance or healing every turn. Shrines and statues in events can bless you too.
  - **Companions** (NPC allies) fight on your side for the next 3 fights: a 💂 Sellsword, a 😇 Acolyte who heals whoever is hurt most, a 🧝 Ranger or a 🐕 War Hound. They grow stronger each act. Careful with your Fireballs: friendly fire hits them too, and a companion who falls is gone for good.
- **🛒 Shops:** everyone browses at once and spends the shared gold. Buy gear, consumables, potions or a relic, sell what you don't need, pay for a lesson (upgrade a cantrip or spell) or forget a skill to make room. The party moves on when everyone clicks Done.
- **Sneak or Charge:** before most fights the party sees the room and votes. Sneaking is a group Stealth check: if at least half of you pass, the monsters lose their first turn; if not, you lose yours. Some fights are ambushes. The Rogue's **Hide** makes monsters ignore them and gives their next attack advantage.
- **Difficulty:** the host picks **📖 Story**, **⚔️ Normal** or **💀 Hard** in the tavern, and the whole run keeps it (saved runs too). On Story the monsters are weaker and fight on instinct: each one goes for whoever is closest. On Normal and Hard they fight as a squad (below), and Hard also hits harder and brings more of them. On Hard every regular monster also has **one extra move** (shown on its tooltip as 💀 On Hard): goblins hamstring, archers pin you in place, skeletons shield-bash you down, zombies grab, wolves and priests shout orders, necromancers raise a fallen friend once a fight, cultists set you on fire, ogres bellow, and so on. Every act's monsters are tougher than the last (more HP, AC, aim and damage), to keep up with a party that picks a card after every fight; the run's first fight is a small warm-up.
- **👑 Bosses are a race:** the moment a boss falls, the rest flee and the fight is won, and each boss punishes a slow fight its own way. The 👑 Goblin King's 📯 War Horn calls more goblins every 3rd round; the ☠️ Bone Knight's 🦴 Rise Again stands its fallen minions back up 2 rounds later; the 🐉 Dread Wyrm's 😡 Wrath adds +1 to hit and +10% damage (its breath too) every round from round 4. Burst it down instead of turtling.
- **🧠 Who plays the monsters:** next to the difficulty, the host can pick the **📜 scripted** squad AI or a **🧠 PPO-trained policy** (a neural network trained against the hero bots) in the tavern. The PPO card is only available when the server has a trained policy file. The run keeps the pick (saved runs too), and a 🧠 PPO tag shows next to the difficulty.
- **🎯 Monster squads:** on Normal and Hard the monsters call a target and gang up on it. A red 🎯 reticle marks each hunted hero and the sidebar names them (in a bigger party the monsters split into packs, each hunting its own hero), so heal them, block for them or draw the monsters off. Every monster has a role, shown on its tooltip:
  - 🛡️ **Brutes** push to the front and hold it, and some **shove** you into fire and other hazards.
  - 🗡️ **Skirmishers** circle around for flanks and back attacks.
  - 🏹 **Archers** keep their distance and shoot.
  - ✨ **Supports** (the Goblin Shaman, Necromancer and Dragon Priest) heal and buff their side from the back. Kill them first.
  - 💨 **Cowards** (rats and kobolds) run away when they get hurt.
  - They talk, too: the monsters' shouts show up in italics in the log.
- **XP & levels:** every kill shares XP with the party, but the hero who lands the killing blow gets a big bonus. Finishing off someone else's target is a **💀 kill steal**. Healing and buffing allies earn XP too. Levels give HP and power, and every other level a **stat point** you put in any stat. Skills come from the **🏆 spoils** after every won fight: each hero picks 1 of 3 cards (two skills, new or upgrades, and an item: gear or a consumable, now and then a boon); pick whenever you like, nobody has to wait. A 🧪 potion can drop after a fight too: 40% at first, and the odds climb after every fight without one.
- **At 0 HP** you fall unconscious and roll death saves on your turn. A friend next to you can 🤝 Help Up (2 AP, back at 25% max HP); healing spells, potions and scrolls work too, cantrips don't. Either way you're 🥴 Groggy and lose your next turn. Going down again in the same fight wears you down: your death saves start one failure worse each time, and the 4th fall is death. If the party wins the fight, everyone gets back up, even the dead, but the dead come back 🩹 Injured (−20% max HP per death) until the next rest site.
- **Rarity** uses the usual colors (grey, green, blue, purple epic, orange legendary) and weighted odds by act, with a pity counter on item cards. Skill cards have rarities too (up to epic).
- **Between rooms:** HP carries over. Drink potions, or heal a friend by picking a heal and clicking their party card.
- **Rooms:** bigger than the screen and shaped: caverns, chambers joined by corridors, pillared halls, ruins, a wall with gaps (elite and boss rooms are bigger still). A fight starts in about a screen's worth of it, so you meet the monsters as soon as before, and the rest is room to flank and fall back.
- **🕳️ Pits:** nobody can walk into one, but you can see and shoot across. Shove a monster in and it's gone (you get the kill); elites and bosses are harder to shove and may catch the edge. A hero who falls in loses 30% of their max HP and climbs out; on Hard the fall kills. Brutes and kobolds shove too.
- **🪨 The Geomancer** (a Wizard engine) is built around pits: 🕳️ **Open Pit** opens one on empty floor (never under anyone) for 3 rounds, 🐏 **Earth Ram** and 〰️ **Tremor** push enemies in, 🪨 **Raise Cover** fills a pit in (and cover or a ⛰️ wall at the edge stops a friend being shoved over), and 🌀 **Undertow** makes every push carry further (Gravity Well: a new pit drags the enemies at its edge in).
- **🪽 Flyers** (Giant Bats, Gargoyles, Magma Imps, the Fire Drake and the Dread Wyrm) cross pits and never step in the ground (fire, oil, water). They can't be pushed into a pit, but one knocked down, stunned or frozen while it hovers over a pit falls in.
- **Camera:** it follows the fight: on your turn it brings your hero into view, and it pans to whoever acts when they're off screen. Right-drag to look around, the wheel zooms toward the mouse, **F** jumps back to your hero.
- **Graphics:** pixel art by default; press **G** to switch to the classic emoji look (it's remembered).
- **💪 Stats:** the six D&D stats, shown on every hero card (hover one to read what it does). STR: melee hit and damage. DEX: bows and daggers, initiative, sneaking, and AC in light armor. CON: max HP (every point raised is +1 HP per level). INT: Wizard spells, and every 2 points raised +1 max slot for any class. WIS: Cleric and Ranger spells and heals. CHA: Bard and Paladin spells and heals, and talking your way through events. Every stat also has its saves and event checks (an event says who would roll and the chance). Raise them with a point every other level (any stat, up to +5), stat boons in the spoils, and gear (which can go past +5).
- **🤖 Auto-play:** press **P** (or the 🤖 Auto button) and the AI plays your hero until you switch it off. That's handy when you're AFK, or when you only want to build your hero: auto-play gives you 10 seconds to make each spoils or level-up pick (and your rest-site choice) yourself before it picks for you, with a countdown on the panel, and the victory screen waits for your picks. Players who disconnect are auto-played until they come back. Auto heroes never vote while a human is at the keyboard; they follow the group.
- **Bots:** every party has at least 3 heroes, so when the run starts, bots take the empty seats (a solo player gets two bot companions, with classes the party lacks). The host can also click **🤖 Add bot** in the tavern for more, up to 6 heroes, and pick each bot's class from the dropdown on its row (add the bots before starting to choose the classes of the ones that fill empty seats). Each bot has its own voice and shouts short callouts in the log, like a teammate typing: when the fight starts (elites and bosses get their own lines), when it is low on health, when a friend goes down or gets back up, on a kill steal or a critical hit, when the monsters hunt it, on a level-up and when the fight is won. They don't flood the log (one line per bot per round), and heroes on auto-play who are people stay silent. Bigger parties face more monsters, with more HP and harder hits.
- **Saving:** runs save themselves at every step on the map (in the `saves/` folder next to the game). Close the server whenever you like. Next time, pick the run under **📜 Continue a saved run** on the home screen, or just reopen your old tab. Type the same name as your hero and you get them back; a friend who can't make it is auto-played until they return. A fight that was interrupted starts over from the beginning. Won and lost runs move to `saves/archive/`.
- **Run journal:** every run also writes its whole story to `saves/journal/<CODE>-<date>.jsonl`: every log line, each fight's numbers, every pick next to the cards that were offered, and how it ended. The game never deletes these. `node scripts/journal-report.ts --latest` prints a report of the newest one (a path, a fight-by-fight table with how long each fight took, the pace: time per act, each person's median seconds per turn and what shared turns saved, who did what, every pick), to compare a real game with the bot balance runs.
- **Chat:** press Enter.

| Class | Plays like |
|---|---|
| 🛡️ Fighter | Tank with AC 16. Shield Bash knocks enemies back, Second Wind heals, Battle Cry and Sentinel keep enemies on you. Attacks twice from level 5. |
| 🗡️ Rogue | Sneak Attack adds extra d6s when an ally is next to the target or you have advantage. Shadow Step teleports behind a target. The kill-steal class. |
| 🧙 Wizard | Fire, frost and lightning at range: the element master. Fireball for crowds, Grease to set up a blaze, Magic Missile never misses. Fragile. |
| ✨ Cleric | Healing Word picks up downed allies from range, Bless makes the party hit harder, Sacred Flame forces a DEX save, Create Water soaks enemies for the Wizard's lightning. |
| 🪓 Barbarian | The most HP. Rage halves the physical damage you take and adds to every melee hit; Reckless Attack swings with advantage but leaves you open; Ground Slam knocks everything around you prone. |
| 🏹 Ranger | Longbow at long range. Hunter's Mark gives the whole party advantage on a target (and Favored Foe adds damage to it), Ensnaring Shot nets a monster in place, Herbal Remedy patches friends up. |
| ⚜️ Paladin | AC 17 and holy fire. Divine Smite hits hard with radiant damage, Lay on Hands heals with a touch, Compelled Duel pulls a monster off your friends, and the Aura of Protection helps everyone near you resist. |
| 🎻 Bard | Support from range. Vicious Mockery stings and dazes, Bardic Inspiration gives an ally advantage, Healing Ballad heals the whole party, Hideous Laughter takes a monster out of the fight. Fragile. |

Every class has **three build engines**: ways to build a hero out of the cards you pick. Nothing is chosen up front. Skill cards have **rarities** like items (common, uncommon, rare, epic), and every class card belongs to an engine. Picks **lean toward the engines you've started** (2 cards of an engine make its cards twice as likely, 4 make them three times), so a build grows as you go. An **epic capstone**, a card that bends a rule of its engine, only shows up once you own 2 cards of that engine. The card shows its rarity and engine, and how many of that engine's cards you have; your party card shows your strongest engine ("Fighter · Guardian").

| Class | Engine A | Engine B | Engine C |
|---|---|---|---|
| 🛡️ Fighter | ⚔️ **Weapon Master**: crits | 🛡️ **Guardian**: Block and thorns | 🤺 **Duelist**: counters |
| 🗡️ Rogue | 🗡️ **Assassin**: poison stacks | 💨 **Skirmisher**: many small hits | 🎭 **Shadow**: one huge backstab |
| 🧙 Wizard | ☄️ **Evoker**: Arcane Charge | ❄️ **Elementalist**: elemental combos | 🪨 **Geomancer**: pits and stone |
| ✨ Cleric | 💖 **Life**: overhealing | ⚖️ **Order**: buffs from range | ☀️ **Light**: Radiance |
| 🪓 Barbarian | 🩸 **Berserker**: low HP, high damage | 🦏 **Juggernaut**: lifesteal tank | 🌋 **Wrecker**: knockdowns |
| 🏹 Ranger | 🪤 **Trapper**: traps and nets | 🎯 **Sharpshooter**: Focus, one huge shot | 🏹 **Hunter**: marks, many targets |
| ⚜️ Paladin | 🏰 **Protection**: Block on friends | 🌟 **Devotion**: heals that shield | ⚔️ **Vengeance**: smite burst |
| 🎻 Bard | 🎺 **Valor**: hand out AP | 🤫 **Whispers**: stacking debuffs | 🎶 **Crescendo**: Verses and the Finale |

Passives come in two kinds: hooks with their own rules (Sentinel, Favored Foe, Aura of Protection, Song of Rest...) and perks, stat blocks that add up like equipment (Thick Hide: +AC and max HP, Archery: +to hit...).

## Development

```bash
npm run dev        # server with auto-restart + Vite hot reload: open http://localhost:5173
npm run typecheck  # TypeScript checks
npm test           # unit tests (map and room generators, events, skills, XP, the battlefield, items, hero AI)
npm run smoke      # with a server running: a party of auto-played bots plays one run headlessly
npm run balance    # many full bot runs in parallel: win rate, where parties die, kills, skills used
npm run resume-check  # plays a few rooms, kills the server, restarts it and checks the party continues where it was
```

For faster bot testing, start the server with `DELVERS_SPEED=10` (monster turns 10× faster) and `DELVERS_ROWS=4` (short acts).

To test multiplayer alone, open several browser tabs. Each new tab is a new player. Reloading a tab puts you back into your character.

**The Codex** is a read-only dashboard over all the game's content: heroes, skills (every tier), items, relics, blessings, monsters and their tricks, acts and encounters, elites, statuses, surfaces and events. It reads the real game data, so it's always current, and every entry names the file and line it lives on (a VS Code link in dev). Its Overview runs pool checks: broken references, unused content, missing sprites, and the coverage goals from PLAN.md. Open http://localhost:5173/codex.html with `npm run dev`, or http://localhost:3000/codex on a played build.

### Project layout

```
shared/rules.ts    classes, monsters, acts, dice, XP and balance numbers  ← start here to tweak the game
shared/skills.ts   every skill and passive (tiers I/II/III-A/III-B), statuses, targeting, descriptions
shared/engines.ts  the three build engines of each class and the rarity of their cards
shared/subclasses.ts  the old subclasses (no longer picked; kept so old saves load)
shared/tactics.ts  facing, back attacks, flanking (every reason a roll has advantage) and cover
shared/surfaces.ts the battlefield: ground, clouds, props, the combo engine, hazards, previews
shared/items.ts    equipment, consumables, relics, blessings and prices
shared/elites.ts   elite traits, NPC allies, and who is on whose side
shared/grid.ts     line of sight, pathfinding
client/sprites.ts  which sprite draws each class, monster, wall, floor, prop, item and map icon
client/assets/     sprite sheets (DawnLike, see CREDITS.md), served at the site root
shared/types.ts    the game state sent from server to clients
server/game.ts     the "Dungeon Master": the run, voting, rooms, turns, combat, monster AI
server/actmap.ts   Slay-the-Spire-style act map generator
server/room.ts     battle room generator
server/events.ts   ❓ event scenes and their choices
server/heroai.ts   auto-play brain for heroes (AFK players, bots, tests)
server/monsterai.ts  the monsters' brain: squad target, roles, flanking, support spells, shoving, tricks and orders
server/barks.ts    the monsters' one-liners (the italic 💬 lines in the log)
server/companions.ts  the bots' voices and callouts (their chat lines in the log)
server/progression.ts  XP shares, level-ups, victory and elite spoils, training
server/saves.ts    saved runs on disk (saves/<CODE>.json) and the archive
server/journal.ts  the run journal (saves/journal/*.jsonl), read by scripts/journal-report.ts
server/rng.ts      seeded random numbers
server/index.ts    HTTP + WebSocket server and room codes
client/runview.ts  the act map and event screens
client/scene.ts    Phaser rendering of the battle room: tiles, creatures, effects
client/hud.ts      sidebar: party, abilities, dice log
client/turnbar.ts  the turn order bar over the battlefield (and the initiative roll)
client/lobby.ts    home screen and tavern lobby
client/codex/      the Codex (codex.html): the content dashboard and its pool checks
```

The server is authoritative: it rolls every die and validates every move, so players can't cheat and all clients stay in sync. Clients only send intents ("move here", "use Fire Bolt on that goblin") and draw the state they get back.

### Credits

Art: [DawnLike](https://opengameart.org/content/dawnlike-16x16-universal-rogue-like-tileset-v181) by DragonDePlatino, palette by DawnBringer (CC-BY 4.0). See [CREDITS.md](CREDITS.md).

### What's next

See [PLAN.md](PLAN.md) for the roadmap and progress tracking.
