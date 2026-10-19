"""
PPO for the monsters (Phase 11).

Node workers (training/env.ts) play real fights headless and ask this script for every monster decision. The network
scores each option the scripted AI lists (features in, one score out); a softmax over the scores is the policy. A
second small network estimates how the fight is going for the monsters (the value, for PPO's advantages).

  1. Imitation (--imitate N decisions): play the scripted AI's pick (always option 0) and learn to copy it, so PPO
     starts from monsters that already fight well instead of from random ones.
  2. PPO (--updates N): sample from the policy, collect finished fights, update, repeat. Every --eval-every updates the
     greedy policy plays --eval-fights fights next to the scripted AI on the same recorded fights.
  3. Export: the best checkpoint goes to server/policies/monster-ppo.json (the weights the server runs, in plain
     TypeScript: server/policy.ts) and monster-ppo.onnx.

    training/.venv/Scripts/python training/ppo.py --name run1
    training/.venv/Scripts/python training/ppo.py --export training/runs/run1/best.pt

See training/README.md.
"""

import argparse
import csv
import json
import os
import queue
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
POLICY_JSON = os.path.join(ROOT, 'server', 'policies', 'monster-ppo.json')
POLICY_ONNX = os.path.join(ROOT, 'server', 'policies', 'monster-ppo.onnx')


# ---------------------------------------------------------------- the network

class Net(nn.Module):
    """Scores options (features -> score) and values states (state -> expected return)."""

    def __init__(self, features, state, hidden=64):
        super().__init__()
        self.features, self.state = features, state
        self.scorer = nn.Sequential(nn.Linear(features, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 1))
        self.value = nn.Sequential(nn.Linear(state, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 1))

    def logits(self, opts, mask):
        return self.scorer(opts).squeeze(-1).masked_fill(~mask, -1e9)

    def v(self, state):
        return self.value(state).squeeze(-1)


def pad(opts_list, max_options, features):
    """Options of different counts -> a [B, max, F] tensor and a mask of the real ones."""
    b = len(opts_list)
    x = np.zeros((b, max_options, features), dtype=np.float32)
    m = np.zeros((b, max_options), dtype=bool)
    for i, opts in enumerate(opts_list):
        n = min(len(opts), max_options)
        x[i, :n] = np.asarray(opts[:n], dtype=np.float32)
        m[i, :n] = True
    return torch.from_numpy(x), torch.from_numpy(m)


# ---------------------------------------------------------------- the workers

class Worker:
    """One Node process running training/env.ts: several fights at once, a decision per line."""

    def __init__(self, idx, args, inbox, run_dir):
        self.idx = idx
        self.log = open(os.path.join(run_dir, f'worker{idx}.log'), 'w', encoding='utf-8')
        self.proc = subprocess.Popen(
            [NODE, 'training/env.ts', args.fights, str(args.at_once), 'train'],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, encoding='utf-8', bufsize=1,
        )
        self.hello = json.loads(self.proc.stdout.readline())['hello']
        threading.Thread(target=self._read, args=(inbox,), daemon=True).start()

    def _read(self, inbox):
        for line in self.proc.stdout:
            inbox.put((self.idx, json.loads(line)))
        inbox.put((self.idx, {'dead': True}))

    def send(self, ep, a):
        self.proc.stdin.write(json.dumps({'ep': ep, 'a': int(a)}) + '\n')
        self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.kill()
        except OSError:
            pass
        self.log.close()


