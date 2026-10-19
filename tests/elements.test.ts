import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Server } from 'socket.io';
import { reachable } from '../shared/grid.ts';
import { MONSTERS } from '../shared/rules.ts';
import { resolveAim, statsAt, type StatusId } from '../shared/skills.ts';
import { CLOUDS, GROUNDS, OIL_FIRE_TURNS, SHOCK_TURNS, tilesAround, type CloudId, type GroundId, type PropId, type PropMap } from '../shared/surfaces.ts';
import type { ClassId, Entity, GameState, LogLine, MonsterEntity, PlayerEntity, PlayerInfo } from '../shared/types.ts';
import { generateActMap } from '../server/actmap.ts';
import { Game } from '../server/game.ts';
import { makeRng } from '../server/rng.ts';
import { generateRoom, type RoomLayout } from '../server/room.ts';

// Scripted fights through the real Game class. The Game keeps its battlefield and turn state private, so the tests
// reach in with `any` to set up a controlled room, then drive it through the same handlers the sockets use.

const games: Game[] = [];
after(() => games.forEach((g) => g.dispose()));

/** Dice by Math.random: LOW rolls all 1s (a natural 1 on a d20), MID the middle of every die, HIGH the maximum. */
const LOW = 0;
const MID = 0.5; // d4 3, d6 4, d8 5, d10 6, d20 11
const HIGH = 0.99; // d4 4, d6 6, d8 8, d20 20

function withRandom<T>(roll: number | number[], fn: () => T): T {
  const real = Math.random;
  const seq = typeof roll === 'number' ? [roll] : roll;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

const NAMES = ['Ann', 'Bob', 'Cid', 'Dee'];

/**
 * A 12x8 walled room in combat. Heroes stand at x=2, one per row from y=3 (40 HP, 5 slots); a far-away kobold keeps
 * the fight from ending. Monsters made with `monster()` have 100 HP and AC 1 so attack rolls land and nobody dies by accident.
 */
function arena(opts: { classes?: ClassId[]; rows?: string[] } = {}) {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const g = new Game(io, 'ELEM');
  games.push(g);
  const p = g as any;
  const pids = (opts.classes ?? ['wizard']).map((c, i) => {
    const r = g.join(undefined, NAMES[i], c);
    assert.ok(r.ok);
    return r.playerId;
  });
  const heroes: PlayerEntity[] = pids.map((id, i) => {
    const h = p.makePlayer(p.players.find((x: PlayerInfo) => x.id === id), 1) as PlayerEntity;
    h.x = 2;
    h.y = 3 + i;
    h.hp = h.maxHp = 40;
    h.slots = h.maxSlots = 5;
    return h;
  });

  const rows = opts.rows ?? Array.from({ length: 8 }, (_, y) => (y === 0 || y === 7 ? '#'.repeat(12) : `#${'.'.repeat(10)}#`));
  const props: PropMap = {};
  let tiles = '';
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === 'B' || ch === 'Z') props[y * row.length + x] = ch === 'B' ? 'barrel' : 'brazier';
      tiles += ch === 'B' || ch === 'Z' ? '#' : ch;
    }),
  );
  g.width = rows[0].length;
  g.height = rows.length;
  g.tiles = tiles;
  g.ground = {};
  g.clouds = {};
  g.props = props;
  p.phase = 'combat';
  p.roomKind = 'combat';
  p.entities = [...heroes];
  p.turn = { order: heroes.map((h) => h.id), init: {}, index: 0, round: 1, movesLeft: 6, ap: 3 };
  p.turnOwner = heroes[0].id;

  const at = (x: number, y: number) => y * g.width + x;
  const monster = (type: string, x: number, y: number, o: { hp?: number; ac?: number } = {}): MonsterEntity => {
    p.spawnMonster(type, { x, y }, 1);
    const m = p.entities.at(-1) as MonsterEntity;
    // Elites roll random traits (Phase 7): these tests want the plain stat block.
    if (m.traits) {
      const def = MONSTERS[type];
      Object.assign(m, { traits: undefined, ward: 0, name: def.name, speed: def.speed });
    }
    m.hp = m.maxHp = o.hp ?? 100;
    m.ac = o.ac ?? 1;
    p.turn.order.push(m.id);
    return m;
  };
  const si = g.tiles.lastIndexOf('.');
  const sentinel = monster('kobold', si % g.width, Math.floor(si / g.width), { hp: 9999, ac: 30 });

  return {
    g,
    p,
    heroes,
    hero: heroes[0],
    ally: heroes[1],
    pid: pids[0],
    pids,
    sentinel,
    at,
    monster,
    ground: (x: number, y: number, id: GroundId, turns: number | null = 5, extra: { shock?: number; by?: string } = {}) => {
      g.ground[at(x, y)] = { id, turns, ...extra };
    },
    cloud: (x: number, y: number, id: CloudId, turns = 3) => {
      g.clouds[at(x, y)] = { id, turns };
    },
    prop: (x: number, y: number, id: PropId) => {
      const i = at(x, y);
      g.tiles = g.tiles.slice(0, i) + '#' + g.tiles.slice(i + 1);
      g.props[i] = id;
    },
  };
}
type Arena = ReturnType<typeof arena>;

const has = (e: Entity, id: StatusId) => e.statuses.some((s) => s.id === id);
const logged = (a: Arena, re: RegExp) => a.p.log.some((l: LogLine) => re.test(l.text));
const gid = (a: Arena, x: number, y: number) => a.g.ground[a.at(x, y)]?.id;
const learn = (h: PlayerEntity, id: string, tier: 1 | 2 | 3 = 1, branch?: 'A' | 'B') => h.skills.push({ id: id as never, tier, branch, cd: 0 });

// ---------------------------------------------------------------- 1-2: lightning and cold

test('lightning: a Wet creature is stunned at once; a dry one is Shocked first, and a second hit stuns it', () => {
  const a = arena();
  a.ground(6, 3, 'water');
  const wet = a.monster('goblin', 6, 3);
  a.p.standIn(wet, 'appear');
  assert.ok(has(wet, 'wet'), 'standing in water makes you Wet');
  a.p.damage(wet, 3, a.hero, 'lightning');
  assert.equal(wet.hp, 97);
  assert.ok(has(wet, 'stunned'));
  assert.ok(!has(wet, 'shocked'));
  assert.ok(logged(a, /is stunned by the shock \(Wet\)/));

  const dry = a.monster('goblin', 8, 5);
  assert.ok(!has(dry, 'wet'));
  a.p.damage(dry, 3, a.hero, 'lightning');
  assert.ok(has(dry, 'shocked'));
  assert.ok(!has(dry, 'stunned'));
  assert.equal(a.p.acOf(dry), dry.ac - 2, 'Shocked: -2 AC');
  a.p.damage(dry, 3, a.hero, 'lightning');
  assert.ok(has(dry, 'stunned'), 'the second hit stuns');
  assert.ok(!has(dry, 'shocked'));
  a.p.damage(dry, 3, a.hero, 'lightning');
  assert.ok(has(dry, 'stunned'));
  assert.ok(!has(dry, 'shocked'), 'a stunned creature is not shocked again');
  assert.equal(dry.hp, 91);
});

