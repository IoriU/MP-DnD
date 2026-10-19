import { ENGINES } from '../shared/engines.ts';
import { CLASSES, MONSTER_AIS, type MonsterAi } from '../shared/rules.ts';
import { topEngine, type StatusId } from '../shared/skills.ts';
import { SUBCLASSES } from '../shared/subclasses.ts';
import type { PlayerEntity, StatusInst } from '../shared/types.ts';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** The run's monster AI as a short label with a tooltip, only when it isn't the default scripted one ("🧠 PPO"). */
export function monsterAiTag(ai: MonsterAi | undefined): { label: string; tip: string } | null {
  if (ai !== 'ppo') return null;
  const def = MONSTER_AIS.ppo;
  return { label: `${def.icon} PPO`, tip: `${def.name}: ${def.desc}` };
}

/** "Fighter", or "Fighter · Guardian" once the hero's picks lean into an engine (an old save's subclass counts too). */
export function classLabel(h: Pick<PlayerEntity, 'classId' | 'subclass' | 'skills'>): string {
  const engine = topEngine(h);
  const name = engine ? ENGINES[engine].name : h.subclass ? SUBCLASSES[h.subclass]?.name : undefined;
  return name ? `${CLASSES[h.classId].name} · ${name}` : CLASSES[h.classId].name;
}

/** Statuses whose power is a stack count, shown after the icon when there is more than one ("🤢5"). */
const STACKED: StatusId[] = ['poisoned', 'charged', 'unleashed', 'seared', 'aiming', 'verse', 'inspired', 'rallied', 'drained'];
export const stacksShown = (x: Pick<StatusInst, 'id' | 'power'>): number => (STACKED.includes(x.id) && (x.power ?? 0) > 1 ? x.power! : 0);

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

// localStorage can throw in private windows; it only holds conveniences like your last name.
export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(`delvers.${key}`);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`delvers.${key}`, value);
  } catch {
    /* ignore */
  }
}
