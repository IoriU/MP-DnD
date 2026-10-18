// Save & resume check: plays a few rooms, kills the server mid-act, starts a new one and makes sure the party
// continues from the same spot on the map with the same heroes.
//
//   node scripts/resume-check.ts [rooms=3]   (uses port 3400 and a temporary save folder; leaves your saves alone)

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { GameState, JoinResult, PlayerEntity } from '../shared/types.ts';

const PORT = 3400;
const URL = `http://localhost:${PORT}`;
const SAVES = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-resume-'));
const ROOMS_FIRST = Math.max(1, Number(process.argv[2]) || 3); // rooms to play before pulling the plug

function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DELVERS_SPEED: '10', DELVERS_SAVES: SAVES },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('server is running') && resolve(child));
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill(); // no goodbye: like closing the terminal mid-game
  });
}

/** Resolves with the first state that passes `ok`. */
function waitFor(socket: Socket, what: string, ok: (s: GameState) => boolean, ms = 120_000): Promise<GameState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    const on = (s: GameState) => {
      if (!ok(s)) return;
      clearTimeout(timer);
      socket.off('state', on);
      resolve(s);
    };
    socket.on('state', on);
  });
}

/** What has to survive a restart. */
const sheet = (s: GameState) =>
  s.entities
    .filter((e): e is PlayerEntity => e.kind === 'player')
    .map((h) => ({ name: h.name, classId: h.classId, level: h.level, xp: h.xp, hp: h.hp, maxHp: h.maxHp, potions: h.potions, kills: h.kills, levelUps: h.levelUps, skills: h.skills.map((k) => `${k.id}:${k.tier}${k.branch ?? ''}`) }))
    .sort((a, b) => a.name.localeCompare(b.name));
const spot = (s: GameState) => ({ act: s.run?.act, currentId: s.run?.currentId, visited: s.run?.visited, gold: s.run?.gold, seed: s.run?.seed });

async function main() {
  let server = await startServer();
  let socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const joined: JoinResult = await socket.timeout(5000).emitWithAck('join', { name: 'Ann', classId: 'cleric' });
  if (!joined.ok) throw new Error(joined.error);
  socket.emit('setAuto', true); // let auto-play move things along
  socket.emit('addBot');
  socket.emit('addBot');
  await waitFor(socket, 'the bots', (s) => s.players.length === 3);
  socket.emit('start');
  await waitFor(socket, `${ROOMS_FIRST} rooms`, (s) => s.phase === 'map' && (s.run?.visited.length ?? 0) >= ROOMS_FIRST);
  socket.emit('setAuto', false); // Ann takes the keyboard back: the map vote waits for her
  await new Promise((r) => setTimeout(r, 800));
  const before = await new Promise<GameState>((resolve) => {
    socket.once('state', resolve);
    socket.emit('chat', 'brb, restarting the server');
  });
  if (before.phase !== 'map') throw new Error(`expected to be on the map, got ${before.phase}`);
  socket.close();
  await stopServer(server);
  console.log(`stopped the server at act ${before.run?.act}, ${before.run?.visited.length} rooms in, party levels ${sheet(before).map((h) => h.level).join('/')}`);

  server = await startServer();
  socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  const back: JoinResult = await socket.timeout(5000).emitWithAck('join', { code: joined.code, name: 'Ann', classId: 'cleric', playerId: joined.playerId });
  if (!back.ok) throw new Error(`rejoin failed: ${back.error}`);
  const tavern = await waitFor(socket, 'the resumed tavern', (s) => s.phase === 'lobby');
  if (!tavern.resume) throw new Error('the tavern does not know about the saved run');
  if (back.playerId !== joined.playerId) throw new Error('rejoined as somebody else');
  socket.emit('start');
  const after = await waitFor(socket, 'the map', (s) => s.phase === 'map');

  const problems: string[] = [];
  if (JSON.stringify(spot(after)) !== JSON.stringify(spot(before))) problems.push(`map position changed:\n  ${JSON.stringify(spot(before))}\n  ${JSON.stringify(spot(after))}`);
  if (JSON.stringify(sheet(after)) !== JSON.stringify(sheet(before))) problems.push(`heroes changed:\n  ${JSON.stringify(sheet(before))}\n  ${JSON.stringify(sheet(after))}`);
  if (JSON.stringify(after.vote?.options) !== JSON.stringify(before.vote?.options)) problems.push('different path choices');
  socket.close();
  await stopServer(server);
  fs.rmSync(SAVES, { recursive: true, force: true });
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`✅ resumed at the same spot (act ${after.run?.act}, room ${after.run?.currentId}) with the same ${sheet(after).length} heroes`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
