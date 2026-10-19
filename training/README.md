# Training the PPO monsters

Phase 11's experiment: a small neural network, trained with PPO against the hero bots, plays the monsters instead of
the scripted squad AI. The host picks which one in the tavern (**Monsters: 📜 Scripted / 🧠 PPO**). The difficulty
still sets the monsters' numbers either way.

## How it fits together

- **The options.** The scripted AI (`server/monsterai.ts`) lists everything a monster could do this turn: every tile
  it can reach and every attack, shove, heal, buff or shot at the ground from there. `monsterChoices` keeps the best
  option for each action and target, plus the next best, 32 at most.
  - Each option is 44 numbers: the kind of action, the hit chance and expected damage, flanking, danger, hazards,
    whether the target is the one its pack hunts, and so on. Three of them are the scripted AI's own opinion of it.
  - The policy only ever picks among these, so its moves are always legal.
- **The network.** It scores each option (44 numbers in, a score out; two hidden layers of 64), and the monster takes
  the best. While training, it samples from a softmax over the scores instead. A second small network estimates how
  the fight is going (PPO's value).
- **The environment** (`training/env.ts`) plays real fights with the real game code, headless and at full speed, many
  at once. The heroes are the normal hero bots.
  - Each fight starts from a save recorded at the start of a fight in a bot run, so the parties are realistic: their
    levels, skills, gear and relics are what the game really produces. The monsters are rolled fresh each time.
  - It asks the trainer for every monster decision, over JSON lines on stdin and stdout.
- **The reward** is the pressure on the party between decisions: how much the party's losses grow (HP lost, heroes
  down or dead, averaged per hero), plus a bonus for a wipe. Monsters staying alive pays off through the damage they
  deal later.
  - The first run also subtracted the monsters' own losses (`DELVERS_REWARD=both`). They nearly always all die, so
    that was mostly noise, and the run ended up no better than the scripted AI.
- **The trainer** (`training/ppo.py`, PyTorch on the CPU) works in two stages:
  1. It first copies the scripted AI (imitation), so PPO starts from monsters that already fight well.
  2. Then it improves with PPO. Every few updates the greedy policy plays a few hundred fights next to the scripted AI,
     on the same recorded fights, and the best checkpoint is kept.
- **Export.** The best checkpoint goes to `server/policies/`:
  - `monster-ppo.json`: the weights. The server runs them in plain TypeScript (`server/policy.ts`), so hosts install
    nothing extra.
  - `monster-ppo.onnx`: the same network as a standard ONNX model.
  - `tests/policy.test.ts` checks that the TypeScript scores match PyTorch's.

## Running it

One-time setup: a Python 3.11 virtual environment with PyTorch (the CPU build is plenty) and onnx.

```bash
python -m venv training/.venv
training/.venv/Scripts/python -m pip install torch==2.14.1 onnx==1.23.2
```

1. **Record fight starts.** Run bot games on a server with `DELVERS_FIGHT_DUMP` set. 40 runs give about 700 fights.

   ```bash
   DELVERS_SPEED=25 PORT=3201 DELVERS_FIGHT_DUMP=training/data/fights node server/index.ts
   DIFF=all URL=http://localhost:3201 node scripts/balance.ts 40 3,4,5,6 8
   ```

2. **Train.** Logs and checkpoints go to `training/runs/<name>/`, and `log.csv` has one row per update.

   ```bash
   training/.venv/Scripts/python training/ppo.py --name ppo1
   ```

3. **Export the best checkpoint** for the game.

   ```bash
   training/.venv/Scripts/python training/ppo.py --export training/runs/ppo1/best.pt
   ```

4. **Compare** in full bot runs: `MONSTER_AI=all` alternates the two.

   ```bash
   MONSTER_AI=all DIFF=all URL=http://localhost:3200 node scripts/balance.ts 24 3,4,5,6 6
   ```

   For a quick look without a server, `node training/env.ts training/data/fights 16 scripted 400` (or `policy`)
   prints the monsters' win rate and their average score over 400 fights.

If the monster AI's features change (`OPTION_FEATURES` in `server/monsterai.ts`), the shipped policy no longer fits.
The server then says so and plays the scripted AI until the policy is retrained.
