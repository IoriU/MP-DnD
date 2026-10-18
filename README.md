# Dungeon Delvers

A co-op, turn-based roguelike in the browser for 1–6 friends. The run plays like Slay the Spire: three acts, each a branching map the party votes its way up. The fights play like a tabletop RPG, using simplified D&D 5e rules: d20 attack rolls against AC, initiative, actions and bonus actions, spell slots, death saves and sneak attacks.

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

- **The map:** each act is a branching map. Click a glowing room to vote for it. When everyone has voted (or 20 seconds after the first vote) the majority wins; ties are rolled.
- **Rooms:**
  - ⚔️ **Combat:** a fight.
  - 💀 **Elite:** a tough fight worth a lot of XP.
  - ❓ **Event:** a scene with choices the party votes on.
  - 🔥 **Rest:** each hero picks **Long Rest** (heal 30% and restore every slot) or **Train** (upgrade a cantrip or spell).
  - 💰 **Treasure:** gold and a potion.
  - 👑 **Boss:** ends the act. Beat all 3 acts to win.
- **Fights:**
  - On your turn you get movement (the blue tiles), one **A**ction and one **B**onus action.
  - Click a tile to walk, or use WASD / arrow keys (Q E Z C for diagonals). Press **Space** to end your turn.
  - **Attack:** click a monster; your basic weapon attack in range is picked for you.
  - **Skills:** keys **1–9** (or the buttons), then click a highlighted target (or a spot, for area spells). Esc or right-click cancels.
- **Skills:** every class has three kinds, each with its own class flavor (the Fighter's spells are Maneuvers paid with Grit, for example):
  - ⏱ **Cantrips** have a cooldown of a few turns and reset every fight. Use them freely.
  - 🔮 **Spells** cost slots, which only come back with a Long Rest (or an act boss kill). Much stronger: save them for elites, bosses and emergencies.
  - 🔁 **Passives** are always on.
  - Each skill upgrades I → II → III, and tier III makes you choose one of two branches (Fire Bolt becomes *Inferno* or *Splitting Bolt*).
- **Positioning:**
  - Everyone faces the way they last moved or attacked; an arrow shows which way.
  - Attacks from behind and flanking attacks (a friend directly across the target) have **advantage**. Hover a monster to see it before you attack.
  - A monster turns to face whoever walks up to it or hits it in melee, so backstabs need teamwork: hit it from behind while it's busy with someone else, shoot it in the back, or Hide first.
  - **Shove** (everyone, bonus action) knocks an enemy back.
- **Sneak or Charge:** before most fights the party sees the room and votes. Sneaking is a group Stealth check: if at least half of you pass, the monsters lose their first turn; if not, you lose yours. Some fights are ambushes. The Rogue's **Hide** makes monsters ignore them and gives their next attack advantage.
- **XP & levels:** every kill shares XP with the party, but the hero who lands the killing blow gets a big bonus. Finishing off someone else's target is a **💀 kill steal**. Healing and buffing allies earn XP too. Each level-up offers 3 cards (new skills, upgrades, passives, boons); pick one whenever you like, nobody has to wait.
- **At 0 HP** you fall unconscious and roll death saves on your turn. Healing (a potion, Healing Word or Second Wind) gets you back up. If the party wins the fight, everyone gets back up, even the dead.
- **Between rooms:** HP carries over. Drink potions, or heal a friend by picking a heal and clicking their party card.
- **Camera:** the mouse wheel zooms and right-drag pans.
- **🤖 Auto-play:** press **P** (or the 🤖 Auto button) and the AI plays your hero until you switch it off. That's handy when you're AFK. Players who disconnect are auto-played until they come back. Auto heroes never vote while a human is at the keyboard; they follow the group.
- **Bots:** the host can click **🤖 Add bot** in the tavern to fill empty seats with computer-controlled heroes.
- **Saving:** runs save themselves at every step on the map (in the `saves/` folder next to the game). Close the server whenever you like. Next time, pick the run under **📜 Continue a saved run** on the home screen, or just reopen your old tab. Type the same name as your hero and you get them back; a friend who can't make it is auto-played until they return. A fight that was interrupted starts over from the beginning. Won and lost runs move to `saves/archive/`.
- **Chat:** press Enter.

| Class | Plays like |
|---|---|
| 🛡️ Fighter | Tank with AC 16. Shield Bash knocks enemies back, Second Wind heals, Battle Cry and Sentinel keep enemies on you. Attacks twice from level 5. |
| 🗡️ Rogue | Sneak Attack adds extra d6s when an ally is next to the target or you have advantage. Shadow Step teleports behind a target. The kill-steal class. |
| 🧙 Wizard | Fire Bolt and Ray of Frost at range, Fireball for crowds, Magic Missile never misses. Fragile. |
| ✨ Cleric | Healing Word picks up downed allies from range, Bless makes the party hit harder, Sacred Flame forces a DEX save. |

## Development

```bash
npm run dev        # server with auto-restart + Vite hot reload: open http://localhost:5173
npm run typecheck  # TypeScript checks
npm test           # unit tests (map and room generators, events, skills, XP, hero AI)
npm run smoke      # with a server running: a party of auto-played bots plays one run headlessly
npm run balance    # many full bot runs in parallel: win rate, where parties die, kills, skills used
npm run resume-check  # plays a few rooms, kills the server, restarts it and checks the party continues where it was
```

For faster bot testing, start the server with `DELVERS_SPEED=10` (monster turns 10× faster) and `DELVERS_ROWS=4` (short acts).

To test multiplayer alone, open several browser tabs. Each new tab is a new player. Reloading a tab puts you back into your character.

### Project layout

```
shared/rules.ts    classes, monsters, acts, dice, XP and balance numbers  ← start here to tweak the game
shared/skills.ts   every skill and passive (tiers I/II/III-A/III-B), statuses, targeting, descriptions
shared/tactics.ts  facing, back attacks, flanking: every reason a roll has advantage
shared/grid.ts     line of sight, pathfinding
shared/types.ts    the game state sent from server to clients
server/game.ts     the "Dungeon Master": the run, voting, rooms, turns, combat, monster AI
server/actmap.ts   Slay-the-Spire-style act map generator
server/room.ts     battle room generator
server/events.ts   ❓ event scenes and their choices
server/heroai.ts   auto-play brain for heroes (AFK players, bots, tests)
server/progression.ts  XP shares, level-ups, level-up cards, training
server/saves.ts    saved runs on disk (saves/<CODE>.json) and the archive
server/rng.ts      seeded random numbers
server/index.ts    HTTP + WebSocket server and room codes
client/runview.ts  the act map and event screens
client/scene.ts    Phaser rendering of the battle room: tiles, creatures, effects
client/hud.ts      sidebar: party, abilities, turn order, dice log
client/lobby.ts    home screen and tavern lobby
```

The server is authoritative: it rolls every die and validates every move, so players can't cheat and all clients stay in sync. Clients only send intents ("move here", "use Fire Bolt on that goblin") and draw the state they get back.

### What's next

See [PLAN.md](PLAN.md) for the roadmap and progress tracking.
