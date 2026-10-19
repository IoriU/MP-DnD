// Pool checks: broken references (errors), content that goes unused (warnings) and coverage goals (info).
// Pure functions of the data, so they run under Node (tests/codex.test.ts) as well as in the codex page.

import { MAX_CANTRIPS, MAX_SPELLS, passiveSlots } from '../../shared/rules.ts';
import { liveData, monsterUsage, statusUsage, usedAsFoe, type CodexData } from './data.ts';

export type Level = 'error' | 'warn' | 'info';

export interface Check {
  level: Level;
  pool: string; // which content pool it is about (one of POOLS)
  id?: string; // the entry it is about, when there is one
  text: string;
}

export const POOLS = ['acts', 'encounters', 'monsters', 'allies', 'classes', 'subclasses', 'skills', 'items', 'statuses', 'events', 'sprites'];

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

/** The skills in a class's pool, by kind (`sub`: the subclass-only skills of that class, which are not in the pool counts). */
export function poolCounts(d: CodexData, pool: string) {
  const all = Object.values(d.skills).filter((s) => s.pool === pool);
  const defs = all.filter((s) => !s.sub);
  const n = (kind: string) => defs.filter((s) => s.kind === kind).length;
  return { cantrip: n('cantrip'), spell: n('spell'), passive: n('passive'), basic: n('basic'), sub: all.length - defs.length };
}

/** Skills a subclass adds to its class (its signature is one of them). */
export const subclassSkills = (d: CodexData, sub: string): string[] => Object.keys(d.skills).filter((id) => d.skills[id].sub === sub);

/** Fewest skills a subclass should have (its signature and two more). */
export const MIN_SUBCLASS_SKILLS = 3;

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
    if (def.sub) {
      const sc = d.subclasses[def.sub];
      if (!Object.hasOwn(d.subclasses, def.sub)) add('error', 'skills', `${def.base.name}: sub "${def.sub}" is not a subclass`, id);
      else if (sc.classId !== def.pool) add('error', 'skills', `${def.base.name}: it is in the ${def.pool} pool, but ${sc.name} is a ${sc.classId} subclass`, id);
    }
  }
  for (const [id, it] of Object.entries(d.items)) {
    if (it.kind === 'consumable' && !d.skills[id]) add('error', 'items', `Consumable "${id}" has no skill of the same id (its rules)`, id);
  }

  // ---- subclasses
  for (const [id, sc] of Object.entries(d.subclasses)) {
    if (!Object.hasOwn(d.classes, sc.classId)) add('error', 'subclasses', `${sc.name}: class "${sc.classId}" does not exist`, id);
    const sig = Object.hasOwn(d.skills, sc.signature) ? d.skills[sc.signature] : undefined;
    if (!sig) add('error', 'subclasses', `${sc.name}: signature "${sc.signature}" is not in SKILLS`, id);
    else if (sig.pool !== sc.classId) add('error', 'subclasses', `${sc.name}: signature ${sig.base.name} is in the ${sig.pool} pool, not ${sc.classId}`, id);
    else if (sig.sub !== id) add('error', 'subclasses', `${sc.name}: signature ${sig.base.name} has sub ${sig.sub ? `"${sig.sub}"` : 'unset'}, not "${id}"`, id);
    const n = subclassSkills(d, id).length;
    if (n < MIN_SUBCLASS_SKILLS) add('warn', 'subclasses', `${sc.name} has ${n} skill${n === 1 ? '' : 's'}: a subclass wants at least ${MIN_SUBCLASS_SKILLS} (its signature and two more)`, id);
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
    add('info', 'skills', `${c.name} pool: ${n.cantrip} cantrips, ${n.spell} spells, ${n.passive} passives, plus ${n.sub} subclass skills (a hero holds ${MAX_CANTRIPS} cantrips, ${MAX_SPELLS} spells and ${passiveSlots(1)}-${passiveSlots(8)} passives)`, id);
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