class Pool:
    """All the workers, and the fights in progress (they carry over from one update to the next)."""

    def __init__(self, args, run_dir):
        self.inbox = queue.Queue()
        self.workers = [Worker(i, args, self.inbox, run_dir) for i in range(args.workers)]
        self.hello = self.workers[0].hello
        self.live = {}  # (worker, ep) -> steps so far

    def collect(self, net, steps_wanted, how):
        """Plays until `steps_wanted` decisions sit in finished fights. how: 'imitate' (play option 0) or 'sample'."""
        finished, have, results = [], 0, []
        f, mo = self.hello['features'], self.hello['maxOptions']
        while have < steps_wanted:
            batch = [self.inbox.get()]
            while True:
                try:
                    batch.append(self.inbox.get_nowait())
                except queue.Empty:
                    break
            decide = []
            for w, msg in batch:
                if msg.get('dead'):
                    raise RuntimeError(f'worker {w} died: see its log in the run folder')
                key = (w, msg['ep'])
                steps = self.live.get(key)
                if msg.get('end'):
                    if steps:
                        steps[-1]['r'] += msg['r']
                        finished.append(steps)
                        have += len(steps)
                        results.append(msg)
                    self.live.pop(key, None)
                    continue
                if steps is None:
                    steps = self.live[key] = []
                elif steps:
                    steps[-1]['r'] += msg['r']
                decide.append((w, msg, steps))
            if not decide:
                continue
            opts, mask = pad([d[1]['opts'] for d in decide], mo, f)
            state = torch.tensor([d[1]['state'] for d in decide], dtype=torch.float32)
            with torch.no_grad():
                logits = net.logits(opts, mask)
                values = net.v(state)
                dist = Categorical(logits=logits)
                actions = torch.zeros(len(decide), dtype=torch.long) if how == 'imitate' else dist.sample()
                logps = dist.log_prob(actions)
            for i, (w, msg, steps) in enumerate(decide):
                steps.append({
                    'opts': msg['opts'][:mo], 'state': msg['state'], 'a': int(actions[i]), 'logp': float(logps[i]),
                    'v': float(values[i]), 'r': 0.0,
                })
                self.workers[w].send(msg['ep'], actions[i])
        return finished, results

    def close(self):
        for w in self.workers:
            w.close()


# ---------------------------------------------------------------- learning

def returns_and_advantages(episodes, gamma, lam):
    """GAE over finished fights (the value after the last decision is 0: the fight is over)."""
    for ep in episodes:
        next_v, gae = 0.0, 0.0
        for step in reversed(ep):
            delta = step['r'] + gamma * next_v - step['v']
            gae = delta + gamma * lam * gae
            step['adv'] = gae
            step['ret'] = gae + step['v']
            next_v = step['v']


def flatten(episodes, hello):
    steps = [s for ep in episodes for s in ep]
    opts, mask = pad([s['opts'] for s in steps], hello['maxOptions'], hello['features'])
    tensor = lambda k, t=torch.float32: torch.tensor([s[k] for s in steps], dtype=t)
    return steps, opts, mask, torch.tensor([s['state'] for s in steps], dtype=torch.float32), tensor('a', torch.long), tensor('logp'), tensor('adv'), tensor('ret')


TOP = 7  # the option feature that says "the scripted AI's top pick" (server/monsterai.ts optionFeatures)


def imitate(net, episodes, hello, args):
    """Learns to pick option 0 (the scripted AI's pick), and the value of where the fight stands."""
    returns_and_advantages(episodes, args.gamma, 1.0)  # lam 1: plain discounted returns
    steps, opts, mask, state, a, _, _, ret = flatten(episodes, hello)
    n = len(steps)
    opt = torch.optim.Adam(net.parameters(), lr=args.imitate_lr)
    for _ in range(args.imitate_epochs):
        perm = torch.randperm(n)
        for i in range(0, n, args.minibatch):
            j = perm[i:i + args.minibatch]
            logits = net.logits(opts[j], mask[j])
            loss = nn.functional.cross_entropy(logits, a[j]) + 0.5 * ((net.v(state[j]) - ret[j]) ** 2).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
    with torch.no_grad():
        picks = net.logits(opts, mask).argmax(-1)
        # Ties count: several options often share the top score (the same hit from two tiles).
        agree = opts[torch.arange(n), picks, TOP].mean().item()
    return agree


