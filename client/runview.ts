// The run screens over the canvas: the act map the party votes its path on, the ❓ event panel, the 🔥 rest site,
// and the 🤫 Sneak-or-Charge card that sits over the room before a fight. The event panel also shows what happened in a
// room (a won fight, an event's outcome, a treasure, a rest) until everyone clicks Continue: the map comes after.

import './runview.css';
import { CLASSES, DIFFICULTIES, NODE_INFO, REST_HEAL, stealthBonus } from '../shared/rules.ts';
import { SKILLS, TIER_LABEL, describeSkill, ownedSkill, skillTitle, statsAt, trainOptions, type SkillId } from '../shared/skills.ts';
import type { ActMap, EventView, GameState, MapNode, Notice, PlayerEntity, RestPick, RestState, RunInfo, VoteState } from '../shared/types.ts';
import { blessingsHtml, relicsHtml } from './inventory.ts';
import { picksWaiting } from './levelup.ts';
import { send } from './net.ts';
import { NODE_SPRITES, SPRITE_PX, artKey, iconHtml, spriteHtml, spritesOn } from './sprites.ts';
import { isAuto, me, store } from './store.ts';
import { $, esc, monsterAiTag } from './util.ts';

// ---------------------------------------------------------------- map layout (SVG units)

const COL_W = 80; // horizontal spacing between columns
const ROW_H = 70; // vertical spacing between rows
const PAD_X = 24;
const BOSS_Y = 62; // centre of the boss node
const BOSS_GAP = 100; // boss to the last row
const PAD_BOTTOM = 46;
const NODE_R = 22;
const BOSS_R = 36;
const JITTER_X = 12;
const JITTER_Y = 5;

interface Placed {
  node: MapNode;
  x: number;
  y: number;
  r: number;
  boss: boolean;
}

interface Voter {
  name: string;
  color: string;
  me: boolean;
}

type NodeState = 'visited' | 'current' | 'option' | 'ahead' | 'locked';

// Render keys: the DOM is only rebuilt when what it shows changes, so hover, focus and scroll survive.
let mapKey = '';
let eventKey = '';
let restKey = '';
let approachKey = '';
let scrollKey = ''; // act + position + options: a change means a new vote, so the options get scrolled into view
let pendingScroll = false;
let smoothScroll = false;
let dismissedNotice = '';

