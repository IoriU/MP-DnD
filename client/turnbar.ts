// The turn order across the top of the battlefield (playtest 1, 2026-10-21): a portrait for every creature in the order
// they act, starting with whoever is acting now (lit), and a line where the next round begins. Each has a little HP bar
// and its initiative. When a fight starts, the initiative dice tumble for a moment before they settle.

import { isAllyNpc, TRAITS } from '../shared/elites.ts';
import { BOSS_SIGNATURES, MONSTERS, baseType } from '../shared/rules.ts';
import { STATUSES, hasStatus } from '../shared/skills.ts';
import type { Entity, GameState } from '../shared/types.ts';
import { MONSTER_SPRITES, classIcon, iconHtml } from './sprites.ts';
import { actingNow, isAuto, store } from './store.ts';
import { $, esc } from './util.ts';

const ROLL_MS = 1500; // how long the dice tumble when a fight starts
const MAX_SHOWN = 14;

let rollUntil = 0;
let inFight = false;
let tumbler: number | null = null;
let lastKey = '';

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The bar's height in canvas pixels while it shows (the battlefield is fitted below it). */
export function turnBarHeight(): number {
  const bar = document.getElementById('turnbar');
  return bar && !bar.hidden ? bar.offsetHeight + 12 : 0;
}

function face(e: Entity): string {
  if (e.kind === 'player') return classIcon(e.classId, 28);
  return iconHtml(MONSTER_SPRITES[baseType(e.type)], e.glyph, 28);
}

function chipHtml(s: GameState, e: Entity, acting: Set<string>, rolling: boolean): string {
  const t = s.turn!;
  const ally = isAllyNpc(e);
  const side = e.kind === 'player' ? 'hero' : ally ? 'ally' : 'foe';
  const down = e.kind === 'player' ? e.dead || e.downed : e.hp <= 0;
  const lost = !!t.acts[e.id]?.lost;
  const mine = e.kind === 'player' && e.playerId === store.playerId;
  const hp = Math.max(0, Math.min(100, Math.round((e.hp / Math.max(1, e.maxHp)) * 100)));
  const surprised = hasStatus(e, 'surprised');
  const sig = e.kind === 'monster' ? MONSTERS[e.type]?.signature : undefined;
  const traits = e.kind === 'monster' ? (e.traits ?? []).map((tr) => TRAITS[tr]?.icon ?? '').join('') + (sig ? BOSS_SIGNATURES[sig].icon : '') : '';
  const auto = e.kind === 'player' && isAuto(s, e.playerId) ? ' 🤖 auto-play' : '';
  const tip = `${e.name}${traits ? ` ${traits}` : ''}${ally ? ' (NPC ally)' : ''}${mine ? ' (you)' : ''}${auto} · ${e.hp} / ${e.maxHp} HP · initiative ${t.init[e.id] ?? '?'}${
    surprised ? ` · ${STATUSES.surprised.icon} surprised: loses its first turn` : ''}${lost ? ' · loses this turn' : ''}${acting.has(e.id) ? ' · acting now' : ''}`;
  const cls = ['tb-chip', side, acting.has(e.id) ? 'now' : '', mine ? 'mine' : '', down ? 'down' : '', lost ? 'lost' : '', e.kind === 'monster' && (e.boss || e.elite) ? 'big' : ''].join(' ');
  return `<div class="${cls}" title="${esc(tip)}">
    <span class="tb-face">${face(e)}${surprised ? '<i class="tb-badge">😱</i>' : ''}</span>
    <span class="tb-hp"><i style="width:${hp}%"></i></span>
    <span class="tb-init" data-init="${t.init[e.id] ?? ''}">${rolling ? '🎲' : (t.init[e.id] ?? '')}</span>
  </div>`;
}

export function renderTurnBar(s: GameState) {
  const bar = $('#turnbar');
  const t = s.phase === 'combat' ? s.turn : null;
  if (!t) {
    bar.hidden = true;
    inFight = false;
    lastKey = '';
    return;
  }
  // A fight just started: roll for initiative.
  if (!inFight) {
    inFight = true;
    rollUntil = reducedMotion() ? 0 : Date.now() + ROLL_MS;
    if (rollUntil) startTumble();
  }
  const rolling = Date.now() < rollUntil;
  const acting = new Set(actingNow(s).map((e) => e.id));
  // Start from whoever acts now; the creatures before them in the order act next round.
  const first = Math.max(0, t.order.findIndex((id) => t.group.includes(id)));
  const ids = [...t.order.slice(first), ...t.order.slice(0, first)];
  const key = JSON.stringify([rolling, t.round, t.group, t.acts && Object.entries(t.acts).map(([id, a]) => [id, !!a.lost]), ids, ids.map((id) => {
    const e = s.entities.find((x) => x.id === id);
    return e ? [e.hp, e.maxHp, e.statuses.length, e.kind === 'player' ? [e.downed, e.dead] : 0] : 0;
  }), store.playerId]);
  bar.hidden = false;
  if (key === lastKey) return;
  lastKey = key;
  const chips: string[] = [];
  ids.slice(0, MAX_SHOWN).forEach((id, i) => {
    const e = s.entities.find((x) => x.id === id);
    if (!e) return;
    if (i === t.order.length - first && i > 0) chips.push(`<span class="tb-round" title="Round ${t.round + 1} starts here">R${t.round + 1}</span>`);
    chips.push(chipHtml(s, e, acting, rolling));
  });
  const more = ids.length > MAX_SHOWN ? `<span class="tb-more">+${ids.length - MAX_SHOWN}</span>` : '';
  bar.classList.toggle('rolling', rolling);
  bar.innerHTML = `<span class="tb-label">${rolling ? '🎲 Roll for initiative!' : `Round ${t.round}`}</span>${chips.join('')}${more}`;
}

/** The dice tumble: random numbers on every chip until ROLL_MS is over, then the real initiative settles in. */
function startTumble() {
  if (tumbler !== null) window.clearInterval(tumbler);
  tumbler = window.setInterval(() => {
    const bar = document.getElementById('turnbar');
    if (!bar || Date.now() >= rollUntil) {
      if (tumbler !== null) window.clearInterval(tumbler);
      tumbler = null;
      if (store.state) renderTurnBar(store.state); // settle: the real numbers, in order
      bar?.classList.add('settle');
      window.setTimeout(() => bar?.classList.remove('settle'), 500);
      return;
    }
    for (const el of bar.querySelectorAll<HTMLElement>('.tb-init')) el.textContent = String(1 + Math.floor(Math.random() * 20));
  }, 70);
}
