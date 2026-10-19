// Saved runs on disk: saves/<CODE>.json, rewritten at every safe point of a run (on the map, and when the party
// enters a node; never mid-fight). Loading a save puts the party back in the tavern, ready to continue.
// Finished and abandoned runs move to saves/archive/, which keeps the most recent few.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassId, LogLine, Notice, PlayerEntity, RunInfo, SaveSummary } from '../shared/types.ts';

export const SAVE_VERSION = 1;
const ARCHIVE_KEEP = 30;
const CODE_RE = /^[A-Z]{4}$/;
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../saves');

export interface SavedPlayer {
  id: string;
  name: string;
  classId: ClassId;
  color: string;
  bot: boolean;
}

/**
 * Where to pick the run back up: the map vote, a node to replay from its start (a fight, event or rest), or the
 * party's vote after an elite (the fight is won, so it isn't replayed).
 */
export type SavePoint =
  | { kind: 'map' }
  | { kind: 'node'; nodeId: string; eventId?: string }
  | { kind: 'reward'; nodeId: string; choices: string[]; text: string };

export interface SaveFile {
  version: number;
  code: string;
  createdAt: number; // when the run started
  savedAt: number;
  players: SavedPlayer[];
  heroes: PlayerEntity[]; // as they were at the save point
  run: RunInfo;
  seenEvents: string[];
  at: SavePoint;
  notice: Notice | null;
  log: LogLine[]; // the last few lines, for context when you come back
}

/** `DELVERS_SAVES` overrides the folder (tests use a temp dir). */
export const saveDir = () => process.env.DELVERS_SAVES || DEFAULT_DIR;
const fileOf = (code: string) => path.join(saveDir(), `${code}.json`);

export const isSaveCode = (code: unknown): code is string => typeof code === 'string' && CODE_RE.test(code);
export const hasSave = (code: string) => isSaveCode(code) && fs.existsSync(fileOf(code));

/** `DELVERS_SAVES=off` writes nothing (the RL trainer plays thousands of throwaway fights). */
const savesOff = () => process.env.DELVERS_SAVES === 'off';

/** Writes atomically (temp file + rename), so a crash mid-write never leaves a broken save. */
export function writeSave(save: SaveFile) {
  if (savesOff()) return;
  fs.mkdirSync(saveDir(), { recursive: true });
  const file = fileOf(save.code);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(save));
  fs.renameSync(`${file}.tmp`, file);
}

function looksLikeSave(x: unknown): x is SaveFile {
  const s = x as SaveFile;
  return !!s && typeof s.version === 'number' && isSaveCode(s.code) && Array.isArray(s.players) && Array.isArray(s.heroes) && !!s.run?.map;
}

export function readSave(code: string): SaveFile | null {
  if (!isSaveCode(code)) return null;
  try {
    const s: unknown = JSON.parse(fs.readFileSync(fileOf(code), 'utf8'));
    return looksLikeSave(s) && s.version <= SAVE_VERSION ? s : null;
  } catch {
    return null;
  }
}

/** Every save, newest first. */
export function listSaves(): SaveFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(saveDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => /^[A-Z]{4}\.json$/.test(n))
    .map((n) => readSave(n.slice(0, 4)))
    .filter((s): s is SaveFile => !!s)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function summarize(s: SaveFile, online: number): SaveSummary {
  const bots = new Set(s.players.filter((p) => p.bot).map((p) => p.id));
  return {
    code: s.code,
    act: s.run.act,
    actName: s.run.actName,
    savedAt: s.savedAt,
    party: s.heroes.map((h) => ({ name: h.name, classId: h.classId, level: h.level, bot: bots.has(h.playerId) })),
    online,
  };
}

/** Moves a save to the archive (after a win or loss, or when someone throws it away), keeping the newest few. */
export function archiveSave(code: string, outcome: 'victory' | 'defeat' | 'abandoned') {
  if (savesOff() || !hasSave(code)) return;
  const dir = path.join(saveDir(), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  fs.renameSync(fileOf(code), path.join(dir, `${code}-${outcome}-${stamp}.json`));
  const old = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(ARCHIVE_KEEP);
  for (const { n } of old) fs.rmSync(path.join(dir, n), { force: true });
}

/**
 * `DELVERS_FIGHT_DUMP=<dir>`: a copy of the save at the start of every fight, so the RL trainer (training/) can replay
 * real fights with the parties bot runs actually had at that point. One file per fight.
 */
export function dumpFight(save: SaveFile) {
  const dir = process.env.DELVERS_FIGHT_DUMP;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${save.code}-${save.savedAt}-${Math.random().toString(36).slice(2, 6)}.json`), JSON.stringify(save));
}
