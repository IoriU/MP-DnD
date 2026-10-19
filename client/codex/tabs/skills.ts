// Skills: every skill and boon, filterable by pool and kind. Click one for every tier, with the generated rules text.

import { BOONS, CLASSES, CLASS_IDS } from '../../../shared/rules.ts';
import { SKILLS, SKILL_IDS, TIER_LABEL, describeSkill, statsAt, type SkillId, type SkillKind, type SkillStats } from '../../../shared/skills.ts';
import { SUBCLASSES, SUBCLASS_IDS, SUBCLASS_LEVEL } from '../../../shared/subclasses.ts';
import { ITEM_SPRITES, type Sprite } from '../../sprites.ts';
import { srcTag } from '../sources.ts';
import { chip, esc, group, icon, q, type TabDef } from '../ui.ts';

const KINDS: SkillKind[] = ['basic', 'cantrip', 'spell', 'passive', 'action', 'item'];
const POOL_ORDER: string[] = [...CLASS_IDS, 'common'];
const subIndex = (id: SkillId) => { const sub = SKILLS[id].sub; return sub ? SUBCLASS_IDS.indexOf(sub) : -1; }; // class skills first, then each subclass's

/** Range and target in a few words. */
function reach(s: SkillStats): string {
  switch (s.target) {
    case 'self': return 'self';
    case 'around': return `around you, r${s.radius ?? 1}`;
    case 'allies': return `allies within ${s.radius ?? 1}`;
    case 'enemy': return `${s.range <= 1 ? 'melee' : `range ${s.range}`} · enemy`;
    case 'ally': return `${s.range <= 1 ? 'adjacent' : `range ${s.range}`} · ally`;
    case 'area': return `range ${s.range} · area r${s.radius ?? 1}`;
  }
}

/** Every tier a skill has: I, then II, then the III branches (a skill without a tier II can't be upgraded). */
function tiers(id: SkillId): string {
  const def = SKILLS[id];
  const list: { label: string; name: string; text: string; raw: SkillStats }[] = [];
  const add = (tier: 1 | 2 | 3, branch: 'A' | 'B' | undefined, name: string) =>
    list.push({ label: tier === 1 && !def.t2 ? '' : TIER_LABEL(tier, branch), name, text: describeSkill(id, tier, branch), raw: statsAt(id, tier, branch) });
  add(1, undefined, def.base.name);
  if (def.t2) add(2, undefined, def.base.name);
  if (def.t2 && def.a) add(3, 'A', def.a.name);
  if (def.t2 && def.b) add(3, 'B', def.b.name);
  return list
    .map((t) => `<div class="tier"><h4>${t.label ? `<span class="tier-label">${t.label}</span> ` : ''}${esc(t.name)}</h4><p class="desc">${esc(t.text)}</p>
      <details class="raw"><summary>raw stats</summary><pre>${esc(JSON.stringify(t.raw, null, 1))}</pre></details></div>`)
    .join('');
}

function row(id: SkillId): string {
  const def = SKILLS[id];
  const s = def.base;
  const passive = def.kind === 'passive';
  const sprite = def.kind === 'item' ? (ITEM_SPRITES as Record<string, Sprite | undefined>)[id] : undefined;
  const cd = def.kind === 'cantrip' ? `⏱ ${s.cooldown ?? 0}` : def.kind === 'spell' ? `🔮 ${s.slots ?? 1}` : '—';
  const starts = Object.values(CLASSES).filter((c) => (c.start as string[]).includes(id)).map((c) => chip(`starts: ${c.name}`, 'dim'));
  const sub = def.sub ? SUBCLASSES[def.sub] : undefined;
  const signature = sub && sub.signature === id ? [chip(`signature of ${esc(sub.name)}: learned with it, takes no slot`, 'sub')] : [];
  const short = describeSkill(id, 1).split('\n')[0];
  return `<details class="entry sk" data-id="${id}" data-pool="${def.pool}" data-kind="${def.kind}" data-sub="${def.sub ?? 'none'}" data-q="${q(s.name, id, def.kind, def.pool, sub?.name, def.a?.name, def.b?.name, short)}">
    <summary>
      <span class="sk-ic">${icon(sprite, s.icon, 28)}</span>
      <span class="sk-name"><b>${esc(s.name)}</b><code>${id}</code></span>
      <span class="sk-tags">${chip(def.kind, `kind-${def.kind}`)}${chip(def.pool, 'pool')}${sub ? chip(`${sub.icon} ${esc(sub.name)}`, 'sub', `${sub.name} subclass skill`) : ''}</span>
      <span class="sk-cost" title="action points">${passive ? '—' : s.ap ? `${s.ap} AP` : 'Free'}</span>
      <span class="sk-cd" title="${def.kind === 'cantrip' ? 'cooldown (turns)' : def.kind === 'spell' ? 'slots' : ''}">${cd}</span>
      <span class="sk-rng">${passive ? '—' : esc(reach(s))}</span>
      <span class="sk-desc">${esc(short)}</span>
    </summary>
    <div class="entry-body">${tiers(id)}<div class="entry-foot">${starts.join('')}${signature.join('')}${srcTag('skill', id)}</div></div>
  </details>`;
}

export const skills: TabDef = {
  id: 'skills',
  label: 'Skills',
  filters: [
    { key: 'pool', label: 'Pool', options: [...CLASS_IDS.map((id): [string, string] => [id, CLASSES[id].name]), ['common', 'Common']] },
    { key: 'kind', label: 'Kind', options: [...KINDS.map((k): [string, string] => [k, k]), ['boon', 'boon']] },
    { key: 'sub', label: 'Subclass', options: [...SUBCLASS_IDS.map((id): [string, string] => [id, `${CLASSES[SUBCLASSES[id].classId].name}: ${SUBCLASSES[id].name}`]), ['none', 'none (class pool)']] },
  ],
  render() {
    const ids = [...SKILL_IDS].sort((a, b) => POOL_ORDER.indexOf(SKILLS[a].pool) - POOL_ORDER.indexOf(SKILLS[b].pool) || subIndex(a) - subIndex(b) || KINDS.indexOf(SKILLS[a].kind) - KINDS.indexOf(SKILLS[b].kind));
    const boons = Object.entries(BOONS)
      .map(([id, b]) => `<div class="entry flat" data-id="boon:${id}" data-pool="common" data-kind="boon" data-sub="none" data-q="${q(b.name, id, 'boon', b.desc)}"><div class="boon"><span class="sk-ic">${b.icon}</span><span class="sk-name"><b>${esc(b.name)}</b><code>${id}</code></span>${chip('boon', 'kind-boon')}<span class="sk-desc">${esc(b.desc)}</span>${srcTag('boon', id)}</div></div>`)
      .join('');
    return `<p class="lead">Level-up cards draw two from the hero's class pool and one from the common pool (passives and boons). The header shows tier I; open a skill for II and III-A / III-B.
        Skills with a subclass chip are only offered to heroes of that subclass (picked at Lv ${SUBCLASS_LEVEL}); its signature is learned on the spot and takes no slot.</p>
      <div class="list">${ids.map(row).join('')}</div>
      ${group('Boons', boons, 'Common-pool level-up cards that are not skills.')}`;
  },
};
