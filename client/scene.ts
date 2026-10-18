// Phaser scene that draws the current battle room. It only renders server state; every rule lives on the server.
// No image assets: tiles are drawn shapes and creatures are emoji, so you can swap in real art later.

import Phaser from 'phaser';
import { dist, hasLOS, reachable } from '../shared/grid.ts';
import { STATUSES, hasStatus, type SkillId } from '../shared/skills.ts';
import { advantageText, attackAdvantage, dirTo, isBehind, isFlanking, netAdvantage, turnsToFace, type AdvantageInfo } from '../shared/tactics.ts';
import type { Entity, Fx, GameState, MonsterEntity, PlayerEntity, Pos } from '../shared/types.ts';
import { send } from './net.ts';
import {
  aimAt, attackProblem, bestAttack, currentEntity, inApproach, isMyTurn, me, mySkillStats, occupied, onFx, select, store, subscribe, validTarget,
} from './store.ts';
import { $, esc, toast } from './util.ts';

const T = 32; // tile size in pixels
const UI_FONT = 'system-ui, "Segoe UI", sans-serif';
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const BG = 0x0b0a09;
const MAX_TAGS = 3; // status icons shown above a unit

/** Floor and wall colors per act: earthy warrens, cold crypt, scorched lair. */
const PALETTES = [
  { floorA: 0x25201c, floorB: 0x29231f, wall: 0x3a322b, wallTop: 0x4d4339, wallShadow: 0x2a241f, speck: 0x3b332c },
  { floorA: 0x1c2023, floorB: 0x1f2427, wall: 0x313940, wallTop: 0x46505a, wallShadow: 0x21272c, speck: 0x2f373d },
  { floorA: 0x281915, floorB: 0x2c1c17, wall: 0x45261c, wallTop: 0x5e3324, wallShadow: 0x2c1711, speck: 0x4a2a1f },
];

