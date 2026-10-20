// Overview: counts per pool, coverage goals, the pool checks and the key numbers (difficulty, party scaling, XP, budgets).

import { ENGINE_IDS } from '../../../shared/engines.ts';
import { GEAR_IDS, CONSUMABLE_IDS, BLESSING_IDS, RELIC_IDS } from '../../../shared/items.ts';
import { ALLY_IDS, TRAIT_IDS } from '../../../shared/elites.ts';
import {
  ACT_ROWS, ACT_SCALING, ACTS, AMBUSH_CHANCE, BOON_HP, BOSS, BREATH_DC, BREATHER, ELITE, MAX_DOWNS, SOLO_HP_SCALING, WARMUP_BUDGET, CLASS_IDS, COWARD_HP, COWARD_TURNS, DIFFICULTIES, DIFFICULTY_IDS, LEVEL_CAP, MAP_COLS,
  MAX_ACT, MAX_BONUS_AC, MAX_CANTRIPS, MAX_PLAYERS, MAX_SPELLS, MIN_PARTY, MONSTERS, PARTY_SCALING, REST_HEAL, REST_MS, STEAL_SHARE,
  STEALTH_DC_BASE, TIER3_LEVEL, VOTE_MS, XP_ASSIST, XP_BUFF, XP_CATCH_UP, XP_HEAL, XP_KILL, XP_REVIVE, XP_SHARED, encounterBudget, packsFor,
  partyScaling, passiveSlots, profBonus, roomGold, scaledHp, xpToNext,
} from '../../../shared/rules.ts';
import { SKILL_IDS, SKILLS, STATUSES } from '../../../shared/skills.ts';
import { CLOUDS, GROUNDS, PROPS } from '../../../shared/surfaces.ts';
import { EVENTS } from '../../../server/events.ts';
import { checks, coverage, engineCards, POOLS, type Check } from '../checks.ts';
import { ALLY_MONSTERS, DATA } from '../model.ts';
import { srcConst, srcTag } from '../sources.ts';
import { chip, esc, fmtNum, group, kv, link, plural, q, td, th, wrapTable, type TabDef } from '../ui.ts';

/** Which tab an entry id of a check's pool opens (the entries carry data-id), if any. */
function idLink(c: Check): string {
  if (!c.id) return '';
  const tab: Record<string, string> = { acts: 'monsters', encounters: 'monsters', monsters: 'monsters', allies: 'elites', classes: 'heroes', engines: 'heroes', skills: 'skills', items: 'items', statuses: 'rules', events: 'events' };
  const to = c.pool === 'sprites' ? (Object.hasOwn(MONSTERS, c.id) ? 'monsters' : 'heroes') : tab[c.pool];
  const id = c.pool === 'engines' ? DATA.engines[c.id]?.classId ?? c.id : c.id; // an engine lives on its class's card
  return to ? link(`${to}?id=${id}`, `<code>${esc(c.id)}</code>`) : `<code>${esc(c.id)}</code>`;
}

function counts(): string {
  const kinds = (k: string) => SKILL_IDS.filter((id) => SKILLS[id].kind === k).length;
  const npc = ALLY_IDS.length;
  const cards: [number, string, string, string][] = [
    [CLASS_IDS.length, 'Classes', 'heroes', ''],
    [ENGINE_IDS.length, 'Engines', 'heroes', `${ENGINE_IDS.length / CLASS_IDS.length} per class · ${ENGINE_IDS.reduce((n, id) => n + engineCards(DATA.engines[id]).length, 0)} cards`],
    [SKILL_IDS.length, 'Skills', 'skills', `${kinds('cantrip')} cantrips · ${kinds('spell')} spells · ${kinds('passive')} passives · ${kinds('item')} consumables`],
    [GEAR_IDS.length, 'Gear', 'items', 'weapons, armor, trinkets'],
    [CONSUMABLE_IDS.length, 'Consumables', 'items', ''],
    [RELIC_IDS.length, 'Relics', 'items', ''],
    [BLESSING_IDS.length, 'Blessings', 'items', ''],
    [Object.keys(MONSTERS).length - ALLY_MONSTERS.size, 'Monsters', 'monsters', `+ ${ALLY_MONSTERS.size} NPC ally stat blocks`],
    [ACTS.reduce((n, a) => n + a.encounters.length, 0), 'Encounter templates', 'acts', `${ACTS.length} acts`],
    [TRAIT_IDS.length, 'Elite traits', 'elites', ''],
    [npc, 'NPC allies', 'elites', ''],
    [Object.keys(STATUSES).length, 'Statuses', 'rules', ''],
    [Object.keys(GROUNDS).length + Object.keys(CLOUDS).length + Object.keys(PROPS).length, 'Surfaces', 'rules', 'grounds, clouds, props'],
    [EVENTS.length, 'Events', 'events', ''],
  ];
  return `<div class="counts">${cards.map(([n, label, tab, sub]) => `<a class="count" href="#${tab}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</a>`).join('')}</div>`;
}

