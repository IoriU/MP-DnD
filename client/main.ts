import './style.css';
import { hotbar } from '../shared/skills.ts';
import { initHud, renderHud, toggleAuto, useSkill } from './hud.ts';
import { initLevelUp, renderLevelUp, toggleLevelUp } from './levelup.ts';
import { initLobby, renderRoom } from './lobby.ts';
import { hasSession, send } from './net.ts';
import { initRunView, renderRunView } from './runview.ts';
import { ensureGame } from './scene.ts';
import { isMyTurn, me, select, store, subscribe } from './store.ts';
import { $ } from './util.ts';

initLobby();
initHud();
initRunView();
initLevelUp();
if (hasSession()) document.body.classList.add('resuming');

subscribe(() => {
  const s = store.state;
  const screen = !s ? 'home' : s.phase === 'lobby' ? 'room' : 'game';
  for (const name of ['home', 'room', 'game']) $(`#screen-${name}`).hidden = name !== screen;
  document.body.classList.remove('resuming');
  if (!s) return;
  if (screen === 'room') renderRoom(s);
  if (screen === 'game') {
    ensureGame();
    renderHud(s);
    renderRunView(s);
    renderLevelUp(s);
  }
});

// ---------------------------------------------------------------- keyboard

const DIRS: Record<string, [number, number]> = {
  w: [0, -1], ArrowUp: [0, -1],
  s: [0, 1], ArrowDown: [0, 1],
  a: [-1, 0], ArrowLeft: [-1, 0],
  d: [1, 0], ArrowRight: [1, 0],
  q: [-1, -1], e: [1, -1], z: [-1, 1], c: [1, 1],
};
let lastStep = 0;

window.addEventListener('keydown', (ev) => {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    if (ev.key === 'Escape') active.blur();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // leave browser shortcuts alone
  const s = store.state;
  if (!s || (s.phase !== 'map' && s.phase !== 'event' && s.phase !== 'rest' && s.phase !== 'combat')) return;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

  const dir = DIRS[key];
  if (dir && s.phase === 'combat') {
    ev.preventDefault();
    if (Date.now() - lastStep < 90) return; // don't flood the server while a key is held
    lastStep = Date.now();
    send('step', dir[0], dir[1]);
    return;
  }
  if (/^[1-9]$/.test(key)) {
    const m = me();
    const skill = m && hotbar(m)[Number(key) - 1]; // keys follow the hotbar: attacks, cantrips, spells, potion
    if (skill) useSkill(skill);
    return;
  }
  switch (key) {
    case ' ':
      ev.preventDefault();
      if (isMyTurn()) send('endTurn');
      break;
    case 'Escape':
      select(null);
      break;
    case 'p':
      toggleAuto();
      break;
    case 'l':
      toggleLevelUp();
      break;
    case 'Enter':
      ev.preventDefault();
      $('#chat-input').focus();
      break;
  }
});