def ppo_update(net, opt, episodes, hello, args):
    returns_and_advantages(episodes, args.gamma, args.lam)
    steps, opts, mask, state, a, old_logp, adv, ret = flatten(episodes, hello)
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    n = len(steps)
    stats = {'pg': 0.0, 'v': 0.0, 'ent': 0.0, 'kl': 0.0, 'clip': 0.0}
    batches = 0
    for _ in range(args.epochs):
        perm = torch.randperm(n)
        for i in range(0, n, args.minibatch):
            j = perm[i:i + args.minibatch]
            dist = Categorical(logits=net.logits(opts[j], mask[j]))
            logp = dist.log_prob(a[j])
            ratio = torch.exp(logp - old_logp[j])
            pg = -torch.min(ratio * adv[j], torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv[j]).mean()
            vloss = ((net.v(state[j]) - ret[j]) ** 2).mean()
            ent = dist.entropy().mean()
            loss = pg + args.vf * vloss - args.ent * ent
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 0.5)
            opt.step()
            with torch.no_grad():
                stats['pg'] += pg.item()
                stats['v'] += vloss.item()
                stats['ent'] += ent.item()
                stats['kl'] += (old_logp[j] - logp).mean().item()
                stats['clip'] += ((ratio - 1).abs() > args.clip).float().mean().item()
            batches += 1
    return {k: v / max(1, batches) for k, v in stats.items()}


# ---------------------------------------------------------------- export and evaluation

def export_json(net, path, steps, notes):
    """The option scorer as plain weights for server/policy.ts, with a few inputs and outputs to check it by."""
    layers, mods = [], list(net.scorer)
    for i, m in enumerate(mods):
        if isinstance(m, nn.Linear):
            act = 'tanh' if i + 1 < len(mods) and isinstance(mods[i + 1], nn.Tanh) else 'linear'
            layers.append({'w': m.weight.detach().tolist(), 'b': m.bias.detach().tolist(), 'act': act})
    rng = np.random.default_rng(1)
    inputs = rng.uniform(-1, 1, size=(4, net.features)).astype(np.float32)
    with torch.no_grad():
        scores = net.scorer(torch.from_numpy(inputs)).squeeze(-1).tolist()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump({
            'version': 1, 'features': net.features, 'layers': layers,
            'trainedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'steps': steps, 'notes': notes,
            'check': {'inputs': inputs.tolist(), 'scores': scores},
        }, fh)


