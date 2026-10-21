// Reads run journals (server/journal.ts, saves/journal/*.jsonl) back into a report: the path, every fight's numbers
// and how long it took, the pace (time per act, seconds per turn for each hero, what shared turns saved), who did what,
// every pick next to what was offered, and the shopping. Made for looking at a real playtest next to the bot numbers
// in PLAN.md (Phase 13).
//
//   node scripts/journal-report.ts saves/journal/ABCD-20261020-1930.jsonl [more files...]
//   node scripts/journal-report.ts --latest        (the newest journal in saves/journal)

import fs from 'node:fs';
import path from 'node:path';
import { ENGINES } from '../shared/engines.ts';
import { BOONS } from '../shared/rules.ts';
import { cardRarity, engineOf, itemInfo, SKILLS } from '../shared/skills.ts';
import type { JournalEntry } from '../server/journal.ts';
import type { OfferCard } from '../shared/types.ts';

type Line = JournalEntry & { t: number };

const NODE_ICON: Record<string, string> = { combat: '⚔️', elite: '💀', event: '❓', rest: '🔥', shop: '🛒', treasure: '💰', boss: '👑' };
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Longer than this without a journal line is time away from the game (or a restart), not play. */
const IDLE_MS = 5 * 60_000;
const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

function cardLabel(c: OfferCard): string {
  switch (c.kind) {
    case 'learn':
    case 'upgrade': {
      const e = engineOf(c.skill);
      const tag = [cardRarity(c.skill), e ? ENGINES[e].name : ''].filter(Boolean).join(', ');
      return `${c.kind === 'upgrade' ? `↑${c.tier === 3 ? 'III' : 'II'} ` : ''}${SKILLS[c.skill]?.base.name ?? c.skill}${tag ? ` (${tag})` : ''}`;
    }
    case 'boon':
      return `boon: ${BOONS[c.boon]?.name ?? c.boon}`;
    case 'stat':
      return `+1 ${c.stat.toUpperCase()}`;
    case 'gear':
    case 'item':
      return `${itemInfo(c.item).name} (${itemInfo(c.item).rarity})`;
    default:
      return c.kind;
  }
}

