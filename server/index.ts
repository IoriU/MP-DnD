// HTTP + WebSocket server. Serves the built client from /dist and hosts game rooms.

import express from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { CLASSES } from '../shared/rules.ts';
import type { ClassId, JoinRequest, JoinResult, PickRequest, Pos, RestPick } from '../shared/types.ts';
import { Game } from './game.ts';

const PORT = Number(process.env.PORT) || 3000;
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const ROOM_TTL_MS = 15 * 60_000; // rooms with nobody connected are deleted after this

const app = express();
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('The client is not built yet.\n\nDevelopment: npm run dev, then open http://localhost:5173\nPlay with friends: npm run play');
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer);
const games = new Map<string, Game>();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0
function newCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (games.has(code));
  return code;
}

io.on('connection', (socket) => {
  let game: Game | null = null;
  let playerId: string | null = null;

  socket.on('join', (req: JoinRequest, ack: (res: JoinResult) => void) => {
    if (typeof ack !== 'function') return;
    const name = String(req?.name ?? '').trim().slice(0, 16);
    const classId = req?.classId;
    if (game) return ack({ ok: false, error: 'Already in a room.' });
    if (!name) return ack({ ok: false, error: 'Enter a name first.' });
    if (typeof classId !== 'string' || !Object.hasOwn(CLASSES, classId)) return ack({ ok: false, error: 'Pick a class.' });

    let g: Game | undefined;
    if (req.code) {
      g = games.get(String(req.code).trim().toUpperCase());
      if (!g) return ack({ ok: false, error: 'Room not found. Check the code?' });
    } else {
      g = new Game(io, newCode());
      games.set(g.code, g);
    }
    const res = g.join(typeof req.playerId === 'string' ? req.playerId : undefined, name, classId as ClassId);
    if (!res.ok) return ack(res);
    game = g;
    playerId = res.playerId;
    void socket.join(g.code);
    void socket.join(`p:${playerId}`);
    ack({ ok: true, code: g.code, playerId });
  });

  // Every other event needs the socket to be in a room first.
  const on = <A extends unknown[]>(event: string, fn: (g: Game, pid: string, ...args: A) => void) =>
    socket.on(event, (...args: unknown[]) => {
      if (!game || !playerId) return;
      try {
        fn(game, playerId, ...(args as A));
      } catch (err) {
        console.error(`[${event}]`, err);
      }
    });

  on('setClass', (g, pid, classId: ClassId) => g.setClass(pid, classId));
  on('start', (g, pid) => g.start(pid));
  on('move', (g, pid, pos: Pos) => g.handleMove(pid, pos));
  on('step', (g, pid, dx: number, dy: number) => g.handleStep(pid, dx, dy));
  on('act', (g, pid, skill: unknown, target?: unknown) => g.handleSkill(pid, skill, target));
  on('pick', (g, pid, req: PickRequest) => g.handlePick(pid, req));
  on('rest', (g, pid, choice: RestPick) => g.handleRest(pid, choice));
  on('endTurn', (g, pid) => g.handleEndTurn(pid));
  on('vote', (g, pid, option: string) => g.handleVote(pid, option));
  on('chat', (g, pid, text: string) => g.handleChat(pid, text));
  on('restart', (g, pid) => g.restart(pid));
  on('setAuto', (g, pid, value: boolean) => g.handleSetAuto(pid, value === true));
  on('addBot', (g, pid) => g.addBot(pid));
  on('removeBot', (g, pid, botId: string) => g.removeBot(pid, String(botId)));

  socket.on('disconnect', () => {
    if (game && playerId) game.socketLeft(playerId);
  });
});

setInterval(() => {
  for (const [code, g] of games) {
    if (g.emptySince !== null && Date.now() - g.emptySince > ROOM_TTL_MS) {
      g.dispose();
      games.delete(code);
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  console.log('\n⚔️  Dungeon Delvers server is running\n');
  console.log(`   On this PC:           http://localhost:${PORT}`);
  for (const ip of addresses) {
    const label = ip.startsWith('100.') ? 'Tailscale friends:' : 'Same Wi-Fi / VPN:';
    console.log(`   ${label.padEnd(21)} http://${ip}:${PORT}`);
  }
  console.log('   Over the internet:    run "npm run tunnel" in a second terminal\n');
  if (!fs.existsSync(distDir)) console.log('   (Client not built. Use "npm run dev" while developing, or "npm run play".)\n');
});
