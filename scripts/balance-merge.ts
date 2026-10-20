// One balance report over several saved batches (scripts/balance.ts with OUT=<file.json>), e.g. two servers' halves.
//
//   node scripts/balance-merge.ts a.json b.json ...

import fs from 'node:fs';
import { report, type RunResult } from './balance.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/balance-merge.ts <results.json>...');
  process.exit(1);
}
const results: RunResult[] = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as RunResult[]);
const sizes = [...new Set(results.map((r) => r.party))].sort((a, b) => a - b).join('/');
report(results, sizes, 0);
