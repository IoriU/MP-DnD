// The sidebar: turn order, party, your skills, the dice log and chat.

import { isAllyNpc, isFoe, TRAITS } from '../shared/elites.ts';
import { BAG_SIZE, type ItemId } from '../shared/items.ts';
import { CLASSES, DIFFICULTIES, LEVEL_CAP, xpToNext } from '../shared/rules.ts';
import {
  canHitProps, describeSkill, hasStatus, hitsArea, hotbar, limitFor, countKind, ownedSkill, skillsOfKind, skillTitle, slotCost, statsOf,
  SKILLS, STATUSES, TIER_LABEL, type SkillId,
} from '../shared/skills.ts';
import { COMBOS, PROPS } from '../shared/surfaces.ts';
import type { GameState, LogLine, PlayerEntity, StatusInst, TurnState } from '../shared/types.ts';
import { alliesHtml, blessingsHtml, gearIconsHtml, itemIcon, relicsHtml, toggleInventory } from './inventory.ts';
import { toggleLevelUp } from './levelup.ts';
import { leave, send } from './net.ts';
import { onGraphicsMode, spritesOn, toggleSprites } from './sprites.ts';
import { aimAt, blockReason, currentEntity, huntedIds, inApproach, isAuto, isMyTurn, me, mySkillStats, refresh, select, store, validTarget } from './store.ts';
import { $, esc, toast } from './util.ts';

let lastLogId = -1;
let lastTurnKey = '';

/** Sets innerHTML only when it changed, so hover states and tooltips survive state updates. */
const lastHtml = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, html: string) {
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  el.innerHTML = html;
}

/**
 * Use a skill. Self, around and allies skills fire at once; enemy and area skills wait for a click on the map;
 * ally skills wait for a click on the map or a party card (or go on yourself when nobody else is in reach).
 */
export function useSkill(id: SkillId) {
  const s = store.state;
  const m = me();
  if (!s || !m) return;
  if (store.selected === id) return select(null);
  const reason = blockReason(id);
  if (reason) return toast(reason);
  const st = mySkillStats(m, id);
  if (!st) return;
  switch (st.target) {
    case 'self':
    case 'allies':
      select(null);
      return send('act', id);
    case 'around': {
      const aim = aimAt(s, m, id, null);
      if (typeof aim !== 'string' && !aim.foes.length) return toast('No enemies in reach.');
      select(null);
      return send('act', id);
    }
    case 'ally':
      // A potion or heal with nobody else in reach just goes on yourself.
      if (!s.entities.some((e) => e.id !== m.id && validTarget(s, m, e, id))) {
        select(null);
        return send('act', id, m.id);
      }
      return select(id);
    default:
      return select(id);
  }
}

/** The G key and the Art button: pixel art or the classic emoji look. */
export function toggleGraphics() {
  toggleSprites();
  toast(spritesOn() ? '🎨 Pixel art' : '🎨 Classic emoji look');
}

export function toggleAuto() {
  const info = store.state?.players.find((p) => p.id === store.playerId);
  if (info) send('setAuto', !info.auto);
}

const COMBO_ICON = { fire: '🔥', cold: '❄️', lightning: '⚡', water: '💧' } as const;

/** The element combos for the "How to play" list, one line per surface: "Water: 🔥 Steam cloud · ❄️ Ice · ...". */
function comboLegend(): string {
  const rows = COMBOS.map((c) => {
    const parts = (Object.keys(COMBO_ICON) as (keyof typeof COMBO_ICON)[]).filter((el) => c[el]).map((el) => `${COMBO_ICON[el]} ${esc(c[el]!)}`);
    return `<div><b>${esc(c.on)}:</b> ${parts.join(' · ')}</div>`;
  });
  return `<li><b>Elements and surfaces:</b> water, ice, fire, oil, poison and lava lie on the floor; steam, smoke and poison gas hang above it.
    Fire, cold, lightning and water react with them. Hover a tile to read it. While you aim, the preview shows what will react and who gets caught,
    and area attacks hit your allies too. Walking into a hazard takes a second click.${rows.join('')}</li>`;
}

