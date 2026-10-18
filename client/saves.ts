// Home screen: the "Continue a saved run" list.

import { CLASSES } from '../shared/rules.ts';
import type { SaveSummary } from '../shared/types.ts';
import { deleteSave, listSaves, socket } from './net.ts';
import { store, subscribe } from './store.ts';
import { $, esc, toast } from './util.ts';

/** "just now", "5 min ago", "2 h ago", "yesterday", or a date. */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60000);
  if (min < 1) return 'just now'; // also covers a few minutes of clock skew between server and browser
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function partyChip(m: SaveSummary['party'][number]): string {
  const c = CLASSES[m.classId];
  return `<span class="save-hero" title="${c.name}">${c.glyph} ${esc(m.name)} <span class="lv">Lv ${m.level}</span>${m.bot ? ' 🤖' : ''}</span>`;
}

function saveRow(sv: SaveSummary): string {
  const online = sv.online > 0 ? `<span class="tag">${sv.online} online</span>` : '';
  return `<li class="save">
    <div class="save-info">
      <div class="save-head">
        <b class="save-code">${esc(sv.code)}</b>
        <span>Act ${sv.act} · ${esc(sv.actName)}</span>
        <span class="muted">${ago(sv.savedAt)}</span>${online}
      </div>
      <div class="save-party">${sv.party.map(partyChip).join('')}</div>
    </div>
    <button type="button" class="btn primary small" data-continue="${esc(sv.code)}">Continue</button>
    <button type="button" class="btn ghost small" data-archive="${esc(sv.code)}" title="Archive this saved run">✕</button>
  </li>`;
}

/** `onContinue` joins the room with the name and class typed on the home screen. */
export function initSaves(onContinue: (code: string) => Promise<void>) {
  const box = $('#saves');
  const list = $('#saves-list');
  const refreshBtn = $<HTMLButtonElement>('#saves-refresh');
  let seq = 0; // drops answers that arrive after a newer request

  async function refresh(manual = false) {
    const mine = ++seq;
    refreshBtn.disabled = true;
    const saves = await listSaves();
    if (mine !== seq) return;
    refreshBtn.disabled = false;
    if (!saves) {
      if (manual) toast('Could not load the saved runs.');
      return;
    }
    const top = list.scrollTop;
    list.innerHTML = saves.map(saveRow).join('');
    list.scrollTop = top;
    box.hidden = saves.length === 0;
  }

  refreshBtn.addEventListener('click', () => void refresh(true));
  list.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const cont = target.closest<HTMLButtonElement>('[data-continue]');
    if (cont) {
      cont.disabled = true;
      await onContinue(cont.dataset.continue!);
      cont.disabled = false;
      return;
    }
    const arch = target.closest<HTMLButtonElement>('[data-archive]');
    if (!arch) return;
    const code = arch.dataset.archive!;
    if (!confirm(`Archive the saved run ${code}? It will disappear from this list.`)) return;
    arch.disabled = true;
    const res = await deleteSave(code);
    arch.disabled = false;
    if (res.ok) toast(`Saved run ${code} archived.`);
    else toast(res.error ?? 'Could not archive that saved run.');
    void refresh();
  });

  socket.on('connect', () => void refresh());
  if (socket.connected) void refresh();
  // Back on the home screen after a failed rejoin: the list may have changed meanwhile.
  let inRoom = false;
  subscribe(() => {
    const now = store.state !== null;
    if (inRoom && !now) void refresh();
    inRoom = now;
  });
}