test('cold: dry creatures are Chilled then Frozen, Wet ones freeze at once, fire thaws; Frozen loses the turn, Chilled halves movement', () => {
  const a = arena();
  const m = a.monster('goblin', 6, 3);
  a.p.damage(m, 2, a.hero, 'cold');
  assert.ok(has(m, 'chilled') && !has(m, 'frozen'));
  a.p.damage(m, 2, a.hero, 'cold');
  assert.ok(has(m, 'frozen') && !has(m, 'chilled'), 'the second cold hit freezes it');
  a.p.damage(m, 2, a.hero, 'cold');
  assert.ok(has(m, 'frozen') && !has(m, 'chilled'), 'already frozen: nothing new');
  a.p.damage(m, 2, a.hero, 'fire');
  assert.ok(!has(m, 'frozen') && !has(m, 'chilled'), 'fire thaws');

  a.p.damage(m, 2, a.hero, 'cold');
  assert.ok(has(m, 'chilled'));
  a.p.damage(m, 2, a.hero, 'fire');
  assert.ok(!has(m, 'chilled'), 'fire removes Chilled too');

  a.ground(8, 5, 'water');
  const soaked = a.monster('goblin', 8, 5);
  a.p.standIn(soaked, 'appear');
  a.p.damage(soaked, 2, a.hero, 'cold');
  assert.ok(has(soaked, 'frozen'), 'Wet + cold = frozen at once');
  assert.ok(!has(soaked, 'wet') && !has(soaked, 'chilled'));
  assert.ok(logged(a, /freezes solid/));

  // A frozen creature loses its turn, and the ice is gone afterwards.
  a.p.turn.order = [soaked.id, a.hero.id, a.sentinel.id];
  a.p.turn.index = 0;
  a.p.beginTurn();
  assert.ok(logged(a, /Goblin is frozen solid and loses the turn/));
  a.p.advanceTurn();
  assert.ok(!has(soaked, 'frozen'), 'it only lasts the one turn');

  // Chilled: half movement.
  a.hero.statuses.push({ id: 'chilled', turns: 2 });
  a.p.turn.order = [a.hero.id, a.sentinel.id];
  a.p.turn.index = 0;
  a.p.beginTurn();
  assert.equal(a.p.turn.movesLeft, Math.floor(a.hero.speed / 2));
  a.g.dispose();
});

test('a frozen hero cannot walk or cast', () => {
  const a = arena();
  const m = a.monster('goblin', 4, 3);
  a.hero.statuses.push({ id: 'frozen', turns: 2 });
  a.g.handleStep(a.pid, 0, 1);
  assert.deepEqual([a.hero.x, a.hero.y], [2, 3]);
  assert.equal(a.g.handleSkill(a.pid, 'dagger', m.id), false);
  assert.equal(a.p.turn.ap, 3);
  assert.equal(m.hp, 100);
});

// ---------------------------------------------------------------- 3: walking into fire

test('walking into fire hurts and sets you Burning', () => {
  const a = arena();
  a.ground(3, 3, 'fire', 2);
  withRandom(HIGH, () => a.g.handleStep(a.pid, 1, 0));
  assert.deepEqual([a.hero.x, a.hero.y], [3, 3]);
  assert.equal(a.hero.hp, 36, '1d4 fire (a 4)');
  assert.ok(has(a.hero, 'burning'));
  assert.equal(a.p.turn.movesLeft, 5);
  assert.ok(logged(a, /caught in the flames/));
});

test('a Wet hero walking into fire is dried off instead of set alight, and takes half damage', () => {
  const a = arena();
  a.ground(3, 3, 'fire', 2);
  a.hero.statuses.push({ id: 'wet', turns: 2 });
  withRandom(HIGH, () => a.g.handleStep(a.pid, 1, 0));
  assert.equal(a.hero.hp, 38, 'half of 4');
  assert.ok(!has(a.hero, 'burning'));
  assert.ok(!has(a.hero, 'wet'), 'the flames dry it off');
  assert.ok(a.p.fx.some((f: { kind: string; text?: string }) => f.kind === 'float' && /dried off/.test(f.text ?? '')));
});

test('click-to-walk goes around fire when the detour fits in the movement, and straight through when it does not', () => {
  const rows = [
    '############',
    '#..........#',
    '#.########.#',
    '#..........#',
    '#.########.#',
    '#..........#',
    '############',
  ];
  const fire = (a: Arena) => a.ground(5, 3, 'fire', 2);
  const plan = (a: Arena) => a.p.walks.get(a.hero.id).path as { x: number; y: number }[];

  const around = arena({ rows });
  around.hero.x = 1;
  around.hero.y = 3;
  fire(around);
  around.p.turn.movesLeft = 14;
  around.g.handleMove(around.pid, { x: 10, y: 3 });
  const rest = plan(around);
  assert.ok(rest.length > 0 && rest.every((s) => !(s.x === 5 && s.y === 3)), 'it detours');
  assert.deepEqual(rest.at(-1), { x: 10, y: 3 });
  assert.equal(gid(around, around.hero.x, around.hero.y), undefined);
  around.g.dispose();

  const through = arena({ rows });
  through.hero.x = 1;
  through.hero.y = 3;
  fire(through);
  through.p.turn.movesLeft = 9;
  through.g.handleMove(through.pid, { x: 10, y: 3 });
  assert.ok(plan(through).some((s) => s.x === 5 && s.y === 3), 'no time for the detour: straight through the fire');
  through.g.dispose();
});

// ---------------------------------------------------------------- 4: shoves

test('shoved through fire: damaged and set alight, and carried on to the end of the shove', () => {
  const a = arena();
  a.ground(6, 3, 'fire', 2);
  a.hero.x = 4;
  a.hero.y = 3;
  const m = a.monster('goblin', 5, 3);
  withRandom(HIGH, () => a.p.push(m, a.hero, 2));
  assert.deepEqual([m.x, m.y], [7, 3]);
  assert.equal(m.hp, 96);
  assert.ok(has(m, 'burning'));
  assert.ok(logged(a, /knocked back 2 tiles/));
});

test('shoved into electrified water: stunned, and it stops there; onto ice: it slips and stops', () => {
  const a = arena();
  a.ground(6, 5, 'water', 4, { shock: 1 });
  const m = a.monster('goblin', 5, 5);
  withRandom(MID, () => a.p.push(m, { x: 4, y: 5 }, 2));
  assert.deepEqual([m.x, m.y], [6, 5], 'stopped on the water');
  assert.ok(has(m, 'stunned'));
  assert.equal(m.hp, 97, '1d4 lightning');

  a.ground(6, 1, 'ice', 3);
  const slider = a.monster('goblin', 5, 1);
  withRandom(LOW, () => a.p.push(slider, { x: 4, y: 1 }, 2));
  assert.deepEqual([slider.x, slider.y], [6, 1], 'slipped on the ice');
  assert.ok(logged(a, /slips on the ice/));

  a.ground(6, 6, 'ice', 3);
  const steady = a.monster('goblin', 5, 6);
  withRandom(HIGH, () => a.p.push(steady, { x: 4, y: 6 }, 2));
  assert.deepEqual([steady.x, steady.y], [7, 6], 'kept its footing');
});

