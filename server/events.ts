// ❓ Event nodes: short text scenes with choices the party votes on.
// Pure content: a choice's resolve() only reads its ctx and returns text plus effects; game.ts applies them.

import type { BlessingId, ItemId, Rarity, RelicId } from '../shared/items.ts';
import type { AllyId } from '../shared/elites.ts';
import { ACTS } from '../shared/rules.ts';
import type { Dice, Stat } from '../shared/rules.ts';
import type { Rng } from './rng.ts';

export type EventStat = Stat; // all six (CHA to talk your way through, CON to stomach it: 2026-10-21)

export type EventEffect =
  | { kind: 'heal'; pct: number } // every living hero heals pct (0-1) of max HP
  | { kind: 'damage'; dice: Dice; who: 'all' | 'checker' } // 'checker' = the hero who made the last check
  | { kind: 'gold'; amount: number } // party gold, may be negative
  | { kind: 'potions'; amount: number } // handed out one at a time to whoever has the fewest
  | { kind: 'maxHp'; amount: number } // permanent, every hero
  | { kind: 'restoreSlots' } // every hero's spell slots back to full
  | { kind: 'relic'; id?: RelicId } // a party relic (shared/items.ts); a random one if no id
  | { kind: 'item'; id?: ItemId; gear?: boolean; rarity?: Rarity } // an item (a given one, or a random consumable or piece of gear) for the checker, or whoever has room
  | { kind: 'blessing'; id?: BlessingId } // a party blessing until the end of the act (random if no id)
  | { kind: 'ally'; id?: AllyId } // an NPC ally for the next few fights (random if no id)
  | { kind: 'spoils'; who: 'all' | 'checker' } // a spoils pick, as after a won fight: two skill cards and an item card
  | { kind: 'injury'; who: 'all' | 'checker' } // 🩹 an Injury (less max HP) until the next rest site or act: a price to pay
  | { kind: 'xp'; amount: number } // every hero (with the usual catch-up bonus)
  | { kind: 'fight'; monsters: string[]; elite?: boolean; ambush?: boolean }; // a battle after the outcome text (ids from MONSTERS); an ambush surrounds the party

export interface CheckResult {
  ok: boolean;
  heroId: string;
  heroName: string;
  text: string; // ready-made, e.g. "🎲 Bram (DEX +3): 14+3=17 vs DC 13, success"
}

export interface EventCtx {
  act: number; // 1-3
  gold: number; // current party gold
  partySize: number;
  rng: Rng;
  /** The game rolls d20 + the best modifier among living heroes for that stat. */
  check(stat: EventStat, dc: number): CheckResult;
}

export interface EventOutcome {
  text: string; // what happened, shown to everyone (includes the check text when a check was rolled)
  effects: EventEffect[];
}

export interface EventChoiceDef {
  id: string;
  label: string; // e.g. "Climb down for the coins"
  hint?: string; // e.g. "DEX check, DC 13" or "Costs 15 gold"
  /**
   * Gold required to pick it (the server hides unaffordable choices from the vote).
   * It only gates the choice: resolve() charges it itself with a negative 'gold' effect, so don't deduct it again.
   */
  cost?: number;
  resolve(ctx: EventCtx): EventOutcome;
}

export interface EventDef {
  id: string;
  title: string;
  glyph: string; // one emoji
  text: string; // 1-3 sentences of scene setting
  acts?: number[]; // acts it can appear in (default: all)
  choices: EventChoiceDef[];
}

/** An event whose choices (prices, mostly) depend on the act. */
type EventTemplate = Omit<EventDef, 'choices'> & { choices(act: number): EventChoiceDef[] };

// ---------------------------------------------------------------- helpers

const clampAct = (act: number) => Math.min(Math.max(Math.round(act) || 1, 1), ACTS.length);
const dice = (n: number, d: number): Dice => ({ n, d });

/** Gold reward: lo..hi per act. */
const loot = (ctx: EventCtx, lo: number, hi: number) => ctx.rng.int(lo, hi) * clampAct(ctx.act);

/** Head count for a regular event fight: 1 + half the party, rounded up. */
const crowd = (ctx: EventCtx) => 1 + Math.ceil(Math.max(ctx.partySize, 1) / 2);

/** `count` monsters drawn from `pool` (default: this act's regular monsters). */
function horde(ctx: EventCtx, count: number, pool: readonly string[] = ACTS[clampAct(ctx.act) - 1].pool): string[] {
  return Array.from({ length: Math.max(count, 0) }, () => ctx.rng.pick(pool));
}

/** The roll first, then the story. */
const told = (check: CheckResult, story: string) => `${check.text.replace(/[\s.]+$/, '')}. ${story}`;

/** The safe way out. Every event ends with one. */
const leave = (text: string, label = 'Leave'): EventChoiceDef => ({ id: 'leave', label, resolve: () => ({ text, effects: [] }) });

/** The chest bites back. From act 3 on it brings a friend. */
function mimicAttack(ctx: EventCtx, text: string): EventOutcome {
  const pair = clampAct(ctx.act) >= 3;
  return {
    text: pair ? `${text} The suspiciously chest-shaped rock next to it joins in.` : text,
    effects: [{ kind: 'fight', monsters: pair ? ['mimic', 'mimic'] : ['mimic'], elite: true }],
  };
}

/** Safe chest contents: some gold and a potion. */
function chestLoot(ctx: EventCtx, story: (gold: number) => string): EventOutcome {
  const g = loot(ctx, 25, 40);
  return { text: story(g), effects: [{ kind: 'gold', amount: g }, { kind: 'potions', amount: 1 }] };
}