function report(file: string) {
  const lines: Line[] = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
  const of = <K extends Line['k']>(k: K) => lines.filter((l): l is Extract<Line, { k: K }> => l.k === k);
  const start = of('start')[0];
  const end = of('end').at(-1);
  /** Time actually played between two journal lines (by index): gaps over IDLE_MS and restarts don't count. */
  const played = (from: number, to: number) => {
    let ms = 0;
    for (let i = Math.max(1, from + 1); i <= to && i < lines.length; i++) {
      const d = lines[i].t - lines[i - 1].t;
      if (lines[i].k !== 'start' && d < IDLE_MS) ms += d;
    }
    return ms;
  };
  const minutes = played(0, lines.length - 1) / 60000;
  console.log(`\n=== ${path.basename(file)} ===`);
  if (start) {
    const people = start.party.filter((p) => !p.bot);
    console.log(`${start.difficulty}, monsters ${start.monsterAi}; party: ${start.party.map((p) => `${p.name} (${p.classId}${p.bot ? ', bot' : ''})`).join(', ')}`);
    console.log(`${people.length === 1 ? '1 person' : `${people.length} people`}; played ${minutes.toFixed(0)} minutes over ${of('start').length} session(s)`);
  }
  console.log(end ? `${end.victory ? '🏆 VICTORY' : `☠️ fell in act ${end.act}`}, ${end.gold} gold left` : '(no ending yet: the run goes on, or the server stopped)');

  // The path
  const nodes = of('node');
  for (const act of [...new Set(nodes.map((n) => n.act))]) console.log(`act ${act}: ${nodes.filter((n) => n.act === act).map((n) => NODE_ICON[n.type] ?? n.type).join(' ')}`);

  // Fights, in order: the next fightEnd closes a fight; a restart leaves it unfinished (it starts over).
  const bouts: { f: Extract<Line, { k: 'fight' }>; e?: Extract<Line, { k: 'fightEnd' }>; ms: number }[] = [];
  let open: (typeof bouts)[number] | null = null;
  let openAt = 0;
  lines.forEach((l, i) => {
    if (l.k === 'fight') {
      open = { f: l, ms: 0 };
      openAt = i;
      bouts.push(open);
    } else if (l.k === 'fightEnd' && open) {
      open.e = l;
      open.ms = played(openAt, i);
      open = null;
    } else if (l.k === 'start') open = null;
  });
  const fights = bouts.map((b) => b.f);
  const ends = bouts.map((b) => b.e);
  console.log('\nfights:');
  console.log(`  ${pad('#', 3)}${pad('where', 9)}${pad('fight', 26)}${pad('start', 11)}${lpad('rounds', 6)}${lpad('time', 7)}${lpad('s/rnd', 6)}${lpad('downs', 6)}${lpad('deaths', 7)}${lpad('HP in', 6)}${lpad('lowest', 7)}  top damage`);
  fights.forEach((f, i) => {
    const e = ends[i];
    const ms = bouts[i].ms;
    const total = e ? Object.values(e.dmg).reduce((a, b) => a + b, 0) : 0;
    const top = e ? Object.entries(e.dmg).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, d]) => `${n} ${total ? pct(d / total) : '-'}`).join(', ') : '';
    const icon = f.kind === 'boss' ? '👑' : f.kind === 'elite' ? '💀' : '⚔️';
    const verdict = !e ? ' (unfinished)' : e.won ? '' : ' ✝ LOST';
    console.log(
      `  ${pad(i + 1, 3)}${pad(`A${f.act} r${f.row}`, 9)}${pad(`${icon} ${f.name}`.slice(0, 25), 26)}${pad(f.deployment, 11)}` +
        (e ? `${lpad(e.rounds, 6)}${lpad(clock(ms), 7)}${lpad(e.rounds ? Math.round(ms / 1000 / e.rounds) : '-', 6)}${lpad(e.downs, 6)}${lpad(e.deaths, 7)}${lpad(pct(e.startHp), 6)}${lpad(pct(e.minHp), 7)}  ${top}` : '') + verdict,
    );
  });
  for (const act of [1, 2, 3]) {
    const done = bouts.filter((b) => b.f.act === act && b.e);
    if (!done.length) continue;
    const by = (k: string) => done.filter((b) => b.f.kind === k);
    const avg = (bs: typeof done, f: (b: (typeof done)[number]) => number) => bs.reduce((a, b) => a + f(b), 0) / bs.length;
    const cell = (bs: typeof done) =>
      bs.length ? `${avg(bs, (b) => b.e!.downs).toFixed(2)}↓ ${pct(avg(bs, (b) => b.e!.minHp))} ${avg(bs, (b) => b.e!.rounds).toFixed(1)}r ${clock(avg(bs, (b) => b.ms))}` : '-';
    console.log(`  act ${act} averages (downs, lowest HP, rounds, time): combat ${cell(by('combat'))} · elite ${cell(by('elite'))} · boss ${cell(by('boss'))}`);
  }

  // Pace: where the time went, and how long each turn took.
  const total = played(0, lines.length - 1);
  const inFights = bouts.reduce((a, b) => a + b.ms, 0);
  console.log(`\npace (time actually played; gaps over ${IDLE_MS / 60000} minutes don't count):`);
  console.log(`  total ${clock(total)} · in fights ${clock(inFights)} (${total ? pct(inFights / total) : '-'}) · between fights ${clock(total - inFights)}`);
  const firstOfAct = (act: number) => lines.findIndex((l) => l.k === 'node' && l.act === act);
  const acts = [1, 2, 3].map((a) => ({ a, from: firstOfAct(a) })).filter((x) => x.from >= 0);
  if (acts.length) console.log(`  ${acts.map((x, i) => `act ${x.a} ${clock(played(x.from, i + 1 < acts.length ? acts[i + 1].from : lines.length - 1))}`).join(' · ')}`);
  const turns = of('turn');
  if (turns.length) {
    const heroTurns = turns.filter((t) => t.side === 'hero');
    const people = [...new Set(heroTurns.filter((t) => !t.auto).map((t) => t.who))];
    const secs = (ts: typeof turns) => `${(median(ts.map((t) => t.ms)) / 1000).toFixed(1)}s`;
    const parts = people.map((who) => {
      const mine = heroTurns.filter((t) => t.who === who && !t.auto);
      return `${who} ${secs(mine)} (${plural(mine.length, 'turn')}, ${mine.filter((t) => t.shared > 1).length} shared)`;
    });
    const bots = heroTurns.filter((t) => t.auto);
    if (bots.length) parts.push(`bots ${secs(bots)}`);
    const foes = turns.filter((t) => t.side === 'monster');
    if (foes.length) parts.push(`monsters ${secs(foes)}`);
    console.log(`  turns (median seconds): ${parts.join(' · ')}`);
    // A shared turn lasts as long as its slowest hero; one after another, the people's turns would have added up.
    const groups = new Map<number, number[]>();
    for (const t of heroTurns) {
      if (t.auto || t.shared < 2) continue;
      const key = Math.round((t.t - t.ms) / 250); // the turn's start
      groups.set(key, [...(groups.get(key) ?? []), t.ms]);
    }
    const together = [...groups.values()].filter((ms) => ms.length > 1);
    const saved = together.reduce((a, ms) => a + ms.reduce((x, y) => x + y, 0) - Math.max(...ms), 0);
    if (together.length) console.log(`  shared turns: people played at the same time ${plural(together.length, 'time')}, which saved about ${clock(saved)} of waiting`);
  }

  // Heroes
  const log = of('log').map((l) => l.text);
  const heroes = end?.heroes ?? start?.party.map((p) => ({ name: p.name, classId: p.classId, level: 0, skills: [], gear: [], injuries: 0 })) ?? [];
  const dmg: Record<string, number> = {};
  for (const e of of('fightEnd')) for (const [n, d] of Object.entries(e.dmg)) dmg[n] = (dmg[n] ?? 0) + d;
  const allDmg = Object.values(dmg).reduce((a, b) => a + b, 0);
  console.log('\nheroes (damage share: 1.00 is an even share):');
  for (const h of heroes) {
    const bot = start?.party.find((p) => p.name === h.name)?.bot;
    const count = (re: RegExp) => log.filter((t) => re.test(t)).length;
    const esc = h.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const share = allDmg ? ((dmg[h.name] ?? 0) / allDmg) * heroes.length : 0;
    console.log(
      `  ${pad(`${h.name} (${h.classId}${bot ? ', bot' : ''})`, 26)} level ${lpad(h.level || '?', 2)}  dmg ${share.toFixed(2)}  ` +
        `kills ${count(new RegExp(`(slain by|snatches the .* from .*\\b)${esc}!|Kill steal! ${esc} `))}  downs ${count(new RegExp(`^🩸 ${esc} falls unconscious`))}  deaths ${count(new RegExp(`^☠️ ${esc} has died`))}` +
        `${'engine' in h && h.engine ? `  engine ${h.engine}` : ''}`,
    );
    if (h.skills.length) console.log(`      ${h.skills.join(', ')}${h.gear.length ? ` | ${h.gear.join(', ')}` : ''}`);
  }

  // Picks: what was on offer, what was taken
  const picks = of('pick');
  console.log(`\npicks (${picks.length}; [the card taken]):`);
  for (const p of picks) {
    const cards = (p.offered as OfferCard[]).map((c, i) => (i === p.card ? `[${cardLabel(c)}]` : cardLabel(c)));
    console.log(`  ${pad(p.hero, 12)}${pad(p.offerKind, 7)}${p.auto ? '(auto) ' : ''}${cards.join(' · ')}`);
  }
  const human = picks.filter((p) => !p.auto);
  if (human.length) {
    const kinds = new Map<string, number>();
    for (const p of human) {
      const c = (p.offered as OfferCard[])[p.card];
      if (c) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    }
    console.log(`  people took: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  }

  // Shopping and resting
  const buys = log.filter((t) => /^🛒 .* buys /.test(t));
  if (buys.length) console.log(`\nshop: ${buys.map((t) => t.replace(/^🛒 /, '')).join(' | ')}`);
  console.log(`rests: Long Rest ${log.filter((t) => /takes a Long Rest/.test(t)).length}, Train ${log.filter((t) => /trains by the fire/.test(t)).length}; injuries ${log.filter((t) => /^🩹 .+ is back, but injured/.test(t)).length}`);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/journal-report.ts <journal.jsonl>... | --latest');
  process.exit(1);
}
const files =
  args[0] === '--latest'
    ? (() => {
        const dir = path.join(process.env.DELVERS_SAVES || 'saves', 'journal');
        const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
        return all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 1);
      })()
    : args;
if (!files.length) console.error('no journals yet');
for (const f of files) report(f);