/** Deterministic 0..1 from a string, so every client draws the same hand-drawn wobble. */
function hash01(s: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const fx = (n: number) => String(Math.round(n * 10) / 10);
const nodeInfo = (n: MapNode) => NODE_INFO[n.type] ?? { icon: '❔', name: n.type };
const isBoss = (map: ActMap, n: MapNode) => n.id === map.bossId || n.type === 'boss';
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function layout(map: ActMap) {
  const width = map.cols * COL_W + PAD_X * 2;
  const rowY = (row: number) => BOSS_Y + BOSS_GAP + (map.rows - 1 - row) * ROW_H;
  const height = rowY(0) + PAD_BOTTOM;
  const pos = new Map<string, Placed>();
  for (const node of map.nodes) {
    const boss = isBoss(map, node);
    pos.set(
      node.id,
      boss
        ? { node, x: width / 2, y: BOSS_Y, r: BOSS_R, boss }
        : {
            node,
            x: PAD_X + (node.col + 0.5) * COL_W + (hash01(node.id, 1) * 2 - 1) * JITTER_X,
            y: rowY(node.row) + (hash01(node.id, 2) * 2 - 1) * JITTER_Y,
            r: NODE_R,
            boss,
          },
    );
  }
  return { width, height, pos };
}

// ---------------------------------------------------------------- votes & countdown

/** Votes grouped by option, in party order so dots don't shuffle between updates. */
function votersByOption(s: GameState, vote: VoteState | null): Map<string, Voter[]> {
  const out = new Map<string, Voter[]>();
  if (!vote) return out;
  const add = (opt: string, v: Voter) => {
    const list = out.get(opt);
    if (list) list.push(v);
    else out.set(opt, [v]);
  };
  for (const p of s.players) {
    const opt = vote.votes[p.id];
    if (opt !== undefined) add(opt, { name: p.name, color: p.color, me: p.id === store.playerId });
  }
  for (const [pid, opt] of Object.entries(vote.votes)) {
    if (!s.players.some((p) => p.id === pid)) add(opt, { name: '?', color: '#888', me: pid === store.playerId });
  }
  return out;
}

const myVote = (vote: VoteState | null) => (vote && store.playerId ? vote.votes[store.playerId] : undefined);

/** Anything with a countdown: a vote, a rest site or a shop. */
type Timed = { endsInMs: number | null };

function remainingMs(t: Timed | null | undefined): number | null {
  if (!t || t.endsInMs === null) return null;
  return Math.max(0, t.endsInMs - (Date.now() - store.receivedAt));
}

const timerText = (ms: number) => `⏳ ${Math.ceil(ms / 1000)}s`;

export function timerHtml(t: Timed | null, tip = 'Time left to vote'): string {
  const ms = remainingMs(t);
  if (ms === null) return '<span class="rv-pill rv-timer" data-countdown hidden></span>';
  return `<span class="rv-pill rv-timer${ms <= 5000 ? ' urgent' : ''}" data-countdown title="${esc(tip)}">${timerText(ms)}</span>`;
}

function progressHtml(s: GameState, vote: VoteState | null): string {
  if (!vote) return '';
  const voted = Object.keys(vote.votes).length;
  const total = Math.max(voted, s.players.filter((p) => p.connected).length);
  const waiting = s.players.filter((p) => p.connected && vote.votes[p.id] === undefined).map((p) => p.name);
  const title = waiting.length ? ` title="${esc(`Waiting for ${waiting.join(', ')}`)}"` : '';
  return `<span class="rv-progress"${title}>${voted}/${total} voted</span>`;
}

/**
 * An outcome screen waits for the people at the keyboard (bots don't wait): each clicks Continue, and someone on
 * auto-play is ready once their picks are made (auto-play makes them after a while).
 */
const outcomeReady = (s: GameState, vote: VoteState, p: GameState['players'][number]) =>
  vote.votes[p.id] !== undefined || (p.auto && s.autoPicks?.[p.id] === undefined);

function readyHtml(s: GameState, vote: VoteState): string {
  const people = s.players.filter((p) => p.connected && !p.bot);
  const ready = people.filter((p) => outcomeReady(s, vote, p)).length;
  const waiting = people.filter((p) => !outcomeReady(s, vote, p)).map((p) => p.name);
  const title = waiting.length ? ` title="${esc(`Waiting for ${waiting.join(', ')}`)}"` : '';
  return `<span class="rv-progress"${title}>${ready}/${people.length} ready</span>`;
}

function outcomeStatusHtml(s: GameState, vote: VoteState | null, picks: number): string {
  if (!vote) return '<span class="rv-status">The party is on the move…</span>';
  if (myVote(vote) === undefined) return `<span class="rv-status go">${picks ? 'Pick your spoils, then continue' : 'Continue when you are ready'}</span>`;
  const waiting = s.players
    .filter((p) => p.connected && !p.bot && !outcomeReady(s, vote, p))
    .map((p) => `${esc(p.name)}${p.auto ? ' (still picking)' : ''}`);
  return `<span class="rv-status">${waiting.length ? `Waiting for ${waiting.join(' and ')}…` : 'Moving on…'}</span>`;
}

function statusHtml(vote: VoteState | null, ask: string): string {
  if (!vote) return '<span class="rv-status">The party is on the move…</span>';
  return myVote(vote) !== undefined
    ? '<span class="rv-status">Waiting for the party…</span>'
    : `<span class="rv-status go">${ask}</span>`;
}

function updateCountdowns(selector: string, t: Timed | null | undefined) {
  const ms = remainingMs(t);
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.hidden = ms === null;
    if (ms === null) continue;
    el.textContent = timerText(ms);
    el.classList.toggle('urgent', ms <= 5000);
  }
}

function tick() {
  updateCountdowns('#map-view [data-countdown], #event-view [data-countdown], #approach-view [data-countdown]', store.state?.vote);
  updateCountdowns('#rest-view [data-countdown]', store.state?.rest);
  const auto = remainingMs(store.state?.rest ? { endsInMs: store.state.rest.autoInMs } : null);
  if (auto !== null) for (const el of document.querySelectorAll<HTMLElement>('#rest-view [data-autorest]')) el.textContent = `${Math.ceil(auto / 1000)}s`;
  updateCountdowns('#shop-view [data-countdown]', store.state?.shop);
  if (pendingScroll) scrollToFocus();
}

function castVote(kind: VoteState['kind'], option: string) {
  const v = store.state?.vote;
  if (!v || v.kind !== kind || !v.options.includes(option)) return;
  if (myVote(v) === option) return;
  send('vote', option);
}

// ---------------------------------------------------------------- setup

export function initRunView(): void {
  const mapView = $('#map-view');
  const eventView = $('#event-view');

  mapView.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-dismiss]')) {
      const n = store.state?.notice;
      if (n) dismissedNotice = noticeKey(n);
      if (store.state) renderRunView(store.state);
      return;
    }
    const opt = t.closest('[data-vote]')?.getAttribute('data-vote');
    if (opt != null) castVote('path', opt);
  });
  // Option nodes are focusable SVG groups with role="button": make Enter and Space work like a click.
  mapView.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const opt = (e.target as Element).closest('[data-vote]')?.getAttribute('data-vote');
    if (opt == null) return;
    e.preventDefault();
    castVote('path', opt);
  });

  eventView.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-vote]');
    const opt = b?.getAttribute('data-vote');
    if (b && !b.disabled && opt != null) castVote(store.state?.vote?.kind === 'continue' ? 'continue' : 'event', opt);
  });

  $('#approach-view').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-vote]');
    const opt = b?.getAttribute('data-vote');
    if (b && !b.disabled && opt != null) castVote('approach', opt);
  });

  $('#rest-view').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-rest]');
    if (b && !b.disabled) castRest(b);
  });

  window.setInterval(tick, 250);
}

// ---------------------------------------------------------------- render

