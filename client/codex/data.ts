// What the codex reads: every content pool, imported straight from the game's own modules so it can never drift.
// Pure (no DOM, no ?raw), so the pool checks can run under Node. `liveData()` is the real game; tests pass their own.

import { EVENTS, type EventDef } from '../../server/events.ts';
import { ALLIES, type AllyDef } from '../../shared/elites.ts';
import { ITEMS, type ItemDef } from '../../shared/items.ts';
import { ACTS, CLASSES, HELP, MONSTERS, ORDER_STATUS, type ActDef, type ClassDef, type MonsterDef } from '../../shared/rules.ts';
import { SKILLS, STATUSES, type SkillDef, type StatusDef } from '../../shared/skills.ts';
import { SUBCLASSES, type SubclassDef } from '../../shared/subclasses.ts';
import { CLASS_SPRITES, MONSTER_SPRITES } from '../sprites.ts';

/** The monsters an event's fights can use, scanned from the event's source (see sources.ts eventFights). */
export interface EventFight {
  monsters: string[]; // named in the event's code
  pool: boolean; // also draws from the act's regular monsters
}

export interface CodexData {
  monsters: Record<string, MonsterDef>;
  acts: ActDef[];
  classes: Record<string, ClassDef>;
  subclasses: Record<string, SubclassDef>;
  skills: Record<string, SkillDef>;
  items: Record<string, ItemDef>;
  allies: Record<string, AllyDef>;
  statuses: Record<string, StatusDef>;
  events: EventDef[]; // priced for act 1
  monsterSprites: Record<string, unknown>;
  classSprites: Record<string, unknown>;
  eventFights: Record<string, EventFight>;
}

export const liveData = (eventFights: Record<string, EventFight> = {}): CodexData => ({
  monsters: MONSTERS,
  acts: ACTS,
  classes: CLASSES,
  subclasses: SUBCLASSES,
  skills: SKILLS,
  items: ITEMS,
  allies: ALLIES,
  statuses: STATUSES,
  events: EVENTS,
  monsterSprites: MONSTER_SPRITES,
  classSprites: CLASS_SPRITES,
  eventFights,
});

// ---------------------------------------------------------------- where a monster appears

export interface Usage {
  pool: number[]; // acts whose regular pool lists it
  encounters: { act: number; name: string; count: number }[];
  elite: number[];
  escort: { act: number; elite: string }[]; // joins this elite
  boss: number[];
  minion: number[]; // joins the act's boss
  ally: string[]; // NPC ally ids that use this stat block
  events: { id: string; pool: boolean }[]; // events whose fights can include it (pool: only by drawing from the act pool)
}

/** Everywhere each monster is used: act pools, encounter templates, elites, escorts, bosses, minions, NPC allies, event fights. */
export function monsterUsage(d: CodexData): Record<string, Usage> {
  const out: Record<string, Usage> = {};
  const of = (id: string): Usage => (out[id] ??= { pool: [], encounters: [], elite: [], escort: [], boss: [], minion: [], ally: [], events: [] });
  for (const id of Object.keys(d.monsters)) of(id);
  d.acts.forEach((act, i) => {
    const n = i + 1;
    for (const m of act.pool) of(m).pool.push(n);
    for (const e of act.encounters) for (const m of new Set(e.monsters)) of(m).encounters.push({ act: n, name: e.name, count: e.monsters.filter((x) => x === m).length });
    for (const m of act.elites) of(m).elite.push(n);
    for (const [elite, list] of Object.entries(act.escorts)) for (const m of list) of(m).escort.push({ act: n, elite });
    of(act.boss).boss.push(n);
    for (const m of act.minions) of(m).minion.push(n);
  });
  for (const [id, a] of Object.entries(d.allies)) of(a.monster).ally.push(id);
  for (const e of d.events) {
    const f = d.eventFights[e.id];
    if (!f) continue;
    for (const m of f.monsters) of(m).events.push({ id: e.id, pool: false });
    if (f.pool) {
      const acts = (e.acts ?? d.acts.map((_, i) => i + 1)).filter((n) => d.acts[n - 1]);
      for (const n of acts) for (const m of d.acts[n - 1].pool) if (!out[m].events.some((x) => x.id === e.id)) out[m].events.push({ id: e.id, pool: true });
    }
  }
  return out;
}

/** The acts a monster shows up in, in any role. */
export const usageActs = (u: Usage): number[] =>
  [...new Set([...u.pool, ...u.encounters.map((x) => x.act), ...u.elite, ...u.escort.map((x) => x.act), ...u.boss, ...u.minion])].sort();

/** Is it used by the act maps (as a regular foe, elite, escort, boss or minion) or by an event fight? */
export const usedAsFoe = (u: Usage): boolean => usageActs(u).length > 0 || u.events.length > 0;

// ---------------------------------------------------------------- where a status comes from

/** Statuses the engine applies without a skill saying so: the battlefield, the elements and the ambush rules. */
const ENGINE_STATUSES: Record<string, string> = {
  burning: 'fire and burning ground',
  poisoned: 'poison ground and gas',
  stunned: 'lightning on a Wet creature',
  wet: 'water and steam',
  chilled: 'cold',
  frozen: 'cold on a Wet or Chilled creature',
  shocked: 'lightning',
  surprised: 'ambushes (game rules)',
  emboldened: 'Voice of Authority and Rousing Inspiration (subclass passives)',
};

/**
 * Status id -> who applies it: skills (any tier), monster support buffs, tricks and riders, the help action, leader orders,
 * weapons, and the engine (elements and ground).
 * Best effort: it reads the skill stats, not the server's code. Ids that aren't in `d.statuses` show up here too, so the checks can flag them.
 */
export function statusUsage(d: CodexData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (status: string, by: string) => {
    const list = out.get(status) ?? [];
    if (!list.includes(by)) list.push(by);
    out.set(status, list);
  };
  for (const id of Object.keys(d.statuses)) out.set(id, []);
  for (const def of Object.values(d.skills)) {
    for (const t of [def.base, def.t2, def.a, def.b]) {
      if (!t) continue;
      for (const x of [...(t.onHit ?? []), ...(t.status ?? []), ...(t.selfStatus ?? [])]) add(x.id, def.base.name);
      if (t.taunt) add('taunted', def.base.name);
    }
  }
  for (const m of Object.values(d.monsters)) {
    const by = `${m.name} (monster)`;
    if (m.support) add(m.support.buff.id, by);
    if (m.rider) add(m.rider.status.id, by);
    for (const x of m.trick?.status ?? []) add(x.id, by);
  }
  add(HELP.id, 'the help action (monsters and NPC allies)');
  for (const list of Object.values(ORDER_STATUS)) for (const x of list) add(x.id, 'leader orders');
  for (const it of Object.values(d.items)) if (it.kind === 'gear') for (const x of it.stats.onHit ?? []) add(x.id, `${it.name} (item)`);
  for (const [id, by] of Object.entries(ENGINE_STATUSES)) add(id, by);
  return out;
}