export function initHud() {
  document.querySelector('.help ul')?.insertAdjacentHTML('beforeend', comboLegend());
  $('#auto-btn').addEventListener('click', toggleAuto);
  const gfx = $('#gfx-btn');
  gfx.addEventListener('click', toggleGraphics);
  const showGfx = () => gfx.setAttribute('aria-pressed', String(spritesOn()));
  showGfx();
  onGraphicsMode(() => {
    showGfx();
    refresh(); // the HUD, map, shop and bag are HTML: draw them again with the other icons
  });
  $('#bag-btn').addEventListener('click', () => toggleInventory());
  $('#ability-bar').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-skill]');
    if (b) useSkill(b.dataset.skill as SkillId);
  });
  // Clicking a party card targets that hero with the selected ally skill (handy between fights, too).
  $('#party').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-open-levelup]')) return toggleLevelUp();
    const card = t.closest<HTMLElement>('[data-entity]');
    const s = store.state;
    const m = me();
    const sel = store.selected;
    if (!card || !s || !m || !sel) return;
    const st = mySkillStats(m, sel);
    if (!st || st.target !== 'ally') return toast('Click a spot on the map to aim that.');
    const target = s.entities.find((x) => x.id === card.dataset.entity);
    if (!target || !validTarget(s, m, target, sel)) return toast(`Can't use ${st.name} on them right now.`);
    send('act', sel, target.id);
    select(null);
  });
  $('#end-turn').addEventListener('click', () => send('endTurn'));
  $('#restart-btn').addEventListener('click', () => send('restart'));
  $('#leave-game').addEventListener('click', () => {
    if (confirm('Leave this game? Your character stays behind until you rejoin with the room code.')) leave();
  });
  $<HTMLFormElement>('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('#chat-input');
    if (input.value.trim()) send('chat', input.value);
    input.value = '';
    input.blur();
  });
}

/** The squads' call, in words (the red reticles on the map): who the monsters are hunting, and who the allies are after. */
function focusNote(s: GameState, t: TurnState): string {
  const hunted = huntedIds(s).flatMap((id) => s.entities.filter((e) => e.id === id && !(e.kind === 'player' && e.dead)));
  const foe = s.entities.find((e) => e.id === t.allyFocus);
  const names = hunted.map((h) => `<b>${h.kind === 'player' && h.playerId === store.playerId ? 'you' : esc(h.name)}</b>`).join(', ');
  return (hunted.length
    ? `<div class="focus-note" title="The monsters called their targets and go for them. Keep them alive, or draw the monsters off.">🎯 Hunted: the monsters are ganging up on ${names}</div>`
    : '') + (foe ? `<div class="focus-note ally" title="Your NPC allies have picked a target.">🎯 Your allies are going for <b>${esc(foe.name)}</b></div>` : '');
}

function title(s: GameState): string {
  switch (s.phase) {
    case 'map':
      return '🗺️ Choose your path';
    case 'event':
      return `${s.event?.glyph ?? '❓'} ${s.event?.title ?? 'Event'}`;
    case 'rest':
      return '🔥 Rest site';
    case 'shop':
      return '🛒 The merchant';
    case 'combat': {
      if (inApproach(s)) return '🤫 Sneak or charge?';
      const label = s.roomKind === 'boss' ? '👑 Boss fight' : s.roomKind === 'elite' ? '💀 Elite fight' : '⚔️ Combat';
      return s.turn ? `${label}, round ${s.turn.round}` : label;
    }
    case 'victory':
      return '🏆 Victory!';
    case 'defeat':
      return '☠️ Defeat';
    default:
      return '';
  }
}

