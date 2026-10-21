// Monsters: a sortable table of every stat block, with where each one appears (acts, encounters, elites, bosses, allies, events).

import { ACTS, BOSS_SIGNATURES, BREATH_DC, HARD_MOVES, HELP, MONSTERS, RESIST_WORD, ROLES, canHelp, diceText, roleOf, type MonsterDef, type Stat } from '../../../shared/rules.ts';
import { STATUSES } from '../../../shared/skills.ts';
import { MONSTER_SPRITES } from '../../sprites.ts';
import { usageActs, type Usage } from '../data.ts';
import { ALLY_MONSTERS, DATA, USAGE } from '../model.ts';
import { srcTag } from '../sources.ts';
import { chip, esc, icon, q, statusText, td, th, wrapTable, type TabDef } from '../ui.ts';

const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
const avg = (m: MonsterDef) => (m.dmg.n * (m.dmg.d + 1)) / 2 + (m.dmg.bonus ?? 0);
const eventTitle = (id: string) => DATA.events.find((e) => e.id === id)?.title ?? id;

/** Breath, shove, support spells and what it leaves behind when it dies. */
function specials(id: string, m: MonsterDef): string[] {
  const out: string[] = [];
  if (ALLY_MONSTERS.has(id)) out.push(chip('NPC ally', 'good', 'Fights for the party (shared/elites.ts)'));
  if (m.breath) out.push(chip('🐲 Breath', 'warn', `Fire breath every 3rd round (DEX save DC ${BREATH_DC})`));
  if (m.signature) out.push(chip(`${BOSS_SIGNATURES[m.signature].icon} ${BOSS_SIGNATURES[m.signature].name}`, 'warn', `${BOSS_SIGNATURES[m.signature].desc} When it falls, the rest flee.`));
  if (m.shove) out.push(chip('✋ Shoves', '', 'Shoves heroes into hazards when it can (STR contest)'));
  if (m.support) {
    const b = m.support.buff;
    out.push(chip(`✨ Heals ${diceText(m.support.heal)}`, 'good', 'Mends a hurt friend at its attack range'));
    out.push(chip(`${STATUSES[b.id].icon} Buffs ${STATUSES[b.id].name} ${b.turns}t${b.power ? ` +${b.power}` : ''}`, 'good', 'Or buffs one'));
  }
  if (m.death) out.push(chip(`💥 ${esc(m.death.text)}`, 'dim', `Leaves ${[m.death.ground, m.death.cloud].filter(Boolean).join(' and ')} within ${m.death.radius}`));
  const hard = HARD_MOVES[id];
  if (hard) out.push(chip(`💀 Hard: ${esc(hard.move)}`, 'bad', 'On Hard it spawns with this extra move (shared/rules.ts HARD_MOVES)'));
  return out;
}

const SAVE: Record<Stat, string> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

/** Phase 12 abilities: its trick, what its hits do (rider), leader orders, and the help action every melee monster has. */
function tricks(m: MonsterDef): string[] {
  const out: string[] = [];
  if (m.leader) out.push(chip('📯 Leader', 'warn', 'Gives its side orders (Elites & allies tab)'));
  if (m.fly) out.push(chip('🪽 Flies', 'warn', "Crosses pits and never steps in the ground; can't be pushed into a pit, but knocked down over one it falls"));
  if (m.block) out.push(chip(`🧱 Block ${m.block}`, 'good', 'A shield: this much Block at the start of each of its turns'));
  const t = m.trick;
  if (t) {
    const how = t.save ? `${SAVE[t.save]} save DC ${t.dc}` : 'attack roll';
    out.push(`<div class="wh"><b>${t.icon} ${esc(t.name)}</b> (range ${t.range}, ${how}) → ${t.status.map(statusText).join(', ')}, ${t.cooldown >= 99 ? 'once a fight' : `cooldown ${t.cooldown} turns`}</div>`);
  }
  const r = m.rider;
  if (r) out.push(`<div class="wh"><b>rider:</b> ${statusText(r.status)} (${r.save ? `${SAVE[r.save]} DC ${r.dc}` : 'always'}) <span class="muted">${esc(r.text.replace('{target}', 'the target'))}</span></div>`);
  if (canHelp(m)) out.push(chip(`👉 Help`, 'dim', `Instead of attacking, gets in a hero's face: the next attack against them has advantage (${HELP.id})`));
  return out;
}

/** What a monster has, for the Ability filter. */
const hasTokens = (m: MonsterDef) =>
  [m.trick && 'trick', m.rider && 'rider', m.leader && 'leader', m.block && 'block', m.breath && 'breath', m.shove && 'shove', m.support && 'support', m.death && 'death', canHelp(m) && 'help'].filter(Boolean).join(' ');