const hexColor = (css: string) => parseInt(css.replace('#', ''), 16);
const hash = (x: number, y: number) => {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

interface Sprite {
  c: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Graphics;
  face: Phaser.GameObjects.Graphics; // the facing arrow on the ring
  glyph: Phaser.GameObjects.Text;
  bar: Phaser.GameObjects.Graphics;
  tags: Phaser.GameObjects.Text; // status icons
  tagBg: Phaser.GameObjects.Graphics;
  key: string;
}

/** "⬆️ advantage (flanking)" in green, "⬇️ disadvantage (blinded)" in red; '' for a straight roll. */
function advantageLine(a: AdvantageInfo): string {
  const net = netAdvantage(a);
  if (net) return `<span class="tip-adv ${net > 0 ? 'up' : 'down'}">${net > 0 ? '⬆️' : '⬇️'} ${esc(advantageText(a))}</span>`;
  if (a.adv.length) return `<span class="tip-adv even">⚖️ ${esc(advantageText(a))} (${esc(a.adv.join(', '))} vs ${esc(a.dis.join(', '))})</span>`;
  return '';
}

class DungeonScene extends Phaser.Scene {
  private mapG!: Phaser.GameObjects.Graphics;
  private overlayG!: Phaser.GameObjects.Graphics;
  private turnG!: Phaser.GameObjects.Graphics;
  private cursorG!: Phaser.GameObjects.Graphics;
  private sprites = new Map<string, Sprite>();
  private tiles = '';
  private hover: Pos | null = null;
  private pointer: Pos | null = null; // mouse position over the canvas in screen pixels, so the tooltip can refresh when the state changes
  private spots = new Map<number, string[]>(); // reachable tiles that would give advantage (tile index -> "Goblin: from behind")
  private inset = 0; // pixels at the top of the canvas covered by the Sneak-or-Charge card; the room is fitted below it
  private userCam = false; // the player panned or zoomed, so leave the camera alone

  constructor() {
    super('dungeon');
  }

  create() {
    this.cameras.main.setBackgroundColor(BG);
    this.mapG = this.add.graphics().setDepth(0);
    this.overlayG = this.add.graphics().setDepth(5);
    this.turnG = this.add.graphics().setDepth(9);
    this.cursorG = this.add.graphics().setDepth(25);

    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.rightButtonDown()) return this.onHover(p);
      // Right-drag pans the camera.
      const cam = this.cameras.main;
      this.userCam = true;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onClick(p));
    this.input.on('gameout', () => {
      this.hover = null;
      this.pointer = null;
      this.drawCursor();
      $('#tooltip').hidden = true;
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      this.userCam = true;
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 3));
    });
    this.scale.on('resize', () => {
      const s = store.state;
      if (!s?.tiles) return;
      this.inset = this.insetFor(s);
      this.fitCamera(s);
    });

    Object.assign(window, { delvers: { scene: this, store } }); // handy for debugging in the browser console
    const offState = subscribe(() => this.sync());
    const offFx = onFx((fx) => this.playFx(fx));
    this.events.once('shutdown', () => {
      offState();
      offFx();
    });
    this.sync();
  }

  update(time: number) {
    // Pulsing ring around whoever's turn it is.
    const g = this.turnG.clear();
    const cur = currentEntity();
    const sp = cur && this.sprites.get(cur.id);
    if (sp && store.state?.phase === 'combat') {
      g.lineStyle(3, 0xffd84d, 0.55 + 0.45 * Math.sin(time / 160)).strokeCircle(sp.c.x, sp.c.y, 17);
    }
  }

  // ---------------------------------------------------------------- state -> pixels

  private sync() {
    const s = store.state;
    if (!s || !s.tiles) {
      if (this.tiles) this.clearRoom();
      return;
    }
    const inset = this.insetFor(s);
    const insetChanged = inset !== this.inset;
    this.inset = inset;
    if (s.tiles !== this.tiles) {
      this.drawMap(s);
      this.fitCamera(s);
    } else if (insetChanged && !this.userCam) {
      this.fitCamera(s, true); // the Sneak-or-Charge card came or went: slide the room into the free space
    }
    this.syncEntities(s);
    this.drawOverlay(s);
    this.drawCursor();
    this.showTip();
  }

  private clearRoom() {
    this.tiles = '';
    this.inset = 0;
    this.spots.clear();
    this.mapG.clear();
    this.overlayG.clear();
    this.cursorG.clear();
    $('#tooltip').hidden = true;
    for (const sp of this.sprites.values()) sp.c.destroy();
    this.sprites.clear();
  }

  private drawMap(s: GameState) {
    this.tiles = s.tiles;
    const pal = PALETTES[Math.min(PALETTES.length, s.run?.act ?? 1) - 1];
    const g = this.mapG.clear();
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const px = x * T;
        const py = y * T;
        const n = hash(x, y);
        if (s.tiles[y * s.width + x] === '#') {
          g.fillStyle(pal.wall).fillRect(px, py, T, T);
          g.fillStyle(pal.wallTop).fillRect(px, py, T, 5);
          g.fillStyle(pal.wallShadow).fillRect(px, py + T - 3, T, 3);
          g.lineStyle(1, pal.wallShadow, 1).lineBetween(px + (n > 0.5 ? T / 2 : T / 3), py + 5, px + (n > 0.5 ? T / 2 : T / 3), py + T - 3);
          continue;
        }
        g.fillStyle(n < 0.5 ? pal.floorA : pal.floorB).fillRect(px, py, T, T);
        g.lineStyle(1, 0x000000, 0.35).strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        if (n > 0.92) g.fillStyle(pal.speck).fillCircle(px + 6 + n * 18, py + 8 + ((n * 97) % 16), 1.5);
      }
    }
  }

  /** How much of the canvas top the Sneak-or-Charge card covers (0 when it isn't up). */
  private insetFor(s: GameState): number {
    if (!inApproach(s)) return 0;
    const card = document.querySelector<HTMLElement>('#approach-view .ap-card');
    return card ? Math.min(card.offsetHeight + 24, this.cameras.main.height * 0.5) : 0;
  }

  /** Zooms so the whole room fits the canvas (below the approach card, if it's up), and centers it. */
  private fitCamera(s: GameState, animate = false) {
    const cam = this.cameras.main;
    const w = s.width * T;
    const h = s.height * T;
    const zoom = Phaser.Math.Clamp(Math.min(cam.width / w, Math.max(80, cam.height - this.inset) / h) * 0.94, 0.5, 2.5);
    const cy = h / 2 - this.inset / (2 * zoom); // shifts the room down by half the inset
    this.userCam = false;
    if (animate) {
      cam.zoomTo(zoom, 350, 'Sine.easeInOut', true);
      cam.pan(w / 2, cy, 350, 'Sine.easeInOut', true);
    } else {
      cam.setZoom(zoom);
      cam.centerOn(w / 2, cy);
    }
  }

  private syncEntities(s: GameState) {
    const seen = new Set<string>();
    for (const e of s.entities) {
      seen.add(e.id);
      const px = e.x * T + T / 2;
      const py = e.y * T + T / 2;
      let sp = this.sprites.get(e.id);
      if (!sp) {
        sp = this.makeSprite(e);
        sp.c.setPosition(px, py);
        this.sprites.set(e.id, sp);
      } else if (sp.c.x !== px || sp.c.y !== py) {
        this.tweens.killTweensOf(sp.c);
        const far = Math.abs(sp.c.x - px) > T * 1.5 || Math.abs(sp.c.y - py) > T * 1.5;
        if (far) sp.c.setPosition(px, py);
        else this.tweens.add({ targets: sp.c, x: px, y: py, duration: 110 });
      }
      this.styleSprite(sp, e);
    }
    for (const [id, sp] of this.sprites) {
      if (seen.has(id)) continue;
      sp.c.destroy();
      this.sprites.delete(id);
    }
  }

  private makeSprite(e: Entity): Sprite {
    const ring = this.add.graphics();
    const face = this.add.graphics();
    const big = e.kind === 'monster' && (e.boss || e.elite);
    const glyph = this.add.text(0, -1, e.glyph, { fontFamily: EMOJI_FONT, fontSize: big ? '26px' : '19px', resolution: 2 }).setOrigin(0.5);
    const bar = this.add.graphics();
    const tagBg = this.add.graphics();
    const tags = this.add.text(0, 0, '', { fontFamily: EMOJI_FONT, fontSize: '9px', resolution: 2 }).setOrigin(0.5, 0);
    const c = this.add.container(0, 0, [ring, face, glyph, bar, tagBg, tags]).setDepth(e.kind === 'player' ? 11 : 10);
    return { c, ring, face, glyph, bar, tags, tagBg, key: '' };
  }

  private styleSprite(sp: Sprite, e: Entity) {
    const dead = e.kind === 'player' && e.dead;
    const down = e.kind === 'player' && e.downed;
    const temp = e.kind === 'player' ? e.tempHp : 0;
    const shown = dead ? [] : e.statuses.slice(0, MAX_TAGS);
    const key = `${e.hp}/${e.maxHp}/${temp}/${dead}/${down}/${e.facing?.x},${e.facing?.y}/${e.statuses.map((x) => x.id).join(',')}`;
    if (sp.key === key) return;
    sp.key = key;
    const big = e.kind === 'monster' && (e.boss || e.elite);
    const r = big ? 19 : 14;
    const color = e.kind === 'player' ? hexColor(e.color) : big ? 0xe8b04a : 0xd94a3a;
    sp.ring.clear().fillStyle(0x000000, 0.55).fillCircle(0, 0, r).lineStyle(big ? 3 : 2, color, dead ? 0.3 : 1).strokeCircle(0, 0, r);
    // Hidden heroes fade out. A small arrow on the ring shows which way the creature faces (attacks from behind have advantage).
    sp.glyph.setText(dead ? '🪦' : e.glyph).setAlpha(down ? 0.5 : hasStatus(e, 'hidden') ? 0.55 : 1).setAngle(down ? 90 : 0);
    sp.face.clear();
    const f = e.facing;
    if (!dead && !down && f && (f.x || f.y)) {
      const len = Math.hypot(f.x, f.y);
      const ux = f.x / len;
      const uy = f.y / len;
      const half = 5; // half the arrow's width
      const bx = ux * (r - 1);
      const by = uy * (r - 1);
      sp.face.fillStyle(color, 1).lineStyle(1.5, 0x000000, 0.9);
      const tri = [ux * (r + 7), uy * (r + 7), bx - uy * half, by + ux * half, bx + uy * half, by - ux * half] as const;
      sp.face.fillTriangle(...tri).strokeTriangle(...tri);
    }
    sp.bar.clear();
    if (!dead) {
      const w = r * 2 - 4;
      const pct = e.hp / e.maxHp;
      sp.bar.fillStyle(0x000000, 0.85).fillRect(-w / 2, r - 1, w, 4);
      sp.bar.fillStyle(pct > 0.5 ? 0x5fd35f : pct > 0.25 ? 0xe8c547 : 0xe0523f).fillRect(-w / 2, r - 1, w * pct, 4);
      // Temporary HP: a thin cyan strip above the bar.
      if (temp > 0) sp.bar.fillStyle(0x6fd3ff, 0.95).fillRect(-w / 2, r - 4, w * Math.min(1, temp / e.maxHp), 2);
    }
    // Status icons across the top of the token, on a dark pill so they read over the emoji.
    const icons = shown.map((x) => STATUSES[x.id].icon).join('') + (!dead && e.statuses.length > MAX_TAGS ? '+' : '');
    sp.tags.setText(icons).setPosition(0, -T / 2 + 1);
    sp.tagBg.clear();
    if (icons) sp.tagBg.fillStyle(0x000000, 0.7).fillRoundedRect(-sp.tags.width / 2 - 2, -T / 2, sp.tags.width + 4, sp.tags.height + 2, 4);
  }

  /** Tiles within `range` of the hero that a ranged skill could reach (beyond melee it needs line of sight). */
  private reachTiles(s: GameState, m: PlayerEntity, range: number): Set<number> {
    const out = new Set<number>();
    for (let y = Math.max(0, m.y - range); y <= Math.min(s.height - 1, m.y + range); y++) {
      for (let x = Math.max(0, m.x - range); x <= Math.min(s.width - 1, m.x + range); x++) {
        if (s.tiles[y * s.width + x] === '#') continue;
        if (range > 1 && !hasLOS(s, m, { x, y })) continue;
        out.add(y * s.width + x);
      }
    }
    return out;
  }

  /** Strokes the outer edge of a set of tiles (tile indices). */
  private outlineTiles(g: Phaser.GameObjects.Graphics, s: GameState, tiles: Set<number>, color: number, alpha: number, width: number) {
    const has = (x: number, y: number) => x >= 0 && y >= 0 && x < s.width && y < s.height && tiles.has(y * s.width + x);
    g.lineStyle(width, color, alpha);
    for (const idx of tiles) {
      const x = idx % s.width;
      const y = (idx - x) / s.width;
      const px = x * T;
      const py = y * T;
      if (!has(x, y - 1)) g.lineBetween(px, py, px + T, py);
      if (!has(x, y + 1)) g.lineBetween(px, py + T, px + T, py + T);
      if (!has(x - 1, y)) g.lineBetween(px, py, px, py + T);
      if (!has(x + 1, y)) g.lineBetween(px + T, py, px + T, py + T);
    }
  }

  /** Blue = where you can walk this turn. With a skill selected: its range, and the valid targets. */
  private drawOverlay(s: GameState) {
    const g = this.overlayG.clear();
    this.spots.clear();
    const m = me();
    if (!m || s.phase !== 'combat') return;
    const sel = store.selected;
    const st = sel ? mySkillStats(m, sel) : null;
    if (sel && st) {
      const color = st.target === 'ally' ? 0x7ddc6f : 0xff5e5e;
      if (st.range > 1 && (st.target === 'enemy' || st.target === 'ally' || st.target === 'area')) {
        const tiles = this.reachTiles(s, m, st.range);
        g.fillStyle(color, 0.06);
        for (const idx of tiles) {
          const x = idx % s.width;
          g.fillRect(x * T, ((idx - x) / s.width) * T, T, T);
        }
        this.outlineTiles(g, s, tiles, color, 0.5, 2);
      }
      if (st.target === 'area') return; // the hover preview shows what it would hit
      for (const e of s.entities) {
        if (!validTarget(s, m, e, sel)) continue;
        g.lineStyle(2, color, 1).strokeRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
        g.fillStyle(color, 0.15).fillRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
      }
      return;
    }
    if (isMyTurn() && s.turn && s.turn.movesLeft > 0) {
      const reach = reachable(s, m, s.turn.movesLeft, (x, y) => occupied(s, x, y, m.id));
      g.fillStyle(0x4fb3ff, 0.12);
      for (const [idx, steps] of reach) {
        if (steps === 0) continue;
        const x = idx % s.width;
        g.fillRect(x * T + 1, ((idx - x) / s.width) * T + 1, T - 2, T - 2);
      }
      // Gold dots: standing here you'd attack a monster from behind or flank it. Hover a dotted tile to see who and why.
      for (const [idx, steps] of reach) {
        if (steps === 0) continue;
        const x = idx % s.width;
        const y = (idx - x) / s.width;
        const why = this.spotReasons(s, m, x, y);
        if (!why.length) continue;
        this.spots.set(idx, why);
        const cx = x * T + T / 2;
        const cy = y * T + T / 2;
        g.fillStyle(0xf6cf7a, 0.95).fillCircle(cx, cy, 3.5).lineStyle(1, 0x000000, 0.7).strokeCircle(cx, cy, 3.5);
      }
    }
  }

  /** What a melee attack from this tile would get you: "Goblin: from behind, flanking", one entry per monster next to it. */
  private spotReasons(s: GameState, m: PlayerEntity, x: number, y: number): string[] {
    const out: string[] = [];
    const there = { ...m, x, y }; // me, if I stood here
    const moved = x !== m.x || y !== m.y;
    for (const mon of s.entities) {
      if (mon.kind !== 'monster' || dist(mon, there) !== 1) continue;
      // Walking up to a monster makes it turn to face you (unless you're hidden), so only flanks survive the walk.
      const looking = moved && turnsToFace(mon, m, there) ? { ...mon, facing: dirTo(mon, there) } : mon;
      const why = [isBehind(looking, there) ? 'from behind' : '', isFlanking(there, mon, s.entities) ? 'flanking' : ''].filter(Boolean);
      if (why.length) out.push(`${mon.name}: ${why.join(', ')}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- input

  private tileAt(p: Phaser.Input.Pointer): Pos {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    return { x: Math.floor(w.x / T), y: Math.floor(w.y / T) };
  }

  /** The creature standing on a tile. Fallen heroes' graves don't count. */
  private entityAt(s: GameState, t: Pos): Entity | undefined {
    return s.entities.find((e) => e.x === t.x && e.y === t.y && !(e.kind === 'player' && e.dead));
  }

  private onHover(p: Phaser.Input.Pointer) {
    this.hover = this.tileAt(p);
    this.pointer = { x: p.x, y: p.y };
    this.drawCursor();
    this.showTip();
  }

  /** The tooltip for whatever is under the mouse. Also redrawn when the state changes, so previews stay current. */
  private showTip() {
    const tip = $('#tooltip');
    const s = store.state;
    const h = this.hover;
    const p = this.pointer;
    const inRoom = !!s?.tiles && !!h && h.x >= 0 && h.y >= 0 && h.x < s.width && h.y < s.height;
    const e = inRoom ? this.entityAt(s!, h!) : undefined;
    const lines = !inRoom || !p ? null : e ? this.entityTip(s!, e) : this.spotTip(s!, h!);
    if (!lines || !p) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = lines.join('<br>');
    tip.style.left = `${p.x + 16}px`;
    tip.style.top = `${p.y + 16}px`;
    tip.hidden = false;
  }

  private entityTip(s: GameState, e: Entity): string[] {
    const tag = e.kind === 'monster' && e.boss ? ' <span class="tag">boss</span>' : e.kind === 'monster' && e.elite ? ' <span class="tag">elite</span>' : '';
    const temp = e.kind === 'player' && e.tempHp > 0 ? ` (+${e.tempHp} temp)` : '';
    const lines = [`<b>${esc(e.name)}</b>${tag}`, `${e.hp} / ${e.maxHp} HP${temp} · AC ${e.ac}`];
    if (e.statuses.length) lines.push(e.statuses.map((x) => `${STATUSES[x.id].icon} ${STATUSES[x.id].name} ${x.turns}`).join(' · '));
    const m = me();
    if (e.kind === 'monster' && m && s.phase === 'combat') {
      const sel = store.selected;
      const atk = sel ? null : bestAttack(s, m, e);
      const adv = this.attackPreview(s, m, e);
      if (adv) {
        const line = advantageLine(adv);
        if (line) lines.push(line);
      }
      // Already covered by the "from behind" reason when it's in the preview; otherwise (not your turn, or a skill that doesn't roll to hit) say it here.
      if (isBehind(e, m) && !adv?.adv.includes('from behind')) lines.push('<span class="tip-adv up">🔙 facing away from you</span>');
      const use = inApproach(s)
        ? 'Choose Sneak or Charge first'
        : sel
          ? validTarget(s, m, e, sel) ? `Click to use ${mySkillStats(m, sel)?.name}` : ''
          : atk ? `Click to attack (${mySkillStats(m, atk)?.name})` : attackProblem(m);
      if (use) lines.push(`<span class="muted">${esc(use)}</span>`);
    }
    return lines;
  }

  /**
   * Why my attack roll on this monster would have advantage or disadvantage: the selected skill if it rolls to hit and
   * can reach it, else the basic attack a click would use. Null when nothing would be rolled (or it isn't my turn).
   */
  private attackPreview(s: GameState, m: PlayerEntity, e: MonsterEntity): AdvantageInfo | null {
    if (!isMyTurn()) return null;
    const sel = store.selected;
    const id = sel ?? bestAttack(s, m, e);
    const st = id && mySkillStats(m, id);
    if (!id || !st || st.roll !== 'attack') return null;
    if (sel) {
      // Enemy skills aim at the monster, area skills at its tile, "around" skills hit everything next to me.
      const aim = aimAt(s, m, sel, st.target === 'area' ? { x: e.x, y: e.y } : st.target === 'around' ? null : e.id);
      if (typeof aim === 'string' || !aim.foes.some((f) => f.id === e.id)) return null;
    }
    return attackAdvantage(m, e, s.entities, !!st.adv);
  }

  /** The tooltip over a gold-dotted tile: which monsters you'd have advantage on from there. */
  private spotTip(s: GameState, h: Pos): string[] | null {
    const why = this.spots.get(h.y * s.width + h.x);
    return why ? ['<b>🎯 Advantage from here</b>', ...why.map((w) => `<span class="tip-adv up">${esc(w)}</span>`)] : null;
  }

  private drawCursor() {
    const g = this.cursorG.clear();
    const s = store.state;
    const h = this.hover;
    if (!s?.tiles || !h || h.x < 0 || h.y < 0 || h.x >= s.width || h.y >= s.height) return;
    if (s.tiles[h.y * s.width + h.x] === '#') return;
    const e = this.entityAt(s, h);
    const m = me();
    const sel = store.selected;
    const st = m && sel && s.phase === 'combat' ? mySkillStats(m, sel) : null;
    if (m && sel && st?.target === 'area') return this.drawAreaPreview(g, s, m, sel, h);
    if (m && sel && st?.target === 'enemy' && e) {
      // Chain skills: show the extra targets they would jump to.
      const aim = aimAt(s, m, sel, e.id);
      if (typeof aim !== 'string') {
        for (const f of aim.foes) if (f !== aim.main) g.lineStyle(2, 0xffa24d, 1).strokeRect(f.x * T + 1, f.y * T + 1, T - 2, T - 2);
      }
    }
    const color = e?.kind === 'monster' ? 0xff5e5e : e ? 0x7ddc6f : 0xf4ead5;
    g.lineStyle(2, color, 0.8).strokeRect(h.x * T + 1, h.y * T + 1, T - 2, T - 2);
  }

  /** The area of an area skill aimed at the hovered tile: red tiles, and a strong outline on every monster it would hit. */
  private drawAreaPreview(g: Phaser.GameObjects.Graphics, s: GameState, m: PlayerEntity, id: SkillId, h: Pos) {
    const aim = aimAt(s, m, id, h);
    if (typeof aim === 'string') {
      g.lineStyle(2, 0x8c8478, 0.8).strokeRect(h.x * T + 1, h.y * T + 1, T - 2, T - 2); // out of range or no line of sight
      return;
    }
    const radius = mySkillStats(m, id)?.radius ?? 1;
    const tiles = new Set<number>();
    for (let y = Math.max(0, aim.center.y - radius); y <= Math.min(s.height - 1, aim.center.y + radius); y++) {
      for (let x = Math.max(0, aim.center.x - radius); x <= Math.min(s.width - 1, aim.center.x + radius); x++) {
        if (s.tiles[y * s.width + x] !== '#') tiles.add(y * s.width + x);
      }
    }
    g.fillStyle(0xff5e5e, 0.2);
    for (const idx of tiles) {
      const x = idx % s.width;
      g.fillRect(x * T, ((idx - x) / s.width) * T, T, T);
    }
    this.outlineTiles(g, s, tiles, 0xff5e5e, 0.9, 2);
    for (const f of aim.foes) {
      g.fillStyle(0xff3b3b, 0.3).fillRect(f.x * T + 1, f.y * T + 1, T - 2, T - 2);
      g.lineStyle(3, 0xff3b3b, 1).strokeRect(f.x * T + 1, f.y * T + 1, T - 2, T - 2);
    }
    g.lineStyle(2, 0xf4ead5, 0.9).strokeRect(h.x * T + 1, h.y * T + 1, T - 2, T - 2);
  }

  private onClick(p: Phaser.Input.Pointer) {
    if (p.rightButtonDown()) return select(null);
    const s = store.state;
    const m = me();
    if (!s || !m || s.phase !== 'combat' || inApproach(s)) return; // no moves before the first turn
    const t = this.tileAt(p);
    const target = this.entityAt(s, t);

    if (store.selected) {
      const sel = store.selected;
      const st = mySkillStats(m, sel);
      if (!st) return select(null);
      const aim = st.target === 'area' ? t : target?.id; // area skills take a tile, the rest a creature
      const res = aimAt(s, m, sel, aim);
      if (typeof res === 'string') return toast(res);
      send('act', sel, aim);
      select(null);
      return;
    }
    if (target?.kind === 'monster') {
      const ab = bestAttack(s, m, target);
      if (ab) send('act', ab, target.id);
      else toast(attackProblem(m));
      return;
    }
    if (target) return; // clicked a party member
    send('move', t);
  }

  // ---------------------------------------------------------------- effects

  private playFx(fx: Fx[]) {
    if (!store.state?.tiles) return;
    const perTile = new Map<string, number>();
    for (const f of fx) {
      if (f.kind === 'float') {
        const key = `${f.x},${f.y}`;
        const n = perTile.get(key) ?? 0;
        perTile.set(key, n + 1);
        const t = this.add
          .text(f.x * T + T / 2, f.y * T + 2, f.text, {
            fontFamily: UI_FONT, fontSize: '15px', fontStyle: 'bold', color: f.color, stroke: '#000000', strokeThickness: 4, resolution: 2,
          })
          .setOrigin(0.5)
          .setDepth(40)
          .setAlpha(0);
        this.tweens.add({ targets: t, alpha: 1, duration: 1, delay: n * 220 });
        this.tweens.add({ targets: t, y: t.y - 28, duration: 1100, delay: n * 220, ease: 'Cubic.easeOut' });
        this.tweens.add({ targets: t, alpha: 0, duration: 400, delay: n * 220 + 800, onComplete: () => t.destroy() });
      } else if (f.kind === 'shot') {
        const dot = this.add.circle(f.from.x * T + T / 2, f.from.y * T + T / 2, 4, hexColor(f.color)).setDepth(39);
        this.tweens.add({ targets: dot, x: f.to.x * T + T / 2, y: f.to.y * T + T / 2, duration: 220, onComplete: () => dot.destroy() });
      } else {
        this.playBurst(f.x, f.y, f.radius, hexColor(f.color));
      }
    }
  }

  /** An area skill going off: a blob covering the affected tiles that swells and fades. */
  private playBurst(x: number, y: number, radius: number, color: number) {
    const size = (2 * radius + 1) * T;
    const g = this.add.graphics().setPosition(x * T + T / 2, y * T + T / 2).setDepth(38).setScale(0.2);
    g.fillStyle(color, 0.4).fillRoundedRect(-size / 2, -size / 2, size, size, size * 0.35);
    g.lineStyle(3, color, 1).strokeRoundedRect(-size / 2, -size / 2, size, size, size * 0.35);
    this.tweens.add({ targets: g, scale: 1, duration: 260, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: g, alpha: 0, duration: 450, delay: 150, onComplete: () => g.destroy() });
  }
}

let game: Phaser.Game | null = null;

/** Creates the Phaser canvas the first time the game screen is shown. */
export function ensureGame() {
  if (game) return;
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'canvas-wrap',
    backgroundColor: '#0b0a09',
    scale: { mode: Phaser.Scale.RESIZE },
    scene: [DungeonScene],
    banner: false,
  });
}
