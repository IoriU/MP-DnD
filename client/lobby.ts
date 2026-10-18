// Home screen (name, class, create/join) and the tavern lobby before a run starts.

import { CLASSES, CLASS_IDS, MAX_PLAYERS } from '../shared/rules.ts';
import type { ClassId, GameState } from '../shared/types.ts';
import { join, leave, send } from './net.ts';
import { store } from './store.ts';
import { $, esc, loadPref, savePref, toast } from './util.ts';

let chosen: ClassId = (CLASS_IDS as string[]).includes(loadPref('class') ?? '') ? (loadPref('class') as ClassId) : 'fighter';

function classCards(selected: ClassId): string {
  return CLASS_IDS.map((id) => {
    const c = CLASSES[id];
    return `<button type="button" class="class-card${id === selected ? ' selected' : ''}" data-class="${id}">
      <span class="cc-glyph">${c.glyph}</span>
      <span class="cc-name">${c.name}</span>
      <span class="cc-stats">❤️ ${c.hp} HP · 🛡️ AC ${c.ac}</span>
      <span class="cc-blurb">${c.blurb}</span>
    </button>`;
  }).join('');
}

function onClassClick(container: HTMLElement, fn: (id: ClassId) => void) {
  container.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-class]');
    if (card) fn(card.dataset.class as ClassId);
  });
}

export function initLobby() {
  const nameInput = $<HTMLInputElement>('#name');
  const codeInput = $<HTMLInputElement>('#code');
  nameInput.value = loadPref('name') ?? '';
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    codeInput.value = room.toUpperCase();
    $('#join-btn').classList.add('primary');
    $('#create-btn').classList.remove('primary');
  }

  const homeClasses = $('#home-classes');
  homeClasses.innerHTML = classCards(chosen);
  onClassClick(homeClasses, (id) => {
    chosen = id;
    savePref('class', id);
    homeClasses.innerHTML = classCards(chosen);
  });

  const go = async (code?: string) => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Enter your name first.');
      nameInput.focus();
      return;
    }
    savePref('name', name);
    const res = await join({ name, classId: chosen, code });
    if (!res.ok) toast(res.error);
  };

  $('#create-btn').addEventListener('click', () => go());
  $<HTMLFormElement>('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) return toast('Room codes are 4 letters.');
    void go(code);
  });

  onClassClick($('#room-classes'), (id) => {
    savePref('class', id);
    send('setClass', id);
  });
  $('#start-btn').addEventListener('click', () => send('start'));
  $('#add-bot').addEventListener('click', () => send('addBot'));
  $('#room-players').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-bot]');
    if (btn) send('removeBot', btn.dataset.removeBot);
  });
  $('#leave-room').addEventListener('click', leave);
  $('#copy-link').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#invite-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      // The clipboard API needs https; plain http (LAN / Tailscale) falls back to the old way.
      input.select();
      document.execCommand('copy');
    }
    toast('Invite link copied! Send it to your friends.');
  });
}

export function renderRoom(s: GameState) {
  $('#room-code').textContent = s.code;
  $<HTMLInputElement>('#invite-link').value = `${location.origin}${location.pathname}?room=${s.code}`;
  const isHost = s.hostId === store.playerId;
  $('#room-players').innerHTML = s.players
    .map((p) => {
      const c = CLASSES[p.classId];
      const tags = [p.id === s.hostId ? 'host' : '', p.id === store.playerId ? 'you' : '', p.bot ? '🤖 bot' : ''].filter(Boolean);
      const remove = p.bot && isHost ? `<button type="button" class="btn ghost small rp-remove" data-remove-bot="${p.id}" title="Remove bot">✕</button>` : '';
      return `<li><span class="dot" style="background:${p.color}"></span><span class="rp-glyph">${c.glyph}</span>
        <b>${esc(p.name)}</b><span class="muted">${c.name}</span>${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${remove}</li>`;
    })
    .join('');
  const mine = s.players.find((p) => p.id === store.playerId);
  $('#room-classes').innerHTML = classCards(mine?.classId ?? chosen);
  $('#start-btn').hidden = !isHost;
  $('#add-bot').hidden = !isHost || s.players.length >= MAX_PLAYERS;
  $('#wait-host').hidden = isHost;
}
