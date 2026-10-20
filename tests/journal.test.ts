import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Journal } from '../server/journal.ts';

// The run journal (server/journal.ts): one JSON line per entry in <saves>/journal/<code>-<started>.jsonl, buffered until
// a flush, appended to (a resumed run keeps writing the same file), and nothing at all with DELVERS_SAVES=off.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-journal-'));
after(() => {
  delete process.env.DELVERS_SAVES;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a journal writes JSON lines with a time, names its file by code and start, and appends across sessions', () => {
  process.env.DELVERS_SAVES = dir;
  const started = Date.UTC(2026, 9, 20, 19, 30);
  const j = new Journal('ABCD', started);
  assert.equal(path.basename(j.file!), 'ABCD-20261020-1930.jsonl');
  j.write({ k: 'log', kind: 'info', text: 'hello', act: 1 });
  assert.ok(!fs.existsSync(j.file!), 'buffered until a flush');
  j.flush();
  const again = new Journal('ABCD', started); // the run resumed after a restart
  again.write({ k: 'node', act: 1, row: 0, type: 'combat' });
  again.flush();
  const lines = fs.readFileSync(j.file!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].k, lines[0].text, lines[1].k, lines[1].type], ['log', 'hello', 'node', 'combat']);
  assert.ok(lines.every((l) => typeof l.t === 'number'));
});

test('DELVERS_SAVES=off keeps no journal (the RL trainer plays thousands of throwaway fights)', () => {
  process.env.DELVERS_SAVES = 'off';
  const j = new Journal('WXYZ', Date.now());
  assert.equal(j.file, null);
  j.write({ k: 'log', kind: 'info', text: 'nothing' });
  j.flush();
});

test('the report times fights and acts, gives each person their median turn, and adds up what shared turns saved', () => {
  const t0 = Date.UTC(2026, 9, 20, 20, 0);
  const at = (s: number) => t0 + s * 1000;
  const lines = [
    { t: at(0), k: 'start', code: 'PACE', resumed: false, difficulty: 'normal', monsterAi: 'scripted', party: [{ name: 'Ann', classId: 'fighter', bot: false }, { name: 'Bob', classId: 'cleric', bot: false }, { name: 'Pip', classId: 'bard', bot: true }] },
    { t: at(10), k: 'node', act: 1, row: 0, type: 'combat' },
    { t: at(20), k: 'fight', act: 1, row: 0, kind: 'combat', name: 'Rat Nest', monsters: ['Giant Rat'], deployment: 'line', heroes: [] },
    // Round 1: Ann and Bob share a turn (30 s and 40 s), then the bot, then a monster.
    { t: at(60), k: 'turn', who: 'Ann', side: 'hero', auto: false, round: 1, ms: 30_000, shared: 2 },
    { t: at(70), k: 'turn', who: 'Bob', side: 'hero', auto: false, round: 1, ms: 40_000, shared: 2 },
    { t: at(73), k: 'turn', who: 'Pip', side: 'hero', auto: true, round: 1, ms: 3_000, shared: 1 },
    { t: at(75), k: 'turn', who: 'Giant Rat', side: 'monster', auto: true, round: 1, ms: 2_000, shared: 1 },
    // Round 2: Ann alone (20 s).
    { t: at(95), k: 'turn', who: 'Ann', side: 'hero', auto: false, round: 2, ms: 20_000, shared: 1 },
    { t: at(140), k: 'fightEnd', won: true, rounds: 2, downs: 0, deaths: 0, startHp: 1, minHp: 0.9, endHp: 0.95, dmg: { Ann: 10 } },
    { t: at(150), k: 'node', act: 2, row: 0, type: 'event' },
    { t: at(150 + 3600), k: 'log', kind: 'info', text: 'back after an hour away' },
  ];
  const file = path.join(dir, 'PACE-20261020-2000.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = execFileSync(process.execPath, ['scripts/journal-report.ts', file], { encoding: 'utf8' });
  assert.match(out, /Rat Nest\s+line\s+2\s+2:00\s+60/, 'the fight: 2 rounds in 2:00, 60 s a round');
  assert.match(out, /total 2:30 · in fights 2:00 \(80%\)/, 'the hour away does not count');
  assert.match(out, /act 1 2:20 · act 2 0:00/);
  assert.match(out, /Ann 25\.0s \(2 turns, 1 shared\) · Bob 40\.0s \(1 turn, 1 shared\) · bots 3\.0s · monsters 2\.0s/);
  assert.match(out, /people played at the same time 1 time, which saved about 0:30 of waiting/, 'one after another, Ann would have waited 30 s more');
});
