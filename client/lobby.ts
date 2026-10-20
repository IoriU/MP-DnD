// Home screen (name, class, create/join) and the tavern lobby before a run starts.

import { CLASSES, CLASS_IDS, DIFFICULTIES, DIFFICULTY_IDS, MAX_PLAYERS, MIN_PARTY, MONSTER_AIS, MONSTER_AI_IDS, type Difficulty, type MonsterAi } from '../shared/rules.ts';
import type { ClassId, GameState, PlayerInfo, ResumeView } from '../shared/types.ts';
import { join, leave, send } from './net.ts';
import { ago, initSaves } from './saves.ts';
import { classIcon } from './sprites.ts';
import { store } from './store.ts';
import { $, esc, loadPref, savePref, toast } from './util.ts';

let chosen: ClassId = (CLASS_IDS as string[]).includes(loadPref('class') ?? '') ? (loadPref('class') as ClassId) : 'fighter';

function classCards(selected: ClassId): string {
  return CLASS_IDS.map((id) => {
    const c = CLASSES[id];
    return `<button type="button" class="class-card${id === selected ? ' selected' : ''}" data-class="${id}">
      <span class="cc-glyph">${classIcon(id, 48)}</span>
      <span class="cc-name">${c.name}</span>
      <span class="cc-stats"><span>❤️ ${c.hp} HP</span><i>·</i><span>🛡️ AC ${c.ac}</span></span>
      <span class="cc-blurb">${c.blurb}</span>
    </button>`;
  }).join('');
}

/** The three difficulties as cards. Only the host can pick (`pickable`); everyone else sees the current pick, read-only. */
function difficultyCards(selected: Difficulty, pickable: boolean): string {
  return DIFFICULTY_IDS.map((id) => {
    const d = DIFFICULTIES[id];
    return `<button type="button" class="class-card diff-card${id === selected ? ' selected' : ''}" data-difficulty="${id}"${pickable ? '' : ' disabled'}>
      <span class="cc-glyph">${d.icon}</span>
      <span class="cc-name">${d.name}</span>
      <span class="cc-blurb">${d.desc}</span>
    </button>`;
  }).join('');
}

/**
 * Who plays the monsters, as cards like the difficulty ones: host-only (`pickable`), read-only for everyone else. The PPO
 * card is disabled, with a note, when this server has no trained policy.
 */
