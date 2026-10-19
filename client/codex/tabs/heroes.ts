// Heroes: one card per class.

import { CLASSES, CLASS_IDS, MAX_CANTRIPS, MAX_SPELLS, maxHpFor, maxSlotsFor, passiveSlots, saveDc, type Stat } from '../../../shared/rules.ts';
import { SKILLS, type SkillId } from '../../../shared/skills.ts';
import { SUBCLASS_LEVEL } from '../../../shared/subclasses.ts';
import { CLASS_SPRITES } from '../../sprites.ts';
import { poolCounts, subclassSkills } from '../checks.ts';
import { DATA } from '../model.ts';
import { srcTag } from '../sources.ts';
import { chip, esc, icon, link, q, type TabDef } from '../ui.ts';

const STATS: Stat[] = ['str', 'dex', 'int', 'wis'];
const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
const LEVELS = [1, 4, 8, 12];

/** A skill as a chip that opens it in the Skills tab; the signature is outlined. */
const skillChip = (id: SkillId, signature = false) =>
  link(`skills?id=${id}`, `<span class="sk-chip${signature ? ' sig' : ''}">${SKILLS[id].base.icon} ${esc(SKILLS[id].base.name)}</span>`, signature ? 'Signature: learned with the subclass, takes no slot' : id);

/** The class's subclasses: what they are about, the signature skill, and the skills they add to level-up offers. */
function subclassBlock(classId: string): string {
  const subs = Object.entries(DATA.subclasses).filter(([, sc]) => sc.classId === classId);
  if (!subs.length) return '';
  const cards = subs
    .map(([sid, sc]) => {
      const more = subclassSkills(DATA, sid).filter((s) => s !== sc.signature) as SkillId[];
      return `<div class="sub-card">
        <div class="sub-head"><b>${sc.icon} ${esc(sc.name)}</b><code>${sid}</code>${srcTag('subclass', sid)}</div>
        <p class="blurb">${esc(sc.blurb)}</p>
        <div class="chips">${skillChip(sc.signature, true)}${more.map((s) => skillChip(s)).join('')}</div>
      </div>`;
    })
    .join('');
  return `<h3>Subclasses <small class="muted">pick one at Lv ${SUBCLASS_LEVEL}</small></h3><div class="sub-list">${cards}</div>`;
}

function card(id: (typeof CLASS_IDS)[number]): string {
  const c = CLASSES[id];
  const sheet = CLASS_SPRITES[id];
  const n = poolCounts(DATA, id);
  const start = c.start.map((s: SkillId) => link(`skills?id=${s}`, `<span class="sk-chip">${SKILLS[s].base.icon} ${esc(SKILLS[s].base.name)}</span>`, s)).join('');
  const mods = STATS.map((s) => `<span class="mod${s === c.stat ? ' main' : ''}" title="${s === c.stat ? 'casting stat' : ''}"><small>${s.toUpperCase()}</small><b>${sign(c.mods[s])}</b></span>`).join('');
  const growth = LEVELS.map((lv) => `<tr><td>Lv ${lv}</td><td>${maxHpFor(id, lv)}</td><td>${maxSlotsFor(id, lv)}</td><td>${saveDc(id, lv)}</td></tr>`).join('');
  return `<article class="card hero" data-id="${id}" data-q="${q(c.name, id, c.blurb, c.stat, Object.values(c.names).join(' '), c.start.join(' '), ...Object.values(DATA.subclasses).filter((sc) => sc.classId === id).map((sc) => `${sc.name} ${sc.blurb}`))}">
    <header class="hero-head">
      ${icon(sheet ? { sheet, frame: 0 } : undefined, c.glyph, 56)}
      <div><h2>${c.glyph} ${esc(c.name)}</h2><code>${id}</code></div>
      ${srcTag('class', id)}
    </header>
    <p class="blurb">${esc(c.blurb)}</p>
    <div class="statline"><span><small>HP</small><b>${c.hp}</b><i>+${c.hpPerLevel}/level</i></span><span><small>AC</small><b>${c.ac}</b></span><span><small>Speed</small><b>${c.speed}</b></span><span><small>${esc(c.names.slots)}</small><b>${c.slots}</b><i>+1 every 2 levels</i></span></div>
    <div class="mods">${mods}</div>
    <p class="muted note">Casting stat: <b>${c.stat.toUpperCase()}</b> (cantrip and spell attacks, save DCs, heals). Mods also set attacks, saves, initiative (DEX) and event checks.</p>
    <h3>Flavor names</h3>
    <p>Cantrips are <b>${esc(c.names.cantrip)}</b>, spells are <b>${esc(c.names.spell)}</b>, slots are <b>${esc(c.names.slots)}</b>.</p>
    <h3>Starting skills</h3>
    <div class="chips">${start}</div>
    <h3>Skill pool</h3>
    <p>${link(`skills?pool=${id}`, `${n.cantrip} cantrips · ${n.spell} spells · ${n.passive} passives${n.basic ? ` · ${n.basic} basic` : ''}`)}${n.sub ? ` <span class="muted">+ ${n.sub} subclass skills</span>` : ''} ${chip(`holds ${MAX_CANTRIPS} / ${MAX_SPELLS} / ${passiveSlots(1)}-${passiveSlots(8)}`, 'dim', 'cantrips, spells, passives a hero can hold at once')}</p>
    ${subclassBlock(id)}
    <h3>Growth</h3>
    <div class="table-wrap"><table class="kv"><thead><tr><th></th><th>Max HP</th><th>Slots</th><th>Save DC</th></tr></thead><tbody>${growth}</tbody></table></div>
  </article>`;
}

export const heroes: TabDef = {
  id: 'heroes',
  label: 'Heroes',
  render: () => `<div class="grid cards">${CLASS_IDS.map(card).join('')}</div>`,
};