export function renderRunView(s: GameState): void {
  const mapView = $('#map-view');
  const eventView = $('#event-view');
  if (!mapView || !eventView) return;

  if (s.phase === 'map' && s.run) {
    renderMap(mapView, s, s.run);
  } else {
    mapView.hidden = true;
    mapKey = '';
    scrollKey = '';
    pendingScroll = false;
  }

  if (s.phase === 'event' && s.event) {
    renderEvent(eventView, s, s.event);
  } else {
    eventView.hidden = true;
    eventKey = '';
  }

  const restView = $('#rest-view');
  if (s.phase === 'rest' && s.rest) {
    renderRest(restView, s, s.rest);
  } else {
    restView.hidden = true;
    restKey = '';
  }

  renderApproach($('#approach-view'), s);
}

/** Remembers which vote button had keyboard focus, so a rebuild doesn't drop it. */
function focusedVote(view: HTMLElement): string | null {
  const a = document.activeElement;
  return a && view.contains(a) ? a.closest('[data-vote]')?.getAttribute('data-vote') ?? null : null;
}

function refocus(view: HTMLElement, id: string | null) {
  if (id === null) return;
  for (const el of view.querySelectorAll<HTMLElement | SVGElement>('[data-vote]')) {
    if (el.getAttribute('data-vote') === id) return el.focus();
  }
}

const noticeKey = (n: Notice) => `${n.glyph}|${n.title}|${n.text}`;

function renderMap(view: HTMLElement, s: GameState, run: RunInfo) {
  const wasVisible = !view.hidden;
  view.hidden = false;
  const vote = s.vote?.kind === 'path' ? s.vote : null;
  const notice = s.notice && noticeKey(s.notice) !== dismissedNotice ? s.notice : null;

  const key = JSON.stringify([
    store.playerId,
    run,
    vote && [vote.options, vote.votes, vote.endsInMs === null],
    notice,
    s.players.map((p) => [p.id, p.name, p.color, p.connected]),
    artKey(),
  ]);
  if (key !== mapKey) {
    mapKey = key;
    const focused = focusedVote(view);
    const top = view.scrollTop;
    view.innerHTML = mapHtml(s, run, vote, notice);
    view.scrollTop = top;
    refocus(view, focused);
  }

  const sk = `${run.act}|${run.currentId ?? ''}|${vote ? vote.options.join(',') : ''}`;
  if (sk !== scrollKey) {
    scrollKey = sk;
    pendingScroll = true;
    smoothScroll = wasVisible;
    scrollToFocus();
  }
}

/** Scrolls the options (or where the party stands) into the lower part of the view, leaving the rows ahead visible. */
function scrollToFocus() {
  const view = $('#map-view');
  if (!view || view.hidden || !view.clientHeight) return; // not laid out yet: the tick retries
  pendingScroll = false;
  const targets = view.querySelectorAll('[data-focus]');
  if (!targets.length) return;
  const box = view.getBoundingClientRect();
  let lo = Infinity;
  let hi = -Infinity;
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    lo = Math.min(lo, r.top - box.top + view.scrollTop);
    hi = Math.max(hi, r.bottom - box.top + view.scrollTop);
  }
  const head = view.querySelector<HTMLElement>('.rv-top')?.offsetHeight ?? 0;
  const visible = view.clientHeight - head;
  const want = hi - lo > visible ? lo - head - 8 : (lo + hi) / 2 - head - visible * 0.62;
  const top = Math.max(0, Math.min(view.scrollHeight - view.clientHeight, want));
  view.scrollTo({ top, behavior: smoothScroll && !reducedMotion() ? 'smooth' : 'auto' });
}

function mapHtml(s: GameState, run: RunInfo, vote: VoteState | null, notice: Notice | null): string {
  const types = new Set(run.map.nodes.map((n) => n.type));
  const legend = (Object.keys(NODE_INFO) as (keyof typeof NODE_INFO)[])
    .filter((t) => types.has(t))
    .map((t) => `<span class="rv-leg t-${t}"><span class="rv-leg-ic">${iconHtml(NODE_SPRITES[t], NODE_INFO[t].icon, SPRITE_PX)}</span>${NODE_INFO[t].name}</span>`)
    .join('');

  const diff = DIFFICULTIES[run.difficulty];
  const ai = monsterAiTag(run.monsterAi); // only when the monsters are played by the PPO policy
  return `<div class="rv-top">
      <header class="rv-head">
        <div class="rv-title">Act ${run.act} of ${run.maxAct} · ${esc(run.actName)}</div>
        <div class="rv-sub">
          ${statusHtml(vote, 'Vote for the next room')}${progressHtml(s, vote)}
          <span class="rv-stats">${timerHtml(vote)}<span class="rv-pill" title="${esc(`${diff.name}: ${diff.desc}`)}">${diff.icon} ${diff.name}</span>${ai ? `<span class="rv-pill" title="${esc(ai.tip)}">${ai.label}</span>` : ''}<span class="rv-pill gold" title="Party gold">💰 ${run.gold}</span></span>
        </div>
        ${run.relics.length || run.blessings.length ? `<div class="rv-relics" title="The party's relics and blessings">${relicsHtml(run.relics)}${blessingsHtml(run.blessings)}</div>` : ''}
      </header>
      ${notice ? noticeHtml(notice) : ''}
    </div>
    <div class="rv-body">
      <div class="rv-map">${mapSvg(s, run, vote)}</div>
      <div class="rv-legend">${legend}</div>
    </div>`;
}

