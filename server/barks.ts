// Monster barks (Phase 9): short handwritten lines in the log when the squad picks a target, a coward runs, a brute
// shoves someone into the fire, a support casts. They tell the party what the monsters are up to.
// {me} is the speaker, {target} who it's about, {class} the target's class (or kind of monster).
// A line starting with '*' is something it does rather than says (beasts and the mindless dead don't talk); those
// start with {me}, which becomes "The Wolf" (or an NPC ally's own name).

import { CLASSES, MONSTERS } from '../shared/rules.ts';
import type { Entity, MonsterEntity } from '../shared/types.ts';

export type BarkEvent = 'focus' | 'flee' | 'cornered' | 'shove' | 'ignite' | 'heal' | 'buff';

type Voice = 'goblin' | 'beast' | 'dead' | 'dread' | 'orc' | 'ogre' | 'cult' | 'imp' | 'dragon' | 'sellsword' | 'acolyte' | 'ranger' | 'hound';

const VOICE: Record<string, Voice> = {
  kobold: 'goblin', goblin: 'goblin', archer: 'goblin', firebomber: 'goblin', shaman: 'goblin', hobgoblin: 'goblin', goblin_king: 'goblin',
  rat: 'beast', wolf: 'beast', spider: 'beast', broodmother: 'beast', mimic: 'beast',
  skeleton: 'dead', zombie: 'dead', bloated: 'dead',
  wight: 'dread', necromancer: 'dread', bone_knight: 'dread',
  orc: 'orc', warchief: 'orc', ogre: 'ogre',
  cultist: 'cult', priest: 'cult', imp: 'imp',
  drake: 'dragon', wyrm: 'dragon',
  sellsword: 'sellsword', acolyte: 'acolyte', ranger: 'ranger', war_hound: 'hound',
};

export const LINES: Record<Voice, Partial<Record<BarkEvent, string[]>>> = {
  goblin: {
    focus: ['Stick the {class}!', 'Get the {class}, get it!', 'All on {target}! Shiny loot!', 'That one! The {class}!'],
    flee: ['Nope! Nope nope nope!', 'Not paid enough for this!', 'Run away!'],
    cornered: ['No way out... fine! FINE!', 'Cornered goblin bites hardest!'],
    shove: ['In you go!', 'Hot hot hot! For you!'],
    ignite: ['Burn it! Burn it all!', 'Ooh, that\'ll go up nice!'],
    heal: ['Back on your feet, runt!', 'Spit on it, you\'re fine!'],
    buff: ['The spirits are with us! Stab harder!', 'Big magic! Go get them!'],
  },
  beast: {
    focus: ['*{me} fixes its eyes on {target}.', '*{me} circles {target}, low and hungry.'],
    flee: ['*{me} yelps and scrambles away.', '*{me} bolts for the shadows.'],
    cornered: ['*{me} bares its teeth, cornered.'],
    shove: ['*{me} slams into {target}.'],
  },
  dead: {
    focus: ['*{me} turns its empty gaze on {target}.', '*{me} lurches toward {target}.'],
    shove: ['*{me} shoves {target} with dead hands.'],
  },
  dread: {
    focus: ['Your warmth, {class}. Give it to me.', 'The {class} first.', 'Join us, {target}.'],
    shove: ['Into the dark with you.'],
    ignite: ['Freeze where you stand.'],
    heal: ['Rise. Your work isn\'t done.', 'Bones knit. Flesh obeys.'],
    buff: ['Death guards its own.', 'Bone and shadow, shield my servant.'],
  },
  orc: {
    focus: ['Smash the {class}!', '{target} is mine!', 'That one dies first!'],
    flee: ['Fall back! FALL BACK!'],
    cornered: ['Then I die fighting!'],
    shove: ['Burn, weakling!', 'Out of my way!'],
  },
  ogre: {
    focus: ['Ogre want {class}.', 'Little {class}! Come here!'],
    shove: ['Ogre push! Ha!', 'Go hot place!'],
  },
  cult: {
    focus: ['The Wyrm demands the {class}!', 'Offer {target} to the flame!'],
    flee: ['The Wyrm will understand!'],
    ignite: ['Let the fire take them!', 'Burn for the Wyrm!'],
    heal: ['The flame mends you, brother.', 'Not yet. The Wyrm still needs you.'],
    buff: ['Dragonfire in your veins!', 'Fight with the Wyrm\'s fury!'],
  },
  imp: {
    focus: ['Hee hee! The {class} looks crunchy!', '{target}! {target}! Let\'s play!'],
    flee: ['Too hot even for me!'],
    ignite: ['Hee! Pretty fire!', 'Boom boom boom!'],
  },
  dragon: {
    focus: ['You. {class}. You smell of courage, and of lunch.', 'Kneel, {target}.'],
    shove: ['Into the fire, morsel.'],
    ignite: ['Burn.'],
  },
  sellsword: {
    focus: ['On {target}! With me!', 'I\'ve got the {class}.'],
    shove: ['Mind your step!'],
  },
  acolyte: {
    heal: ['Hold still, {target}.', 'The light is with you, {target}.', 'Not today, {target}.'],
    buff: ['May your aim be true, {target}.', 'Blessings on you, {target}!'],
  },
  ranger: {
    focus: ['Taking the shot on {target}.', '{target}, marked.'],
  },
  hound: {
    focus: ['*{me} growls at {target}.'],
  },
};

/** How often a bark is said when it could be (the target call is always made: it's information). */
export const BARK_ODDS: Record<BarkEvent, number> = { focus: 1, flee: 1, cornered: 1, shove: 0.5, ignite: 0.5, heal: 0.4, buff: 0.4 };

/** The log line for a bark, or null if this creature has nothing to say about it. */
export function barkLine(m: MonsterEntity, ev: BarkEvent, target: Entity | undefined, roll: number): string | null {
  const lines = LINES[VOICE[m.type] ?? 'beast']?.[ev];
  if (!lines?.length) return null;
  const pick = lines[Math.floor(roll * lines.length) % lines.length];
  const cls = target?.kind === 'player' ? CLASSES[target.classId].name : target ? MONSTERS[target.type]?.name ?? 'thing' : 'enemy';
  const text = pick
    .replace(/^\*/, '')
    .replaceAll('{me}', m.ally ? m.name : `The ${m.name}`)
    .replaceAll('{target}', target?.name ?? 'them')
    .replaceAll('{class}', cls);
  return pick.startsWith('*') ? `💬 ${text}` : `💬 ${m.name}: "${text}"`;
}
