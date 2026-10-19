// Subclasses (decided 2026-10-19): at SUBCLASS_LEVEL every hero picks one of the two for their class, as a level-up
// pick. It gives its signature skill at once (that skill doesn't take a slot and can't be forgotten), and from then on
// level-up offers draw from the class pool plus the subclass's own skills (SkillDef.sub in shared/skills.ts).

import type { SkillId } from './skills.ts';
import type { ClassId } from './types.ts';

export type SubclassId =
  | 'weapon_master'
  | 'guardian'
  | 'assassin'
  | 'skirmisher'
  | 'evoker'
  | 'elementalist'
  | 'life'
  | 'order'
  | 'berserker'
  | 'juggernaut'
  | 'trapper'
  | 'sharpshooter'
  | 'protection'
  | 'devotion'
  | 'valor'
  | 'whispers';

export interface SubclassDef {
  classId: ClassId;
  name: string;
  icon: string;
  blurb: string;
  signature: SkillId; // learned the moment the subclass is picked
}

export const SUBCLASS_LEVEL = 3;

export const SUBCLASSES: Record<SubclassId, SubclassDef> = {
  weapon_master: { classId: 'fighter', name: 'Weapon Master', icon: '⚔️', signature: 'cleave', blurb: 'Raw damage and counters: cleave through crowds, line up a precise strike, punish every miss.' },
  guardian: { classId: 'fighter', name: 'Guardian', icon: '🛡️', signature: 'shield_wall', blurb: 'A wall of Block that hurts to hit: soak the blows, patch yourself up, and let the spikes do the rest.' },
  assassin: { classId: 'rogue', name: 'Assassin', icon: '🗡️', signature: 'envenom', blurb: 'Poison and burst: coat the blade, wait for the opening, and end it in one strike.' },
  skirmisher: { classId: 'rogue', name: 'Skirmisher', icon: '💨', signature: 'quick_stab', blurb: 'Hit and run: cheap stabs, rolls and dashes. Never there when the counterattack comes.' },
  evoker: { classId: 'wizard', name: 'Evoker', icon: '☄️', signature: 'sculpt_spells', blurb: 'Big area spells that spare your friends, and a Meteor to end the fight.' },
  elementalist: { classId: 'wizard', name: 'Elementalist', icon: '❄️', signature: 'frost_nova', blurb: 'Control and reactions: freeze, shove and set the battlefield off for more.' },
  life: { classId: 'cleric', name: 'Life', icon: '💖', signature: 'mass_healing_word', blurb: 'The best healer there is: whole-party heals that get the fallen back up.' },
  order: { classId: 'cleric', name: 'Order', icon: '⚖️', signature: 'warding_light', blurb: 'Protects from range with Block, commands monsters to kneel, and every buff hurries your friends (+1 AP).' },
  berserker: { classId: 'barbarian', name: 'Berserker', icon: '🩸', signature: 'blood_price', blurb: 'Pay in blood: spend your own HP for AP, frenzy, and hit hardest when you are nearly dead.' },
  juggernaut: { classId: 'barbarian', name: 'Juggernaut', icon: '🦏', signature: 'blood_drinker', blurb: 'Drinks the blood it spills, dares the monsters to hit it, and cannot be knocked down.' },
  trapper: { classId: 'ranger', name: 'Trapper', icon: '🪤', signature: 'snare_trap', blurb: 'Hidden snares and barrages: pin the pack in place and punish whatever is stuck.' },
  sharpshooter: { classId: 'ranger', name: 'Sharpshooter', icon: '🎯', signature: 'aimed_shot', blurb: 'Long range, huge single shots, arrows that go through.' },
  protection: { classId: 'paladin', name: 'Protection', icon: '🏰', signature: 'intercept', blurb: 'Takes the hits meant for friends and wraps everyone next to it in Block.' },
  devotion: { classId: 'paladin', name: 'Devotion', icon: '🌟', signature: 'blessed_smites', blurb: 'Smites that heal, a healing touch, and holy vitality that keeps you standing.' },
  valor: { classId: 'bard', name: 'Valor', icon: '🎺', signature: 'rousing', blurb: 'Buffs: Inspiration that hurries a friend (+1 AP), war chants and blessed blades.' },
  whispers: { classId: 'bard', name: 'Whispers', icon: '🤫', signature: 'dissonant_whispers', blurb: 'Debuffs and fear: words that frighten, cut and wound the already broken.' },
};

export const SUBCLASS_IDS = Object.keys(SUBCLASSES) as SubclassId[];
export const isSubclassId = (id: unknown): id is SubclassId => typeof id === 'string' && Object.hasOwn(SUBCLASSES, id);
export const subclassesOf = (c: ClassId): SubclassId[] => SUBCLASS_IDS.filter((id) => SUBCLASSES[id].classId === c);