const GOBLINS = ['goblin', 'archer'];
const UNDEAD = ['skeleton', 'zombie'];
const CULTISTS = ['cultist', 'priest', 'imp'];

// ---------------------------------------------------------------- the events

const TEMPLATES: EventTemplate[] = [
  {
    id: 'well',
    title: 'The Wishing Well',
    glyph: '🪙',
    text: 'A mossy old well sits in the middle of the tunnel, coins glittering far below. A crooked sign reads: ONE WISH PER CUSTOMER. NO REFUNDS.',
    choices: (act) => {
      const cost = 15 * act;
      return [
        {
          id: 'toss',
          label: 'Toss in some gold',
          hint: `Costs ${cost} gold`,
          cost,
          resolve: (ctx) =>
            ctx.rng.chance(0.6)
              ? {
                  text: 'The coins plink into the dark and a warm glow washes over the party. Wish granted: everyone feels much less stabbed.',
                  effects: [{ kind: 'gold', amount: -cost }, { kind: 'heal', pct: 0.35 }],
                }
              : {
                  text: 'The coins plink into the dark. Somewhere far below, a frog says "thanks". Nothing else happens.',
                  effects: [{ kind: 'gold', amount: -cost }],
                },
        },
        {
          id: 'climb',
          label: 'Climb down for the coins',
          hint: 'DEX check, DC 13',
          resolve: (ctx) => {
            const r = ctx.check('dex', 13);
            if (r.ok) {
              const g = loot(ctx, 25, 40);
              return { text: told(r, `${r.heroName} shimmies down and back up with ${g} gold worth of other people's wishes.`), effects: [{ kind: 'gold', amount: g }] };
            }
            const g = loot(ctx, 3, 8);
            return {
              text: told(r, `${r.heroName} slips and lands face-first in the wishes. Ouch, but they grabbed ${g} gold on the way.`),
              effects: [{ kind: 'damage', dice: dice(1, 6), who: 'checker' }, { kind: 'gold', amount: g }],
            };
          },
        },
        leave('You resist the urge to make a wish. The well looks a little disappointed.'),
      ];
    },
  },
  {
    id: 'prisoner',
    title: 'The Goblin Prisoner',
    glyph: '🔗',
    text: 'A scrawny goblin dangles in a cage above a pit, rattling the bars. "Let Snik out! Snik knows things!"',
    acts: [1, 2],
    choices: () => [
      {
        id: 'free',
        label: 'Free him',
        hint: 'Snik seems grateful. Probably.',
        resolve: () => ({
          text: '"Snik is FREE! Snik remembers friends!" He presses two slightly sticky potions into your hands and scampers off cackling.',
          effects: [{ kind: 'potions', amount: 2 }],
        }),
      },
      {
        id: 'interrogate',
        label: 'Interrogate him',
        hint: 'CHA check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('cha', 12);
          if (r.ok) {
            const g = loot(ctx, 25, 40);
            return { text: told(r, `${r.heroName} sees through every one of Snik's lies until he sobs and points at a loose brick hiding ${g} gold.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return {
            text: told(r, 'Snik shrieks "INTRUDERS!" at a pitch only goblins and dogs can hear. Goblins pour out of every crack.'),
            effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx) + clampAct(ctx.act) - 1, GOBLINS) }],
          };
        },
      },
      leave('You leave Snik hanging. He yells some very creative goblin words after you.', 'Leave him hanging'),
    ],
  },
  {
    id: 'shrine',
    title: 'Forgotten Shrine',
    glyph: '⛩️',
    text: 'A cracked shrine to a god nobody remembers. A few candles still burn, which is either a miracle or a fire hazard.',
    choices: () => [
      {
        id: 'pray',
        label: 'Pray',
        hint: 'A blessing until the end of the act',
        resolve: () => ({
          text: 'The party kneels and mumbles a polite prayer. Somewhere, a forgotten god is thrilled to finally have fans, and shows it.',
          effects: [{ kind: 'blessing' }, { kind: 'heal', pct: 0.1 }],
        }),
      },
      {
        id: 'desecrate',
        label: 'Pry off the gold leaf',
        hint: 'Gold, but the god may object',
        resolve: (ctx) => {
          const g = loot(ctx, 30, 45);
          return {
            text: `You scrape ${g} gold off the altar. The forgotten god suddenly remembers how to smite, and everyone gets zapped.`,
            effects: [{ kind: 'gold', amount: g }, { kind: 'damage', dice: dice(1, 6), who: 'all' }],
          };
        },
      },
      leave('You tiptoe past. One candle flickers in what might be relief.'),
    ],
  },
  {
    id: 'chest',
    title: 'A Suspicious Chest',
    glyph: '📦',
    text: 'A lone chest sits in an otherwise empty room. It is covered in tooth marks, and some of them look fresh.',
    choices: () => [
      {
        id: 'open',
        label: 'Open it',
        hint: 'What could go wrong?',
        resolve: (ctx) =>
          ctx.rng.chance(0.6)
            ? chestLoot(ctx, (g) => `It's just a chest! Inside: ${g} gold and a potion. The tooth marks remain unexplained.`)
            : mimicAttack(ctx, 'The lid creaks open... and keeps opening. It is a Mimic, and it is starving!'),
      },
      {
        id: 'inspect',
        label: 'Inspect it first',
        hint: 'INT check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('int', 12);
          return r.ok
            ? chestLoot(ctx, (g) => told(r, `${r.heroName} pokes it with a ten-foot pole. Nothing bites. Inside: ${g} gold and a potion.`))
            : mimicAttack(ctx, told(r, `${r.heroName} leans in for a closer look. The chest leans in for a closer bite!`));
        },
      },
      leave('You back away slowly. Behind you, the chest sighs, very quietly.', 'Leave it alone'),
    ],
  },
  {
    id: 'alchemist',
    title: 'The Wandering Alchemist',
    glyph: '⚗️',
    text: 'A cheerful gnome with no eyebrows waves you over to a cart of bubbling bottles. "Free samples! Mostly safe!"',
    choices: (act) => {
      const cost = 20 * act;
      return [
        {
          id: 'red',
          label: 'Drink the red vial',
          hint: 'Smells like cherries and courage',
          resolve: () => ({
            text: 'It tastes like cherries and courage. Everyone feels a bit sturdier, and someone grows a single, magnificent chest hair.',
            effects: [{ kind: 'maxHp', amount: 3 }],
          }),
        },
        {
          id: 'green',
          label: 'Drink the green vial',
          hint: 'CON check, DC 12. It is bubbling. A lot.',
          resolve: (ctx) => {
            const r = ctx.check('con', 12);
            return r.ok
              ? {
                  text: told(r, `${r.heroName} drinks first and keeps it down. Every wound in the party knits shut with a fizzy pop! The gnome looks almost as surprised as you are.`),
                  effects: [{ kind: 'heal', pct: 1 }],
                }
              : {
                  text: told(r, 'Everyone turns a lovely shade of green, then becomes violently unwell. "Fascinating!" says the gnome, taking notes.'),
                  effects: [{ kind: 'damage', dice: dice(1, 8), who: 'all' }],
                };
          },
        },
        {
          id: 'buy',
          label: 'Buy two potions',
          hint: `Costs ${cost} gold`,
          cost,
          resolve: () => ({
            text: 'The gnome pockets your gold and hands over two potions. "Pleasure doing business! No refunds if you explode."',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'potions', amount: 2 }],
          }),
        },
        leave('You politely decline. The gnome shrugs and drinks a sample himself. His hair turns blue.'),
      ];
    },
  },
  {
    id: 'dice',
    title: 'Kobold Dice Night',
    glyph: '🎲',
    text: 'Three kobolds crouch around an upturned shield, gambling with dice that are almost certainly loaded. "Tall folk! You play? Double or nothing!"',
    acts: [1, 3],
    choices: (act) => {
      const bet = 10 * act;
      return [
        {
          id: 'bet',
          label: 'Place a bet',
          hint: `Costs ${bet} gold. 2d6 vs 2d6, pays 2 to 1`,
          cost: bet,
          resolve: (ctx) => {
            const you = ctx.rng.int(1, 6) + ctx.rng.int(1, 6);
            const them = ctx.rng.int(1, 6) + ctx.rng.int(1, 6);
            const rolls = `🎲 You roll ${you}, the kobolds roll ${them}.`;
            if (you > them) {
              return { text: `${rolls} They pay out ${2 * bet} gold with the saddest little sighs you have ever heard.`, effects: [{ kind: 'gold', amount: 2 * bet }] };
            }
            const taunt = you === them ? '"Tie goes to house! House rules!"' : '"Ha! Kobolds always win!"';
            return { text: `${rolls} ${taunt} They scoop up your ${bet} gold.`, effects: [{ kind: 'gold', amount: -bet }] };
          },
        },
        {
          id: 'flex',
          label: 'Flex until they hand over the pot',
          hint: 'STR check, DC 12',
          resolve: (ctx) => {
            const r = ctx.check('str', 12);
            if (r.ok) {
              const g = loot(ctx, 20, 35);
              return { text: told(r, `${r.heroName} flexes. One kobold faints, and the rest slide over the pot (${g} gold), pretending it was their idea.`), effects: [{ kind: 'gold', amount: g }] };
            }
            // From act 2 on, the kobolds have hired some muscle of their own.
            const gang = [...Array<string>(crowd(ctx)).fill('kobold'), ...horde(ctx, clampAct(ctx.act) - 1)];
            return {
              text: told(r, `${r.heroName} flexes, something goes *pop*, and the kobolds decide they can take you after all.`),
              effects: [{ kind: 'fight', monsters: gang }],
            };
          },
        },
        leave('You leave them to it. Behind you, one kobold accuses another of cheating and a tiny brawl breaks out.'),
      ];
    },
  },
  {
    id: 'skull',
    title: 'The Riddling Skull',
    glyph: '💀',
    text: 'A skull on a pedestal clears its throat, which is impressive for something with no throat. "Answer my riddle, mortals, or suffer... mild inconvenience!"',
    acts: [2],
    choices: () => [
      {
        id: 'riddle',
        label: 'Answer the riddle',
        hint: 'INT check, DC 13',
        resolve: (ctx) => {
          const r = ctx.check('int', 13);
          if (r.ok) {
            return {
              text: told(r, `"What has no lungs, yet never shuts up?" ${r.heroName}: "...You?" The skull cackles with delight and hums a tune that recharges everyone's magic.`),
              effects: [{ kind: 'restoreSlots' }, { kind: 'heal', pct: 0.2 }],
            };
          }
          return {
            text: told(r, `${r.heroName} answers "a horse?" with total confidence. The skull's disappointed sigh is so withering it actually hurts.`),
            effects: [{ kind: 'damage', dice: dice(1, 6), who: 'all' }],
          };
        },
      },
      {
        id: 'teeth',
        label: 'Pry out its gold teeth',
        hint: 'Gold, but it will not go quietly',
        resolve: (ctx) => {
          const g = loot(ctx, 25, 40);
          return {
            text: `You pocket ${g} gold worth of teeth. The skull screams for help, and the whole crypt answers with a lot of rattling.`,
            effects: [{ kind: 'gold', amount: g }, { kind: 'fight', monsters: horde(ctx, crowd(ctx), ['skeleton', 'zombie']) }],
          };
        },
      },
      leave('You walk off mid-riddle. The skull finishes it anyway, to nobody, and laughs at its own punchline.'),
    ],
  },
  {
    id: 'armwrestle',
    title: "Grul's Arm-Wrestling Pit",
    glyph: '💪',
    text: 'A huge ogre slams his elbow onto a barrel, which explodes. He fetches a new barrel. "Beat Grul, get shiny. Lose, Grul keep arm."',
    acts: [3],
    choices: () => [
      {
        id: 'wrestle',
        label: 'Arm-wrestle Grul',
        hint: 'STR check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('str', 14);
          if (r.ok) {
            const g = loot(ctx, 35, 50);
            return { text: told(r, `${r.heroName} slams Grul's knuckles into the barrel. He weeps big ogre tears and hands over ${g} gold.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return {
            text: told(r, `Grul wins, and keeps going. ${r.heroName}'s arm now bends in an exciting new direction, but Grul kindly lets them keep it.`),
            effects: [{ kind: 'damage', dice: dice(2, 6), who: 'checker' }],
          };
        },
      },
      {
        id: 'cheat',
        label: 'Grease your hand first',
        hint: 'DEX check, DC 13',
        resolve: (ctx) => {
          const r = ctx.check('dex', 13);
          if (r.ok) {
            const g = loot(ctx, 45, 60);
            return { text: told(r, `${r.heroName}'s buttery hand slips free and slaps Grul's flat. ${g} gold is yours before he works out what happened.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return {
            text: told(r, 'Grul sniffs his greasy hand, then you. "CHEAT!" His friends, who were apparently there the whole time, stand up.'),
            effects: [{ kind: 'fight', monsters: ['ogre', ...horde(ctx, crowd(ctx) - 1, ['orc', 'kobold'])] }],
          };
        },
      },
      leave('You decline. Grul goes back to arm-wrestling a stalagmite. He is winning.'),
    ],
  },
  {
    id: 'fallen',
    title: 'A Fallen Adventurer',
    glyph: '⚰️',
    text: 'Someone got here first, and stayed. Their gear is still in decent shape. Their expression suggests they would like to keep it.',
    choices: () => [
      {
        id: 'loot',
        label: 'Take their gear',
        hint: 'WIS check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('wis', 12);
          if (r.ok) {
            return { text: told(r, `${r.heroName} says a few kind words first. The gear comes away without a fuss.`), effects: [{ kind: 'item', gear: true, rarity: 'uncommon' }] };
          }
          return {
            text: told(r, `${r.heroName} grabs it without asking. A cold hand grabs back, and only lets go of the worst of it.`),
            effects: [{ kind: 'item', gear: true, rarity: 'common' }, { kind: 'damage', dice: dice(1, 8), who: 'checker' }],
          };
        },
      },
      {
        id: 'bury',
        label: 'Give them a proper burial',
        hint: 'Heals the party a little',
        resolve: () => ({
          text: 'You bury them with their boots on. Something in the dark seems grateful: everyone feels lighter, and a potion turns up in the fresh dirt.',
          effects: [{ kind: 'heal', pct: 0.2 }, { kind: 'potions', amount: 1 }],
        }),
      },
      leave('You tip your hat and move on. It feels like being watched by someone very polite.'),
    ],
  },
  {
    id: 'statues',
    title: 'The Twin Statues',
    glyph: '🗿',
    text: 'Two stone statues face each other across the hall: a warrior with a cracked shield and a robed sage holding an empty lamp. Each has an offering bowl at its feet.',
    choices: (act) => {
      const cost = 20 * act;
      return [
        {
          id: 'warrior',
          label: "Make an offering to the warrior",
          hint: `Costs ${cost} gold. A blessing of battle until the end of the act`,
          cost,
          resolve: (ctx) => ({
            text: 'The coins vanish from the bowl. Stone grinds as the warrior raises its shield in salute.',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'blessing', id: ctx.rng.pick(['valor', 'bulwark', 'vigor'] as const) }],
          }),
        },
        {
          id: 'sage',
          label: 'Make an offering to the sage',
          hint: `Costs ${cost} gold. A blessing of the mind until the end of the act`,
          cost,
          resolve: (ctx) => ({
            text: 'The coins vanish from the bowl, and the empty lamp lights itself with a soft blue flame.',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'blessing', id: ctx.rng.pick(['arcana', 'fortune', 'warding', 'haste', 'renewal'] as const) }],
          }),
        },
        {
          id: 'topple',
          label: 'Topple them for the gold inlay',
          hint: 'STR check, DC 14',
          resolve: (ctx) => {
            const r = ctx.check('str', 14);
            if (r.ok) {
              const g = loot(ctx, 30, 45);
              return { text: told(r, `${r.heroName} heaves both statues over and pries out ${g} gold of inlay. Nothing smites anyone. Yet.`), effects: [{ kind: 'gold', amount: g }] };
            }
            return {
              text: told(r, `The warrior tips the wrong way and lands on ${r.heroName}'s foot.`),
              effects: [{ kind: 'damage', dice: dice(2, 6), who: 'checker' }],
            };
          },
        },
        leave('You bow politely to both and walk on.'),
      ];
    },
  },
  {
    id: 'captive',
    title: 'The Caged Mercenary',
    glyph: '⛓️',
    text: 'A battered sellsword sits in a locked cage, guards nowhere in sight. "Get me out of here and I\'ll fight for you for free. For a while, anyway."',
    choices: (act) => {
      const cost = 25 * act;
      return [
        {
          id: 'break',
          label: 'Break the lock',
          hint: 'STR check, DC 13',
          resolve: (ctx) => {
            const r = ctx.check('str', 13);
            if (r.ok) return { text: told(r, `${r.heroName} rips the door off its hinges. The sellsword grabs a sword from the rack and falls in line.`), effects: [{ kind: 'ally', id: 'sellsword' }] };
            return {
              text: told(r, 'The lock holds, the cage rattles, and the guards come back from their break.'),
              effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx)) }],
            };
          },
        },
        {
          id: 'key',
          label: 'Buy the key from a passing goblin',
          hint: `Costs ${cost} gold`,
          cost,
          resolve: () => ({
            text: 'A goblin who definitely has nothing to do with the cage sells you the key. The sellsword joins up, grumbling about the price of freedom.',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'ally', id: 'sellsword' }],
          }),
        },
        leave('"Fine! I\'ll rot then!" You hear him complaining for a long way down the tunnel.'),
      ];
    },
  },
  // ---- every act: trades (Slay the Spire style) and a little learning
  {
    id: 'training_hall',
    title: 'The Old Training Hall',
    glyph: '🥋',
    text: 'Straw dummies, a cracked weapon rack and a faded sign: NO PAIN, NO GAIN. Someone has crossed out GAIN and written GOBLINS.',
    choices: () => [
      {
        id: 'drill',
        label: 'Train until it hurts',
        hint: 'Everyone takes 2d6 damage and gets a spoils pick',
        resolve: () => ({
          text: 'Hours of drills and bruises in new and exciting places, and everyone walks out with a trick they did not know this morning.',
          effects: [{ kind: 'damage', dice: dice(2, 6), who: 'all' }, { kind: 'spoils', who: 'all' }],
        }),
      },
      {
        id: 'manuals',
        label: 'Read the old drill manuals',
        hint: 'INT check, DC 13',
        resolve: (ctx) => {
          const r = ctx.check('int', 13);
          return r.ok
            ? { text: told(r, `${r.heroName} finds a chapter nobody else bothered to read and practices it in a corner.`), effects: [{ kind: 'spoils', who: 'checker' }] }
            : { text: told(r, `The "manual" turns out to be a cookbook. ${r.heroName} now knows forty ways to cook a rat.`), effects: [] };
        },
      },
      leave('You skip leg day. And arm day. And every other day.'),
    ],
  },
  {
    id: 'blood_tailor',
    title: 'The Blood Tailor',
    glyph: '🩸',
    text: 'A pale, polite figure with a measuring tape and very long teeth bows low. "I make suits from courage, and courage is in the blood. I pay well for a sample."',
    choices: () => [
      {
        id: 'sell',
        label: 'Everyone gives a sample',
        hint: 'Gold, but everyone is Injured until the next rest site',
        resolve: (ctx) => {
          const g = loot(ctx, 45, 60);
          return {
            text: `A tiny prick each, a lot of happy humming, and ${g} gold. Everyone feels a little thinner, somehow.`,
            effects: [{ kind: 'gold', amount: g }, { kind: 'injury', who: 'all' }],
          };
        },
      },
      {
        id: 'haggle',
        label: 'Haggle for a finished piece',
        hint: 'CHA check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('cha', 14);
          return r.ok
            ? { text: told(r, `${r.heroName} haggles like a dwarf at a gem sale. The tailor sighs and hands over something fine from the rack.`), effects: [{ kind: 'item', gear: true, rarity: 'uncommon' }] }
            : { text: told(r, `The tailor smiles, measures ${r.heroName} for a suit, and takes a sample while they are distracted.`), effects: [{ kind: 'injury', who: 'checker' }] };
        },
      },
      leave('You keep your blood on the inside, where it belongs.'),
    ],
  },
  {
    id: 'library',
    title: 'The Drowned Library',
    glyph: '📚',
    text: 'Shelves of swollen, half-drowned books lean against each other. A few are still readable, and one of them seems to be reading you back.',
    choices: (act) => [
      {
        id: 'read',
        label: 'Read what you can',
        hint: `Everyone gains ${25 * act} XP`,
        resolve: () => ({ text: 'Soggy pages, faded ink, and a surprising amount of useful advice about not dying.', effects: [{ kind: 'xp', amount: 25 * act }] }),
      },
      {
        id: 'tome',
        label: 'Take the book that reads you',
        hint: 'INT check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('int', 14);
          return r.ok
            ? {
                text: told(r, `${r.heroName} stares the book down until it blinks first. It teaches them a thing or two, then crumbles into something useful.`),
                effects: [{ kind: 'spoils', who: 'checker' }, { kind: 'item', rarity: 'uncommon' }],
              }
            : { text: told(r, `The book snaps shut on ${r.heroName}'s fingers. Hard.`), effects: [{ kind: 'damage', dice: dice(1, 8), who: 'checker' }] };
        },
      },
      leave('You leave the books to their reading.'),
    ],
  },
  {
    id: 'pact_altar',
    title: 'The Altar of Pacts',
    glyph: '🗿',
    text: 'A black stone altar, warm to the touch. Carved letters promise POWER. Much smaller letters underneath mention terms and conditions.',
    choices: () => [
      {
        id: 'pact',
        label: 'Sign in blood',
        hint: 'A relic, but everyone is Injured until the next rest site',
        resolve: () => ({
          text: 'Everyone pricks a thumb. The altar drinks, purrs, and coughs up something that glows.',
          effects: [{ kind: 'relic' }, { kind: 'injury', who: 'all' }],
        }),
      },
      {
        id: 'smash',
        label: 'Smash it',
        hint: 'STR check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('str', 14);
          if (r.ok) {
            const g = loot(ctx, 30, 50);
            return { text: told(r, `${r.heroName} splits the altar in two, and ${g} gold in old offerings spills out.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return { text: told(r, 'The altar takes offense. The blast knocks everyone off their feet.'), effects: [{ kind: 'damage', dice: dice(1, 6), who: 'all' }] };
        },
      },
      leave('You decline. Nobody ever reads the small print anyway.'),
    ],
  },

  // ---- act 1: the Goblin Warrens
  {
    id: 'toll_bridge',
    title: 'The Goblin Toll Bridge',
    glyph: '🌉',
    text: 'A rope bridge over a chasm, guarded by three goblins and a sign that says TOLL. The price is written in chalk and has clearly been changed several times today.',
    acts: [1],
    choices: (act) => {
      const cost = 20 * act;
      return [
        {
          id: 'pay',
          label: 'Pay the toll',
          hint: `Costs ${cost} gold. A blessing until the end of the act`,
          cost,
          resolve: () => ({
            text: 'The goblins count the coins twice, bow, and throw in some very useful gossip about the warrens ahead.',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'blessing' }],
          }),
        },
        {
          id: 'bluff',
          label: 'Claim to be the toll inspectors',
          hint: 'CHA check, DC 13',
          resolve: (ctx) => {
            const r = ctx.check('cha', 13);
            if (r.ok) {
              const g = loot(ctx, 25, 40);
              return { text: told(r, `${r.heroName} tuts at their paperwork until the goblins pay a ${g} gold fine and apologize.`), effects: [{ kind: 'gold', amount: g }] };
            }
            return {
              text: told(r, '"Inspectors don\'t carry swords," says the smallest goblin, and whistles for help.'),
              effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx), GOBLINS) }],
            };
          },
        },
        {
          id: 'charge',
          label: 'Charge across',
          hint: 'A fight',
          resolve: (ctx) => ({ text: 'You do not pay tolls. The goblins take it personally.', effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx) + 1, GOBLINS) }] }),
        },
        leave('You find another way down. It takes longer, but nobody charges you for it.'),
      ];
    },
  },
  {
    id: 'goblin_cook',
    title: 'The Goblin Cook',
    glyph: '🍲',
    text: 'A goblin in a tall chef\'s hat stirs a cauldron big enough to bathe in. "Customers! Real ones! Sit, sit!" Something in the pot waves at you.',
    acts: [1],
    choices: () => [
      {
        id: 'eat',
        label: 'Eat the stew',
        hint: 'CON check, DC 11. Delicious? Probably.',
        resolve: (ctx) => {
          const r = ctx.check('con', 11);
          return r.ok
            ? { text: told(r, 'It is, against all odds, delicious. Everyone feels warm, full and a little tougher.'), effects: [{ kind: 'heal', pct: 0.3 }, { kind: 'maxHp', amount: 2 }] }
            : { text: told(r, 'The thing in the pot waves goodbye on its way down. It does not stay down.'), effects: [{ kind: 'damage', dice: dice(1, 8), who: 'all' }] };
        },
      },
      {
        id: 'recipe',
        label: 'Ask for the secret recipe',
        hint: 'INT check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('int', 12);
          return r.ok
            ? { text: told(r, `${r.heroName} guesses the secret ingredient (mushrooms, and then more mushrooms). The delighted cook bottles some for the road.`), effects: [{ kind: 'potions', amount: 2 }] }
            : { text: told(r, `${r.heroName} guesses "rat". The cook, deeply offended, chases everyone out with a ladle.`), effects: [{ kind: 'damage', dice: dice(1, 4), who: 'checker' }] };
        },
      },
      leave('You say you already ate. The cook looks heartbroken, and the stew looks relieved.'),
    ],
  },
  {
    id: 'tinkerer',
    title: 'The Kobold Tinkerer',
    glyph: '🔧',
    text: 'A kobold in enormous goggles is building something that ticks. "Contraptions! Guaranteed to explode at the right time, most of the time!"',
    acts: [1, 3],
    choices: (act) => {
      const cost = 15 * act;
      return [
        {
          id: 'buy',
          label: 'Buy a pair of bombs',
          hint: `Costs ${cost} gold`,
          cost,
          resolve: () => ({
            text: 'One fire bomb and one frost bomb, wrapped in a sock. "Don\'t drop them. Or do, near enemies!"',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'item', id: 'fire_bomb' }, { kind: 'item', id: 'frost_bomb' }],
          }),
        },
        {
          id: 'blueprints',
          label: 'Peek at the blueprints',
          hint: 'INT check, DC 14',
          resolve: (ctx) => {
            const r = ctx.check('int', 14);
            return r.ok
              ? { text: told(r, `${r.heroName} spots the design flaw. The grateful tinkerer hands over a gadget that actually works.`), effects: [{ kind: 'item', gear: true, rarity: 'uncommon' }] }
              : { text: told(r, `${r.heroName} points at the wrong wire. Everyone is suddenly much closer to the ceiling.`), effects: [{ kind: 'damage', dice: dice(2, 4), who: 'all' }] };
          },
        },
        leave('You back away from the ticking. The kobold waves goodbye with the three fingers it has left.'),
      ];
    },
  },

  // ---- act 2: the Forgotten Crypt
  {
    id: 'bone_organ',
    title: 'The Bone Organ',
    glyph: '🎹',
    text: 'A pipe organ built from ribs and thighbones fills the far wall. The sheet music is still open. Its title roughly translates as "Please Don\'t".',
    acts: [2],
    choices: () => [
      {
        id: 'play',
        label: 'Play the music',
        hint: 'CHA check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('cha', 14);
          if (r.ok) {
            return {
              text: told(r, `${r.heroName} plays a hymn so mournful that the crypt sighs and the restless dead settle down to listen. A warm calm follows you out.`),
              effects: [{ kind: 'blessing' }, { kind: 'heal', pct: 0.15 }],
            };
          }
          return {
            text: told(r, `${r.heroName} hits a wrong note. Every skeleton in earshot takes it as an invitation to dance, and they are already here.`),
            effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx), UNDEAD), ambush: true }],
          };
        },
      },
      {
        id: 'pipes',
        label: 'Pry out the silver pipes',
        hint: 'STR check, DC 13',
        resolve: (ctx) => {
          const r = ctx.check('str', 13);
          if (r.ok) {
            const g = loot(ctx, 35, 55);
            return { text: told(r, `${r.heroName} wrenches out three pipes. Silver sells, even when it smells like this: ${g} gold.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return { text: told(r, "The organ lets out one last, terrible chord. Everyone's ears ring for a week."), effects: [{ kind: 'damage', dice: dice(1, 6), who: 'all' }] };
        },
      },
      leave('You leave the music unplayed. The crypt seems grateful.'),
    ],
  },
  {
    id: 'grave_robbers',
    title: 'The Grave Robbers',
    glyph: '⛏️',
    text: 'Two grave robbers freeze mid-dig, shovels raised. "This is not what it looks like." It is exactly what it looks like.',
    acts: [2],
    choices: () => [
      {
        id: 'dig',
        label: 'Help them dig',
        hint: 'A share of the loot. The owner may object.',
        resolve: (ctx) => {
          const g = loot(ctx, 25, 40);
          return ctx.rng.chance(0.5)
            ? { text: `You split the treasure: ${g} gold and an old trinket. The robbers tip their hats and vanish.`, effects: [{ kind: 'gold', amount: g }, { kind: 'item', rarity: 'common' }] }
            : {
                text: `You split ${g} gold, and then the grave's owner sits up to complain about it.`,
                effects: [{ kind: 'gold', amount: g }, { kind: 'fight', monsters: horde(ctx, crowd(ctx), ['zombie', 'zombie', 'bloated']) }],
              };
        },
      },
      {
        id: 'scare',
        label: 'Scare them off',
        hint: 'CHA check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('cha', 12);
          return r.ok
            ? { text: told(r, `${r.heroName} does a very convincing ghost voice. The robbers drop everything and run.`), effects: [{ kind: 'item', gear: true, rarity: 'common' }, { kind: 'potions', amount: 1 }] }
            : { text: told(r, `${r.heroName}'s ghost voice needs work. The robbers throw grave dirt in your faces and leave laughing.`), effects: [{ kind: 'damage', dice: dice(1, 4), who: 'checker' }] };
        },
      },
      leave('You did not see anything. Nobody saw anything.'),
    ],
  },
  {
    id: 'ghost_duel',
    title: 'The Ghostly Duelist',
    glyph: '🤺',
    text: 'A see-through swordsman bows with a flourish. "Three hundred years I have waited for a worthy opponent. You will do."',
    acts: [2],
    choices: (act) => [
      {
        id: 'duel',
        label: 'Accept the duel',
        hint: 'DEX check, DC 15',
        resolve: (ctx) => {
          const r = ctx.check('dex', 15);
          return r.ok
            ? { text: told(r, `${r.heroName} disarms the ghost with a move nobody has seen in three centuries. The ghost, beaming, hands over its prize.`), effects: [{ kind: 'item', gear: true, rarity: 'rare' }] }
            : { text: told(r, `The ghost's blade slips past ${r.heroName}'s guard, and then through ${r.heroName}. It hurts more than it looks.`), effects: [{ kind: 'damage', dice: dice(2, 6), who: 'checker' }] };
        },
      },
      {
        id: 'lesson',
        label: 'Ask for a lesson instead',
        hint: `Everyone gains ${20 * act} XP`,
        resolve: () => ({
          text: 'The ghost is thrilled to have students. The lesson takes an hour and covers footwork, posture and three centuries of complaints.',
          effects: [{ kind: 'xp', amount: 20 * act }],
        }),
      },
      leave('You decline. The ghost goes back to waiting. It is very good at it.'),
    ],
  },
  {
    id: 'soul_mirror',
    title: 'The Soul Mirror',
    glyph: '🪞',
    text: 'A tall mirror in a tarnished silver frame. Your reflections look a little braver than you do, and they are waving you closer.',
    acts: [2, 3],
    choices: () => [
      {
        id: 'touch',
        label: 'Touch the glass',
        hint: 'WIS check, DC 15',
        resolve: (ctx) => {
          const r = ctx.check('wis', 15);
          return r.ok
            ? { text: told(r, `${r.heroName} holds their reflection's gaze. The reflections share what they know, and everyone comes away with something new.`), effects: [{ kind: 'spoils', who: 'all' }] }
            : { text: told(r, `${r.heroName}'s reflection grabs their hand and keeps a little piece of them.`), effects: [{ kind: 'injury', who: 'checker' }] };
        },
      },
      {
        id: 'shatter',
        label: 'Smash it',
        hint: 'STR check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('str', 12);
          if (r.ok) {
            const g = loot(ctx, 20, 35);
            return { text: told(r, `The glass bursts into a thousand pieces. The silver frame is worth ${g} gold.`), effects: [{ kind: 'gold', amount: g }] };
          }
          return { text: told(r, 'The mirror bends instead of breaking and snaps back. Seven years of bad luck arrive all at once.'), effects: [{ kind: 'damage', dice: dice(1, 6), who: 'all' }] };
        },
      },
      leave('You leave your reflections behind. They look disappointed in you.'),
    ],
  },

  // ---- act 3: the Dragon's Lair
  {
    id: 'hoard_spill',
    title: 'The Spilled Hoard',
    glyph: '💎',
    text: 'A river of gold coins spills out from under a cave wall. It is very quiet. Suspiciously, sleeping-dragon quiet.',
    acts: [3],
    choices: () => [
      {
        id: 'grab',
        label: 'Fill your pockets',
        hint: 'DEX check, DC 15',
        resolve: (ctx) => {
          const r = ctx.check('dex', 15);
          if (r.ok) {
            const g = loot(ctx, 45, 60);
            return { text: told(r, `${r.heroName} wades through the coins without a single clink: ${g} gold.`), effects: [{ kind: 'gold', amount: g }] };
          }
          const g = loot(ctx, 15, 25);
          return {
            text: told(r, `Clink. Then a great many clinks. The hoard's guards come running, and you only get away with ${g} gold.`),
            effects: [{ kind: 'gold', amount: g }, { kind: 'fight', monsters: horde(ctx, crowd(ctx) + 1, ['kobold', 'kobold', 'cultist']), ambush: true }],
          };
        },
      },
      {
        id: 'gem',
        label: 'Take one gem and go',
        hint: 'Safe, and small',
        resolve: (ctx) => {
          const g = loot(ctx, 15, 25);
          return { text: `One gem, quietly pocketed, worth ${g} gold. Greed is for people who do not enjoy being alive.`, effects: [{ kind: 'gold', amount: g }] };
        },
      },
      leave('You leave the gold where it is. Somewhere, a dragon sleeps a little easier.'),
    ],
  },
  {
    id: 'dragon_egg',
    title: 'The Dragon Egg',
    glyph: '🥚',
    text: 'A dragon egg the size of a barrel sits warming in a brazier while three cultists hum hymns at it. They have not noticed you yet.',
    acts: [3],
    choices: () => [
      {
        id: 'smash',
        label: 'Smash the egg',
        hint: 'A blessing, and a fight',
        resolve: (ctx) => ({
          text: 'One dragon fewer in the world. The shell flares, a warm power settles over the party, and the cultists stop humming and start screaming.',
          effects: [{ kind: 'blessing' }, { kind: 'fight', monsters: horde(ctx, crowd(ctx), CULTISTS) }],
        }),
      },
      {
        id: 'steal',
        label: 'Steal it',
        hint: 'DEX check, DC 14',
        resolve: (ctx) => {
          const r = ctx.check('dex', 14);
          return r.ok
            ? { text: told(r, `${r.heroName} swaps the egg for a round rock, and the cultists keep humming. Inside the shell, curled where a dragonling should be, is a warm and very strange relic.`), effects: [{ kind: 'relic' }] }
            : { text: told(r, `${r.heroName} drops the egg. It bounces. The cultists stop humming.`), effects: [{ kind: 'fight', monsters: horde(ctx, crowd(ctx) + 1, CULTISTS), ambush: true }] };
        },
      },
      leave('You let the cultists keep their egg. Someone else can deal with the dragon in twenty years.'),
    ],
  },
  {
    id: 'deserter',
    title: 'The Orc Deserter',
    glyph: '🏳️',
    text: 'An orc sits by a tiny fire, sharpening an axe and looking miserable. "Warchief said no more naps. I quit. You hiring?"',
    acts: [3],
    choices: (act) => {
      const cost = 25 * act;
      return [
        {
          id: 'hire',
          label: 'Hire the orc',
          hint: `Costs ${cost} gold. An NPC ally for the next few fights`,
          cost,
          resolve: () => ({
            text: 'The orc pockets the gold, signs the contract with a thumbprint and falls in line as your sellsword. "Naps on Sundays."',
            effects: [{ kind: 'gold', amount: -cost }, { kind: 'ally', id: 'sellsword' }],
          }),
        },
        {
          id: 'ask',
          label: 'Ask about the lair',
          hint: 'CHA check, DC 13',
          resolve: (ctx) => {
            const r = ctx.check('cha', 13);
            return r.ok
              ? { text: told(r, `${r.heroName} listens patiently. The orc knows every trap, every shortcut and the guards' nap schedule.`), effects: [{ kind: 'blessing' }] }
              : { text: told(r, 'The orc starts explaining, yawns, and falls asleep mid-sentence. Fair enough.'), effects: [] };
          },
        },
        leave('You wish the orc luck. The orc is already asleep.'),
      ];
    },
  },
];