test('knockback control: Shield Bash II and Shocking Grasp on a dry target fly the full 2 tiles', () => {
  const a = arena({ classes: ['fighter'] });
  a.hero.skills.find((s) => s.id === 'shield_bash')!.tier = 2;
  const m = a.monster('goblin', 3, 3);
  withRandom(MID, () => a.g.handleSkill(a.pid, 'shield_bash', m.id));
  assert.deepEqual([m.x, m.y], [5, 3]);

  const b = arena();
  b.hero.x = 3;
  b.hero.y = 3;
  learn(b.hero, 'shocking_grasp');
  const dry = b.monster('goblin', 4, 3);
  withRandom(MID, () => b.g.handleSkill(b.pid, 'shocking_grasp', dry.id));
  assert.deepEqual([dry.x, dry.y], [6, 3]);
  assert.ok(has(dry, 'shocked'));
});

test(
  'a shove goes the whole way even when the target gets stunned first (Concussive Bash: stun, then push 2)',
  () => {
    const a = arena({ classes: ['fighter'] });
    const bash = a.hero.skills.find((s) => s.id === 'shield_bash')!;
    bash.tier = 3;
    bash.branch = 'A';
    const m = a.monster('goblin', 3, 3);
    withRandom(MID, () => a.g.handleSkill(a.pid, 'shield_bash', m.id));
    assert.ok(has(m, 'stunned'));
    assert.ok(logged(a, /knocked back 2 tiles/));
    assert.deepEqual([m.x, m.y], [5, 3], 'flew 2 tiles, as logged');
  },
);

test(
  'Shocking Grasp on a Wet target stuns it and still knocks it back 2 tiles',
  () => {
    const a = arena();
    a.hero.x = 3;
    a.hero.y = 3;
    learn(a.hero, 'shocking_grasp');
    a.ground(4, 3, 'water', 4);
    const m = a.monster('goblin', 4, 3);
    a.p.standIn(m, 'appear');
    withRandom(MID, () => a.g.handleSkill(a.pid, 'shocking_grasp', m.id));
    assert.ok(has(m, 'stunned'));
    assert.deepEqual([m.x, m.y], [6, 3]);
  },
);

test(
  'pushing a creature that was already stunned or frozen still moves it the full distance over plain floor',
  () => {
    const a = arena();
    const stunned = a.monster('goblin', 5, 3);
    stunned.statuses.push({ id: 'stunned', turns: 1 });
    a.p.push(stunned, { x: 4, y: 3 }, 3);
    assert.equal(stunned.x, 8, 'stunned goblin');
    const frozen = a.monster('goblin', 5, 5);
    frozen.statuses.push({ id: 'frozen', turns: 1 });
    a.p.push(frozen, { x: 4, y: 5 }, 3);
    assert.equal(frozen.x, 8, 'frozen goblin');
  },
);

// ---------------------------------------------------------------- 5: electrified puddles

test('lightning through a puddle: everything standing in it is zapped and stunned, the hero too; another puddle is spared', () => {
  const a = arena();
  a.hero.x = 3;
  a.hero.y = 3;
  learn(a.hero, 'shocking_grasp');
  for (const [x, y] of [[3, 3], [4, 3], [5, 3], [6, 4], [9, 5]]) a.ground(x, y, 'water', 4);
  const A = a.monster('goblin', 4, 3);
  const B = a.monster('goblin', 5, 3); // behind A, so Shocking Grasp cannot shove A
  const C = a.monster('goblin', 6, 4); // diagonal to B: still the same puddle
  const D = a.monster('goblin', 9, 5); // a different puddle
  for (const e of [a.hero, A, B, C, D]) a.p.standIn(e, 'appear');
  for (const e of [a.hero, A, B, C, D]) assert.ok(has(e, 'wet'));

  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'shocking_grasp', A.id)), true);

  assert.ok(has(A, 'stunned'));
  assert.equal(A.hp, 92, '5 from the hit, 3 from the water');
  for (const m of [B, C]) {
    assert.ok(has(m, 'stunned'), `${m.id} is stunned by the electrified water`);
    assert.equal(m.hp, 97);
  }
  assert.equal(B.dmgBy[a.hero.id], 3, 'the hero gets the credit for the water too');
  assert.ok(has(a.hero, 'stunned'), 'a hero standing in the same puddle is hit: friendly fire through the field');
  assert.equal(a.hero.hp, 37);
  assert.equal(D.hp, 100);
  assert.ok(!has(D, 'stunned') && !has(D, 'shocked'), 'the other puddle is untouched');
  for (const [x, y] of [[3, 3], [4, 3], [5, 3], [6, 4]]) assert.equal(a.g.ground[a.at(x, y)]!.shock, SHOCK_TURNS);
  assert.equal(a.g.ground[a.at(9, 5)]!.shock, undefined);
  assert.ok(logged(a, /Lightning crackles through it/));
});

// ---------------------------------------------------------------- 6: friendly fire

