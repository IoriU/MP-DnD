// Tips in the game (playtest 1, 2026-10-21: "the tutorial is too much text"): a small card the first time something new
// comes up (the map, your first turn, a status, an event check, spoils, a stat point, a pit, a downed friend, a shared
// turn), one at a time. Each is shown once per browser; "No more tips" turns them all off.

import { PIT } from '../shared/grid.ts';
import type { GameState } from '../shared/types.ts';
import { actingNow, isMyTurn, me, store } from './store.ts';
import { $, loadPref, savePref } from './util.ts';

interface Tip {
  id: string;
  icon: string;
  text: string;
  when: (s: GameState) => boolean;
}

const TIPS: Tip[] = [
  { id: 'map', icon: '🗺️', text: 'Click a glowing room to vote where the party goes next. ⚔️ fights, 💀 elites, ❓ events, 🔥 rests, 💰 treasure, 🛒 shops. The boss 👑 waits at the top.', when: (s) => s.phase === 'map' },
  {
    id: 'turn', icon: '👣',
    text: 'Your turn! Walk anywhere in the blue area (as often as you like until you act), then click a monster to attack. You get ⚡ 3 AP a turn: attacks cost 2, quick skills 1, and AP you save carries over. Space ends your turn.',
    when: (s) => s.phase === 'combat' && isMyTurn(),
  },
  {
    id: 'shared', icon: '🤝', text: 'Heroes next to each other in the turn order (the bar at the top) play at the same time. Move and act in any order, then each ends their own turn.',
    when: (s) => s.phase === 'combat' && isMyTurn() && actingNow(s).filter((e) => e.kind === 'player').length > 1,
  },
  { id: 'status', icon: '🏷️', text: 'Hover a creature to read its buffs and debuffs, its HP and AC, and what your attack would roll against it.', when: (s) => s.phase === 'combat' && s.entities.some((e) => e.statuses.length > 0) },
  { id: 'pit', icon: '🕳️', text: "A pit! Nobody can walk in, but a monster shoved in is gone (✋ Shove, 1 AP). Mind the edge yourself when a brute is near.", when: (s) => s.phase === 'combat' && !!s.tiles?.includes(PIT) },
  {
    id: 'downed', icon: '🩸', text: 'A friend is down. 🤝 Help Up (2 AP, next to them) or a heal gets them back on their feet before their death saves run out.',
    when: (s) => s.phase === 'combat' && s.entities.some((e) => e.kind === 'player' && e.downed && !e.dead),
  },
  { id: 'event', icon: '🎲', text: "Vote on what to do. A check says who would roll it and the chance, from your party's best stat.", when: (s) => s.phase === 'event' && s.vote?.kind === 'event' },
  { id: 'spoils', icon: '🏆', text: 'Pick one of three cards: a new skill, an upgrade or an item. Your build grows from these. L opens and closes the panel.', when: () => me()?.offerKind === 'reward' && !!me()?.offer },
  { id: 'stat', icon: '💪', text: 'A stat point: raise any stat. Your stats are on your hero card; hover one to read what it does (CON is HP, DEX is AC in light armor, INT is slots).', when: () => !!me()?.offer?.some((c) => c.kind === 'stat') },
];

const SEEN_KEY = 'tips';

let seen = new Set<string>(JSON.parse(loadPref(SEEN_KEY) ?? '[]') as string[]);
let off = loadPref('tipsOff') === '1';
let showing: string | null = null;

function remember() {
  savePref(SEEN_KEY, JSON.stringify([...seen]));
}

export function initTips() {
  $('#tips').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!b) return;
    if (showing) seen.add(showing);
    if (b.dataset.tip === 'off') {
      off = true;
      savePref('tipsOff', '1');
    }
    remember();
    showing = null;
    if (store.state) renderTips(store.state);
  });
}

/** Shows the first tip that applies now and hasn't been seen (or keeps the one that's up). */
export function renderTips(s: GameState) {
  const el = $('#tips');
  if (off || s.phase === 'lobby') {
    el.hidden = true;
    return;
  }
  const tip = TIPS.find((t) => t.id === showing) ?? TIPS.find((t) => !seen.has(t.id) && t.when(s));
  if (!tip) {
    el.hidden = true;
    return;
  }
  if (tip.id !== showing) {
    showing = tip.id;
    el.innerHTML = `<div class="tip-icon">${tip.icon}</div><div class="tip-body"><div class="tip-text">${tip.text}</div>
      <div class="tip-btns"><button type="button" class="btn small primary" data-tip="ok">Got it</button><button type="button" class="btn small ghost" data-tip="off">No more tips</button></div></div>`;
  }
  el.hidden = false;
}

/** For the How to play panel: show every tip again. */
export function resetTips() {
  seen = new Set();
  off = false;
  remember();
  savePref('tipsOff', '0');
}
