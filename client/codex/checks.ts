// Pool checks: broken references (errors), content that goes unused (warnings) and coverage goals (info).
// Pure functions of the data, so they run under Node (tests/codex.test.ts) as well as in the codex page.

import { CARD_RARITIES, type EngineDef } from '../../shared/engines.ts';
import { MAX_CANTRIPS, MAX_SPELLS, passiveSlots } from '../../shared/rules.ts';
import { liveData, monsterUsage, statusUsage, usedAsFoe, type CodexData } from './data.ts';

export type Level = 'error' | 'warn' | 'info';

export interface Check {
  level: Level;
  pool: string; // which content pool it is about (one of POOLS)
  id?: string; // the entry it is about, when there is one
  text: string;
}

export const POOLS = ['acts', 'encounters', 'monsters', 'allies', 'classes', 'engines', 'skills', 'items', 'statuses', 'events', 'sprites'];

/** Coverage goals from PLAN.md Phase 12. */
export const GOALS = { events: 15, encounters: 8, classes: 8 };
export const PLANNED_CLASSES = ['Ranger', 'Paladin', 'Barbarian', 'Bard'];

export interface Coverage {
  pool: string;
  label: string;
  have: number;
  goal: number;
  note?: string;
}

const actNums = (d: CodexData) => d.acts.map((_, i) => i + 1);
const inAct = (e: { acts?: number[] }, act: number) => !e.acts || e.acts.includes(act);

/** How far each coverage goal is: events and encounter templates per act, classes. */
export function coverage(d: CodexData): Coverage[] {
  const out: Coverage[] = [];
  for (const n of actNums(d)) out.push({ pool: 'events', label: `Events, act ${n}`, have: d.events.filter((e) => inAct(e, n)).length, goal: GOALS.events });
  for (const n of actNums(d)) out.push({ pool: 'encounters', label: `Encounter templates, act ${n}`, have: d.acts[n - 1].encounters.length, goal: GOALS.encounters });
  const missing = PLANNED_CLASSES.filter((name) => !Object.values(d.classes).some((c) => c.name === name));
  out.push({ pool: 'classes', label: 'Classes', have: Object.keys(d.classes).length, goal: GOALS.classes, note: missing.length ? `planned: ${missing.join(', ')}` : undefined });
  return out;
}

/** Every card of an engine, rarest last. */
export const engineCards = (e: EngineDef): string[] => CARD_RARITIES.flatMap((r) => e.cards[r] ?? []);

/** The engines of a class. */
export const enginesIn = (d: CodexData, classId: string): [id: string, def: EngineDef][] => Object.entries(d.engines).filter(([, e]) => e.classId === classId);

/** Every class has this many build engines. */
export const ENGINES_PER_CLASS = 3;

/** The skills in a class's pool, by kind, and how many of them belong to an engine. */
export function poolCounts(d: CodexData, pool: string) {
  const defs = Object.values(d.skills).filter((s) => s.pool === pool);
  const n = (kind: string) => defs.filter((s) => s.kind === kind).length;
  const inEngine = new Set(enginesIn(d, pool).flatMap(([, e]) => engineCards(e)));
  return { cantrip: n('cantrip'), spell: n('spell'), passive: n('passive'), basic: n('basic'), engine: inEngine.size };
}

/** The class's cards (cantrips, spells and passives of its pool) that sit in no engine: general on purpose, or still to place. */
export const looseCards = (d: CodexData, classId: string): string[] => {
  const inEngine = new Set(enginesIn(d, classId).flatMap(([, e]) => engineCards(e)));
  return Object.keys(d.skills).filter((id) => d.skills[id].pool === classId && ['cantrip', 'spell', 'passive'].includes(d.skills[id].kind) && !inEngine.has(id));
};

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2 };

