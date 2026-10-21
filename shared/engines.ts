// Build engines (decided 2026-10-19, in place of the level-3 subclass pick): every class has three, and your build is
// whichever engine your victory and elite picks lean into. Builders make a resource (stacks, a status, low HP), payoffs
// multiply it, and an epic capstone bends a rule for it. Offers lean toward the engines you already own cards of
// (server/progression.ts), and every card has a rarity, like items. The first 16 engines keep the old subclass ids, so
// old saves' subclass labels still mean something.

import type { SkillId } from './skills.ts';
import type { ClassId } from './types.ts';

export type EngineId =
  | 'weapon_master' | 'guardian' | 'duelist'
  | 'assassin' | 'skirmisher' | 'shadow'
  | 'evoker' | 'elementalist' | 'geomancer'
  | 'life' | 'order' | 'light'
  | 'berserker' | 'juggernaut' | 'wrecker'
  | 'trapper' | 'sharpshooter' | 'hunter'
  | 'protection' | 'devotion' | 'vengeance'
  | 'valor' | 'whispers' | 'crescendo';

/** How rare a class card is in offers (no legendary skills: those are for items). */
export type CardRarity = 'common' | 'uncommon' | 'rare' | 'epic';
export const CARD_RARITIES: CardRarity[] = ['common', 'uncommon', 'rare', 'epic'];

export interface EngineDef {
  classId: ClassId;
  name: string;
  icon: string;
  desc: string; // what it builds up and what pays it off
  cards: Partial<Record<CardRarity, SkillId[]>>;
}