function coverageBars(): string {
  return `<div class="cov">${coverage(DATA).map((c) => {
    const pct = Math.min(100, Math.round((c.have / c.goal) * 100));
    return `<div class="cov-row"><span>${esc(c.label)}</span><div class="bar"><i class="${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></i></div><b>${c.have} / ${c.goal}</b><span class="muted">${c.note ? esc(c.note) : ''}</span></div>`;
  }).join('')}</div>`;
}

function checkList(list: Check[]): string {
  const rows = (level: Check['level']) =>
    list
      .filter((c) => c.level === level)
      .map((c) => `<li class="chk ${level}" data-q="${q(level, c.pool, c.id, c.text)}" data-level="${level}" data-pool="${c.pool}">${chip(c.pool, 'pool')}<span>${esc(c.text)}</span>${idLink(c)}</li>`)
      .join('');
  const n = (level: Check['level']) => list.filter((c) => c.level === level).length;
  const part = (level: Check['level'], title: string, note = '') => (n(level) ? group(`${title} <small>${n(level)}</small>`, `<ul class="checks">${rows(level)}</ul>`, note) : '');
  return `${n('error') ? '' : '<p class="banner ok">No broken references: every id used by an act, class, skill, item or event exists.</p>'}
    ${part('error', 'Errors', 'Broken references. These would crash or corrupt a run.')}
    ${part('warn', 'Warnings', 'Content that goes unused or is missing art.')}
    ${part('info', 'Info', 'The coverage goals and the skill pool sizes, as checks.')}`;
}

const difficulties = () =>
  wrapTable(
    [th('Difficulty'), th('Monster HP'), th('Attack'), th('Damage'), th('Budget'), th('Squad AI'), th('Slip'), th('Description'), th('Source')].join(''),
    DIFFICULTY_IDS.map((id) => {
      const d = DIFFICULTIES[id];
      const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
      return `<tr>${td(`${d.icon} <b>${d.name}</b>`)}${td(`×${d.hp}`)}${td(sign(d.atk))}${td(`×${d.dmg}`)}${td(`×${d.budget}`)}${td(d.squad ? 'yes' : 'no')}${td(`${Math.round(d.slip * 100)}%`)}${td(esc(d.desc), undefined, 'wide')}${td(srcTag('difficulty', id))}</tr>`;
    }).join(''),
  );

function partyTable(): string {
  const sizes = Array.from({ length: MAX_PLAYERS - MIN_PARTY + 1 }, (_, i) => MIN_PARTY + i);
  const row = (label: string, f: (n: number) => string | number) => `<tr><th>${label}</th>${sizes.map((n) => td(f(n))).join('')}</tr>`;
  return `<div class="table-wrap"><table class="kv"><thead><tr><th>Party of</th>${sizes.map((n) => `<th>${n}</th>`).join('')}</tr></thead><tbody>
    ${row('Encounter budget', (n) => `×${fmtNum(partyScaling(n).count)}`)}
    ${row('Monster max HP', (n) => `×${fmtNum(partyScaling(n).hp)}`)}
    ${row('Monster damage', (n) => `×${fmtNum(partyScaling(n).dmg)}`)}
    ${row('Packs (squad AI)', packsFor)}
    ${row('Elite HP (per 100 base)', (n) => scaledHp(100, n, false))}
    ${row('Boss HP (per 100 base)', (n) => scaledHp(100, n, true))}
  </tbody></table></div>
  <p class="muted note">Per hero past ${MIN_PARTY}: +${fmtNum(PARTY_SCALING.count * 100)}% encounter budget, +${fmtNum(PARTY_SCALING.hp * 100)}% HP, +${fmtNum(PARTY_SCALING.dmg * 100)}% damage (${srcConst('PARTY_SCALING')}). Elites and bosses use scaledHp instead: ×${fmtNum(SOLO_HP_SCALING.elite)} (elites) or ×${fmtNum(SOLO_HP_SCALING.boss)} (bosses) against ${MIN_PARTY} heroes, +${fmtNum(SOLO_HP_SCALING.perHero)} per hero past that (${srcConst('SOLO_HP_SCALING')}).</p>`;
}

/** ACT_SCALING, BOSS and ELITE (Phase 13): how every monster grows with the act, on top of its stat block. */
function actTable(): string {
  const body = ACT_SCALING.map((a, i) =>
    `<tr>${td(`${ACTS[i]?.glyph ?? ''} Act ${i + 1}`)}${td(`×${fmtNum(a.hp)}`)}${td(`×${fmtNum(a.solo)}`)}${td(a.ac ? `+${a.ac}` : '—')}${td(a.atk ? `+${a.atk}` : '—')}${td(`×${fmtNum(a.dmg)}`)}</tr>`,
  ).join('');
  return `${wrapTable([th('Act'), th('Monster HP'), th('Elite and boss HP'), th('AC'), th('Attack'), th('Damage')].join(''), body)}
    <p class="muted note">On top of every stat block (${srcConst('ACT_SCALING')}), so the monsters keep up with heroes who pick a card after every fight. Damage is a multiplier on the average hit, added as a flat bonus per hit. Bosses hit ×${fmtNum(BOSS.dmg)} harder and bring ${fmtNum(BOSS.minions)} minion per hero (${srcConst('BOSS')}); elites hit ×${fmtNum(ELITE.dmg)} (${srcConst('ELITE')}). The run's first fight is a warm-up: ×${fmtNum(WARMUP_BUDGET)} budget, from the classic line (${srcConst('WARMUP_BUDGET')}).</p>`;
}