def export_onnx(net, path):
    """The same scorer as an ONNX graph (MatMul, Add, Tanh), built directly so it doesn't depend on torch's exporter."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    nodes, inits, x = [], [], 'options'
    mods = list(net.scorer)
    k = 0
    for i, m in enumerate(mods):
        if not isinstance(m, nn.Linear):
            continue
        w = numpy_helper.from_array(m.weight.detach().numpy().T.copy(), f'w{k}')
        b = numpy_helper.from_array(m.bias.detach().numpy().copy(), f'b{k}')
        inits += [w, b]
        nodes.append(helper.make_node('MatMul', [x, f'w{k}'], [f'mm{k}']))
        nodes.append(helper.make_node('Add', [f'mm{k}', f'b{k}'], [f'z{k}']))
        x = f'z{k}'
        if i + 1 < len(mods) and isinstance(mods[i + 1], nn.Tanh):
            nodes.append(helper.make_node('Tanh', [x], [f'h{k}']))
            x = f'h{k}'
        k += 1
    nodes.append(helper.make_node('Identity', [x], ['scores']))
    graph = helper.make_graph(
        nodes, 'monster_ppo_scorer',
        [helper.make_tensor_value_info('options', TensorProto.FLOAT, ['n', net.features])],
        [helper.make_tensor_value_info('scores', TensorProto.FLOAT, ['n', 1])], inits,
    )
    model = helper.make_model(graph, producer_name='dungeon-delvers', opset_imports=[helper.make_opsetid('', 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, path)
    # Check it against torch with ONNX's own reference runtime.
    from onnx.reference import ReferenceEvaluator
    probe = np.random.default_rng(2).uniform(-1, 1, size=(5, net.features)).astype(np.float32)
    got = ReferenceEvaluator(model).run(None, {'options': probe})[0]
    with torch.no_grad():
        want = net.scorer(torch.from_numpy(probe)).numpy()
    assert np.allclose(got, want, atol=1e-5), 'the ONNX graph disagrees with torch'


def evaluate(args, policy_json=None, fights=None, workers=4):
    """Greedy play in Node (env.ts eval modes): the policy in `policy_json`, or the scripted AI if None."""
    fights = fights or args.eval_fights
    per = max(1, fights // workers)
    env = dict(os.environ)
    if policy_json:
        env['DELVERS_POLICY'] = policy_json
    procs = [
        subprocess.Popen([NODE, 'training/env.ts', args.fights, str(min(16, per)), 'policy' if policy_json else 'scripted', str(per)],
                         cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        for _ in range(workers)
    ]
    total = {'fights': 0, 'monsterWins': 0, 'score': 0.0, 'party': 0.0, 'rounds': 0.0, 'stuck': 0}
    for p in procs:
        out, _ = p.communicate()
        summary = json.loads(out.strip().splitlines()[-1])['summary']
        n = summary['fights']
        total['fights'] += n
        total['monsterWins'] += summary['monsterWins']
        total['stuck'] += summary['stuck']
        total['score'] += summary['score'] * n
        total['party'] += summary['party'] * n
        total['rounds'] += summary['rounds'] * n
    n = max(1, total['fights'])
    return {'fights': total['fights'], 'win%': 100 * total['monsterWins'] / n, 'score': total['score'] / n, 'party': total['party'] / n,
            'rounds': total['rounds'] / n, 'stuck': total['stuck']}


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--name', default=datetime.now().strftime('run-%Y%m%d-%H%M'))
    ap.add_argument('--fights', default='training/data/fights', help='recorded fight starts (DELVERS_FIGHT_DUMP)')
    ap.add_argument('--workers', type=int, default=10)
    ap.add_argument('--at-once', type=int, default=24, help='fights each worker plays at the same time')
    ap.add_argument('--imitate', type=int, default=30000, help='decisions of copying the scripted AI first (0: start from scratch)')
    ap.add_argument('--imitate-epochs', type=int, default=40)
    ap.add_argument('--imitate-lr', type=float, default=1e-3)
    ap.add_argument('--updates', type=int, default=60)
    ap.add_argument('--steps', type=int, default=8192, help='decisions per PPO update')
    ap.add_argument('--epochs', type=int, default=4)
    ap.add_argument('--minibatch', type=int, default=1024)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--gamma', type=float, default=0.99)
    ap.add_argument('--lam', type=float, default=0.95)
    ap.add_argument('--clip', type=float, default=0.2)
    ap.add_argument('--ent', type=float, default=0.01)
    ap.add_argument('--vf', type=float, default=0.5)
    ap.add_argument('--hidden', type=int, default=64)
    ap.add_argument('--eval-every', type=int, default=10)
    ap.add_argument('--eval-fights', type=int, default=400)
    ap.add_argument('--threads', type=int, default=4, help='torch threads (the rest of the CPU is for the workers)')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--export', help='only export this checkpoint to server/policies/')
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    random.seed(args.seed)

    if args.export:
        ck = torch.load(args.export, weights_only=False)
        net = Net(ck['features'], ck['state'], ck['hidden'])
        net.load_state_dict(ck['model'])
        export_json(net, POLICY_JSON, ck['steps'], ck.get('notes', ''))
        export_onnx(net, POLICY_ONNX)
        print(f'exported {args.export} -> {POLICY_JSON} and {POLICY_ONNX}')
        return

    run_dir = os.path.join(ROOT, 'training', 'runs', args.name)
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, 'args.json'), 'w', encoding='utf-8') as fh:
        json.dump(vars(args), fh, indent=2)
    pool = Pool(args, run_dir)
    hello = pool.hello
    print(f"{args.workers} workers x {args.at_once} fights; {hello['fights']} recorded fight starts; "
          f"{hello['features']} features per option, up to {hello['maxOptions']} options", flush=True)
    net = Net(hello['features'], hello['state'], args.hidden)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    log = open(os.path.join(run_dir, 'log.csv'), 'w', newline='', encoding='utf-8')
    writer = csv.writer(log)
    writer.writerow(['update', 'decisions', 'seconds', 'fights', 'monster_win%', 'score', 'agree_scripted', 'entropy', 'kl', 'clip', 'v_loss', 'eval_win%', 'eval_party'])
    total, t0 = 0, time.time()

    def save(path, notes):
        torch.save({'model': net.state_dict(), 'features': hello['features'], 'state': hello['state'], 'hidden': args.hidden, 'steps': total, 'notes': notes}, path)

    try:
        baseline = evaluate(args)
        print(f"scripted AI: monsters win {baseline['win%']:.1f}% of {baseline['fights']} fights, party losses {baseline['party']:.4f}, {baseline['rounds']:.1f} rounds", flush=True)
        with open(os.path.join(run_dir, 'baseline.json'), 'w', encoding='utf-8') as fh:
            json.dump(baseline, fh)

        if args.imitate:
            episodes, _ = pool.collect(net, args.imitate, 'imitate')
            total += sum(len(e) for e in episodes)
            agree = imitate(net, episodes, hello, args)
            print(f'imitation: {total} decisions, copies the scripted pick {100 * agree:.1f}% of the time ({time.time() - t0:.0f}s)', flush=True)
            save(os.path.join(run_dir, 'imitation.pt'), 'imitation of the scripted AI')

        best = None
        for update in range(1, args.updates + 1):
            episodes, results = pool.collect(net, args.steps, 'sample')
            n_dec = sum(len(e) for e in episodes)
            total += n_dec
            stats = ppo_update(net, opt, episodes, hello, args)
            agree = sum(s['opts'][s['a']][TOP] for e in episodes for s in e) / max(1, n_dec)
            win = 100 * sum(r['won'] for r in results) / max(1, len(results))
            score = sum(r['score'] for r in results) / max(1, len(results))
            row = [update, total, round(time.time() - t0), len(results), round(win, 2), round(score, 4), round(agree, 3),
                   round(stats['ent'], 3), round(stats['kl'], 4), round(stats['clip'], 3), round(stats['v'], 4), '', '']
            line = f"update {update}: {len(results)} fights, monsters win {win:.1f}%, score {score:.3f}, picks the scripted move {100 * agree:.0f}%, entropy {stats['ent']:.2f}, kl {stats['kl']:.4f}"
            if update % args.eval_every == 0 or update == args.updates:
                tmp = os.path.join(run_dir, 'eval-policy.json')
                export_json(net, tmp, total, f'update {update}')
                ev = evaluate(args, tmp)
                row[-2:] = [round(ev['win%'], 2), round(ev['party'], 4)]
                line += f" | greedy: monsters win {ev['win%']:.1f}%, party losses {ev['party']:.4f} (scripted {baseline['win%']:.1f}%, {baseline['party']:.4f})"
                save(os.path.join(run_dir, f'update{update}.pt'), f'update {update}')
                # Best = the most pressure on the party (what the monsters are for), over --eval-fights fights.
                if best is None or ev['party'] > best:
                    best = ev['party']
                    save(os.path.join(run_dir, 'best.pt'), f'PPO update {update}: party losses {ev["party"]:.4f}, monsters win {ev["win%"]:.1f}% over {ev["fights"]} fights (scripted {baseline["party"]:.4f}, {baseline["win%"]:.1f}%)')
            writer.writerow(row)
            log.flush()
            print(line + f' ({time.time() - t0:.0f}s)', flush=True)
    finally:
        pool.close()
        log.close()


if __name__ == '__main__':
    main()