export function renderHud(s: GameState) {
  const m = me();
  const myTurn = isMyTurn();
  const cur = currentEntity();
  const run = s.run;

  $('#hud-title').textContent = title(s);
  const diff = DIFFICULTIES[run?.difficulty ?? s.difficulty];
  setHtml(
    $('#hud-sub'),
    run
      ? `Act ${run.act} of ${run.maxAct} · ${esc(run.actName)} · <span class="diff-tag" title="${esc(`${diff.name}: ${diff.desc}`)}">${diff.icon} ${diff.name}</span> · 💰 ${run.gold} · Room ${s.code}`
      : `Room ${s.code}`,
  );

  // The party's relics, blessings and NPC allies, always in view during a run (blessings and allies only when there are some)
  const relics = $('#relics');
  relics.hidden = !run;
  if (run) {
    const block = (label: string, body: string) => `<div class="rel-block"><div class="section-label">${label}</div>${body}</div>`;
    const liveAllies = s.phase === 'combat' ? s.entities.filter(isAllyNpc) : []; // their HP, while they're in the fight
    setHtml(
      relics,
      block('🏺 Relics', `<div class="relics">${relicsHtml(run.relics) || '<span class="muted" title="Treasure rooms, shops and bosses give them">none yet</span>'}</div>`) +
        (run.blessings.length ? block('✨ Blessings <i>until the end of the act</i>', `<div class="relics">${blessingsHtml(run.blessings)}</div>`) : '') +
        (run.allies.length ? block('🤝 Allies', `<div class="allies">${alliesHtml(run.allies, liveAllies)}</div>`) : ''),
    );
  }

  // Turn order
  const init = $('#initiative');
  init.hidden = !s.turn;
  if (s.turn) {
    const t = s.turn;
    init.innerHTML = `<div class="section-label">Turn order</div><div class="chips">${t.order
      .map((id) => {
        const e = s.entities.find((x) => x.id === id);
        if (!e) return '';
        const ally = isAllyNpc(e);
        const cls = [id === cur?.id ? 'current' : '', ally ? 'ally' : e.kind, e.kind === 'player' && e.playerId === store.playerId ? 'mine' : ''].join(' ');
        const auto = e.kind === 'player' && isAuto(s, e.playerId) ? ' 🤖' : '';
        const surprised = hasStatus(e, 'surprised') ? ` ${STATUSES.surprised.icon}` : ''; // loses its first turn
        const traits = e.kind === 'monster' ? (e.traits ?? []).map((tr) => TRAITS[tr]?.icon ?? '').join('') : ''; // an elite's traits
        const tip = `${ally ? 'NPC ally: fights for the party · ' : ''}Initiative ${t.init[id] ?? '?'}${surprised ? ' · Surprised: loses its first turn' : ''}`;
        return `<span class="chip ${cls}" title="${tip}">${e.glyph} ${esc(e.name)}${traits ? ` ${traits}` : ''}${auto}${surprised}</span>`;
      })
      .join('')}</div>${focusNote(s, t)}`;
  }

  // Your turn banner
  const turnKey = s.turn ? `${s.turn.round}:${s.turn.index}:${cur?.id}` : '';
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    if (myTurn) toast('🎲 Your turn!');
  }

  // Party
  const party = s.entities.filter((e): e is PlayerEntity => e.kind === 'player');
  const sel = store.selected;
  const selStats = m && sel ? mySkillStats(m, sel) : null;
  setHtml(
    $('#party'),
    party.map((p) => partyCard(s, p, p.id === cur?.id, !!(m && sel && selStats?.target === 'ally' && validTarget(s, m, p, sel)))).join(''),
  );

  // Skills and turn controls
  const panel = $('#me-panel');
  const playing = s.phase === 'map' || s.phase === 'event' || s.phase === 'rest' || s.phase === 'shop' || s.phase === 'combat';
  panel.hidden = !m || !playing;
  if (m) {
    setHtml($('#ability-bar'), hotbarHtml(m));

    const eco = $('#economy');
    const myInfo = s.players.find((p) => p.id === store.playerId);
    setHtml($('#bag-btn'), `🎒 Bag ${m.bag.length}/${BAG_SIZE} <kbd>I</kbd>`);
    const autoBtn = $('#auto-btn');
    autoBtn.classList.toggle('on', !!myInfo?.auto);
    autoBtn.innerHTML = `🤖 Auto: ${myInfo?.auto ? 'on' : 'off'} <kbd>P</kbd>`;
    const approaching = inApproach(s);
    if (approaching) {
      eco.innerHTML = '<span class="muted">🤫 Vote Sneak or Charge (the card above the room). The fight starts when the vote is in.</span>';
    } else if (s.phase === 'combat' && s.turn && myTurn && myInfo?.auto) {
      eco.innerHTML = '<span class="pill">🤖 Auto-play is taking your turn. Press P to take over.</span>';
    } else if (s.phase === 'combat' && s.turn) {
      eco.innerHTML = myTurn
        ? `<span class="pill">👣 ${s.turn.movesLeft} moves</span><span class="pill ${s.turn.actionUsed ? 'used' : ''}">Action</span><span class="pill ${s.turn.bonusUsed ? 'used' : ''}">Bonus</span>`
        : `<span class="muted">Waiting for ${cur ? esc(cur.name) : '...'}${isAllyNpc(cur) ? " (ally's turn)" : isFoe(cur) ? ' (monster turn)' : ''}</span>`;
    } else if (s.phase === 'shop') {
      eco.innerHTML = '<span class="muted">🛒 Shopping: press I for your bag (equip, give, drop). Potions and heals wait until you are back on the map.</span>';
    } else {
      const picks =
        (m.levelUps > 0 ? ` <span class="pill lvl">⬆️ ${m.levelUps} level-up pick${m.levelUps > 1 ? 's' : ''} waiting</span>` : '') +
        (m.elitePicks > 0 ? ` <span class="pill lvl">💀 ${m.elitePicks} elite spoil${m.elitePicks > 1 ? 's' : ''} waiting</span>` : '');
      eco.innerHTML = `<span class="muted">Between rooms: drink a potion or use a heal (pick it, then click a friend's card). Slots come back at a Long Rest.</span>${picks}`;
    }
    $('#end-turn').hidden = s.phase !== 'combat' || approaching;
    $<HTMLButtonElement>('#end-turn').disabled = !myTurn;

    const hint = $('#target-hint');
    hint.hidden = !sel || s.phase !== 'combat' || approaching;
    if (sel && selStats) {
      const own = ownedSkill(m, sel)!;
      // Oil barrels and braziers in the room can be hit too.
      const props = canHitProps(selStats) ? [...new Set(Object.values(s.props ?? {}))].map((id) => id && PROPS[id].icon).join(' ') : '';
      const r = selStats.radius ?? 1;
      const how =
        selStats.target === 'enemy'
          ? `click an enemy${props ? ` or ${props}` : ''}${selStats.range <= 1 ? ' next to you' : ` within ${selStats.range} tiles`}`
          : selStats.target === 'ally'
            ? 'click an ally or a party card'
            : `click a spot within ${selStats.range} tiles (${hitsArea(selStats) ? `hits everyone within ${r} of it, allies too` : `covers everything within ${r} of it`})`;
      hint.textContent = `${selStats.icon} ${skillTitle(own)}: ${how} (Esc to cancel)`;
    }
  }

  renderLog(s.log);
  renderEnd(s, party);
}