function budgetTable(): string {
  const sizes = Array.from({ length: MAX_PLAYERS - MIN_PARTY + 1 }, (_, i) => MIN_PARTY + i);
  const rows = [0, 3, 6, 9, ACT_ROWS - 1];
  const body = ACTS.map((act, i) => rows.map((r, j) => `<tr>${j === 0 ? `<th rowspan="${rows.length}">${act.glyph} Act ${i + 1}</th>` : ''}${td(`row ${r}`)}${sizes.map((n) => td(fmtNum(Math.round(encounterBudget(i + 1, r, n) * 10) / 10))).join('')}</tr>`).join('')).join('');
  return `${wrapTable(`<th>Act</th><th>Map row</th>${sizes.map((n) => `<th>${n} heroes</th>`).join('')}`, body, 'budget')}
    <p class="muted note">Threat budget of a regular fight (${srcConst('encounterBudget')}), before the difficulty's budget multiplier. A monster's cost is its threat (Monsters tab); a room holds 6 monsters at most.</p>`;
}

function levelTable(): string {
  let total = 0;
  const rows = Array.from({ length: LEVEL_CAP }, (_, i) => {
    const lv = i + 1;
    const next = lv < LEVEL_CAP ? xpToNext(lv) : 0;
    const row = `<tr>${td(`Lv ${lv}`)}${td(next || '—')}${td(total)}${td(`+${profBonus(lv)}`)}${td(passiveSlots(lv))}${td(lv >= TIER3_LEVEL ? 'yes' : '—')}</tr>`;
    total += next;
    return row;
  }).join('');
  return wrapTable([th('Level'), th('XP to next'), th('Total XP'), th('Proficiency'), th('Passive slots'), th('Tier III')].join(''), rows);
}

