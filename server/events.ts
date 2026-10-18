// ❓ Event nodes: short text scenes with choices the party votes on.
// Pure content: a choice's resolve() only reads its ctx and returns text plus effects; game.ts applies them.

import { ACTS } from '../shared/rules.ts';
import type { Dice } from '../shared/rules.ts';
import type { Rng } from './rng.ts';

export type EventStat = 'str' | 'dex' | 'int' | 'wis';

export type EventEffect =
  | { kind: 'heal'; pct: number } // every living hero heals pct (0-1) of max HP
  | { kind: 'damage'; dice: Dice; who: 'all' | 'checker' } // 'checker' = the hero who made the last check
  | { kind: 'gold'; amount: number } // party gold, may be negative
  | { kind: 'potions'; amount: number } // handed out one at a time to whoever has the fewest
  | { kind: 'maxHp'; amount: number } // permanent, every hero
  | { kind: 'restoreSlots' } // every hero's spell slots back to full
  | { kind: 'fight'; monsters: string[]; elite?: boolean }; // starts a battle after the outcome text (ids from MONSTERS)

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
        hint: 'WIS check, DC 12',
        resolve: (ctx) => {
          const r = ctx.check('wis', 12);
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
        hint: 'Heals the party a little',
        resolve: () => ({
          text: 'The party kneels and mumbles a polite prayer. Somewhere, a forgotten god is thrilled to finally have fans.',
          effects: [{ kind: 'heal', pct: 0.25 }],
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
          hint: 'It is bubbling. A lot.',
          resolve: (ctx) =>
            ctx.rng.chance(0.5)
              ? {
                  text: 'Every wound knits shut with a fizzy pop! The gnome looks almost as surprised as you are.',
                  effects: [{ kind: 'heal', pct: 1 }],
                }
              : {
                  text: 'Everyone turns a lovely shade of green, then becomes violently unwell. "Fascinating!" says the gnome, taking notes.',
                  effects: [{ kind: 'damage', dice: dice(1, 8), who: 'all' }],
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
