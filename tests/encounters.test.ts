import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTS, ACT_ROWS, MONSTERS } from '../shared/rules.ts';

test('every encounter template uses known monsters with a threat cost', () => {
  for (const act of ACTS) {
    for (const e of act.encounters) {
      assert.ok(e.monsters.length > 0, `${act.name} / ${e.name} is empty`);
      for (const m of e.monsters) assert.ok(MONSTERS[m]?.threat > 0, `${act.name} / ${e.name}: unknown or free monster "${m}"`);
    }
  }
});

test('every map row has at least one encounter template', () => {
  for (const act of ACTS) {
    for (let row = 0; row < ACT_ROWS; row++) {
      assert.ok(act.encounters.some((e) => (e.minRow ?? 0) <= row), `${act.name} has no template for row ${row}`);
    }
  }
});

test('elites, escorts, bosses and minions exist', () => {
  for (const act of ACTS) {
    for (const elite of act.elites) {
      assert.ok(MONSTERS[elite], `unknown elite ${elite}`);
      for (const m of act.escorts[elite] ?? []) assert.ok(MONSTERS[m]?.threat > 0, `${elite} escort "${m}" unknown`);
    }
    for (const key of Object.keys(act.escorts)) assert.ok(act.elites.includes(key), `${act.name}: escorts for non-elite ${key}`);
    assert.ok(MONSTERS[act.boss], `unknown boss ${act.boss}`);
    for (const m of act.minions) assert.ok(MONSTERS[m], `unknown minion ${m}`);
    for (const m of act.pool) assert.ok(MONSTERS[m], `unknown pool monster ${m}`);
  }
});