export const ENGINES: Record<EngineId, EngineDef> = {
  // ---------------------------------------------- Fighter: damage, self-heal, Block, counters and thorns
  weapon_master: {
    classId: 'fighter', name: 'Weapon Master', icon: '⚔️', desc: 'Crits: widen your crit range, then make every crit hit harder and pay you back.',
    cards: { common: ['heavy_strike', 'keen_edge'], uncommon: ['precision_strike', 'cleave', 'momentum'], rare: ['whirlwind', 'devastating_blows'], epic: ['perfect_form'] },
  },
  guardian: {
    classId: 'fighter', name: 'Guardian', icon: '🛡️', desc: 'Block and thorns: stack up Block, then hit with it and make it hurt to hit you.',
    cards: { common: ['shield_bash', 'battle_cry', 'second_wind', 'battle_hardened'], uncommon: ['shield_wall', 'iron_recovery', 'shield_slam'], rare: ['spiked_shield', 'entrench'], epic: ['fortress'] },
  },
  duelist: {
    classId: 'fighter', name: 'Duelist', icon: '🤺', desc: 'Counters: be hard to hit, then punish every miss.',
    cards: { common: ['trip_attack', 'fighting_style', 'parry'], uncommon: ['sentinel', 'swift_riposte'], rare: ['counterattack'], epic: ['blade_wall'] },
  },
  // ---------------------------------------------- Rogue: backstabs, hit and run, burst combos, poison
  assassin: {
    classId: 'rogue', name: 'Assassin', icon: '🗡️', desc: 'Poison stacks: pile on Poison, multiply it, then cash it in.',
    cards: { common: ['envenom', 'hail_of_arrows', 'noxious_fumes'], uncommon: ['death_mark', 'toxic_catalyst'], rare: ['rupture'], epic: ['virulence'] },
  },
  skirmisher: {
    classId: 'rogue', name: 'Skirmisher', icon: '💨', desc: 'Many small hits: cheap attacks, and every hit in a turn makes the next one hurt more.',
    cards: { common: ['quick_stab', 'throwing_knives', 'cunning_dash', 'slippery'], uncommon: ['tumble', 'strike_and_fade', 'flurry'], rare: ['knife_juggler'], epic: ['thousand_cuts'] },
  },
  shadow: {
    classId: 'rogue', name: 'Shadow', icon: '🎭', desc: 'One huge backstab: set it up from hiding, with debuffs, then strike.',
    cards: { common: ['hide', 'feint', 'cheap_shot'], uncommon: ['shadow_step', 'opportunist', 'cunning_strikes'], rare: ['assassinate', 'melt_away'], epic: ['death_blossom'] },
  },
  // ---------------------------------------------- Wizard: area, crowd control, elemental reactions, the ground itself
  evoker: {
    classId: 'wizard', name: 'Evoker', icon: '☄️', desc: 'Arcane Charge: every spell you cast powers up the next ones.',
    cards: { common: ['magic_missile', 'fire_bolt', 'arcane_focus', 'arcane_charge'], uncommon: ['fireball', 'sculpt_spells', 'empowered_evocation'], rare: ['meteor', 'unleash'], epic: ['archmage'] },
  },
  elementalist: {
    classId: 'wizard', name: 'Elementalist', icon: '❄️', desc: 'Combos: soak them, then shock or freeze them; oil, then fire.',
    cards: { common: ['ray_of_frost', 'shocking_grasp', 'grease', 'elemental_affinity', 'drench'], uncommon: ['frost_nova', 'flash_freeze', 'conductor', 'shatter_point'], rare: ['catalyst'], epic: ['convergence'] },
  },
  geomancer: {
    classId: 'wizard', name: 'Geomancer', icon: '🪨', desc: 'Pits and stone: open pits, push enemies in, and raise or fill the ground to keep friends from going over.',
    cards: { common: ['raise_cover', 'tremor', 'earth_ram'], uncommon: ['open_pit', 'shatter_ground', 'wall_of_stone'], rare: ['crushing_force', 'undertow'], epic: ['earthshaper'] },
  },
  // ---------------------------------------------- Cleric: healing, shielding allies, buffs
  life: {
    classId: 'cleric', name: 'Life', icon: '💖', desc: 'Overhealing: heal more than they need, and the rest becomes protection.',
    cards: { common: ['healing_word', 'healing_touch', 'blessed_healer'], uncommon: ['mass_healing_word', 'prayer_of_healing', 'overflowing_grace'], rare: ['disciple_of_life', 'soul_link'], epic: ['font_of_life'] },
  },
  order: {
    classId: 'cleric', name: 'Order', icon: '⚖️', desc: 'Buffs from range: every blessing of yours on a friend makes them hit harder.',
    cards: { common: ['bless', 'warding_light', 'devout'], uncommon: ['command', 'inspiring_presence'], rare: ['voice_of_authority'], epic: ['divine_order'] },
  },
  light: {
    classId: 'cleric', name: 'Light', icon: '☀️', desc: 'Radiance: radiant hits sear enemies, and seared enemies take more, until the Dawn burns it all.',
    cards: { common: ['sacred_flame', 'word_of_radiance', 'searing_light'], uncommon: ['guiding_bolt', 'divine_strike'], rare: ['dawn'], epic: ['avatar_of_light'] },
  },
  // ---------------------------------------------- Barbarian: lifesteal, taunts, hurting yourself for big damage
  berserker: {
    classId: 'barbarian', name: 'Berserker', icon: '🩸', desc: 'Low HP, high damage: pay in blood, and hit harder the more you bleed.',
    cards: { common: ['reckless_attack', 'blood_price', 'brutal_blows', 'blood_rite'], uncommon: ['frenzy', 'bloodlust', 'brutal_strike'], rare: ['blood_fury'], epic: ['unkillable'] },
  },
  juggernaut: {
    classId: 'barbarian', name: 'Juggernaut', icon: '🦏', desc: 'Lifesteal tank: taunt them, drink from them, and turn the extra into Block.',
    cards: { common: ['rage', 'challenge', 'war_roar', 'thick_hide'], uncommon: ['blood_drinker', 'unstoppable', 'relentless', 'scar_tissue'], rare: ['bloodbath'], epic: ['immortal_hunger'] },
  },
  wrecker: {
    classId: 'barbarian', name: 'Wrecker', icon: '🌋', desc: 'Knockdowns: put them on the floor, then stamp on them.',
    cards: { common: ['ground_slam', 'harpoon', 'pile_driver'], uncommon: ['earth_splitter', 'stomp'], epic: ['earthbreaker'] },
  },
  // ---------------------------------------------- Ranger: traps, many targets, long-range big hits
  trapper: {
    classId: 'ranger', name: 'Trapper', icon: '🪤', desc: 'Traps and nets: pin them down, then make the pinned pay.',
    cards: { common: ['snare_trap', 'ensnaring_shot', 'natural_explorer', 'spike_pit'], uncommon: ['barrage', 'ambusher', 'hail_of_thorns', 'fire_trap'], rare: ['hunters_snare'], epic: ['killing_field'] },
  },
  sharpshooter: {
    classId: 'ranger', name: 'Sharpshooter', icon: '🎯', desc: 'Stand still, hit hard: every turn you hold your ground builds Focus for one huge shot.',
    cards: { common: ['steady_aim', 'archery', 'patience'], uncommon: ['aimed_shot', 'deadeye', 'piercing_shot'], rare: ['kill_shot'], epic: ['snipers_nest'] },
  },
  hunter: {
    classId: 'ranger', name: 'Hunter', icon: '🏹', desc: 'Marks and many targets: mark the pack, and every mark makes your arrows hurt more.',
    cards: { common: ['hunters_mark', 'quick_shot'], uncommon: ['lightning_arrow', 'favored_foe', 'split_shot'], rare: ['pack_hunter'], epic: ['rain_of_arrows'] },
  },
  // ---------------------------------------------- Paladin: self-sustain, blocking for allies, healing by touch
  protection: {
    classId: 'paladin', name: 'Protection', icon: '🏰', desc: 'Block on friends: shield the people next to you, and heal from what your Block takes.',
    cards: { common: ['bulwark', 'defender'], uncommon: ['aegis', 'aura_of_warding', 'aura_of_protection', 'shared_burden'], rare: ['intercept'], epic: ['unbreakable_oath'] },
  },
  devotion: {
    classId: 'paladin', name: 'Devotion', icon: '🌟', desc: 'Sustain by touch: every heal you give also shields.',
    cards: { common: ['lay_on_hands', 'healing_hands', 'divine_health'], uncommon: ['restoring_touch', 'divine_vitality', 'radiant_recovery'], rare: ['blessed_smites'], epic: ['saint'] },
  },
  vengeance: {
    classId: 'paladin', name: 'Vengeance', icon: '⚔️', desc: 'Smite burst: mark your enemy, then smite it with everything.',
    cards: { common: ['radiant_strike', 'compelled_duel', 'vow_of_enmity'], uncommon: ['divine_smite', 'crusaders_mantle'], rare: ['zealous_smite'], epic: ['avenging_angel'] },
  },
  // ---------------------------------------------- Bard: crowd control, buffs, debuffs
  valor: {
    classId: 'bard', name: 'Valor', icon: '🎺', desc: 'Hand out AP: inspire your friends, then inspire them again.',
    cards: { common: ['inspiration'], uncommon: ['war_chant', 'combat_inspiration', 'heroic_anthem', 'standing_ovation'], rare: ['rousing'], epic: ['heroic_saga'] },
  },
  whispers: {
    classId: 'bard', name: 'Whispers', icon: '🤫', desc: 'Debuffs stack: the more is wrong with a monster, the harder your words hit it.',
    cards: { common: ['vicious_mockery', 'cutting_words', 'hypnotic_gaze'], uncommon: ['dissonant_whispers', 'hideous_laughter', 'mind_rot'], rare: ['psychic_blades', 'haunting_refrain'], epic: ['madness'] },
  },
  crescendo: {
    classId: 'bard', name: 'Crescendo', icon: '🎶', desc: 'Verses: every song builds a Verse, and the Finale spends them all at once.',
    cards: { common: ['thunderwave', 'healing_ballad', 'song_of_rest', 'verse'], uncommon: ['shatter'], rare: ['finale'], epic: ['magnum_opus'] },
  },
};

export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[];
export const isEngineId = (id: unknown): id is EngineId => typeof id === 'string' && Object.hasOwn(ENGINES, id);
export const enginesOf = (classId: ClassId): EngineId[] => ENGINE_IDS.filter((id) => ENGINES[id].classId === classId);
