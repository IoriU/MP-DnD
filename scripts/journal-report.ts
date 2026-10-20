// Reads run journals (server/journal.ts, saves/journal/*.jsonl) back into a report: the path, every fight's numbers,
// who did what, every pick next to what was offered, and the shopping. Made for looking at a real playtest next to
// the bot numbers in PLAN.md (Phase 13).
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
  const minutes = lines.length ? (lines.at(-1)!.t - lines[0].t) / 60000 : 0;
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

  // Fights
  const fights = of('fight');
  const ends = of('fightEnd');
  console.log('\nfights:');
  console.log(`  ${pad('#', 3)}${pad('where', 9)}${pad('fight', 26)}${pad('start', 11)}${lpad('rounds', 6)}${lpad('downs', 6)}${lpad('deaths', 7)}${lpad('HP in', 6)}${lpad('lowest', 7)}  top damage`);
  fights.forEach((f, i) => {
    const e = ends[i];
    const total = e ? Object.values(e.dmg).reduce((a, b) => a + b, 0) : 0;
    const top = e ? Object.entries(e.dmg).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, d]) => `${n} ${total ? pct(d / total) : '-'}`).join(', ') : '';
    const icon = f.kind === 'boss' ? '👑' : f.kind === 'elite' ? '💀' : '⚔️';
    const verdict = !e ? ' (unfinished)' : e.won ? '' : ' ✝ LOST';
    console.log(
      `  ${pad(i + 1, 3)}${pad(`A${f.act} r${f.row}`, 9)}${pad(`${icon} ${f.name}`.slice(0, 25), 26)}${pad(f.deployment, 11)}` +
        (e ? `${lpad(e.rounds, 6)}${lpad(e.downs, 6)}${lpad(e.deaths, 7)}${lpad(pct(e.startHp), 6)}${lpad(pct(e.minHp), 7)}  ${top}` : '') + verdict,
    );
  });
  const done = ends.filter((e) => e.won !== undefined);
  for (const act of [1, 2, 3]) {
    const pairs = fights.map((f, i) => [f, ends[i]] as const).filter(([f, e]) => f.act === act && e);
    if (!pairs.length) continue;
    const by = (k: string) => pairs.filter(([f]) => f.kind === k).map(([, e]) => e!);
    const cell = (es: typeof done) => (es.length ? `${(es.reduce((a, e) => a + e.downs, 0) / es.length).toFixed(2)}↓ ${pct(es.reduce((a, e) => a + e.minHp, 0) / es.length)} ${(es.reduce((a, e) => a + e.rounds, 0) / es.length).toFixed(1)}r` : '-');
    console.log(`  act ${act} averages (downs, lowest HP, rounds): combat ${cell(by('combat'))} · elite ${cell(by('elite'))} · boss ${cell(by('boss'))}`);
  }

  // Heroes
  const log = of('log').map((l) => l.text);
  const heroes = end?.heroes ?? start?.party.map((p) => ({ name: p.name, classId: p.classId, level: 0, skills: [], gear: [], injuries: 0 })) ?? [];
  const dmg: Record<string, number> = {};
  for (const e of ends) for (const [n, d] of Object.entries(e.dmg)) dmg[n] = (dmg[n] ?? 0) + d;
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