// ---------------------------------------------------------------- hotbar

const COST_LABEL = { action: 'A', bonus: 'B', free: 'free' } as const;

function skillButton(m: PlayerEntity, id: SkillId, n: number): string {
  const own = ownedSkill(m, id)!;
  const st = statsOf(own);
  const def = SKILLS[id];
  const reason = blockReason(id);
  const tip = `${skillTitle(own)}\n${describeSkill(id, own.tier, own.branch, m)}${reason ? `\n\n⛔ ${reason}` : ''}`;
  const cd = own.cd > 0 ? `<span class="cd-ov">⏱${own.cd}</span>` : '';
  const icon = id === 'potion' || def.kind === 'item' ? itemIcon(id as ItemId | 'potion', st.icon) : st.icon; // potions and consumables have item art
  const meta = [
    `<span class="cost ${st.cost}">${COST_LABEL[st.cost]}</span>`,
    def.kind === 'spell' ? `<span class="slotcost">🔮${slotCost(st)}</span>` : '',
    id === 'potion' ? `<span class="uses">×${m.potions}</span>` : def.kind === 'item' ? `<span class="uses" title="In your bag">×${m.bag.filter((b) => b === id).length}</span>` : '',
  ].join('');
  return `<button type="button" class="ability kind-${def.kind}${reason ? ' off' : ''}${store.selected === id ? ' selected' : ''}" data-skill="${id}" title="${esc(tip)}">
    <span class="ab-icon">${icon}${cd}</span>
    <span class="ab-main"><span class="aname">${esc(id === 'potion' ? 'Potion' : skillTitle(own))}</span><span class="ab-meta">${meta}</span></span>
    ${n <= 10 ? `<span class="key">${n % 10}</span>` : ''}
  </button>`;
}

