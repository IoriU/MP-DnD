// Talks to the game server over Socket.IO. Reconnects (and rejoins your room) automatically.

import { io } from 'socket.io-client';
import type { ClassId, Fx, GameState, JoinRequest, JoinResult } from '../shared/types.ts';
import { emitFx, setState, store } from './store.ts';
import { toast } from './util.ts';

export const socket = io();

// Per-tab session, so a page reload drops you back into the same character.
// (A fresh tab is a fresh player, which is handy for testing with several tabs.)
interface Session {
  code: string;
  playerId: string;
  name: string;
  classId: ClassId;
}
const SESSION_KEY = 'delvers.session';

function loadSession(): Session | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export const hasSession = () => loadSession() !== null;

export function join(req: JoinRequest): Promise<JoinResult> {
  return new Promise((resolve) => {
    socket.timeout(8000).emit('join', req, (err: Error | null, res: JoinResult) => {
      if (err) return resolve({ ok: false, error: 'The server did not answer. Is it running?' });
      if (res.ok) {
        store.playerId = res.playerId;
        saveSession({ code: res.code, playerId: res.playerId, name: req.name, classId: req.classId });
      }
      resolve(res);
    });
  });
}

export function leave() {
  saveSession(null);
  socket.disconnect();
  location.href = location.pathname;
}

export const send = (event: string, ...args: unknown[]) => socket.emit(event, ...args);

socket.on('connect', async () => {
  const s = loadSession();
  if (!s) return;
  const res = await join({ code: s.code, name: s.name, classId: s.classId, playerId: s.playerId });
  if (!res.ok) {
    // Usually the server restarted and the room is gone: back to the home screen.
    saveSession(null);
    document.body.classList.remove('resuming');
    setState(null);
    toast(`Could not rejoin room ${s.code}: ${res.error}`);
  }
});

socket.on('disconnect', (reason) => {
  if (reason !== 'io client disconnect') toast('Connection lost. Reconnecting...');
});
socket.on('state', (s: GameState) => setState(s));
socket.on('fx', (fx: Fx[]) => emitFx(fx));
socket.on('toast', (msg: string) => toast(msg));