test('Fireball catches an ally in the blast: they get a save and take the damage (log: Friendly fire)', () => {
  const a = arena({ classes: ['wizard', 'fighter'] });
  learn(a.hero, 'fireball');
  a.ally.x = 7;
  a.ally.y = 3;
  const m = a.monster('goblin', 6, 3);
  const pre = resolveAim(statsAt('fireball'), a.hero, { x: 6, y: 3 }, { map: a.g, entities: a.p.entities, inCombat: true });
  assert.ok(typeof pre === 'object');
  assert.deepEqual(pre.caught?.map((h) => h.id), [a.ally.id]);

  const slots = a.hero.slots;
  assert.equal(withRandom(LOW, () => a.g.handleSkill(a.pid, 'fireball', { x: 6, y: 3 })), true);
  assert.equal(a.hero.slots, slots - 1);
  assert.ok(logged(a, /Friendly fire! Bob is caught in the Fireball/));
  assert.ok(logged(a, /Bob is caught by Ann's Fireball I \(DEX save 🎲1\+1=2 vs DC 13\): 3 fire/), 'the ally rolls a save');
  assert.equal(a.ally.hp, 37, 'failed it: 3d6 of ones');
  assert.equal(m.hp, 97);
  assert.equal(a.hero.hp, 40);
});

test('Fireball: an ally who makes the save takes half; the caster is caught when the blast is next to them', () => {
  const a = arena({ classes: ['wizard', 'fighter'] });
  learn(a.hero, 'fireball');
  a.ally.x = 7;
  a.ally.y = 3;
  a.monster('goblin', 6, 3);
  withRandom(HIGH, () => a.g.handleSkill(a.pid, 'fireball', { x: 6, y: 3 }));
  assert.equal(a.ally.hp, 31, 'half of 18');
  assert.ok(logged(a, /Bob resists Ann's Fireball/));

  const b = arena();
  learn(b.hero, 'fireball');
  b.monster('goblin', 3, 3);
  withRandom(LOW, () => b.g.handleSkill(b.pid, 'fireball', { x: 3, y: 3 }));
  assert.ok(logged(b, /Friendly fire! Ann themself is caught in the Fireball/));
  assert.equal(b.hero.hp, 37, 'caught in their own fireball');
});

// ---------------------------------------------------------------- 7: explosions

test('an explosion hits everyone within 1 tile for 2d6 fire: heroes too, not the far, not the downed', () => {
  const a = arena({ classes: ['wizard', 'fighter'] });
  a.ground(5, 3, 'poison', 3);
  const near = a.monster('goblin', 6, 3);
  const on = a.monster('goblin', 5, 3);
  const far = a.monster('goblin', 9, 3);
  a.hero.x = 4;
  a.hero.y = 4;
  a.ally.x = 5;
  a.ally.y = 2;
  a.ally.downed = true;
  a.ally.hp = 0;
  withRandom(MID, () => a.p.runField([{ kind: 'touch', tiles: [a.at(5, 3)], element: 'fire' }]));
  assert.equal(near.hp, 92, '2d6 = 4 + 4');
  assert.equal(a.hero.hp, 32);
  assert.equal(far.hp, 100);
  assert.equal(a.ally.hp, 0, 'the downed are not hit again');
  assert.equal(on.hp, 89, 'the blast, then the new fire under it');
  assert.ok(has(on, 'burning'));
  assert.equal(gid(a, 5, 3), 'fire');
  assert.ok(logged(a, /caught in the explosion: 8 fire/));
});

test('an explosion hurts each creature once, however many tiles of it cover them', () => {
  const a = arena();
  a.ground(5, 3, 'poison');
  a.ground(6, 3, 'poison');
  const m = a.monster('goblin', 5, 4); // next to both puddles
  withRandom(MID, () => a.p.runField([{ kind: 'touch', tiles: [a.at(5, 3)], element: 'fire' }]));
  assert.equal(m.hp, 92);
});

test('Fire Bolt on a monster in an oil slick sets the whole slick alight and burns everyone in it', () => {
  const a = arena();
  for (const [x, y] of [[6, 3], [7, 3], [7, 4]]) a.ground(x, y, 'oil', 6);
  const hit = a.monster('goblin', 6, 3);
  const also = a.monster('goblin', 7, 4);
  const dry = a.monster('goblin', 9, 3);
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', hit.id)), true);
  for (const [x, y] of [[6, 3], [7, 3], [7, 4]]) {
    assert.equal(gid(a, x, y), 'fire');
    assert.equal(a.g.ground[a.at(x, y)]!.turns, OIL_FIRE_TURNS);
  }
  assert.equal(hit.hp, 91, '6 from the bolt, 3 from the flames');
  assert.equal(also.hp, 97);
  assert.ok(has(hit, 'burning') && has(also, 'burning'));
  assert.ok(!has(dry, 'burning') && dry.hp === 100);
  assert.ok(!has(a.hero, 'burning'));
  assert.ok(logged(a, /goes up in flames/));
});

test('Grease then Fire Bolt: a combo across two actions', () => {
  const a = arena();
  learn(a.hero, 'grease');
  const A = a.monster('goblin', 6, 3);
  const B = a.monster('goblin', 7, 4);
  const C = a.monster('goblin', 9, 6);
  assert.equal(a.g.handleSkill(a.pid, 'grease', { x: 6, y: 3 }), true);
  assert.equal(gid(a, 6, 3), 'oil');
  assert.equal(gid(a, 7, 4), 'oil');
  assert.equal(gid(a, 9, 6), undefined);
  assert.equal(A.hp + B.hp + C.hp, 300, 'Grease hurts nobody');
  assert.equal(a.hero.slots, 4);
  a.p.turn.ap = 3;
  withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', A.id));
  assert.ok(has(A, 'burning') && has(B, 'burning'), 'everyone in the grease burns');
  assert.ok(!has(C, 'burning'));
  assert.equal(gid(a, 7, 4), 'fire');
});

test('a bloated zombie caught in an explosion bursts onto the fire and sets off a second explosion', () => {
  const a = arena();
  a.ground(6, 3, 'poison', 3);
  const zombie = a.monster('bloated', 7, 3, { hp: 5 });
  const bystander = a.monster('goblin', 7, 5);
  withRandom(MID, () => a.p.runField([{ kind: 'touch', tiles: [a.at(6, 3)], element: 'fire' }], a.hero));
  assert.ok(!a.p.entities.includes(zombie), 'the blast killed it');
  assert.equal(a.hero.kills, 1, 'credited to whoever lit the fuse');
  assert.equal(bystander.hp, 92, 'the second blast reached the goblin two tiles from the first');
  assert.ok(logged(a, /bursts in a spray of poison/));
  assert.equal(a.p.log.filter((l: LogLine) => /It explodes/.test(l.text)).length, 2);
});

test("a firebomber's attack ignites the oil under its target even when it misses", () => {
  const a = arena();
  a.ground(3, 3, 'oil', 6);
  a.ground(3, 4, 'oil', 6);
  a.hero.x = 3;
  a.hero.y = 3;
  const fb = a.monster('firebomber', 7, 3);
  withRandom(LOW, () => a.p.monsterAttack(fb, a.hero));
  assert.ok(logged(a, /miss/));
  assert.equal(gid(a, 3, 3), 'fire');
  assert.equal(gid(a, 3, 4), 'fire', 'it spread');
  assert.equal(a.hero.hp, 39);
  assert.ok(has(a.hero, 'burning'));
});

test("a wight's cold attack freezes the puddle its target stands in", () => {
  const a = arena();
  a.ground(3, 3, 'water', 4);
  a.hero.x = 3;
  a.hero.y = 3;
  const wight = a.monster('wight', 7, 3);
  withRandom(LOW, () => a.p.monsterAttack(wight, a.hero));
  assert.equal(gid(a, 3, 3), 'ice');
});

// ---------------------------------------------------------------- 8: barrels and braziers

test('Fire Bolt aimed at an oil barrel explodes it: the tile opens up, the barrel is gone, the area burns', () => {
  const a = arena();
  a.prop(6, 3, 'barrel');
  const next = a.monster('goblin', 7, 3);
  const far = a.monster('goblin', 9, 6);
  const idx = a.at(6, 3);
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', { x: 6, y: 3 })), true);
  assert.equal(a.g.tiles[idx], '.');
  assert.equal(a.g.props[idx], undefined);
  assert.equal(a.g.ground[idx]?.id, 'fire');
  for (const [x, y] of [[5, 2], [6, 2], [7, 2], [5, 3], [7, 3], [5, 4], [6, 4], [7, 4]]) assert.equal(gid(a, x, y), 'fire', `(${x},${y})`);
  assert.equal(next.hp, 89, '2d6 blast and the burning oil');
  assert.ok(has(next, 'burning'));
  assert.equal(far.hp, 100);
  assert.equal(a.hero.hp, 40);
  assert.equal(a.p.turn.ap, 1);
  assert.ok(logged(a, /hits the Oil Barrel with Fire Bolt/));
  assert.ok(logged(a, /It explodes/));
});

test('hitting a barrel with a dagger only spills the oil; a brazier is knocked over into fire', () => {
  const a = arena();
  a.prop(6, 3, 'barrel');
  const m = a.monster('goblin', 7, 3);
  assert.equal(a.g.handleSkill(a.pid, 'dagger', { x: 6, y: 3 }), true);
  assert.equal(a.g.tiles[a.at(6, 3)], '.');
  assert.equal(a.g.props[a.at(6, 3)], undefined);
  for (const i of tilesAround(a.g, { x: 6, y: 3 }, 1)) {
    assert.equal(a.g.ground[i]?.id, 'oil');
    assert.equal(a.g.ground[i]!.turns, GROUNDS.oil.turns);
  }
  assert.equal(m.hp, 100);
  assert.ok(logged(a, /Oil spills everywhere/));
  assert.ok(!logged(a, /explodes/));

  const b = arena();
  b.prop(6, 3, 'brazier');
  const burnt = b.monster('goblin', 7, 3);
  assert.equal(b.g.handleSkill(b.pid, 'dagger', { x: 6, y: 3 }), true);
  assert.equal(b.g.props[b.at(6, 3)], undefined);
  assert.equal(gid(b, 6, 3), 'fire');
  assert.equal(b.g.ground[b.at(6, 3)]!.turns, GROUNDS.fire.turns);
  assert.ok(has(burnt, 'burning'));
  assert.ok(logged(b, /Burning coals spill out/));
});

test('a barrel out of range, or behind smoke, cannot be targeted and costs nothing', () => {
  const a = arena();
  a.prop(9, 3, 'barrel');
  assert.equal(a.g.handleSkill(a.pid, 'dagger', { x: 9, y: 3 }), false, 'a dagger reaches 4 tiles');
  assert.equal(a.p.turn.ap, 3);
  assert.equal(a.g.props[a.at(9, 3)], 'barrel');
  a.cloud(5, 3, 'smoke');
  assert.equal(a.g.handleSkill(a.pid, 'fire_bolt', { x: 9, y: 3 }), false, 'no line of sight through smoke');
  assert.equal(a.g.props[a.at(9, 3)], 'barrel');
  delete a.g.clouds[a.at(5, 3)];
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', { x: 9, y: 3 })), true);
  assert.equal(a.g.props[a.at(9, 3)], undefined);
});

test('smoke blocks targeting through the game too', () => {
  const a = arena();
  const m = a.monster('goblin', 7, 3);
  a.cloud(4, 3, 'smoke');
  assert.equal(a.g.handleSkill(a.pid, 'fire_bolt', m.id), false);
  assert.equal(a.p.turn.ap, 3);
  assert.equal(m.hp, 100);
  delete a.g.clouds[a.at(4, 3)];
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', m.id)), true);
  assert.ok(m.hp < 100);
});

// ---------------------------------------------------------------- 9: death surfaces

test('a bloated zombie bursts into poison where it dies, poisoning the living (not the undead)', () => {
  const a = arena();
  a.hero.x = 5;
  a.hero.y = 3;
  const bloated = a.monster('bloated', 6, 3);
  const goblin = a.monster('goblin', 6, 4);
  const skeleton = a.monster('skeleton', 7, 4);
  withRandom(MID, () => a.p.damage(bloated, 999, a.hero));
  assert.ok(!a.p.entities.includes(bloated));
  assert.equal(a.hero.kills, 1);
  for (const i of tilesAround(a.g, { x: 6, y: 3 }, 1)) {
    assert.equal(a.g.ground[i]?.id, 'poison');
    assert.equal(a.g.ground[i]!.turns, GROUNDS.poison.turns);
    assert.equal(a.g.ground[i]!.by, a.hero.id, 'credited to whoever killed it');
  }
  assert.ok(logged(a, /bursts in a spray of poison/));
  assert.ok(has(a.hero, 'poisoned'));
  assert.equal(a.hero.hp, 37);
  assert.ok(has(goblin, 'poisoned'));
  assert.equal(goblin.hp, 97);
  assert.ok(!has(skeleton, 'poisoned'));
  assert.equal(skeleton.hp, 100, 'poison cannot hurt the dead');
});

test('a magma imp collapses into fire; with no killer the fire is anonymous', () => {
  const a = arena();
  a.hero.x = 5;
  a.hero.y = 3;
  const imp = a.monster('imp', 6, 3);
  withRandom(MID, () => a.p.damage(imp, 999, a.hero));
  for (const i of tilesAround(a.g, { x: 6, y: 3 }, 1)) {
    assert.equal(a.g.ground[i]?.id, 'fire');
    assert.equal(a.g.ground[i]!.turns, GROUNDS.fire.turns);
    assert.equal(a.g.ground[i]!.by, a.hero.id);
  }
  assert.ok(logged(a, /collapses into a pool of fire/));
  assert.ok(has(a.hero, 'burning'));
  assert.equal(a.hero.hp, 37);

  const b = arena();
  const bloated = b.monster('bloated', 8, 4);
  b.p.damage(bloated, 999);
  assert.equal(b.g.ground[b.at(8, 4)]?.id, 'poison');
  assert.ok(!('by' in b.g.ground[b.at(8, 4)]!));
});

// ---------------------------------------------------------------- 10: resistances

test('a fire drake is immune to fire (damage and flames); a magma imp is healed by it', () => {
  const a = arena();
  const drake = a.monster('drake', 6, 3);
  a.p.damage(drake, 10, a.hero, 'fire');
  assert.equal(drake.hp, 100);
  assert.ok(a.p.fx.some((f: { kind: string; text?: string }) => f.kind === 'float' && f.text === 'immune'));
  a.ground(6, 3, 'fire', 2);
  withRandom(HIGH, () => a.p.standIn(drake, 'step'));
  assert.equal(drake.hp, 100, 'standing in fire');
  assert.ok(!has(drake, 'burning'));
  a.p.applyStatus(drake, { id: 'burning', turns: 2 });
  assert.ok(!has(drake, 'burning'));
  a.p.damage(drake, 10, a.hero, 'cold');
  assert.equal(drake.hp, 90, 'other elements still work');

  const imp = a.monster('imp', 8, 5);
  imp.maxHp = 16;
  imp.hp = 5;
  a.p.damage(imp, 4, a.hero, 'fire');
  assert.equal(imp.hp, 9);
  assert.ok(logged(a, /Magma Imp drinks in the fire: \+4 HP/));
  a.p.damage(imp, 50, a.hero, 'fire');
  assert.equal(imp.hp, 16, 'healing stops at max HP');
  imp.hp = 10;
  a.p.damage(imp, 4, a.hero, 'cold');
  assert.equal(imp.hp, 2, 'cold is double against an imp');
});

test('zombies burn, cultists resist, Wet halves fire; poison cannot touch a skeleton', () => {
  const a = arena();
  const zombie = a.monster('zombie', 6, 3);
  a.p.damage(zombie, 5, a.hero, 'fire');
  assert.equal(zombie.hp, 90);
  const cultist = a.monster('cultist', 7, 3);
  a.p.damage(cultist, 5, a.hero, 'fire');
  assert.equal(cultist.hp, 98);
  a.ground(8, 5, 'water');
  const soaked = a.monster('goblin', 8, 5);
  a.p.standIn(soaked, 'appear');
  a.p.damage(soaked, 6, a.hero, 'fire');
  assert.equal(soaked.hp, 97);
  a.p.damage(soaked, 6, a.hero);
  assert.equal(soaked.hp, 91, 'physical damage is not halved');

  const skeleton = a.monster('skeleton', 9, 2);
  a.ground(9, 2, 'poison');
  a.p.standIn(skeleton, 'step');
  a.p.damage(skeleton, 10, a.hero, 'poison');
  assert.equal(skeleton.hp, 100);
  assert.ok(!has(skeleton, 'poisoned'));
});

test('Attunement (Elemental Affinity III-B): half fire damage, never Burning, and flames on the ground do nothing', () => {
  const a = arena();
  learn(a.hero, 'elemental_affinity', 3, 'B');
  const m = a.monster('goblin', 6, 3);
  a.p.damage(a.hero, 10, m, 'fire');
  assert.equal(a.hero.hp, 35);
  a.p.applyStatus(a.hero, { id: 'burning', turns: 2 }, m);
  assert.ok(!has(a.hero, 'burning'));
  a.ground(3, 3, 'fire', 2);
  withRandom(HIGH, () => a.g.handleStep(a.pid, 1, 0));
  assert.deepEqual([a.hero.x, a.hero.y], [3, 3]);
  assert.equal(a.hero.hp, 35, 'the fire under them does not hurt');
  assert.ok(!has(a.hero, 'burning'));
  a.p.damage(a.hero, 10, m, 'cold');
  assert.equal(a.hero.hp, 25, 'other elements are full damage');

  const plain = arena();
  const q = plain.monster('goblin', 6, 3);
  plain.p.damage(plain.hero, 10, q, 'fire');
  assert.equal(plain.hero.hp, 30, 'everyone else takes it all');
});

test('poison gas poisons whoever starts a turn in it, except the undead', () => {
  const a = arena();
  a.cloud(2, 3, 'gas', 2);
  a.p.turn.order = [a.hero.id, a.sentinel.id];
  a.p.turn.index = 0;
  a.p.beginTurn();
  assert.ok(has(a.hero, 'poisoned'));
  assert.ok(logged(a, /breathes in the poison gas/));

  const skeleton = a.monster('skeleton', 6, 3);
  a.cloud(6, 3, 'gas', 2);
  a.p.standIn(skeleton, 'start');
  assert.ok(!has(skeleton, 'poisoned'));
});

// ---------------------------------------------------------------- 11: the round tick

test('the field ticks when the round turns over (not before): fire burns out, ice melts, steam clears', () => {
  const a = arena({ classes: ['wizard', 'fighter'] });
  a.ground(2, 3, 'fire', 1); // under Ann: out by the time her turn starts
  a.ground(2, 4, 'fire', 2); // under Bob: still burning
  a.ground(6, 3, 'ice', 1);
  a.ground(7, 3, 'water', 4, { shock: 1 });
  a.ground(8, 3, 'water', null);
  a.cloud(6, 5, 'steam', 1);
  a.cloud(7, 5, 'smoke', 3);
  a.p.turn.order = [a.hero.id, a.ally.id, a.sentinel.id];
  a.p.turn.index = 2;
  a.p.turnOwner = a.sentinel.id;

  withRandom(MID, () => a.p.advanceTurn());
  assert.equal(a.p.turn.round, 2);
  assert.equal(a.p.turn.index, 0);
  assert.equal(gid(a, 2, 3), undefined, 'a fire with 1 turn is gone');
  assert.equal(a.hero.hp, 40, 'so Ann is not burned at the start of her turn');
  assert.equal(a.g.ground[a.at(2, 4)]!.turns, 1);
  assert.equal(gid(a, 6, 3), 'water', 'the ice melted');
  assert.equal(a.g.ground[a.at(7, 3)]!.shock, undefined, 'the electricity faded');
  assert.equal(a.g.ground[a.at(7, 3)]!.turns, 3);
  assert.equal(a.g.ground[a.at(8, 3)]!.turns, null, 'permanent puddles stay');
  assert.equal(a.g.clouds[a.at(6, 5)], undefined);
  assert.equal(a.g.clouds[a.at(7, 5)]!.turns, 2);

  withRandom(MID, () => a.p.advanceTurn()); // Ann -> Bob, mid-round: no tick
  assert.equal(a.p.turn.round, 2);
  assert.equal(a.g.ground[a.at(2, 4)]!.turns, 1, 'no tick mid-round');
  assert.equal(a.ally.hp, 37, 'Bob starts his turn in the flames');
  assert.ok(has(a.ally, 'burning'));
  assert.ok(logged(a, /Bob is still in the flames/));
  a.g.dispose();
});

// ---------------------------------------------------------------- 12: ice

test('stepping onto ice: a failed DEX save ends your movement, a good one keeps you going', () => {
  const slip = arena();
  slip.ground(3, 3, 'ice', 3);
  withRandom(LOW, () => slip.g.handleStep(slip.pid, 1, 0));
  assert.deepEqual([slip.hero.x, slip.hero.y], [3, 3], 'you do get onto the ice');
  assert.equal(slip.p.turn.movesLeft, 0, 'but you fall and lose the rest of your movement');
  assert.ok(logged(slip, /slips on the ice/));
  slip.g.handleStep(slip.pid, 1, 0);
  assert.equal(slip.hero.x, 3, 'no more steps this turn');

  const steady = arena();
  steady.ground(3, 3, 'ice', 3);
  withRandom(HIGH, () => steady.g.handleStep(steady.pid, 1, 0));
  assert.equal(steady.p.turn.movesLeft, 5);
  assert.ok(!logged(steady, /slips/));
});

// ---------------------------------------------------------------- the rest of the cast

test('Smoke Bomb: you land next to the target in a cloud of smoke, hidden, with extra movement', () => {
  const a = arena({ classes: ['rogue'] });
  const s = a.hero.skills.find((x) => x.id === 'shadow_step')!;
  s.tier = 3;
  s.branch = 'B';
  const m = a.monster('goblin', 7, 3);
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'shadow_step', m.id)), true);
  assert.equal(Math.max(Math.abs(a.hero.x - 7), Math.abs(a.hero.y - 3)), 1, 'next to the goblin');
  for (const i of tilesAround(a.g, a.hero, 1)) {
    assert.equal(a.g.clouds[i]?.id, 'smoke', `tile ${i}`);
    assert.equal(a.g.clouds[i]!.turns, CLOUDS.smoke.turns);
  }
  assert.equal(a.g.clouds[a.at(2, 3)], undefined, 'nothing where you started');
  assert.ok(has(a.hero, 'hidden'));
  assert.equal(a.p.turn.movesLeft, 9);
});

test('a death burst waits for the spell that caused it: a Fire Bolt kill leaves the poison unlit, an Inferno kill sets it off', () => {
  const a = arena();
  const z = a.monster('bloated', 6, 3, { hp: 2 });
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', z.id)), true);
  assert.ok(!a.p.entities.includes(z), 'dead');
  assert.equal(gid(a, 6, 3), 'poison', 'the bolt landed first, then the zombie burst: no explosion');
  assert.ok(!a.p.log.some((l: { text: string }) => /It explodes/.test(l.text)));
  // Inferno leaves fire on the tile first, and the poison lands in it.
  const b = arena();
  const bolt = b.hero.skills.find((s) => s.id === 'fire_bolt')!;
  bolt.tier = 3;
  bolt.branch = 'A';
  const z2 = b.monster('bloated', 6, 3, { hp: 2 });
  assert.equal(withRandom(MID, () => b.g.handleSkill(b.pid, 'fire_bolt', z2.id)), true);
  assert.ok(b.p.log.some((l: { text: string }) => /It explodes/.test(l.text)), 'poison poured onto the fire explodes');
});

test('a toppled brazier spills fire all around it, but not onto whoever knocked it over', () => {
  const a = arena({ classes: ['fighter'] });
  a.prop(6, 3, 'brazier');
  a.hero.x = 5;
  a.hero.y = 3;
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'longsword', { x: 6, y: 3 })), true);
  assert.equal(gid(a, 5, 3), undefined, "the attacker's tile");
  assert.equal(gid(a, 6, 3), 'fire');
  assert.equal(gid(a, 7, 3), 'fire');
  assert.equal(gid(a, 5, 2), 'fire');
});