/** Rows for attacks + cantrips, spells, and Shove + the potion (everyone has those), the slot pips, and a row of passive icons. */
function hotbarHtml(m: PlayerEntity): string {
  const names = CLASSES[m.classId].names;
  const keys = hotbar(m);
  const row = (kinds: string[]) =>
    keys
      .map((id, i) => (kinds.includes(SKILLS[id].kind) ? skillButton(m, id, i + 1) : ''))
      .join('');
  const count = (kind: 'cantrip' | 'spell' | 'passive') => `${countKind(m, kind)}/${limitFor(m, kind)}`;
  const pips = Array.from({ length: m.maxSlots }, (_, i) => `<span class="pip${i < m.slots ? ' on' : ''}"></span>`).join('');
  const passives = skillsOfKind(m, 'passive')
    .map((o) => {
      const st = statsOf(o);
      const tip = `${skillTitle(o)}\n${describeSkill(o.id, o.tier, o.branch, m)}`;
      return `<span class="passive" title="${esc(tip)}">${st.icon}<i>${TIER_LABEL(o.tier, o.branch)}</i></span>`;
    })
    .join('');
  return `<div class="hb-label"><span>⚔️ Attacks · ⏱ ${names.cantrip} ${count('cantrip')}</span></div>
    <div class="hb-row">${row(['basic', 'cantrip'])}</div>
    <div class="hb-label"><span>🔮 ${names.spell} ${count('spell')}</span>
      <span class="pips" title="${esc(`${names.slots}: ${m.slots} of ${m.maxSlots} left. A Long Rest restores them.`)}"><b>${names.slots}</b>${pips || '<span class="muted">none</span>'}</span></div>
    ${keys.some((id) => SKILLS[id].kind === 'spell') ? `<div class="hb-row">${row(['spell'])}</div>` : ''}
    <div class="hb-label"><span>🎒 Actions</span></div>
    <div class="hb-row">${row(['action', 'item'])}</div>
    <div class="hb-label"><span>🔁 Passives ${count('passive')}</span></div>
    <div class="passives">${passives || '<span class="muted">none yet</span>'}</div>`;
}

// ---------------------------------------------------------------- party

function statusChip(st: StatusInst): string {
  const def = STATUSES[st.id];
  const power = st.power ? ` (power ${st.power})` : '';
  const tip = `${def.name}${power}, ${st.turns} turn${st.turns === 1 ? '' : 's'} left\n${def.desc}`;
  return `<span class="st ${def.good ? 'good' : 'bad'}" title="${esc(tip)}">${def.icon}<i>${st.turns}</i></span>`;
}