function noticeHtml(n: Notice): string {
  return `<div class="rv-notice" role="status">
    <div class="rv-notice-glyph">${esc(n.glyph)}</div>
    <div class="rv-notice-body"><div class="rv-notice-title">${esc(n.title)}</div><div class="rv-notice-text">${esc(n.text)}</div></div>
    <button type="button" class="rv-notice-close" data-dismiss title="Dismiss" aria-label="Dismiss">×</button>
  </div>`;
}

function mapSvg(s: GameState, run: RunInfo, vote: VoteState | null): string {
  const map = run.map;
  const { width, height, pos } = layout(map);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const options = new Set(vote?.options.filter((id) => byId.has(id)) ?? []);
  const mine = myVote(vote);
  const voters = votersByOption(s, vote);
  const current = run.currentId ? byId.get(run.currentId) : undefined;

  const visited = new Set(run.visited);
  if (run.currentId) visited.add(run.currentId);
  const path = [...run.visited];
  if (run.currentId && path[path.length - 1] !== run.currentId) path.push(run.currentId);
  const taken = new Set<string>();
  for (let i = 1; i < path.length; i++) {
    if (byId.get(path[i - 1])?.next.includes(path[i])) taken.add(`${path[i - 1]}>${path[i]}`);
  }

  // Everything still reachable from here: drawn brighter than the branches the party can no longer take.
  const frontier = options.size ? [...options] : current ? current.next : map.nodes.filter((n) => n.row === 0).map((n) => n.id);
  const ahead = new Set<string>();
  const stack = [...frontier];
  while (stack.length) {
    const id = stack.pop()!;
    const n = byId.get(id);
    if (!n || ahead.has(id)) continue;
    ahead.add(id);
    stack.push(...n.next);
  }

  // Edges, dim ones first so the taken path and the open choices draw on top.
  const layers: Record<'dim' | 'ahead' | 'taken' | 'open', string[]> = { dim: [], ahead: [], taken: [], open: [] };
  for (const n of map.nodes) {
    const a = pos.get(n.id)!;
    for (const to of n.next) {
      const b = pos.get(to);
      if (!b) continue;
      const kind = taken.has(`${n.id}>${to}`)
        ? 'taken'
        : n.id === run.currentId && options.has(to)
          ? 'open'
          : ahead.has(n.id) && ahead.has(to)
            ? 'ahead'
            : 'dim';
      const line = edgeSvg(a, b, kind);
      if (line) layers[kind].push(line);
    }
  }

  // Scroll target: the options, else where the party stands, else the first row.
  const focus = new Set(options.size ? options : current ? [current.id] : map.nodes.filter((n) => n.row === 0).map((n) => n.id));

  const nodes = map.nodes
    .map((n) => {
      const p = pos.get(n.id)!;
      const state: NodeState =
        n.id === run.currentId ? 'current' : options.has(n.id) ? 'option' : visited.has(n.id) ? 'visited' : ahead.has(n.id) ? 'ahead' : 'locked';
      return nodeSvg(p, state, mine === n.id, focus.has(n.id), voters.get(n.id) ?? []);
    })
    .join('');

  return `<svg class="rv-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Act ${run.act} map">
    <g class="rv-edges">${layers.dim.join('')}${layers.ahead.join('')}${layers.taken.join('')}${layers.open.join('')}</g>
    <g class="rv-nodes">${nodes}</g>
  </svg>`;
}

/** A line between two nodes, trimmed so it stops just short of both circles. */
function edgeSvg(a: Placed, b: Placed, kind: string): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const s = a.r + 5;
  const e = b.r + 5;
  if (len <= s + e) return '';
  const ux = dx / len;
  const uy = dy / len;
  return `<line class="rv-edge ${kind}" x1="${fx(a.x + ux * s)}" y1="${fx(a.y + uy * s)}" x2="${fx(b.x - ux * e)}" y2="${fx(b.y - uy * e)}"/>`;
}

function nodeSvg(p: Placed, state: NodeState, mine: boolean, focus: boolean, voters: Voter[]): string {
  const info = nodeInfo(p.node);
  const opt = state === 'option';
  const suffix = opt
    ? mine
      ? ' (your vote)'
      : ' (click to vote)'
    : state === 'current'
      ? ' (the party is here)'
      : state === 'visited'
        ? ' (visited)'
        : '';
  const label = `${info.name}${suffix}`;
  const cls = `rv-node t-${esc(p.node.type)} ${state}${p.boss ? ' boss' : ''}${mine ? ' mine' : ''}`;
  const attrs = opt ? ` data-vote="${esc(p.node.id)}" role="button" tabindex="0" aria-label="${esc(label)}"` : '';
  return `<g class="${cls}" transform="translate(${fx(p.x)} ${fx(p.y)})"${attrs}${focus ? ' data-focus' : ''}>
    <title>${esc(label)}</title>
    ${opt ? `<circle class="rv-hit" r="${p.r + 12}"/><circle class="rv-halo" r="${p.r + 5}"/>` : ''}
    ${state === 'current' ? `<circle class="rv-cur" r="${p.r + 7}"/>` : ''}
    <circle class="rv-disc" r="${p.r}"/>
    ${nodeIcon(p)}
    ${mine ? `<circle class="rv-mine" r="${p.r + 5}"/>` : ''}
    ${dotsSvg(voters, p.r)}
  </g>`;
}