/** The "where it appears" cell: one line per act, then NPC ally and event lines. */
function where(u: Usage): string {
  const lines = usageActs(u).map((n) => {
    const parts: string[] = [];
    if (u.pool.includes(n)) parts.push('pool');
    const enc = u.encounters.filter((e) => e.act === n);
    if (enc.length) parts.push(`encounters: ${enc.map((e) => esc(e.name) + (e.count > 1 ? ` ×${e.count}` : '')).join(', ')}`);
    if (u.elite.includes(n)) parts.push('<b>elite</b>');
    for (const e of u.escort.filter((x) => x.act === n)) parts.push(`escort of ${esc(MONSTERS[e.elite]?.name ?? e.elite)}`);
    if (u.boss.includes(n)) parts.push('<b>boss</b>');
    if (u.minion.includes(n)) parts.push(`minion of ${esc(MONSTERS[ACTS[n - 1].boss]?.name ?? 'the boss')}`);
    return `<div class="wh"><b>${ACTS[n - 1].glyph} Act ${n}</b> ${parts.join(' · ')}</div>`;
  });
  if (u.ally.length) lines.push(`<div class="wh"><b>NPC ally</b> ${u.ally.join(', ')}</div>`);
  const named = u.events.filter((e) => !e.pool).map((e) => esc(eventTitle(e.id)));
  const pooled = u.events.filter((e) => e.pool).map((e) => esc(eventTitle(e.id)));
  if (named.length) lines.push(`<div class="wh"><b>Events</b> ${named.join(', ')}</div>`);
  if (pooled.length) lines.push(`<div class="wh muted"><b>Events (act pool)</b> ${pooled.join(', ')}</div>`);
  return lines.join('') || '<span class="bad-text">nowhere</span>';
}

function row(id: string): string {
  const m = MONSTERS[id];
  const u = USAGE[id];
  const role = roleOf(m);
  const acts = usageActs(u).map(String);
  if (u.ally.length) acts.push('ally');
  if (!acts.length && !u.events.length) acts.push('none');
  const resist = Object.entries(m.resist ?? {}).map(([el, r]) => chip(`${RESIST_WORD[r]} ${el}`, `res-${r}`));
  const spec = specials(id, m);
  const abil = tricks(m);
  const text = `${m.name} ${id} ${role} ${m.element ?? 'physical'} ${resist.map((r) => r.replace(/<[^>]+>/g, '')).join(' ')} ${spec.map((s) => s.replace(/<[^>]+>/g, '')).join(' ')} ${abil.map((s) => s.replace(/<[^>]+>/g, '')).join(' ')} ${u.encounters.map((e) => e.name).join(' ')} ${u.events.map((e) => eventTitle(e.id)).join(' ')}`;
  return `<tr data-id="${id}" data-act="${acts.join(' ')}" data-role="${role}" data-has="${hasTokens(m)}" data-q="${q(text)}">
    ${td(`<span class="mon-ic">${icon(MONSTER_SPRITES[id], m.glyph, 32)}<span class="glyph">${m.glyph}</span></span>`)}
    ${td(`<b>${esc(m.name)}</b>`, m.name)}${td(`<code>${id}</code>`)}
    ${td(m.hp, m.hp)}${td(m.ac, m.ac)}${td(m.speed, m.speed)}${td(sign(m.atk), m.atk)}${td(diceText(m.dmg), avg(m))}${td(`×${m.attacks}`, m.attacks)}${td(m.range === 1 ? 'melee' : m.range, m.range)}
    ${td(`<span title="${esc(ROLES[role].desc)}">${ROLES[role].icon} ${ROLES[role].name}</span>`, role)}
    ${td(m.element ?? 'physical', m.element ?? 'physical')}
    ${td(resist.join(' '), undefined, 'chips')}
    ${td(`<span title="DEX / STR / WIS saves">${sign(m.dex)}/${sign(m.str)}/${sign(m.wis)}</span>`)}
    ${td(m.threat, m.threat)}${td(m.xp, m.xp)}
    ${td(spec.join(' '), undefined, 'chips')}
    ${td(abil.join(''), undefined, 'where')}
    ${td(where(u), undefined, 'where')}
    ${td(srcTag('monster', id))}</tr>`;
}

export const monsters: TabDef = {
  id: 'monsters',
  label: 'Monsters',
  filters: [
    { key: 'act', label: 'Act', options: [...ACTS.map((a, i): [string, string] => [String(i + 1), `${a.glyph} Act ${i + 1}`]), ['ally', 'NPC allies'], ['none', 'Used nowhere']] },
    { key: 'role', label: 'Role', options: Object.entries(ROLES).map(([id, r]): [string, string] => [id, `${r.icon} ${r.name}`]) },
    { key: 'has', label: 'Ability', options: [['trick', 'Trick'], ['rider', 'Rider'], ['leader', 'Leader'], ['block', 'Block (shield)'], ['breath', 'Breath'], ['shove', 'Shoves'], ['support', 'Support spells'], ['death', 'Death effect'], ['help', 'Can help']] },
  ],
  render() {
    const head = [
      th(''), th('Name', 'str'), th('Id', 'str'), th('HP', 'num'), th('AC', 'num'), th('Speed', 'num'), th('Atk', 'num'), th('Damage', 'num'), th('Attacks', 'num'), th('Range', 'num'),
      th('Role', 'str'), th('Element', 'str'), th('Resistances'), th('Saves'), th('Threat', 'num'), th('XP', 'num'), th('Specials'), th('Tricks'), th('Where it appears'), th('Source'),
    ].join('');
    return `<p class="lead">Threat is the monster's cost against an encounter's budget; XP is shared out when it dies. Click a column to sort. Elites and bosses get their HP from scaledHp instead of the party-size scaling.</p>
      ${wrapTable(head, Object.keys(DATA.monsters).map(row).join(''), 'sortable monsters')}`;
  },
};