function partyCard(s: GameState, p: PlayerEntity, isCurrent: boolean, targetable: boolean): string {
  const c = CLASSES[p.classId];
  const info = s.players.find((x) => x.id === p.playerId);
  const hpPct = Math.max(0, Math.min(100, Math.round((p.hp / p.maxHp) * 100)));
  const tempPct = Math.min(100, Math.round((p.tempHp / p.maxHp) * 100));
  const hpColor = hpPct > 50 ? 'var(--good)' : hpPct > 25 ? 'var(--warn)' : 'var(--bad)';
  const status = p.dead
    ? '<span class="tag bad">dead</span>'
    : p.downed
      ? `<span class="tag bad">down ✔${p.saves.ok} ✖${p.saves.fail}</span>`
      : '';
  const mine = p.playerId === store.playerId;
  // Waiting picks: level-ups (⬆️) and elite spoils (💀). Your own badges open the panel.
  const pick = (n: number, icon: string, what: string) =>
    n <= 0 ? '' : mine
      ? `<button type="button" class="tag lvl" data-open-levelup title="Open your ${what}">${icon} ${n}</button>`
      : `<span class="tag lvl" title="${what[0].toUpperCase() + what.slice(1)} waiting">${icon} ${n}</span>`;
  const ups = pick(p.levelUps, '⬆️', 'level-up picks') + pick(p.elitePicks, '💀', 'elite spoils');
  const max = p.level >= LEVEL_CAP;
  const need = xpToNext(p.level);
  const xpPct = max ? 100 : Math.max(0, Math.min(100, Math.round((p.xp / need) * 100)));
  const pips = Array.from({ length: p.maxSlots }, (_, i) => `<span class="pip${i < p.slots ? ' on' : ''}"></span>`).join('');
  const focus = !p.dead && huntedIds(s).includes(p.id); // the monsters are ganging up on this hero
  const cls = ['pc', isCurrent ? 'current' : '', mine ? 'mine' : '', p.dead || p.downed ? 'down' : '', targetable ? 'targetable' : '', focus ? 'focus' : ''].join(' ');
  return `<div class="${cls}" data-entity="${p.id}">
    <div class="pc-glyph" style="border-color:${p.color}">${p.dead ? '🪦' : c.glyph}</div>
    <div class="pc-main">
      <div class="pc-name"><b>${esc(p.name)}</b> <span class="muted">${c.name} Lv ${p.level}</span>${autoTag(info)}${status}${focus ? '<span class="tag bad" title="Hunted: the monsters are ganging up on this hero">🎯 hunted</span>' : ''}${ups}</div>
      <div class="hpbar"><div style="width:${hpPct}%;background:${hpColor}"></div>${p.tempHp > 0 ? `<i class="tmp" style="width:${tempPct}%"></i>` : ''}<span>${p.hp} / ${p.maxHp}${p.tempHp > 0 ? ` <em>+${p.tempHp} 🛡</em>` : ''}</span></div>
      <div class="xpbar${max ? ' max' : ''}" title="${max ? 'Max level' : `${p.xp} of ${need} XP to level ${p.level + 1}`}"><div style="width:${xpPct}%"></div><span>${max ? 'MAX' : `XP ${p.xp} / ${need}`}</span></div>
      <div class="pc-stats">${gearIconsHtml(p) ? `<span class="pc-gear">${gearIconsHtml(p)}</span>` : ''}<span title="Armor class">🛡️ ${p.ac}</span><span title="Potions">🧪 ${p.potions}</span><span title="Kills">💀 ${p.kills}</span><span title="Kill steals: killing blows on monsters someone else did most of the damage to">🗡️ ${p.steals}</span>${
        p.maxSlots ? `<span class="pips" title="${esc(`${c.names.slots}: ${p.slots} of ${p.maxSlots}`)}"><b>${c.names.slots}</b>${pips}</span>` : ''
      }</div>
      ${p.statuses.length ? `<div class="pc-status">${p.statuses.map(statusChip).join('')}</div>` : ''}
    </div>
  </div>`;
}

function autoTag(info: GameState['players'][number] | undefined): string {
  if (!info) return '';
  if (info.bot) return '<span class="tag">🤖 bot</span>';
  if (!info.connected) return '<span class="tag">away · 🤖</span>';
  return info.auto ? '<span class="tag">🤖 auto</span>' : '';
}

function renderLog(log: LogLine[]) {
  const newest = log[log.length - 1]?.id ?? 0;
  if (newest === lastLogId) return;
  lastLogId = newest;
  const el = $('#log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = log.map((l) => `<div class="line k-${l.kind}">${esc(l.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderEnd(s: GameState, party: PlayerEntity[]) {
  const over = s.phase === 'victory' || s.phase === 'defeat';
  $('#end-overlay').hidden = !over;
  if (!over) return;
  const run = s.run;
  const gold = run?.gold ?? 0;
  $('#end-title').textContent = s.phase === 'victory' ? '🏆 Victory!' : '☠️ The party has fallen';
  $('#end-text').textContent =
    s.phase === 'victory'
      ? `You conquered all ${run?.maxAct ?? 3} acts and escaped with ${gold} gold. Songs will be sung.`
      : `Your run ended in Act ${run?.act ?? 1} (${run?.actName ?? ''}) with ${gold} gold. The dungeon claims another party...`;
  const topKills = Math.max(0, ...party.map((p) => p.kills));
  const topSteals = Math.max(0, ...party.map((p) => p.steals));
  $('#end-stats').innerHTML = [...party]
    .sort((a, b) => b.kills - a.kills || b.steals - a.steals)
    .map((p) => {
      const slayer = topKills > 0 && p.kills === topKills ? ' <span class="tag">💀 top slayer</span>' : '';
      const crown = topSteals > 0 && p.steals === topSteals ? ' <span class="tag">🗡️ kill-steal champion</span>' : '';
      return `<li><span class="dot" style="background:${p.color}"></span>${CLASSES[p.classId].glyph} <b>${esc(p.name)}</b>
        <span class="muted">${CLASSES[p.classId].name} Lv ${p.level}</span>${slayer}${crown}
        <span class="end-kills" title="Kills and kill steals">💀 ${p.kills} · 🗡️ ${p.steals}</span></li>`;
    })
    .join('');
}