/** A node's icon: its sprite at 2x (3x for the boss) in a box over the disc, or the emoji when there's no art. */
function nodeIcon(p: Placed): string {
  const px = p.boss ? 3 * SPRITE_PX : 2 * SPRITE_PX;
  const sprite = spritesOn() ? spriteHtml(NODE_SPRITES[p.node.type], px) : '';
  if (!sprite) return `<text class="rv-icon" dy="0.35em">${nodeInfo(p.node).icon}</text>`;
  return `<foreignObject class="rv-sprite" x="${-px / 2}" y="${-px / 2}" width="${px}" height="${px}">${sprite}</foreignObject>`;
}

/** Voter dots in a small arc above a node. */
function dotsSvg(voters: Voter[], r: number): string {
  const d = r + 11;
  const step = ((r > 30 ? 17 : 26) * Math.PI) / 180;
  return voters
    .map((v, i) => {
      const a = -Math.PI / 2 + (i - (voters.length - 1) / 2) * step;
      return `<g class="rv-vdot${v.me ? ' me' : ''}" transform="translate(${fx(Math.cos(a) * d)} ${fx(Math.sin(a) * d)})">
        <title>${esc(v.me ? `${v.name} (you)` : v.name)}</title>
        ${v.me ? '<circle class="rv-vdot-ring" r="9.5"/>' : ''}<circle r="6" fill="${esc(v.color)}"/>
      </g>`;
    })
    .join('');
}

// ---------------------------------------------------------------- event

function renderEvent(view: HTMLElement, s: GameState, ev: EventView) {
  view.hidden = false;
  const vote = s.vote?.kind === 'event' || s.vote?.kind === 'continue' ? s.vote : null;
  const key = JSON.stringify([
    store.playerId,
    ev,
    vote && [vote.kind, vote.options, vote.votes, vote.endsInMs === null],
    s.run?.gold,
    picksWaiting(s),
    Object.keys(s.autoPicks ?? {}),
    s.players.map((p) => [p.id, p.name, p.color, p.connected, p.auto]),
  ]);
  if (key === eventKey) return;
  eventKey = key;
  const focused = focusedVote(view);
  const panelTop = view.querySelector('.rv-event-panel')?.scrollTop ?? 0;
  view.innerHTML = eventHtml(s, ev, vote);
  const panel = view.querySelector('.rv-event-panel');
  if (panel) panel.scrollTop = panelTop;
  refocus(view, focused);
}