test('Inferno (Fire Bolt III-A) leaves a fire on the target tile even when the bolt kills the target', () => {
  const a = arena();
  const bolt = a.hero.skills.find((s) => s.id === 'fire_bolt')!;
  bolt.tier = 3;
  bolt.branch = 'A';
  const m = a.monster('goblin', 6, 3, { hp: 3 });
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'fire_bolt', m.id)), true);
  assert.ok(!a.p.entities.includes(m), 'dead');
  assert.equal(gid(a, 6, 3), 'fire');
  assert.equal(a.g.ground[a.at(6, 3)]!.turns, GROUNDS.fire.turns);
  assert.equal(a.g.ground[a.at(6, 3)]!.by, a.hero.id);
  assert.equal(gid(a, 7, 3), undefined, 'only the target tile');
});

test('Meteor (Fireball III-A) costs 2 slots and leaves fire over its whole area, burning allies caught in it too', () => {
  const a = arena({ classes: ['wizard', 'fighter'] });
  learn(a.hero, 'fireball', 3, 'A');
  a.hero.slots = 3;
  a.ally.x = 7;
  a.ally.y = 3;
  const m = a.monster('goblin', 6, 3);
  assert.equal(withRandom(LOW, () => a.g.handleSkill(a.pid, 'fireball', { x: 6, y: 3 })), true);
  assert.equal(a.hero.slots, 1);
  for (const i of tilesAround(a.g, { x: 6, y: 3 }, 2)) {
    assert.equal(a.g.ground[i]?.id, 'fire', `tile ${i}`);
    assert.equal(a.g.ground[i]!.turns, GROUNDS.fire.turns);
  }
  assert.ok(has(m, 'burning'));
  assert.ok(has(a.ally, 'burning'), 'standing in the new fire');
  assert.ok(a.ally.hp < 40);
  assert.ok(logged(a, /Friendly fire! Bob is caught in the Meteor/));
});

