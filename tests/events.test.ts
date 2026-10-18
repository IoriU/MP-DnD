import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENTS, getEvent, pickEvent } from '../server/events.ts';
import type { CheckResult, EventChoiceDef, EventCtx, EventDef, EventEffect, EventOutcome, EventStat } from '../server/events.ts';
import { makeRng } from '../server/rng.ts';
import { MONSTERS } from '../shared/rules.ts';

const SEEDS = 40;
const ACT_NUMS = [1, 2, 3];
const PARTY_SIZES = [1, 2, 4, 6];
const STATS: EventStat[] = ['str', 'dex', 'int', 'wis'];

interface Check extends CheckResult {
  stat: EventStat;
  dc: number;
}

/** A ctx with a seeded RNG and a check that alternates success/failure, starting with `firstOk`. */
function fakeCtx(act: number, seed: number, partySize: number, gold: number, firstOk: boolean) {
  let ok = firstOk;
  const checks: Check[] = [];
  const ctx: EventCtx = {
    act,
    gold,
    partySize,
    rng: makeRng(seed),
    check(stat, dc) {
      const roll = ok ? 15 : 4;
      const text = `🎲 Bram (${stat.toUpperCase()} +3): ${roll}+3=${roll + 3} vs DC ${dc}, ${ok ? 'success' : 'failure'}`;
      const r: Check = { ok, heroId: 'h1', heroName: 'Bram', text, stat, dc };
      checks.push(r);
      ok = !ok;
      return r;
    },
  };
  return { ctx, checks };
}

interface Run {
  act: number;
  event: EventDef;
  choice: EventChoiceDef;
  firstOk: boolean;
  checks: Check[];
  gold: number;
  out: EventOutcome;
}

/** Resolves every choice of every event, in every act, over many seeds and party sizes. */
const runs: Run[] = [];
for (const act of ACT_NUMS) {
  for (const base of EVENTS) {
    const event = getEvent(base.id, act)!;
    for (const choice of event.choices) {
      for (let seed = 0; seed < SEEDS; seed++) {
        for (const partySize of PARTY_SIZES) {
          for (const firstOk of [true, false]) {
            const gold = choice.cost ?? 0; // the poorest party that can still pick it
            const { ctx, checks } = fakeCtx(act, seed * 7919 + partySize, partySize, gold, firstOk);
            runs.push({ act, event, choice, firstOk, checks, gold, out: choice.resolve(ctx) });
          }
        }
      }
    }
  }
}

const where = (r: Run) => `act ${r.act}, ${r.event.id}.${r.choice.id}`;
const ofChoice = (eventId: string, choiceId: string, act?: number) =>
  runs.filter((r) => r.event.id === eventId && r.choice.id === choiceId && (act === undefined || r.act === act));
const kinds = (out: EventOutcome) => out.effects.map((e) => e.kind).join(',');
const netGold = (effects: EventEffect[]) => effects.reduce((sum, e) => sum + (e.kind === 'gold' ? e.amount : 0), 0);
const effect = <K extends EventEffect['kind']>(out: EventOutcome, kind: K) =>
  out.effects.find((e): e is Extract<EventEffect, { kind: K }> => e.kind === kind);

function eachRun(fn: (r: Run) => void) {
  for (const r of runs) {
    try {
      fn(r);
    } catch (e) {
      throw new Error(`${where(r)}: ${(e as Error).message}`, { cause: e });
    }
  }
}

test('ids are unique and every event is well-formed', () => {
  const ids = EVENTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate event ids');
  for (const required of ['well', 'prisoner', 'shrine', 'chest', 'alchemist']) assert.ok(ids.includes(required), `missing ${required}`);
  for (const act of ACT_NUMS) {
    for (const base of EVENTS) {
      const e = getEvent(base.id, act)!;
      const at = `act ${act}, ${e.id}`;
      assert.equal(e.id, base.id, at);
      assert.ok(e.title && e.glyph && e.text, `${at}: missing title, glyph or text`);
      if (e.acts) {
        assert.ok(e.acts.length > 0, `${at}: empty acts`);
        for (const a of e.acts) assert.ok(ACT_NUMS.includes(a), `${at}: bad act ${a}`);
      }
      assert.ok(e.choices.length >= 2 && e.choices.length <= 4, `${at}: ${e.choices.length} choices`);
      const choiceIds = e.choices.map((c) => c.id);
      assert.equal(new Set(choiceIds).size, choiceIds.length, `${at}: duplicate choice ids`);
      for (const c of e.choices) assert.ok(c.id && c.label, `${at}: choice without id or label`);
      const last = e.choices[e.choices.length - 1];
      assert.equal(last.id, 'leave', `${at}: last choice is not leave`);
      assert.match(last.label, /^Leave/, `${at}: leave label`);
      assert.equal(last.cost, undefined, `${at}: leave has a cost`);
    }
  }
});

