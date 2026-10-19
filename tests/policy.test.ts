import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { OPTION_FEATURES } from '../server/monsterai.ts';
import { POLICY_FILE, Policy, validPolicy, type PolicyFile } from '../server/policy.ts';

/** A network small enough to work out by hand: OPTION_FEATURES inputs, 2 tanh units, 1 output. */
function tiny(): PolicyFile {
  const row = (k: number) => Array.from({ length: OPTION_FEATURES }, (_, i) => (i === k ? 1 : 0));
  return {
    version: 1, features: OPTION_FEATURES, trainedAt: 'test', steps: 0,
    layers: [
      { w: [row(0), row(1)], b: [0, 0.5], act: 'tanh' },
      { w: [[2, -1]], b: [0.25], act: 'linear' },
    ],
  };
}
const input = (a: number, b: number) => Array.from({ length: OPTION_FEATURES }, (_, i) => (i === 0 ? a : i === 1 ? b : 0));

test('the policy runs its layers like PyTorch: weights[out][in], bias, then the activation', () => {
  const p = new Policy(tiny());
  const want = 2 * Math.tanh(0.3) - Math.tanh(-0.2 + 0.5) + 0.25;
  assert.ok(Math.abs(p.score(input(0.3, -0.2)) - want) < 1e-12);
});

test('it picks the best-scored option, and the first one on a tie (the scripted pick comes first)', () => {
  const p = new Policy(tiny());
  assert.equal(p.pick([input(0, 0), input(1, 0), input(0.5, 0)]), 1);
  assert.equal(p.pick([input(0.2, 0), input(0.2, 0)]), 0);
});

test('a policy file has to fit this version of the monster AI', () => {
  assert.ok(validPolicy(tiny()));
  assert.equal(validPolicy({ ...tiny(), features: OPTION_FEATURES - 1 }), false, 'trained on other features');
  const broken = tiny();
  broken.layers[1].w = [[1, 2, 3]];
  assert.equal(validPolicy(broken), false, 'layers that do not chain');
  const wide = tiny();
  wide.layers[1] = { w: [[1, 1], [1, 1]], b: [0, 0], act: 'linear' };
  assert.equal(validPolicy(wide), false, 'more than one output');
  assert.equal(validPolicy(null), false);
});

test('the shipped policy scores its check inputs exactly as PyTorch did', { skip: !fs.existsSync(POLICY_FILE) && 'no trained policy yet' }, () => {
  const file = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) as PolicyFile;
  assert.ok(validPolicy(file), 'it fits this version of the monster AI');
  assert.ok(file.check?.inputs.length, 'the trainer writes a few check inputs');
  const p = new Policy(file);
  file.check!.inputs.forEach((x, i) => assert.ok(Math.abs(p.score(x) - file.check!.scores[i]) < 1e-4, `check ${i}`));
});