function eventHtml(s: GameState, ev: EventView, vote: VoteState | null): string {
  const options = new Set(vote?.options ?? []);
  const voters = votersByOption(s, vote);
  const mine = myVote(vote);
  const outcome = vote ? vote.kind === 'continue' : ev.choices.length === 1 && ev.choices[0].id === 'continue';
  const picks = picksWaiting(s);
  const choices = ev.choices
    .map((c) => {
      const ok = options.has(c.id);
      const isMine = mine === c.id;
      const dots = (voters.get(c.id) ?? [])
        .map((v) => `<span class="rv-dot${v.me ? ' me' : ''}" style="background:${esc(v.color)}" title="${esc(v.me ? `${v.name} (you)` : v.name)}"></span>`)
        .join('');
      return `<button type="button" class="rv-choice${isMine ? ' mine' : ''}" data-vote="${esc(c.id)}"${ok ? ` aria-pressed="${isMine}"` : ' disabled title="Not available right now"'}>
        <span class="rv-choice-main">
          <span class="rv-choice-label">${esc(c.label)}</span>
          ${c.hint ? `<span class="rv-choice-hint">${esc(c.hint)}</span>` : ''}
        </span>
        <span class="rv-voters">${isMine ? `<span class="rv-mine-tag">${outcome ? '✓ Ready' : 'Your vote'}</span>` : ''}${dots}</span>
      </button>`;
    })
    .join('');

  const lines = ev.lines?.length ? `<ul class="rv-event-lines">${ev.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  const spoils = picks
    ? `<p class="rv-event-picks">🏆 You have ${picks === 1 ? 'a pick' : `${picks} picks`} waiting in the corner (<kbd>L</kbd>).${outcome ? " Whatever you don't pick now waits for you on the map." : ''}</p>`
    : '';
  return `<div class="rv-event-panel${outcome ? ' rv-outcome' : ''}" role="dialog" aria-labelledby="rv-event-title">
    <div class="rv-event-glyph">${esc(ev.glyph)}</div>
    <h2 id="rv-event-title" class="rv-event-title">${esc(ev.title)}</h2>
    ${ev.chosen ? `<p class="rv-event-chosen">You chose: <b>${esc(ev.chosen)}</b></p>` : ''}
    <p class="rv-event-text">${esc(ev.text)}</p>
    ${lines}
    ${spoils}
    <div class="rv-event-end">
      <div class="rv-choices">${choices}</div>
      <div class="rv-event-foot">
        <span class="rv-sub">${outcome ? `${outcomeStatusHtml(s, vote, picks)}${vote ? readyHtml(s, vote) : ''}` : `${statusHtml(vote, 'Vote on what to do')}${progressHtml(s, vote)}`}</span>
        <span class="rv-stats">${timerHtml(vote, outcome ? 'Moving on in' : undefined)}${s.run ? `<span class="rv-pill gold" title="Party gold">💰 ${s.run.gold}</span>` : ''}</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- rest site

const same = (a: RestPick | undefined, b: RestPick) =>
  !!a && a.kind === b.kind && (a.kind !== 'train' || (b.kind === 'train' && a.skill === b.skill && a.branch === b.branch));

/** Sends the pick a rest button stands for (a player may change their pick until the rest resolves). */
function castRest(b: HTMLElement) {
  const rest = store.state?.rest;
  if (!rest) return;
  const skill = b.dataset.skill as SkillId | undefined;
  const branch = b.dataset.branch as 'A' | 'B' | undefined;
  const pick: RestPick = b.dataset.rest === 'train' && skill ? { kind: 'train', skill, ...(branch ? { branch } : {}) } : { kind: 'long' };
  if (same(store.playerId ? rest.picks[store.playerId] : undefined, pick)) return;
  send('rest', pick);
}

const restFocusId = (view: HTMLElement): string | null => {
  const a = document.activeElement;
  const b = a && view.contains(a) ? a.closest<HTMLElement>('[data-rest]') : null;
  return b ? `${b.dataset.rest}|${b.dataset.skill ?? ''}|${b.dataset.branch ?? ''}` : null;
};

function renderRest(view: HTMLElement, s: GameState, rest: RestState) {
  view.hidden = false;
  const m = me();
  const key = JSON.stringify([
    store.playerId,
    rest.picks,
    rest.endsInMs === null,
    rest.autoInMs === null,
    m && [m.hp, m.maxHp, m.slots, m.maxSlots, m.level, m.dead, m.skills.map((o) => [o.id, o.tier, o.branch])],
    s.players.map((p) => [p.id, p.name, p.color, p.connected, p.auto, p.bot]),
  ]);
  if (key === restKey) return;
  restKey = key;
  const focused = restFocusId(view);
  const panelTop = view.querySelector('.rv-event-panel')?.scrollTop ?? 0;
  view.innerHTML = restHtml(s, rest, m);
  const panel = view.querySelector('.rv-event-panel');
  if (panel) panel.scrollTop = panelTop;
  if (focused) {
    for (const el of view.querySelectorAll<HTMLElement>('[data-rest]')) {
      if (`${el.dataset.rest}|${el.dataset.skill ?? ''}|${el.dataset.branch ?? ''}` === focused) return el.focus();
    }
  }
}

const descHtml = (text: string, cls = 'rv-choice-hint') => `<span class="${cls} rv-pre">${esc(text)}</span>`;

function restChoice(attrs: string, mine: boolean, label: string, body: string): string {
  return `<button type="button" class="rv-choice${mine ? ' mine' : ''}" ${attrs} aria-pressed="${mine}">
    <span class="rv-choice-main"><span class="rv-choice-label">${label}</span>${body}</span>
    ${mine ? '<span class="rv-voters"><span class="rv-mine-tag">Your pick</span></span>' : ''}
  </button>`;
}

/** One trainable skill: tier II is a single button, tier III asks for a branch. */
export function trainHtml(m: PlayerEntity, opt: { skill: SkillId; tier: 2 | 3 }, mine: RestPick | undefined): string {
  const own = ownedSkill(m, opt.skill)!;
  const st = statsAt(opt.skill, own.tier, own.branch);
  const now = descHtml(`Now: ${describeSkill(opt.skill, own.tier, own.branch, m)}`, 'rv-choice-hint now');
  if (opt.tier === 2) {
    const picked = mine?.kind === 'train' && mine.skill === opt.skill;
    return restChoice(
      `data-rest="train" data-skill="${opt.skill}"`, picked,
      `${st.icon} ${esc(skillTitle(own))} → ${TIER_LABEL(2)}`,
      `${now}${descHtml(`Next: ${describeSkill(opt.skill, 2, undefined, m)}`, 'rv-choice-hint next')}`,
    );
  }
  const branches = (['A', 'B'] as const)
    .map((br) => {
      const next = statsAt(opt.skill, 3, br);
      const picked = mine?.kind === 'train' && mine.skill === opt.skill && mine.branch === br;
      return restChoice(
        `data-rest="train" data-skill="${opt.skill}" data-branch="${br}"`, picked,
        `${next.icon} ${esc(next.name)} <span class="muted">(${TIER_LABEL(3, br)})</span>`,
        descHtml(describeSkill(opt.skill, 3, br, m), 'rv-choice-hint next'),
      );
    })
    .join('');
  return `<div class="rv-train-group"><div class="rv-train-title">${st.icon} ${esc(skillTitle(own))} → tier III: pick a branch</div>${now}${branches}</div>`;
}

function pickLabel(s: GameState, playerId: string, pick: RestPick | undefined): string {
  if (!pick) return '<span class="muted">deciding…</span>';
  if (pick.kind === 'long') return '🛌 Long Rest';
  const hero = s.entities.find((e): e is PlayerEntity => e.kind === 'player' && e.playerId === playerId);
  const tier = hero ? ownedSkill(hero, pick.skill)?.tier : undefined;
  const to = tier ? ` → ${TIER_LABEL(tier + 1, pick.branch)}` : '';
  return `📖 Training ${esc(SKILLS[pick.skill]?.base.name ?? pick.skill)}${to}`;
}

function picksHtml(s: GameState, rest: RestState): string {
  return s.players
    .map((p) => {
      const auto = p.bot || isAuto(s, p.id) ? ' <span title="Auto-play picks for them">🤖</span>' : '';
      const you = p.id === store.playerId ? ' <span class="muted">(you)</span>' : '';
      return `<li><span class="rv-dot" style="background:${esc(p.color)}"></span><b>${esc(p.name)}</b>${you}${auto}<span class="rv-pick">${pickLabel(s, p.id, rest.picks[p.id])}</span></li>`;
    })
    .join('');
}

function restHtml(s: GameState, rest: RestState, m: PlayerEntity | undefined): string {
  const mine = store.playerId ? rest.picks[store.playerId] : undefined;
  const names = m ? CLASSES[m.classId].names : null;
  const options = m ? trainOptions(m) : [];
  const decided = Object.keys(rest.picks).length;
  const total = Math.max(decided, s.players.filter((p) => p.connected).length);
  const autoOn = !!s.players.find((p) => p.id === store.playerId)?.auto;

  const long = m
    ? restChoice(
        'data-rest="long"', mine?.kind === 'long', '🛌 Long Rest',
        `<span class="rv-choice-hint">Heal ${Math.round(REST_HEAL * 100)}% of your max HP and restore all your ${esc(names!.slots)}.</span>
         <span class="rv-rest-now">❤️ ${m.hp} / ${m.maxHp} HP · 🔮 ${m.slots} / ${m.maxSlots} ${esc(names!.slots)}</span>`,
      )
    : '';
  const train = m
    ? options.length
      ? options.map((o) => trainHtml(m, o, mine)).join('')
      : '<button type="button" class="rv-choice" disabled><span class="rv-choice-main"><span class="rv-choice-label">Nothing to train</span><span class="rv-choice-hint">Your cantrips and spells are at their top tier for now (tier III needs a higher level).</span></span></button>'
    : '';

  return `<div class="rv-event-panel rv-rest-panel" role="dialog" aria-labelledby="rv-rest-title">
    <div class="rv-event-glyph">🔥</div>
    <h2 id="rv-rest-title" class="rv-event-title">Rest site</h2>
    <p class="rv-event-text">The party makes camp. Each hero chooses how to spend the night.</p>
    <div class="rv-choices">${long}</div>
    ${m ? `<div class="rv-train"><div class="rv-train-head">📖 Train <span class="muted">upgrade one cantrip or spell a tier</span></div><div class="rv-choices">${train}</div></div>` : ''}
    <ul class="rv-picks">${picksHtml(s, rest)}</ul>
    <div class="rv-event-foot">
      <span class="rv-sub"><span class="rv-status${m && !mine ? ' go' : ''}">${m && !mine ? `Pick how to rest${autoOn && rest.autoInMs !== null ? ' · 🤖 auto-play picks for you in <b data-autorest></b>' : ''}` : 'Waiting for the party…'}</span><span class="rv-progress">${decided}/${total} decided</span></span>
      <span class="rv-stats">${timerHtml(rest, 'Time left. Anyone undecided takes a Long Rest.')}${s.run ? `<span class="rv-pill gold" title="Party gold">💰 ${s.run.gold}</span>` : ''}</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- approach: Sneak or Charge

/** One hero's chance to beat the group Stealth DC: d20 + bonus >= dc. */
const stealthChance = (bonus: number, dc: number) => Math.min(0.95, Math.max(0.05, (21 + bonus - dc) / 20));

/** The chance that at least `need` of the heroes pass, each with a chance of their own (a Poisson binomial). */
function groupChance(chances: number[], need: number): number {
  let exactly = [1]; // exactly[k]: the chance that k of the heroes counted so far passed
  for (const p of chances) {
    const next = new Array<number>(exactly.length + 1).fill(0);
    exactly.forEach((q, k) => {
      next[k] += q * (1 - p);
      next[k + 1] += q * p;
    });
    exactly = next;
  }
  return exactly.slice(need).reduce((a, b) => a + b, 0);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const tone = (p: number) => (p >= 0.65 ? 'good' : p >= 0.35 ? 'warn' : 'bad');
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const hasAlert = (h: PlayerEntity) => h.skills.some((o) => o.id === 'alert');

function renderApproach(view: HTMLElement, s: GameState) {
  const vote = s.vote?.kind === 'approach' ? s.vote : null;
  if (s.phase !== 'combat' || !vote || !s.approach) {
    view.hidden = true;
    approachKey = '';
    return;
  }
  view.hidden = false;
  const heroes = s.entities.filter((e): e is PlayerEntity => e.kind === 'player' && !e.dead && !e.downed); // the ones who roll
  const key = JSON.stringify([
    store.playerId,
    s.approach.dc,
    vote.options,
    vote.votes,
    vote.endsInMs === null,
    heroes.map((h) => [h.id, h.name, h.color, h.classId, h.level, hasAlert(h)]),
    s.players.map((p) => [p.id, p.name, p.color, p.connected, p.auto, p.bot]),
  ]);
  if (key === approachKey) return;
  approachKey = key;
  const focused = focusedVote(view);
  const top = view.querySelector('.ap-card')?.scrollTop ?? 0;
  view.innerHTML = approachHtml(s, vote, s.approach.dc, heroes);
  const card = view.querySelector('.ap-card');
  if (card) card.scrollTop = top;
  refocus(view, focused);
}

function approachHtml(s: GameState, vote: VoteState, dc: number, heroes: PlayerEntity[]): string {
  const voters = votersByOption(s, vote);
  const mine = myVote(vote);
  const chances = heroes.map((h) => stealthChance(stealthBonus(h), dc));
  const need = Math.ceil(heroes.length / 2);
  const group = heroes.length ? groupChance(chances, need) : 0;

  // Auto-play follows the humans, so only they count toward "voted".
  const humans = s.players.filter((p) => p.connected && !p.bot && !p.auto);
  const pool = humans.length ? humans : s.players.filter((p) => p.connected);
  const waiting = pool.filter((p) => vote.votes[p.id] === undefined).map((p) => p.name);
  const waitTip = waiting.length ? ` title="${esc(`Waiting for ${waiting.join(', ')}`)}"` : '';
  const progress = `<span class="rv-progress"${waitTip}>${pool.length - waiting.length}/${pool.length} voted</span>`;
  const iFollow = humans.length > 0 && !humans.some((p) => p.id === store.playerId);
  const status =
    mine !== undefined
      ? '<span class="rv-status">Waiting for the party…</span>'
      : iFollow
        ? '<span class="rv-status">🤖 Auto-play follows the humans (you can still vote).</span>'
        : '<span class="rv-status go">Vote on how to start the fight</span>';

  const option = (id: string, label: string, body: string) => {
    const isMine = mine === id;
    const dots = (voters.get(id) ?? [])
      .map((v) => `<span class="rv-dot${v.me ? ' me' : ''}" style="background:${esc(v.color)}" title="${esc(v.me ? `${v.name} (you)` : v.name)}"></span>`)
      .join('');
    return `<button type="button" class="rv-choice ap-opt${isMine ? ' mine' : ''}" data-vote="${id}" aria-pressed="${isMine}">
      <span class="ap-opt-head"><span class="rv-choice-label">${label}</span><span class="rv-voters">${isMine ? '<span class="rv-mine-tag">Your vote</span>' : ''}${dots}</span></span>
      ${body}
    </button>`;
  };

  const rows = heroes
    .map((h, i) => {
      const bonus = stealthBonus(h);
      const alert = hasAlert(h);
      const tip = `${h.name}: d20 ${signed(bonus)} against DC ${dc}, so a ${Math.max(1, dc - bonus)} or higher passes (${pct(chances[i])})${
        alert ? "\nAlert: can't be surprised, even if the party is spotted." : ''
      }`;
      const alertTag = alert ? `<span>${SKILLS.alert.base.icon}</span>` : '';
      return `<li title="${esc(tip)}"><span class="rv-dot" style="background:${esc(h.color)}"></span><b>${esc(h.name)}</b>${alertTag}<span class="muted">${signed(bonus)}</span><span class="ap-pct ${tone(chances[i])}">${pct(chances[i])}</span></li>`;
    })
    .join('');

  const sneak = option(
    'sneak',
    '🤫 Sneak',
    `<span class="rv-choice-hint">Group Stealth vs DC ${dc}; at least half the party must pass.</span>
     <span class="rv-choice-hint">Success: they lose their first turn. Failure: you lose yours.</span>
     ${heroes.length ? `<span class="ap-odds ${tone(group)}">${pct(group)} to succeed</span>` : ''}`,
  );
  const charge = option('charge', '⚔️ Charge', '<span class="rv-choice-hint">A normal start.</span>');
  const check = heroes.length
    ? `<div class="ap-check">🎲 Stealth: d20 + bonus vs DC ${dc}. Need ${need} of ${heroes.length} to pass.</div><ul class="ap-heroes">${rows}</ul>`
    : '';

  return `<div class="ap-card" role="dialog" aria-labelledby="ap-title">
    <div class="ap-head">
      <h2 id="ap-title" class="ap-title">🤫 Sneak or ⚔️ Charge?</h2>
      <span class="rv-stats">${timerHtml(vote)}</span>
    </div>
    <div class="rv-sub">${status}${progress}</div>
    <div class="ap-options">${sneak}${charge}</div>
    ${check}
  </div>`;
}