// ---------------------------------------------------------------- lookup

/** Fills in an event's choices for an act. */
function build(t: EventTemplate, act: number): EventDef {
  const { choices, ...rest } = t;
  return { ...rest, choices: choices(clampAct(act)) };
}

const fitsAct = (e: { acts?: number[] }, act: number) => !e.acts || e.acts.includes(act);

/** Every event, priced for act 1. pickEvent() and getEvent() price them for the act you pass. */
export const EVENTS: EventDef[] = TEMPLATES.map((t) => build(t, 1));

/** Looks an event up by id, priced for `act`: e.g. to rebuild the current event after a reload. */
export function getEvent(id: string, act: number): EventDef | undefined {
  const t = TEMPLATES.find((e) => e.id === id);
  return t && build(t, act);
}

/**
 * Picks an event for this act, preferring ones the party hasn't seen this run.
 * Once everything has been seen, anything but the most recent one is fair game again.
 */
export function pickEvent(act: number, seen: readonly string[], rng: Rng): EventDef {
  const a = clampAct(act);
  const fits = TEMPLATES.filter((e) => fitsAct(e, a));
  const fresh = fits.filter((e) => !seen.includes(e.id));
  const notLast = fits.filter((e) => e.id !== seen[seen.length - 1]);
  return build(rng.pick(fresh.length ? fresh : notLast.length ? notLast : fits), a);
}
