// Random numbers: a small interface with a seedable implementation, so maps can be reproduced from a seed.

export interface Rng {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: T[]): T[]; // in place, returns arr
  chance(p: number): boolean;
}

function wrap(next: () => number): Rng {
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    chance: (p) => next() < p,
  };
}

/** Deterministic generator (mulberry32): the same seed always gives the same sequence. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  return wrap(() => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/** Default generator, backed by Math.random. */
export const rng: Rng = wrap(Math.random);

export const randInt = (min: number, max: number) => rng.int(min, max);
export const pick = <T>(arr: readonly T[]): T => rng.pick(arr);
export const shuffle = <T>(arr: T[]): T[] => rng.shuffle(arr);
