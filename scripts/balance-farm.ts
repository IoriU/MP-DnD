// A big balance batch, fast (Phase 13): several test servers at a high game speed, one scripts/balance.ts client each,
// then one report over all of them. A run takes about 1.5 minutes this way instead of 10; 4 servers play 48 runs in
// about 5 minutes. Every server plays every difficulty and party size in turn.
//
//   node scripts/balance-farm.ts [servers=4] [runs per server=12] [sizes=3,4,5,6]
//   env: BASE_PORT (3200: ports BASE_PORT..+servers-1, never 3000), SPEED (1000), DIFF (all), OUT_DIR (a temp dir),
//        DELVERS_TUNE (JSON merged into the knobs in shared/rules.ts TUNABLES, to try numbers without editing code)
//
// Each client keeps its runs in OUT_DIR/<port>.json and its log in OUT_DIR/<port>.txt; scripts/balance-merge.ts can
// report on any set of those files later (say, two batches of the same settings together).

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { report, type RunResult } from './balance.ts';

const int = (v: string | undefined, def: number) => (Number(v) > 0 ? Math.floor(Number(v)) : def);
const SERVERS = int(process.argv[2], 4);
const RUNS = int(process.argv[3], 12);
const SIZES = process.argv[4] ?? '3,4,5,6';
const BASE = int(process.env.BASE_PORT, 3200);
const SPEED = int(process.env.SPEED, 1000);
const OUT = process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-farm-'));
fs.mkdirSync(OUT, { recursive: true });
const ports = Array.from({ length: SERVERS }, (_, i) => BASE + i);
if (ports.includes(3000)) throw new Error('port 3000 is the real server: pick another BASE_PORT');

const listening = (port: number) =>
  new Promise<boolean>((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => (s.end(), res(true)));
    s.on('error', () => res(false));
  });

async function main() {
  for (const p of ports) if (await listening(p)) throw new Error(`port ${p} is already in use`);
  const tune = process.env.DELVERS_TUNE ?? '';
  console.log(`${SERVERS} servers (ports ${ports[0]}-${ports.at(-1)}) x ${RUNS} runs, heroes ${SIZES}, speed ${SPEED}${tune ? `, DELVERS_TUNE=${tune}` : ''}; results in ${OUT}`);
  const servers: ChildProcess[] = ports.map((port) =>
    spawn(process.execPath, ['server/index.ts'], {
      env: { ...process.env, PORT: String(port), DELVERS_SPEED: String(SPEED), DELVERS_SAVES: path.join(OUT, `saves-${port}`) },
      stdio: ['ignore', fs.openSync(path.join(OUT, `server-${port}.log`), 'w'), fs.openSync(path.join(OUT, `server-${port}.log`), 'a')],
    }),
  );
  const stop = () => servers.forEach((s) => s.kill());
  process.on('SIGINT', () => (stop(), process.exit(1)));
  try {
    for (const port of ports) {
      for (let i = 0; i < 100 && !(await listening(port)); i++) await new Promise((r) => setTimeout(r, 200));
      if (!(await listening(port))) throw new Error(`the server on ${port} did not start (see ${OUT}/server-${port}.log)`);
    }
    const t0 = Date.now();
    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((res) => {
            const log = fs.openSync(path.join(OUT, `${port}.txt`), 'w');
            const c = spawn(process.execPath, ['scripts/balance.ts', String(RUNS), SIZES, '6'], {
              env: { ...process.env, URL: `http://localhost:${port}`, RUN_TIMEOUT_S: '1800', DIFF: process.env.DIFF ?? 'all', OUT: path.join(OUT, `${port}.json`) },
              stdio: ['ignore', log, log],
            });
            c.on('exit', () => {
              console.log(`server ${port}: done after ${Math.round((Date.now() - t0) / 1000)}s`);
              res();
            });
          }),
      ),
    );
    const results: RunResult[] = ports.flatMap((port) => {
      const f = path.join(OUT, `${port}.json`);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as RunResult[]) : [];
    });
    report(results, SIZES.replaceAll(',', '/'), (Date.now() - t0) / 1000);
    const anomalies = results.flatMap((r) => r.anomalies.map((a) => `run ${r.code}: ${a.split('\n')[0]}`));
    console.log(`\nanomalies: ${anomalies.length}`);
    for (const a of anomalies.slice(0, 20)) console.log(`  ${a}`);
    process.exitCode = anomalies.length ? 1 : 0;
  } finally {
    stop();
  }
}

await main();