function constants(): string {
  const c = (name: string, v: string | number, f?: Parameters<typeof srcConst>[1]): [string, string | number, string] => [name, v, srcConst(name, f)];
  return kv([
    c('MAX_PLAYERS', MAX_PLAYERS), c('MIN_PARTY', MIN_PARTY), c('MAX_ACT', MAX_ACT), c('ACT_ROWS', ACT_ROWS), c('MAP_COLS', MAP_COLS), c('VOTE_MS', `${VOTE_MS / 1000}s`),
    c('LEVEL_CAP', LEVEL_CAP), c('TIER3_LEVEL', TIER3_LEVEL), c('MAX_CANTRIPS', MAX_CANTRIPS), c('MAX_SPELLS', MAX_SPELLS),
    c('XP_SHARED', XP_SHARED), c('XP_KILL', XP_KILL), c('XP_ASSIST', XP_ASSIST), c('XP_HEAL', XP_HEAL), c('XP_REVIVE', XP_REVIVE), c('XP_BUFF', XP_BUFF),
    c('XP_CATCH_UP', XP_CATCH_UP), c('STEAL_SHARE', STEAL_SHARE),
    c('REST_HEAL', REST_HEAL), ['BREATHER.heal (after every won fight)', BREATHER.heal, srcConst('BREATHER')], c('REST_MS', `${REST_MS / 1000}s`), c('BOON_HP', BOON_HP), c('MAX_BONUS_AC', MAX_BONUS_AC),
    ['MAX_DOWNS (worn down: the 4th fall in one fight is death)', MAX_DOWNS, srcConst('MAX_DOWNS')],
    c('STEALTH_DC_BASE', STEALTH_DC_BASE), c('AMBUSH_CHANCE', AMBUSH_CHANCE), c('BREATH_DC', BREATH_DC), c('COWARD_HP', COWARD_HP), c('COWARD_TURNS', COWARD_TURNS),
  ]);
}

const goldTable = () =>
  wrapTable(
    [th('Act'), th('Combat'), th('Elite'), th('Boss')].join(''),
    ACTS.map((_, i) => `<tr>${td(`Act ${i + 1}`)}${td(roomGold(i + 1, 'combat'))}${td(roomGold(i + 1, 'elite'))}${td(roomGold(i + 1, 'boss'))}</tr>`).join(''),
  );

export const overview: TabDef = {
  id: 'overview',
  label: 'Overview',
  filters: [
    { key: 'level', label: 'Level', options: [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Coverage']] },
    { key: 'pool', label: 'Pool', options: POOLS.map((p): [string, string] => [p, p]) },
  ],
  render() {
    const list = checks(DATA);
    const sum = `${plural(list.filter((c) => c.level === 'error').length, 'error')}, ${plural(list.filter((c) => c.level === 'warn').length, 'warning')}`;
    return `
      <p class="lead">Every pool in the game, read straight from the code (this page imports the same modules the game does, so it can't drift). It is read-only: edit the files named by the small tags, then reload. <b>Pool checks:</b> ${sum}.</p>
      ${group('Pools', counts())}
      ${group('Coverage goals', coverageBars(), 'Targets from PLAN.md Phase 12.')}
      ${checkList(list)}
      ${group('Difficulties', difficulties(), 'Tuned in the balance pass (Phase 13) with bot runs; see PLAN.md for the win rates.')}
      ${group('Monsters by act', actTable())}
      ${group('Party scaling', partyTable())}
      ${group('Encounter budget', budgetTable())}
      ${group('Levels', levelTable())}
      ${group('Gold for clearing a room', goldTable())}
      ${group('Constants', constants())}`;
  },
};
