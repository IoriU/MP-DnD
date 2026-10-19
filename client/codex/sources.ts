// "Where it lives": the source line that defines an entry, as a small tag like `shared/rules.ts:218`.
// The game's source files are imported as text (?raw, so Node can't load this module) and searched for the line that
// defines the id, so the tags can't go stale. In dev they link to VS Code; in a build they are plain text.

import eventsSrc from '../../server/events.ts?raw';
import elitesSrc from '../../shared/elites.ts?raw';
import enginesSrc from '../../shared/engines.ts?raw';
import itemsSrc from '../../shared/items.ts?raw';
import rulesSrc from '../../shared/rules.ts?raw';
import skillsSrc from '../../shared/skills.ts?raw';
import surfacesSrc from '../../shared/surfaces.ts?raw';
import { MONSTERS } from '../../shared/rules.ts';
import type { EventFight } from './data.ts';

declare const __CODEX_ROOT__: string | undefined; // the project folder, defined by vite.config.ts for the dev server only

const ROOT = import.meta.env.DEV && typeof __CODEX_ROOT__ === 'string' ? __CODEX_ROOT__.replace(/\\/g, '/').replace(/\/$/, '') : null;

const file = (path: string, src: string) => ({ path, lines: src.split('\n') });
const FILES = {
  rules: file('shared/rules.ts', rulesSrc),
  skills: file('shared/skills.ts', skillsSrc),
  items: file('shared/items.ts', itemsSrc),
  elites: file('shared/elites.ts', elitesSrc),
  surfaces: file('shared/surfaces.ts', surfacesSrc),
  engines: file('shared/engines.ts', enginesSrc),
  events: file('server/events.ts', eventsSrc),
};
type FileKey = keyof typeof FILES;

const keyed = (id: string) => new RegExp(`^\\s*${id}:`); // `  rat: m(...)`
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (id: string) => new RegExp(`name: ['"]${reEsc(id)}['"]`); // `name: 'Rat Nest'`

/** Each kind of entry: its file, the line where its table starts, and how to spot the entry's own line inside it. */
const KINDS = {
  class: ['rules', /^export const CLASSES\b/, keyed],
  engine: ['engines', /^export const ENGINES\b/, keyed],
  monster: ['rules', /^export const MONSTERS\b/, keyed],
  act: ['rules', /^export const ACTS\b/, named],
  encounter: ['rules', /^export const ACTS\b/, named],
  role: ['rules', /^export const ROLES\b/, keyed],
  difficulty: ['rules', /^export const DIFFICULTIES\b/, keyed],
  boon: ['rules', /^export const BOONS\b/, keyed],
  order: ['rules', /^export const ORDERS\b/, keyed],
  skill: ['skills', /^const SKILL_DEFS\b/, keyed],
  status: ['skills', /^export const STATUSES\b/, keyed],
  item: ['items', /^const ITEM_DEFS\b/, keyed],
  relic: ['items', /^const RELIC_DEFS\b/, keyed],
  blessing: ['items', /^const BLESSING_DEFS\b/, keyed],
  trait: ['elites', /^export const TRAITS\b/, keyed],
  ally: ['elites', /^export const ALLIES\b/, keyed],
  ground: ['surfaces', /^export const GROUNDS\b/, keyed],
  cloud: ['surfaces', /^export const CLOUDS\b/, keyed],
  prop: ['surfaces', /^export const PROPS\b/, keyed],
  event: ['events', /^const TEMPLATES\b/, (id: string) => new RegExp(`^\\s*id: '${reEsc(id)}',`)],
} satisfies Record<string, [FileKey, RegExp, (id: string) => RegExp]>;

export type SrcKind = keyof typeof KINDS;

/** The 1-based line of the first line matching `key`, searching from the first line matching `section`. */
function locate(f: FileKey, section: RegExp | null, key: RegExp): number | null {
  const lines = FILES[f].lines;
  let i = section ? lines.findIndex((l) => section.test(l)) : 0;
  if (i < 0) return null;
  for (; i < lines.length; i++) if (key.test(lines[i])) return i + 1;
  return null;
}

function tag(f: FileKey, line: number | null): string {
  const { path } = FILES[f];
  const text = line ? `${path}:${line}` : path;
  return ROOT
    ? `<a class="src" href="vscode://file/${ROOT}/${path}${line ? `:${line}` : ''}" title="Open in VS Code">${text}</a>`
    : `<span class="src" title="${text}">${text}</span>`;
}

/** The tag for an entry: `srcTag('monster', 'rat')` -> `shared/rules.ts:215`. */
export function srcTag(kind: SrcKind, id: string): string {
  const [f, section, key] = KINDS[kind];
  return tag(f, locate(f, section, key(id)));
}

/** The tag for a constant or function: `srcConst('XP_SHARED')`. */
export const srcConst = (name: string, f: FileKey = 'rules'): string => tag(f, locate(f, null, new RegExp(`^export (?:const|function) ${name}\\b`)));

// ---------------------------------------------------------------- which monsters an event's fights use

/**
 * Reads server/events.ts as text: the monster ids an event's code names (directly, or through a helper like mimicAttack or a
 * list like GOBLINS), and whether its fights draw from the act's regular pool (a horde(...) with no list of its own).
 * Best effort: it only needs the file to keep its shape (one `id: '...'` line per event, in TEMPLATES).
 */
export function eventFights(ids: string[]): Record<string, EventFight> {
  const lines = FILES.events.lines;
  const start = lines.findIndex((l) => /^const TEMPLATES\b/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^\];/.test(l));
  const monstersIn = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((id) => Object.hasOwn(MONSTERS, id));

  // The helpers and lists above the events: name -> the monsters they name, and whether they start a fight.
  const helpers = new Map<string, { monsters: string[]; fights: boolean }>();
  let cur = '';
  let body: string[] = [];
  const flush = () => {
    const text = body.join('\n');
    if (cur) helpers.set(cur, { monsters: monstersIn(text), fights: /kind: 'fight'/.test(text) });
  };
  for (const l of lines.slice(0, start)) {
    const m = /^(?:function|const) (\w+)/.exec(l);
    if (m) {
      flush();
      cur = m[1];
      body = [];
    }
    body.push(l);
  }
  flush();

  // Each event's block runs from its `id:` line to the next event's.
  const at = ids.map((id) => ({ id, line: locate('events', /^const TEMPLATES\b/, KINDS.event[2](id)) })).filter((x): x is { id: string; line: number } => x.line !== null);
  at.sort((a, b) => a.line - b.line);
  const out: Record<string, EventFight> = {};
  at.forEach(({ id, line }, i) => {
    const text = lines.slice(line - 1, (at[i + 1]?.line ?? end + 1) - 1).join('\n').replace(/\bid: '[a-z_]+'/g, '');
    const used = [...helpers].filter(([name]) => new RegExp(`\\b${name}\\b`).test(text));
    if (!/kind: 'fight'/.test(text) && !used.some(([, h]) => h.fights)) return;
    out[id] = { monsters: [...new Set([...monstersIn(text), ...used.flatMap(([, h]) => h.monsters)])], pool: usesPool(text) };
  });
  return out;
}

/** Does any horde(...) call in this text draw from the act's pool (no `[list]` and no CONSTANT_LIST argument)? */
function usesPool(text: string): boolean {
  for (const m of text.matchAll(/\bhorde\(/g)) {
    const from = m.index! + m[0].length;
    let depth = 1;
    let i = from;
    for (; i < text.length && depth > 0; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    if (!/\[|\b[A-Z][A-Z_]{2,}\b/.test(text.slice(from, i - 1))) return true;
  }
  return false;
}