test('costs are positive integers, shown in the hint and scaled by act', () => {
  for (const base of EVENTS) {
    for (const act of ACT_NUMS) {
      for (const c of getEvent(base.id, act)!.choices) {
        if (c.cost === undefined) continue;
        const at = `act ${act}, ${base.id}.${c.id}`;
        assert.ok(Number.isInteger(c.cost) && c.cost > 0, `${at}: cost ${c.cost}`);
        assert.ok(c.hint?.includes(`${c.cost} gold`), `${at}: hint "${c.hint}" doesn't show the cost`);
        const act1 = base.choices.find((b) => b.id === c.id)!.cost!;
        assert.equal(c.cost, act1 * act, `${at}: cost doesn't scale with the act`);
      }
    }
  }
});

test('every choice resolves to text and valid effects', () => {
  eachRun((r) => {
    const { out, act } = r;
    assert.equal(typeof out.text, 'string');
    assert.ok(out.text.trim().length > 0, 'empty text');
    assert.ok(Array.isArray(out.effects), 'effects is not an array');
    for (const e of out.effects) {
      switch (e.kind) {
        case 'heal':
          assert.ok(e.pct > 0 && e.pct <= 1, `heal pct ${e.pct}`);
          break;
        case 'damage':
          assert.ok(Number.isInteger(e.dice.n) && e.dice.n >= 1, `dice n ${e.dice.n}`);
          assert.ok(Number.isInteger(e.dice.d) && e.dice.d >= 2, `dice d ${e.dice.d}`);
          assert.ok(e.dice.n * e.dice.d + (e.dice.bonus ?? 0) <= 12, 'damage above 2d6');
          assert.ok(e.who === 'all' || e.who === 'checker', `who ${e.who}`);
          if (e.who === 'checker') assert.ok(r.checks.length > 0, 'checker damage without a check');
          break;
        case 'gold':
          assert.ok(Number.isInteger(e.amount) && e.amount !== 0, `gold ${e.amount}`);
          assert.ok(e.amount <= 60 * act, `gold reward ${e.amount} too big for act ${act}`);
          break;
        case 'potions':
          assert.ok(Number.isInteger(e.amount) && e.amount >= 1 && e.amount <= 2, `potions ${e.amount}`);
          break;
        case 'maxHp':
          assert.ok(Number.isInteger(e.amount) && e.amount >= 2 && e.amount <= 4, `maxHp ${e.amount}`);
          break;
        case 'restoreSlots':
          break;
        case 'fight':
          assert.ok(Array.isArray(e.monsters) && e.monsters.length > 0, 'empty fight');
          for (const id of e.monsters) assert.ok(id in MONSTERS, `unknown monster ${id}`);
          assert.ok(e.elite === undefined || typeof e.elite === 'boolean', 'elite flag');
          break;
        default:
          assert.fail(`unknown effect kind ${(e as { kind: string }).kind}`);
      }
    }
    assert.ok(netGold(out.effects) >= -r.gold, `spends ${-netGold(out.effects)} gold with only ${r.gold}`);
    if (r.choice.id === 'leave') assert.deepEqual(out.effects, [], 'leave has effects');
  });
});

test('checks use real stats, show their roll and match the hint', () => {
  const statsUsed = new Set<EventStat>();
  eachRun((r) => {
    assert.ok(r.checks.length <= 1, 'more than one check per choice');
    for (const c of r.checks) {
      statsUsed.add(c.stat);
      assert.ok(STATS.includes(c.stat), `stat ${c.stat}`);
      assert.ok(Number.isInteger(c.dc) && c.dc >= 8 && c.dc <= 18, `DC ${c.dc}`);
      assert.ok(r.out.text.includes(c.text), 'outcome text is missing the check text');
      assert.ok(r.choice.hint?.includes(`${c.stat.toUpperCase()} check, DC ${c.dc}`), `hint "${r.choice.hint}" doesn't match the check`);
    }
  });
  assert.ok(statsUsed.has('str'), 'no event uses STR');
});

