// Headless smoke test: one game played entirely by the server's auto-play. The host joins, switches Auto on,
// adds bots and starts; this script then only watches `state` and `toast` events until victory, defeat or the time limit.
//
//   node scripts/smoke.ts [seconds=300] [heroes=4]          env: URL (default http://localhost:3000)
//
// Fast run against a test server:  PORT=3200 DELVERS_SPEED=10 [DELVERS_ROWS=4] node server/index.ts
//                                  URL=http://localhost:3200 node scripts/smoke.ts 300 4
// Exit code: 1 if no state arrived, no fight happened, or there were anomalies (no state change for 30 s,
// or one hero's turn stuck for more than 15 s); otherwise 0. The watching logic lives in scripts/balance.ts.

import { MAX_PLAYERS } from '../shared/rules.ts';
import { NODE_TYPES, playRun, whereLabel } from './balance.ts';

const url = process.env.URL ?? 'http://localhost:3000';
const seconds = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 300;
const heroes = Math.min(MAX_PLAYERS, Math.max(1, Math.floor(Number(process.argv[3]) || 4)));

console.log(`smoke: ${heroes} heroes on ${url}, up to ${seconds}s`);
const r = await playRun({ url, heroes, timeoutS: seconds, onStart: (code) => console.log(`room ${code}: host on auto + ${heroes - 1} bots, starting`) });

const won = r.fights.filter((f) => f.won).length;
const kinds = [...new Set(r.fights.map((f) => f.kind))].map((k) => `${k} ${r.fights.filter((f) => f.kind === k).length}`).join(', ');
const nodeTotal = NODE_TYPES.reduce((n, t) => n + r.nodes[t], 0);

console.log(`\n=== smoke summary (${r.seconds.toFixed(1)}s, ended: ${r.outcome}) ===`);
console.log(`outcome: ${r.outcome}; acts cleared ${r.actsCleared}/${r.maxAct}; ended at ${whereLabel(r.at)}; ${r.states} states`);
console.log(`nodes entered (${nodeTotal}): ${NODE_TYPES.map((t) => `${t} ${r.nodes[t]}`).join(', ')}`);
console.log(`fights: started ${r.fightsStarted}, won ${won} (${kinds || 'none'}); heroes downed ${r.downs.length}, died ${r.deaths.length}`);
if (r.killer) console.log(`party wiped by: ${r.killer}`);
for (const h of r.heroes) console.log(`  ${h.name.padEnd(12)} ${h.classId.padEnd(8)} L${h.level}  kills ${h.kills}  hp ${h.hp}/${h.maxHp}`);
console.log(`toasts (rejected host actions): ${r.toastCount} total, ${r.toasts.length} unique${r.toasts.length ? ': ' + r.toasts.slice(0, 10).join(' | ') : ''}`);
console.log(`anomalies: ${r.anomalies.length}`);
for (const a of r.anomalies) console.log(`  ${a}`);
console.log('--- last 20 log lines ---');
for (const l of r.log) console.log(l);

const code = r.states === 0 || r.fightsStarted === 0 || r.anomalies.length ? 1 : 0;
if (r.states === 0) console.log('The server never sent a state.');
else if (r.fightsStarted === 0) console.log('No fight ever started.');
process.exitCode = code;
setTimeout(() => process.exit(code), 1000).unref();
