// The learned monster policy (Phase 11): a small network trained with PPO in training/ (Python + PyTorch) against the
// hero bots. It scores each option server/monsterai.ts lists for a monster (monsterChoices), and the monster takes
// the best one. The trainer exports the network twice: as ONNX, and as the plain weights in
// server/policies/monster-ppo.json, which this file runs in plain TypeScript, so hosts need nothing extra installed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTION_FEATURES } from './monsterai.ts';

/** One fully connected layer, as PyTorch stores it: w[out][in]. */
export interface Layer {
  w: number[][];
  b: number[];
  act: 'tanh' | 'relu' | 'linear';
}

export interface PolicyFile {
  version: 1;
  features: number; // inputs per option (OPTION_FEATURES when it was trained)
  layers: Layer[]; // the option scorer: features in, one score out
  trainedAt: string;
  steps: number; // decisions it trained on
  notes?: string;
  check?: { inputs: number[][]; scores: number[] }; // what PyTorch scored for a few inputs (tests/policy.test.ts)
}

export class Policy {
  readonly file: PolicyFile;

  constructor(file: PolicyFile) {
    this.file = file;
  }

  /** The network's score for one option. */
  score(features: number[]): number {
    let x = features;
    for (const l of this.file.layers) {
      const y = l.b.slice();
      for (let o = 0; o < y.length; o++) {
        const row = l.w[o];
        let s = y[o];
        for (let i = 0; i < x.length; i++) s += row[i] * x[i];
        y[o] = l.act === 'tanh' ? Math.tanh(s) : l.act === 'relu' ? Math.max(0, s) : s;
      }
      x = y;
    }
    return x[0];
  }

  /** The best option (the first one on a tie: that's the scripted AI's own pick). */
  pick(options: number[][]): number {
    let best = 0;
    let top = -Infinity;
    options.forEach((f, i) => {
      const s = this.score(f);
      if (s > top) {
        top = s;
        best = i;
      }
    });
    return best;
  }
}

/** Checks a policy file's shape: right input size, layers that chain, one output. */
export function validPolicy(f: unknown): f is PolicyFile {
  const p = f as PolicyFile;
  if (!p || p.version !== 1 || p.features !== OPTION_FEATURES || !Array.isArray(p.layers) || !p.layers.length) return false;
  let width = p.features;
  for (const l of p.layers) {
    if (!Array.isArray(l.w) || !Array.isArray(l.b) || l.w.length !== l.b.length || l.w.some((r) => r.length !== width)) return false;
    width = l.b.length;
  }
  return width === 1;
}

export const POLICY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'policies/monster-ppo.json');

let cached: Policy | null | undefined;

/** The trained policy, or null if there's none (or it was trained for other features). Loaded once. */
export function monsterPolicy(): Policy | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const file: unknown = JSON.parse(fs.readFileSync(process.env.DELVERS_POLICY || POLICY_FILE, 'utf8'));
    if (validPolicy(file)) cached = new Policy(file);
    else console.warn('[policy] monster-ppo.json does not match this version of the monster AI; PPO monsters are off.');
  } catch {
    // no trained policy yet: PPO monsters fall back to the scripted AI
  }
  return cached;
}