test('the five spec events behave as described', () => {
  for (const act of ACT_NUMS) {
    // Wishing Well
    const toss = ofChoice('well', 'toss', act);
    for (const r of toss) assert.equal(netGold(r.out.effects), -15 * act, 'well.toss always costs its gold');
    assert.ok(toss.some((r) => effect(r.out, 'heal')?.pct === 0.35), 'well.toss never heals');
    assert.ok(toss.some((r) => !effect(r.out, 'heal')), 'well.toss always heals');
    for (const r of ofChoice('well', 'climb', act)) {
      const ok = r.checks[0].ok;
      assert.equal(kinds(r.out), ok ? 'gold' : 'damage,gold', `well.climb ${ok}`);
      assert.ok(netGold(r.out.effects) > 0);
      if (!ok) assert.deepEqual(effect(r.out, 'damage'), { kind: 'damage', dice: { n: 1, d: 6 }, who: 'checker' });
    }
    // Forgotten Shrine
    for (const r of ofChoice('shrine', 'pray', act)) assert.deepEqual(r.out.effects, [{ kind: 'heal', pct: 0.25 }]);
    for (const r of ofChoice('shrine', 'desecrate', act)) {
      assert.equal(kinds(r.out), 'gold,damage');
      assert.equal(effect(r.out, 'damage')!.who, 'all');
    }
    // Suspicious Chest
    const open = ofChoice('chest', 'open', act);
    assert.ok(open.some((r) => kinds(r.out) === 'gold,potions'), 'chest.open never has loot');
    assert.ok(open.some((r) => kinds(r.out) === 'fight'), 'chest.open is never a mimic');
    for (const r of [...open, ...ofChoice('chest', 'inspect', act)]) {
      const fight = effect(r.out, 'fight');
      if (fight) {
        assert.equal(fight.elite, true, 'mimic fight is not elite');
        assert.ok(fight.monsters.every((m) => m === 'mimic'), 'chest fight is not mimics');
      }
      if (r.choice.id === 'inspect') assert.equal(kinds(r.out), r.checks[0].ok ? 'gold,potions' : 'fight');
    }
    // Wandering Alchemist
    for (const r of ofChoice('alchemist', 'red', act)) assert.deepEqual(r.out.effects, [{ kind: 'maxHp', amount: 3 }]);
    const green = ofChoice('alchemist', 'green', act);
    assert.ok(green.some((r) => effect(r.out, 'heal')?.pct === 1), 'green vial never heals');
    assert.ok(green.some((r) => effect(r.out, 'damage')?.who === 'all'), 'green vial never hurts');
    for (const r of ofChoice('alchemist', 'buy', act)) assert.deepEqual(r.out.effects, [{ kind: 'gold', amount: -20 * act }, { kind: 'potions', amount: 2 }]);
  }
  // Goblin Prisoner (acts 1-2): goblins scale with the party
  for (const r of ofChoice('prisoner', 'free')) assert.deepEqual(r.out.effects, [{ kind: 'potions', amount: 2 }]);
  for (const r of ofChoice('prisoner', 'interrogate', 1)) {
    if (r.checks[0].ok) {
      assert.equal(kinds(r.out), 'gold');
      continue;
    }
    const fight = effect(r.out, 'fight')!;
    assert.ok(fight.monsters.every((m) => m === 'goblin' || m === 'archer'), 'prisoner fight is not goblins');
    assert.ok(fight.monsters.length >= 2 && fight.monsters.length <= 4, `${fight.monsters.length} goblins`);
  }
});

test('pickEvent fits the act and prefers unseen events', () => {
  for (const act of ACT_NUMS) {
    const fits = EVENTS.filter((e) => !e.acts || e.acts.includes(act)).map((e) => e.id);
    assert.ok(fits.length >= 5, `only ${fits.length} events in act ${act}`);
    const picked = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const rng = makeRng(seed);
      const e = pickEvent(act, [], rng);
      picked.add(e.id);
      assert.ok(fits.includes(e.id), `act ${act}: picked ${e.id}`);
      // priced for the act
      assert.deepEqual(e.choices.map((c) => c.cost), getEvent(e.id, act)!.choices.map((c) => c.cost));
      // one unseen left: always that one
      const unseen = fits[seed % fits.length];
      assert.equal(pickEvent(act, fits.filter((id) => id !== unseen), rng).id, unseen);
      // everything seen: still a valid event, but not a repeat of the last one
      const seen = makeRng(seed + 1).shuffle([...fits]);
      const again = pickEvent(act, seen, rng);
      assert.ok(fits.includes(again.id), `act ${act}: picked ${again.id} after seeing all`);
      assert.notEqual(again.id, seen[seen.length - 1], 'repeated the last event');
    }
    assert.deepEqual([...picked].sort(), [...fits].sort(), `act ${act}: some events never picked`);
  }
  // out-of-range acts are clamped instead of crashing
  for (const act of [0, 4, 99]) assert.ok(EVENTS.some((e) => e.id === pickEvent(act, [], makeRng(act)).id));
  assert.equal(getEvent('nope', 1), undefined);
});
