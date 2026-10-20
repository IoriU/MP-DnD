import assert from 'node:assert/strict';
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