test('Deep Freeze (Ray of Frost III-A) freezes what it hits; Glacial Ray (III-B) freezes the puddle and ices the ground around', () => {
  const a = arena();
  learn(a.hero, 'ray_of_frost', 3, 'A');
  const m = a.monster('goblin', 6, 3);
  assert.equal(withRandom(MID, () => a.g.handleSkill(a.pid, 'ray_of_frost', m.id)), true);
  assert.ok(has(m, 'frozen'), 'Deep Freeze');
  a.p.turn.order = [m.id, a.hero.id, a.sentinel.id];
  a.p.turn.index = 0;
  a.p.beginTurn();
  assert.ok(logged(a, /frozen solid and loses the turn/));
  a.g.dispose();

  const b = arena();
  learn(b.hero, 'ray_of_frost', 3, 'B');
  b.ground(6, 3, 'water', 4);
  const wet = b.monster('goblin', 6, 3);
  b.p.standIn(wet, 'appear');
  assert.equal(withRandom(MID, () => b.g.handleSkill(b.pid, 'ray_of_frost', wet.id)), true);
  assert.ok(has(wet, 'frozen'), 'Wet + cold');
  assert.equal(gid(b, 6, 3), 'ice', 'the puddle under it froze');
  for (const i of tilesAround(b.g, { x: 6, y: 3 }, 1)) assert.equal(b.g.ground[i]?.id, 'ice', `tile ${i}`);
  assert.equal(gid(b, 8, 3), undefined);
  assert.ok(logged(b, /The water freezes over/));
});

