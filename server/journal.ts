// The run journal (Phase 13, for analyzing real playtests): everything a run does, one JSON object per line, in
// saves/journal/<code>-<started>.jsonl. Unlike the save (the last safe point and 30 log lines) it keeps the whole
// story: every log line, each fight's numbers, every pick with the cards that were offered, and how the run ended.
// The game never trims or deletes it. `node scripts/journal-report.ts <file>` reads it back.
//
// Lines are buffered and written in batches (at each map step, every few hundred lines, and when the run ends), so a
// crash loses at most the current fight's tail.

import fs from 'node:fs';
import path from 'node:path';
import { saveDir } from './saves.ts';

/** What a journal line can be. `t` (ms since 1970) is added to each one. */
export type JournalEntry =
  | { k: 'start'; code: string; resumed: boolean; difficulty: string; monsterAi: string; party: { name: string; classId: string; bot: boolean }[] }
  | { k: 'log'; kind: string; text: string; act?: number; round?: number }
  | { k: 'node'; act: number; row: number; type: string }
  | { k: 'fight'; act: number; row: number; kind: string; name: string; monsters: string[]; deployment: string; heroes: { name: string; classId: string; level: number; hp: number; maxHp: number }[] }
  | { k: 'fightEnd'; won: boolean; rounds: number; downs: number; deaths: number; startHp: number; minHp: number; endHp: number; dmg: Record<string, number> }
  /** One creature's turn, for pace: how long it took (ms, from the start of its turn), and how many heroes shared it. */
  | { k: 'turn'; who: string; side: 'hero' | 'monster' | 'ally'; auto: boolean; round: number; ms: number; shared: number }
  | { k: 'pick'; hero: string; classId: string; offerKind: string; auto: boolean; offered: unknown[]; card: number; branch?: string; text: string }
  | { k: 'end'; victory: boolean; act: number; gold: number; relics: string[]; heroes: { name: string; classId: string; level: number; engine?: string; skills: string[]; gear: string[]; injuries: number }[] };

const FLUSH_AT = 300;

export class Journal {
  private lines: string[] = [];
  readonly file: string | null;

  /** `started` is the run's createdAt, so a resumed run keeps writing to the same file and a new run in the same room gets its own. */
  constructor(code: string, started: number) {
    if (process.env.DELVERS_SAVES === 'off') {
      this.file = null;
      return;
    }
    const stamp = new Date(started).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    this.file = path.join(saveDir(), 'journal', `${code}-${stamp}.jsonl`);
  }

  write(entry: JournalEntry) {
    if (!this.file) return;
    this.lines.push(JSON.stringify({ t: Date.now(), ...entry }));
    if (this.lines.length >= FLUSH_AT) this.flush();
  }

  flush() {
    if (!this.file || !this.lines.length) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${this.lines.join('\n')}\n`);
      this.lines = [];
    } catch (err) {
      console.error(`[journal] could not write ${this.file}:`, err);
    }
  }
}