/** Every check, errors first. Default: the real game's data. */
export function checks(d: CodexData = liveData()): Check[] {
  const out: Check[] = [];
  const add = (level: Level, pool: string, text: string, id?: string) => out.push({ level, pool, text, ...(id ? { id } : {}) });
  const name = (id: string) => d.monsters[id]?.name ?? id;
  const ref = (pool: string, id: string, where: string) => {
    if (!Object.hasOwn(d.monsters, id)) add('error', pool, `${where}: unknown monster "${id}"`, id);
  };

  // ---- acts, encounters, elites, bosses
  d.acts.forEach((act, i) => {
    const A = `Act ${i + 1} (${act.name})`;
    for (const m of act.pool) ref('acts', m, `${A} pool`);
    for (const e of act.encounters) {
      if (!e.monsters.length) add('error', 'encounters', `${A} / ${e.name}: the template is empty`);
      for (const m of e.monsters) ref('encounters', m, `${A} / ${e.name}`);
    }
    for (const el of act.elites) {
      ref('acts', el, `${A} elites`);
      if (!act.escorts[el]?.length) add('error', 'acts', `${A}: elite ${name(el)} has no escorts entry`, el);
    }
    for (const [el, list] of Object.entries(act.escorts)) {
      if (!act.elites.includes(el)) add('warn', 'acts', `${A}: escorts for "${el}", which is not one of the act's elites`, el);
      for (const m of list) ref('acts', m, `${A} escorts of ${el}`);
    }
    ref('acts', act.boss, `${A} boss`);
    for (const m of act.minions) ref('acts', m, `${A} boss minions`);
    for (const m of act.pool) {
      if (Object.hasOwn(d.monsters, m) && !act.encounters.some((e) => e.monsters.includes(m))) add('warn', 'acts', `${A}: ${name(m)} is in the pool but in no encounter template`, m);
    }
  });

  // ---- monsters, allies
  const usage = monsterUsage(d);
  const allyMonsters = new Set(Object.values(d.allies).map((a) => a.monster));
  for (const [id, a] of Object.entries(d.allies)) {
    if (!Object.hasOwn(d.monsters, a.monster)) add('error', 'allies', `NPC ally "${id}" uses unknown monster "${a.monster}"`, id);
  }
  for (const id of Object.keys(d.monsters)) {
    if (!allyMonsters.has(id) && !usedAsFoe(usage[id])) add('warn', 'monsters', `${name(id)} is not used by any act, encounter, elite, boss or event`, id);
    if (!d.monsterSprites[id]) add('warn', 'sprites', `${name(id)} has no sprite (it is drawn as ${d.monsters[id].glyph})`, id);
  }

  // ---- classes
  for (const [id, c] of Object.entries(d.classes)) {
    for (const s of c.start) {
      const def = d.skills[s];
      if (!def) add('error', 'classes', `${c.name}: start skill "${s}" is not in SKILLS`, id);
      else if (def.pool !== id && def.pool !== 'common') add('error', 'classes', `${c.name}: start skill "${s}" belongs to the ${def.pool} pool`, id);
    }
    if (!d.classSprites[id]) add('warn', 'sprites', `${c.name} has no sprite (it is drawn as ${c.glyph})`, id);
  }

  // ---- skills
  for (const [id, def] of Object.entries(d.skills)) {
    if (def.pool !== 'common' && !Object.hasOwn(d.classes, def.pool)) add('error', 'skills', `${def.base.name}: pool "${def.pool}" is not a class`, id);
    if (!!def.a !== !!def.b) add('error', 'skills', `${def.base.name}: has tier III-${def.a ? 'A' : 'B'} but no III-${def.a ? 'B' : 'A'}`, id);
    if ((def.a || def.b) && !def.t2) add('error', 'skills', `${def.base.name}: has a tier III branch but no tier II`, id);
    if ((def.kind === 'cantrip' || def.kind === 'spell' || def.kind === 'passive') && !def.t2) add('warn', 'skills', `${def.base.name}: ${def.kind} with no tier II (it can't be upgraded)`, id);
    if (def.kind === 'item' && id !== 'potion' && !d.items[id]) add('warn', 'items', `${def.base.name}: item skill with no ITEMS entry`, id);
  }
  for (const [id, it] of Object.entries(d.items)) {
    if (it.kind === 'consumable' && !d.skills[id]) add('error', 'items', `Consumable "${id}" has no skill of the same id (its rules)`, id);
  }

  // ---- engines: three per class, each a set of class cards by rarity with an epic capstone
  const owner = new Map<string, string>(); // card -> the engine that has it
  for (const [id, e] of Object.entries(d.engines)) {
    if (!Object.hasOwn(d.classes, e.classId)) add('error', 'engines', `${e.name}: class "${e.classId}" does not exist`, id);
    if (!e.cards.epic?.length) add('error', 'engines', `${e.name} has no epic capstone`, id);
    for (const card of engineCards(e)) {
      const def = Object.hasOwn(d.skills, card) ? d.skills[card] : undefined;
      if (!def) add('error', 'engines', `${e.name}: card "${card}" is not in SKILLS`, id);
      else if (def.pool !== e.classId) add('error', 'engines', `${e.name}: card ${def.base.name} is in the ${def.pool} pool, not ${e.classId}`, id);
      const other = owner.get(card);
      if (other) add('error', 'engines', `${def?.base.name ?? card} is a card of both ${d.engines[other].name} and ${e.name}`, id);
      else owner.set(card, id);
    }
  }
  for (const [id, c] of Object.entries(d.classes)) {
    const n = enginesIn(d, id).length;
    if (n !== ENGINES_PER_CLASS) add('error', 'classes', `${c.name} has ${n} build engine${n === 1 ? '' : 's'}, not ${ENGINES_PER_CLASS}`, id);
  }

  // ---- statuses
  for (const [id, by] of statusUsage(d)) {
    if (!Object.hasOwn(d.statuses, id)) add('error', 'statuses', `Status "${id}" is applied by ${by[0]} but is not in STATUSES`, id);
    else if (!by.length) add('warn', 'statuses', `${d.statuses[id].name} is never applied by any skill, monster, item or element`, id);
  }

  // ---- events
  const seen = new Set<string>();
  for (const e of d.events) {
    if (seen.has(e.id)) add('error', 'events', `Duplicate event id "${e.id}"`, e.id);
    seen.add(e.id);
    for (const a of e.acts ?? []) {
      if (!Number.isInteger(a) || a < 1 || a > d.acts.length) add('error', 'events', `${e.title}: acts lists ${a}, but there are acts 1-${d.acts.length}`, e.id);
    }
    if (!e.choices.length) add('error', 'events', `${e.title}: no choices`, e.id);
  }

  // ---- coverage goals (info)
  for (const c of coverage(d)) {
    const left = c.goal - c.have;
    add('info', c.pool, `${c.label}: ${c.have} of ~${c.goal}${left > 0 ? ` (${left} to go)` : ''}${c.note ? `. ${c.note}` : ''}`);
  }
  for (const [id, c] of Object.entries(d.classes)) {
    const n = poolCounts(d, id);
    add('info', 'skills', `${c.name} pool: ${n.cantrip} cantrips, ${n.spell} spells, ${n.passive} passives, ${n.engine} of its cards in an engine (a hero holds ${MAX_CANTRIPS} cantrips, ${MAX_SPELLS} spells and ${passiveSlots(1)}-${passiveSlots(8)} passives)`, id);
    const loose = looseCards(d, id);
    if (loose.length) add('info', 'engines', `${c.name}: ${loose.length} class card${loose.length === 1 ? ' is' : 's are'} in no engine (some are general on purpose): ${loose.map((s) => d.skills[s].base.name).join(', ')}`, id);
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