function monsterAiCards(selected: MonsterAi, pickable: boolean, ppoReady: boolean): string {
  return MONSTER_AI_IDS.map((id) => {
    const a = MONSTER_AIS[id];
    const missing = id === 'ppo' && !ppoReady;
    return `<button type="button" class="class-card diff-card${id === selected ? ' selected' : ''}" data-monster-ai="${id}"${pickable && !missing ? '' : ' disabled'}>
      <span class="cc-glyph">${a.icon}</span>
      <span class="cc-name">${a.name}</span>
      <span class="cc-blurb">${a.desc}</span>
      ${missing ? '<span class="cc-note">No trained policy on this server yet</span>' : ''}
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
  initSaves(go);

  onClassClick($('#room-classes'), (id) => {
    savePref('class', id);
    send('setClass', id);
  });
  $('#room-difficulty').addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-difficulty]');
    if (card && !card.disabled) send('setDifficulty', card.dataset.difficulty);
  });
  $('#room-monster-ai').addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-monster-ai]');
    if (card && !card.disabled) send('setMonsterAi', card.dataset.monsterAi);
  });
  $('#start-btn').addEventListener('click', () => send('start'));
  $('#add-bot').addEventListener('click', () => send('addBot'));
  // The host picks each bot's class from the dropdown on its row.
  $('#room-players').addEventListener('change', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-bot-class]');
    if (pick) send('setBotClass', pick.dataset.botClass, pick.value);
  });
  $('#room-players').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const bot = target.closest<HTMLElement>('[data-remove-bot]');
    if (bot) return send('removeBot', bot.dataset.removeBot);
    const claim = target.closest<HTMLElement>('[data-claim]');
    if (claim) send('claimHero', claim.dataset.claim);
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

type SavedHero = ResumeView['heroes'][number];

let playersHtml = ''; // the party list as last drawn

const tagList = (tags: string[]) =>
  tags
    .filter(Boolean)
    .map((t) => `<span class="tag${t === 'away' ? ' away' : ''}">${t}</span>`)
    .join('');

const removeBotBtn = (p: PlayerInfo | undefined, isHost: boolean) =>
  p?.bot && isHost ? `<button type="button" class="btn ghost small rp-remove" data-remove-bot="${p.id}" title="Remove bot">✕</button>` : '';

/** A bot's class: the host can change it (a dropdown), everyone else just reads it. */
function classLabel(p: PlayerInfo, isHost: boolean): string {
  if (!p.bot || !isHost) return `<span class="muted">${CLASSES[p.classId].name}</span>`;
  const options = CLASS_IDS.map((id) => `<option value="${id}"${id === p.classId ? ' selected' : ''}>${CLASSES[id].name}</option>`).join('');
  return `<select class="rp-class" data-bot-class="${esc(p.id)}" aria-label="${esc(p.name)}'s class" title="Pick ${esc(p.name)}'s class">${options}</select>`;
}

function playerRow(s: GameState, p: PlayerInfo, isHost: boolean, extra: string[] = []): string {
  const tags = [p.id === s.hostId ? 'host' : '', p.id === store.playerId ? 'you' : '', p.bot ? '🤖 bot' : '', ...extra];
  return `<li><span class="dot" style="background:${p.color}"></span><span class="rp-glyph">${classIcon(p.classId, 32)}</span>
    <b>${esc(p.name)}</b>${classLabel(p, isHost)}${tagList(tags)}${removeBotBtn(p, isHost)}</li>`;
}

/** A hero from the saved party: you, here, away (claimable by an unassigned player) or a bot. */
function heroRow(s: GameState, h: SavedHero, isHost: boolean, unassigned: boolean): string {
  const c = CLASSES[h.classId];
  const p = s.players.find((x) => x.id === h.playerId);
  const here = h.bot || !!p?.connected;
  const status = h.playerId === store.playerId ? 'you' : h.bot ? '🤖 bot' : here ? 'here' : 'away';
  const claim = !here && unassigned ? `<button type="button" class="btn small rp-claim" data-claim="${h.playerId}">Play as ${esc(h.name)}</button>` : '';
  return `<li${here ? '' : ' class="away"'}><span class="dot" style="background:${p?.color ?? '#6b5434'}"></span><span class="rp-glyph">${classIcon(h.classId, 32)}</span>
    <b>${esc(h.name)}</b><span class="muted">${c.name} · Lv ${h.level}</span>${tagList([p?.id === s.hostId ? 'host' : '', status])}${claim}${removeBotBtn(p, isHost)}</li>`;
}

const awayHeroes = (s: GameState, r: ResumeView) => r.heroes.some((h) => !h.bot && !s.players.find((p) => p.id === h.playerId)?.connected);

/** The "Continuing a saved run" banner, with a hint that fits who is looking. */
function resumeBanner(r: ResumeView, unassigned: boolean, away: boolean, joinLevel: number): string {
  let hint = '';
  if (unassigned) {
    hint = away
      ? `You are not one of the saved heroes. Take over an away hero with “Play as”, or just start and join as a new hero at level ${joinLevel}.`
      : `You are not one of the saved heroes. You will join as a new hero at level ${joinLevel}.`;
  } else if (away) {
    hint = 'Heroes who are away are played by the computer until their player comes back with the same name.';
  }
  return `<b>📜 Continuing a saved run:</b> Act ${r.act} · ${esc(r.actName)} · saved ${ago(r.savedAt)}${hint ? `<div class="muted">${hint}</div>` : ''}`;
}

export function renderRoom(s: GameState) {
  $('#room-code').textContent = s.code;
  $<HTMLInputElement>('#invite-link').value = `${location.origin}${location.pathname}?room=${s.code}`;
  const isHost = s.hostId === store.playerId;
  const r = s.resume;
  const heroIds = new Set((r?.heroes ?? []).map((h) => h.playerId));
  const unassigned = !!r && !heroIds.has(store.playerId ?? '');
  const joinLevel = r ? Math.max(1, ...r.heroes.map((h) => h.level)) : 1;

  $('#resume-banner').hidden = !r;
  if (r) $('#resume-banner').innerHTML = resumeBanner(r, unassigned, awayHeroes(s, r), joinLevel);
  const rows = r
    ? [
        ...r.heroes.map((h) => heroRow(s, h, isHost, unassigned)),
        ...s.players.filter((p) => !heroIds.has(p.id)).map((p) => playerRow(s, p, isHost, [`new hero (joins at level ${joinLevel})`])),
      ].join('')
    : s.players.map((p) => playerRow(s, p, isHost)).join('');
  if (rows !== playersHtml) $('#room-players').innerHTML = playersHtml = rows; // unchanged: an open class dropdown stays open

  // Every run has at least MIN_PARTY heroes: the server fills the empty seats with bots when it starts.
  const party = r ? r.heroes.length + s.players.filter((p) => !heroIds.has(p.id)).length : s.players.length;
  const fill = MIN_PARTY - party;
  $('#room-fill-hint').hidden = fill <= 0;
  $('#room-fill-hint').textContent =
    fill > 0
      ? `Every party has at least ${MIN_PARTY} heroes: ${fill === 1 ? 'a bot takes the empty seat' : `${fill} bots take the empty seats`} when the run starts.${isHost && !r ? ' Add them now with 🤖 Add bot to pick their classes.' : ''}`
      : '';

  // Saved heroes keep their class; only players who join as a new hero choose one.
  $('#room-class-section').hidden = !!r && !unassigned;
  $('#room-class-hint').hidden = !unassigned;
  const mine = s.players.find((p) => p.id === store.playerId);
  $('#room-classes').innerHTML = classCards(mine?.classId ?? chosen);
  // Only the host picks the difficulty, and only for a new run: a saved run keeps the one it was started with.
  const pickDifficulty = isHost && !r;
  $('#room-difficulty').innerHTML = difficultyCards(s.difficulty, pickDifficulty);
  $('#room-difficulty-hint').textContent = r
    ? `This saved run keeps its difficulty (${DIFFICULTIES[s.difficulty].name}).`
    : isHost ? 'You are the host: pick how hard the dungeon fights back.' : 'The host picks the difficulty.';
  // Likewise the monsters' brain: the host picks it for a new run, a saved run keeps its own.
  $('#room-monster-ai').innerHTML = monsterAiCards(s.monsterAi, isHost && !r, s.ppoReady);
  $('#room-monster-ai-hint').textContent = r
    ? `This saved run keeps its monster AI (${MONSTER_AIS[s.monsterAi].name}).`
    : isHost ? 'You are the host: pick who plays the monsters.' : 'The host picks who plays the monsters.';
  $('#start-btn').textContent = r ? 'Continue the adventure' : 'Start the adventure';
  $('#start-btn').hidden = !isHost;
  $('#add-bot').hidden = !isHost || s.players.length >= MAX_PLAYERS;
  $('#wait-host').hidden = isHost;
}