test('Create Water on a fire makes steam and soaks everyone in it', () => {
  const a = arena({ classes: ['cleric'] });
  learn(a.hero, 'create_water');
  a.ground(6, 3, 'fire', 2);
  const inFire = a.monster('goblin', 6, 3);
  const beside = a.monster('goblin', 7, 4);
  assert.equal(a.g.handleSkill(a.pid, 'create_water', { x: 6, y: 3 }), true);
  assert.equal(gid(a, 6, 3), undefined, 'the fire is out');
  assert.equal(a.g.clouds[a.at(6, 3)]?.id, 'steam');
  assert.equal(gid(a, 7, 4), 'water');
  assert.ok(has(inFire, 'wet') && has(beside, 'wet'));
  assert.ok(!has(inFire, 'burning'));
  assert.ok(logged(a, /The fire goes out/));
  assert.equal(inFire.hp + beside.hp, 200, 'Create Water hurts nobody, allies included');
});

test('winning the fight wipes the battlefield and the statuses it caused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delvers-elements-'));
  process.env.DELVERS_SAVES = dir;
  try {
    const a = arena();
    a.p.run = { act: 1, maxAct: 3, actName: 'Goblin Warrens', map: generateActMap(1, 7, 4), currentId: null, visited: [], gold: 0, relics: [], blessings: [], allies: [], seed: 7 };
    a.ground(4, 4, 'fire', 2);
    a.ground(5, 4, 'water', null);
    a.cloud(6, 4, 'smoke');
    a.prop(8, 4, 'barrel');
    a.hero.statuses.push({ id: 'burning', turns: 2 }, { id: 'chilled', turns: 2 });
    a.p.damage(a.sentinel, 99999, a.hero);
    a.p.checkEnd();
    assert.equal(a.g.phase, 'map');
    assert.deepEqual([a.g.width, a.g.height, a.g.tiles], [0, 0, '']);
    assert.deepEqual(a.g.ground, {});
    assert.deepEqual(a.g.clouds, {});
    assert.deepEqual(a.g.props, {});
    assert.deepEqual(a.hero.statuses, []);
    a.g.dispose();
  } finally {
    delete process.env.DELVERS_SAVES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the room and the snapshot

test('a fight room is dressed for its act, and the battlefield goes out in the state snapshot', async () => {
  let last: GameState | null = null;
  const io = { to: () => ({ emit: (event: string, data: unknown) => event === 'state' && (last = data as GameState) }) } as unknown as Server;
  const g = new Game(io, 'DRES');
  games.push(g);
  const p = g as any;
  assert.ok(g.join(undefined, 'Ann', 'wizard').ok);
  p.entities = [p.makePlayer(p.players[0], 1)];
  p.run = { act: 2 };
  p.startRoom('combat', ['goblin', 'goblin'], 'Test', 'charge');
  await new Promise((r) => setImmediate(r));
  const crypt = last as unknown as GameState;
  assert.equal(crypt.phase, 'combat');
  assert.ok(Object.values(crypt.ground).some((x) => x?.id === 'water'), 'act 2 has water');
  assert.deepEqual(crypt.clouds, {});
  assert.deepEqual(crypt.props, g.props);
  assert.equal(crypt.ground, g.ground);
  assert.equal(crypt.tiles.length, crypt.width * crypt.height);

  p.run = { act: 3 };
  p.startRoom('combat', ['goblin'], 'Test', 'charge');
  await new Promise((r) => setImmediate(r));
  const lair = last as unknown as GameState;
  assert.ok(Object.values(lair.ground).some((x) => x?.id === 'lava'), 'act 3 has lava');
  assert.ok(!Object.values(lair.ground).some((x) => x?.id === 'water'), 'nothing carries over from the last room');
  g.dispose();
});

// ---------------------------------------------------------------- 13: room themes

const ACT_THEME: Record<number, { ground: string[]; props: string[] }> = {
  1: { ground: ['oil'], props: ['barrel', 'brazier'] },
  2: { ground: ['water', 'poison'], props: [] },
  3: { ground: ['lava', 'oil'], props: ['brazier', 'barrel'] },
};
const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const KINDS = ['combat', 'elite', 'boss'] as const;

function checkDressing(room: RoomLayout, act: number, where: string) {
  const { width, height, tiles } = room;
  const theme = ACT_THEME[act];
  const spawns = [...room.partySpawns, ...room.enemySpawns].map((s) => s.y * width + s.x);
  assert.ok(room.partySpawns.length >= 12 && room.enemySpawns.length >= 12, `${where}: enough spawn tiles`);
  for (const [k, g] of Object.entries(room.ground)) {
    const i = Number(k);
    const x = i % width;
    assert.equal(tiles[i], '.', `${where}: a patch on a non-floor tile ${i}`);
    assert.ok(theme.ground.includes(g!.id), `${where}: ${g!.id} does not belong in act ${act}`);
    assert.equal(g!.turns, null, `${where}: room features are permanent`);
    assert.ok(x >= 3 && x <= width - 4, `${where}: a patch in a spawn column (${x})`);
    assert.ok(!spawns.includes(i), `${where}: a patch on a spawn tile`);
  }
  for (const [k, id] of Object.entries(room.props)) {
    const i = Number(k);
    const x = i % width;
    assert.equal(tiles[i], '#', `${where}: a prop must stand on a '#' tile`);
    assert.ok(theme.props.includes(id!), `${where}: ${id} does not belong in act ${act}`);
    assert.equal(room.ground[i], undefined, `${where}: oil under a prop`);
    assert.ok(x >= 3 && x <= width - 4, `${where}: a prop in a spawn column`);
    assert.ok(Math.floor(i / width) >= 1 && Math.floor(i / width) <= height - 2, `${where}: a prop on the border`);
  }
  for (const i of spawns) assert.equal(tiles[i], '.', `${where}: a spawn tile is not floor`);
  const floor = [...tiles].filter((t) => t === '.').length;
  const start = tiles.indexOf('.');
  const seen = reachable(room, { x: start % width, y: Math.floor(start / width) }, width * height, () => false);
  assert.equal(seen.size, floor, `${where}: props or patches cut the room in two`);
}

test('dressed rooms keep their rules: props on walls, patches on floor away from spawns, the room still connected', () => {
  for (const act of [1, 2, 3]) {
    for (const kind of KINDS) {
      for (const seed of SEEDS) checkDressing(generateRoom(kind, makeRng(seed), act), act, `act ${act} ${kind} seed ${seed}`);
    }
  }
});

test('act 1 rooms have oil and/or barrels, act 2 water, act 3 lava', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      const one = generateRoom(kind, makeRng(seed), 1);
      const oil = Object.values(one.ground).some((g) => g?.id === 'oil');
      const barrels = Object.values(one.props).some((id) => id === 'barrel');
      assert.ok(oil || barrels, `act 1 ${kind} seed ${seed}: no oil and no barrels`);
      const two = generateRoom(kind, makeRng(seed), 2);
      assert.ok(Object.values(two.ground).some((g) => g?.id === 'water'), `act 2 ${kind} seed ${seed}: no water`);
      assert.deepEqual(two.props, {}, 'act 2 has no props');
      const three = generateRoom(kind, makeRng(seed), 3);
      assert.ok(Object.values(three.ground).some((g) => g?.id === 'lava'), `act 3 ${kind} seed ${seed}: no lava`);
    }
  }
  const barrels = SEEDS.filter((s) => Object.values(generateRoom('combat', makeRng(s), 1).props).includes('barrel')).length;
  assert.ok(barrels >= SEEDS.length * 0.8, `barrels turn up in most act 1 rooms (${barrels}/${SEEDS.length})`);
  const braziers = SEEDS.filter((s) => Object.values(generateRoom('combat', makeRng(s), 3).props).includes('brazier')).length;
  assert.ok(braziers >= SEEDS.length * 0.8, `braziers turn up in most act 3 rooms (${braziers}/${SEEDS.length})`);
});

test('act 0 rooms are bare, and the same seed gives the same dressed room', () => {
  for (const seed of SEEDS) {
    const bare = generateRoom('combat', makeRng(seed));
    assert.deepEqual(bare.ground, {});
    assert.deepEqual(bare.props, {});
    assert.deepEqual(generateRoom('combat', makeRng(seed), 7).props, {}, 'an unknown act is bare too');
  }
  assert.deepEqual(generateRoom('elite', makeRng(9), 3), generateRoom('elite', makeRng(9), 3));
});
