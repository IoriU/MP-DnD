// Phaser scene that draws the current battle room. It only renders server state; every rule lives on the server.
// Pixel art (DawnLike, see sprites.ts) for the room and the creatures. With the art switched off, or a sheet missing,
// tiles are drawn shapes and creatures are emoji.

import Phaser from 'phaser';
import { ALLIES, TRAITS, isAllyNpc, isFoe, type AllyDef } from '../shared/elites.ts';
import { LOW_COVER, dist, hasLOS, reachable } from '../shared/grid.ts';
import { BOSS_SIGNATURES, FULL_COVER, HALF_COVER, diceText, MONSTERS, ORDERS, RESIST_WORD, ROLES, roleOf, type MonsterDef, type Resist } from '../shared/rules.ts';
import { STATUSES, blockOf, canHitProps, hasStatus, hitsArea, type AimResult, type Element, type SkillStats, type StatusId } from '../shared/skills.ts';
import {
  CLOUDS, ELECTRIFIED, GROUNDS, HAZARD_DICE, ICE_DC, PROPS, REACTIONS, aimFieldOps, immuneToStatus, planWalk, previewField, reactionSummary,
  resistance, tilePos, tilesAround, type CloudId, type FieldLike, type FieldPreview, type GroundId,
} from '../shared/surfaces.ts';
import { advantageText, attackAdvantage, coverFrom, coverWord, dirTo, isBehind, isFlanking, netAdvantage, turnsToFace, type AdvantageInfo } from '../shared/tactics.ts';
import type { Entity, Fx, GameState, MonsterEntity, PlayerEntity, Pos } from '../shared/types.ts';
import { send } from './net.ts';
import {
  ACT_TILES, CLASS_SPRITES, COVER_LOOKS, DECOR_SHARE, FLAME, MONSTER_SPRITES, PLATINO, PROP_SPRITES, SHEETS, SPRITE_PX, WALK_ROW,
  floorFrame, markMissing, onGraphicsMode, platinoFor, sheetFiles, sheetKeys, sheetsReady, spritesOn, wallFrame, type SheetId,
} from './sprites.ts';
import {
  actingNow, aimAt, attackProblem, bestAttack, bestPropAttack, huntedIds, inApproach, isMyTurn, me, myActs, mySkillStats, occupied, onFx, refresh, select, store, turnKey,
  subscribe, validTarget,
} from './store.ts';
import { $, esc, stacksShown, toast } from './util.ts';

const T = 32; // tile size in pixels
const ART = T / SPRITE_PX; // DawnLike sprites are 16x16, drawn at 2x so one fills a tile
const ART_Y = -2; // creature art sits a little above the tile centre, so its feet stand on the ring
const WALK_MS = 95; // a hero's walking frame (4 per cycle)
const IDLE_MS = 500; // a monster's 2-frame idle: about 2 frames per second
const FLASH_MS = 80; // the white flash when something takes damage
const FADE_MS = 400; // a defeated monster fading out
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
/** A well-mixed unsigned 32-bit hash of an integer (the same everywhere, so decorations stay put between redraws). */
const hash32 = (n: number) => {
  let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
const strHash = (text: string) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
/** The walk-sheet row for the way a hero faces; diagonals use their horizontal part. */
const walkRow = (f: Pos) => (f.x > 0 ? WALK_ROW.right : f.x < 0 ? WALK_ROW.left : f.y < 0 ? WALK_ROW.up : WALK_ROW.down);

/** How each surface pool looks: its color (oil darkened so it reads as a slick) and opacity. */
const GROUND_LOOK: Record<GroundId, { color: number; alpha: number }> = {
  water: { color: hexColor(GROUNDS.water.color), alpha: 0.4 },
  ice: { color: hexColor(GROUNDS.ice.color), alpha: 0.42 },
  fire: { color: hexColor(GROUNDS.fire.color), alpha: 0.5 },
  oil: { color: 0x3b2d14, alpha: 0.78 },
  poison: { color: hexColor(GROUNDS.poison.color), alpha: 0.38 },
  lava: { color: hexColor(GROUNDS.lava.color), alpha: 0.8 },
};
/** Cloud puffs: smoke is lightened from its palette color, or it vanishes against the dark floor. */
const CLOUD_LOOK: Record<CloudId, { color: number; alpha: number }> = {
  steam: { color: hexColor(CLOUDS.steam.color), alpha: 0.13 },
  smoke: { color: 0x8d929c, alpha: 0.17 },
  gas: { color: hexColor(CLOUDS.gas.color), alpha: 0.12 },
};
const SHOCK = hexColor(ELECTRIFIED.color);
const WARN = 0xff3b3b; // friendly fire and walking into harm
const BLAST = 0xff8a1f;
const ALLY = 0x6fe07a; // NPC allies: a green ring, so they don't read as enemies (red) or heroes (their own color)
const FOCUS = 0xff3b3b; // the reticle on the hero the monsters are ganging up on
const ELEMENTS: Element[] = ['physical', 'fire', 'cold', 'lightning', 'poison', 'radiant', 'force'];
const RESIST_ORDER: Resist[] = ['immune', 'absorb', 'resist', 'weak'];

/** The sprite-sheet tile a creature is drawn with. Walk sheets (the heroes) pick their row and frame as they go. */
interface ArtSpec {
  sheet: SheetId;
  frame: number;
  walk: boolean;
}

/** Everything drawn for one creature: a ring, its art (or an emoji glyph), bars and tags. */
interface Token {
  c: Phaser.GameObjects.Container;
  ring: Phaser.GameObjects.Graphics;
  face: Phaser.GameObjects.Graphics; // the facing arrow on the ring
  glyph: Phaser.GameObjects.Text;
  art: Phaser.GameObjects.Sprite | null; // null: the emoji glyph is shown instead
  spec: ArtSpec | null;
  bar: Phaser.GameObjects.Graphics;
  tags: Phaser.GameObjects.Text; // status icons
  tagBg: Phaser.GameObjects.Graphics;
  traits: Phaser.GameObjects.Text; // an elite's trait icons, under its HP bar
  traitBg: Phaser.GameObjects.Graphics;
  key: string;
  kind: Entity['kind'];
  hp: number; // the last HP seen, to flash when it drops
  tint: number | null; // the status tint (frozen) to go back to after a flash
  flash: Phaser.Time.TimerEvent | null; // set while the white flash is on
  walking: boolean; // a move tween is running
  dir: number; // a hero's walk row
  frame: number; // the art frame showing now
  phase: number; // offsets idle animations so creatures don't blink in step
}

/** A flame sprite on a burning tile. */
interface Flame {
  img: Phaser.GameObjects.Image;
  n: number;
  fade: boolean;
  frame: number;
}

/** A ground or cloud tile, as the per-frame animation needs it. */
interface FieldTile<Id> {
  i: number;
  id: Id;
  fade: boolean; // its last round
  shock: boolean;
}

/** What a click on the hovered tile would do: aim a skill (the selected one, or a basic attack), or walk there. */
type Plan =
  | { kind: 'aim'; st: SkillStats; res: AimResult | string; area: Set<number> | null; field: FieldPreview | null }
  | { kind: 'walk'; to: Pos; path: Pos[]; hazards: Pos[] };
type WalkPlan = Extract<Plan, { kind: 'walk' }>;
type AimPlan = Extract<Plan, { kind: 'aim' }>;

/** "⬆️ advantage (flanking)" in green, "⬇️ disadvantage (blinded)" in red; '' for a straight roll. */
function advantageLine(a: AdvantageInfo): string {
  const net = netAdvantage(a);
  if (net) return `<span class="tip-adv ${net > 0 ? 'up' : 'down'}">${net > 0 ? '⬆️' : '⬇️'} ${esc(advantageText(a))}</span>`;
  if (a.adv.length) return `<span class="tip-adv even">⚖️ ${esc(advantageText(a))} (${esc(a.adv.join(', '))} vs ${esc(a.dis.join(', '))})</span>`;
  return '';
}

const desc = (text: string) => `<span class="tip-desc">${esc(text)}</span>`;

const BUFF_VERB: Partial<Record<StatusId, string>> = { blessed: 'Blesses', shielded: 'Shields', rallied: 'Rallies' }; // a support's buff, in words

/** A monster's role and tricks: "🛡️ Brute: pushes to the front", "✋ Shoves heroes into hazards", "✨ Heals 1d8+2 · 🙏 Blesses allies". */
function roleLines(def: MonsterDef, mon?: MonsterEntity): string[] {
  const role = ROLES[roleOf(def)];
  const lines = [`<span class="tip-role"><b>${role.icon} ${esc(role.name)}:</b> ${esc(role.desc)}</span>`];
  if (def.shove) lines.push('<span class="tip-role">✋ Shoves heroes into hazards</span>');
  if (def.support) {
    const { heal, buff } = def.support;
    const st = STATUSES[buff.id];
    lines.push(`<span class="tip-role">✨ Heals ${diceText(heal)} · ${st.icon} ${BUFF_VERB[buff.id] ?? esc(st.name)} allies (${buff.turns} rounds)</span>`);
  }
  // Phase 12 tricks: what it sets up for its friends.
  const t = def.trick;
  if (t) {
    const roll = t.save ? `${t.save.toUpperCase()} save DC ${t.dc ?? 12}` : 'attack roll';
    const statuses = t.status.map((x) => `${STATUSES[x.id].icon} ${STATUSES[x.id].name}`).join(', ');
    const cd = mon?.trickCd ? ` · ready in ${mon.trickCd} turn${mon.trickCd === 1 ? '' : 's'}` : t.cooldown >= 99 ? ' · once a fight' : '';
    lines.push(`<span class="tip-role">${t.icon} ${esc(t.name)}: ${statuses} (range ${t.range}, ${roll})${cd}</span>`);
  }
  if (def.rider) {
    const st = STATUSES[def.rider.status.id];
    lines.push(`<span class="tip-role">${st.icon} Its hits: ${esc(st.name)}${def.rider.save ? ` (${def.rider.save.toUpperCase()} save DC ${def.rider.dc ?? 12})` : ''}</span>`);
  }
  if (def.leader) lines.push(`<span class="tip-role">📯 Leader: shouts orders (${Object.values(ORDERS).map((o) => o.name).join(' ')})</span>`);
  return lines;
}
const roundsLeft = (turns: number | null) => (turns === null ? 'permanent' : `${turns} round${turns === 1 ? '' : 's'} left`);

/** Names for a preview line; heroes and NPC allies in red (it's your side getting hurt), you as "you". */
function names(list: Entity[], m: PlayerEntity): string {
  return list.map((e) => (isFoe(e) ? esc(e.name) : `<span class="tip-adv down">${e.id === m.id ? 'you' : esc(e.name)}</span>`)).join(', ');
}

/** What the party's record says about an NPC ally on the map (its fights left), matched by name; and its kind. */
function allyInfo(s: GameState, e: MonsterEntity): { def?: AllyDef; fights?: number } {
  const rec = s.run?.allies.find((a) => a.name === e.name);
  return { def: rec ? ALLIES[rec.id] : Object.values(ALLIES).find((a) => a.monster === e.type), fights: rec?.fights };
}

/** An elite's trait icons in a row ("🔥🔰"); empty for anything else. */
/** An elite's trait icons, or an act boss's signature (BOSS_SIGNATURES). */
const traitIcons = (e: Entity): string => {
  if (e.kind !== 'monster') return '';
  const sig = MONSTERS[e.type]?.signature;
  return (e.traits ?? []).map((t) => TRAITS[t]?.icon ?? '').join('') + (sig ? BOSS_SIGNATURES[sig].icon : '');
};

/** What stepping onto a tile does to this creature: "fire (1d4 + Burning)". Mirrors hazardAt in shared/surfaces.ts. */
function tileHazards(f: FieldLike, i: number, who: Entity): string[] {
  const g = f.ground[i];
  const c = f.clouds[i];
  const burns = !immuneToStatus(who, 'burning');
  const poisons = !immuneToStatus(who, 'poisoned');
  const out: string[] = [];
  if (g?.id === 'fire' && burns) out.push(`fire (${diceText(HAZARD_DICE.fire!)} + Burning)`);
  if (g?.id === 'lava' && burns) out.push(`lava (${diceText(HAZARD_DICE.lava!)} + Burning)`);
  if (g?.id === 'poison' && poisons) out.push(`poison (${diceText(HAZARD_DICE.poison!)} + Poisoned)`);
  if (g?.id === 'ice') out.push(`ice (DEX save DC ${ICE_DC} or fall)`);
  if (g?.id === 'water' && g.shock) out.push(`electrified water (${diceText(HAZARD_DICE.shock!)} lightning)`);
  if (c?.id === 'gas' && poisons) out.push('poison gas (Poisoned)');
  if (c?.id === 'steam' && c.shock) out.push(`electrified steam (${diceText(HAZARD_DICE.shock!)} lightning)`);
  return out;
}

function hazardWords(f: FieldLike, tiles: Pos[], who: Entity): string {
  return [...new Set(tiles.flatMap((p) => tileHazards(f, p.y * f.width + p.x, who)))].join(', ');
}

/** A walk only needs confirming again if it would go through different hazards. */
const walkKey = (w: WalkPlan) => `${w.to.x},${w.to.y}|${w.hazards.map((p) => `${p.x},${p.y}`).join(';')}`;

/** Does the walk get all the way there this turn (and not just as far as the movement lasts)? */
function arrives(w: WalkPlan): boolean {
  const end = w.path[w.path.length - 1];
  return end.x === w.to.x && end.y === w.to.y;
}

/** Low cover is a crate or a heap of rubble, picked by tile so it looks the same every redraw. */
const coverLook = (i: number) => COVER_LOOKS[hash32(i) % COVER_LOOKS.length];

const SIDES = [
  { dx: 0, dy: -1, name: 'north' }, { dx: 1, dy: 0, name: 'east' }, { dx: 0, dy: 1, name: 'south' }, { dx: -1, dy: 0, name: 'west' },
] as const;
interface CoverSide {
  dx: number;
  dy: number;
  name: string;
  cover: number; // HALF_COVER or FULL_COVER
}

/** The sides of a tile that have cover. Asks coverFrom about a shooter two tiles out on each side, so the rules stay in one place. */
function coverSides(s: GameState, t: Pos): CoverSide[] {
  return SIDES.map((d) => ({ ...d, cover: coverFrom(s, { x: t.x + d.dx * 2, y: t.y + d.dy * 2 }, t) })).filter((d) => d.cover > 0);
}

/** "🛡️ Cover: full to the east, half to the north and south (vs ranged attacks from those sides)"; no line without any cover. */
function coverLines(s: GameState, t: Pos): string[] {
  const sides = coverSides(s, t);
  const part = (full: boolean) => {
    const names = sides.filter((d) => (d.cover >= FULL_COVER) === full).map((d) => d.name);
    const where = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return names.length ? `${full ? 'full' : 'half'} to the ${where}` : '';
  };
  const words = [part(true), part(false)].filter(Boolean).join(', ');
  return words ? [`<span class="tip-cover"><b>🛡️ Cover: ${words}</b> (vs ranged attacks from ${sides.length > 1 ? 'those sides' : 'that side'})</span>`] : [];
}

/** What cover a monster has against my attack: "🛡️ Behind a wall: +5 AC", or named when several are in a blast: "🛡️ Goblin is in cover: +2 on its DEX save". */
function coverNote(n: { foe: MonsterEntity; cover: number; vs: string }, named: boolean): string {
  const word = coverWord(n.cover);
  return `<span class="tip-adv down">🛡️ ${named ? `${esc(n.foe.name)} is ${word}` : word[0].toUpperCase() + word.slice(1)}: +${n.cover} ${n.vs}</span>`;
}

/** The tiles, ignoring props: blowing up a barrel changes `tiles` but it's still the same room. */
function roomKey(s: GameState): string {
  const t = s.tiles.split('');
  for (const k of Object.keys(s.props ?? {})) t[Number(k)] = '.';
  return `${s.width}:${t.join('')}`;
}

class DungeonScene extends Phaser.Scene {
  private mapG!: Phaser.GameObjects.Graphics;
  private groundG = new Map<GroundId, Phaser.GameObjects.Graphics>(); // one per surface, so fire and lava can flicker as a whole
  private fieldFxG!: Phaser.GameObjects.Graphics; // flames, bubbles, sparks: redrawn every frame
  private cloudG!: Phaser.GameObjects.Graphics; // above the creatures, redrawn every frame
  private overlayG!: Phaser.GameObjects.Graphics;
  private turnG!: Phaser.GameObjects.Graphics;
  private cursorG!: Phaser.GameObjects.Graphics;
  private focusG!: Phaser.GameObjects.Graphics; // the reticle on the monsters' squad target, redrawn every frame
  private sprites = new Map<string, Token>();
  private ghosts = new Set<Phaser.GameObjects.Container>(); // defeated monsters on their way out
  private ready = new Set<SheetId>(); // the sheets that loaded; anything on a missing one falls back to emoji
  private tileObjs: Phaser.GameObjects.GameObject[] = []; // the room's floor, wall and decoration sprites
  private flames: Flame[] = [];
  private propTexts: Phaser.GameObjects.GameObject[] = []; // prop sprites (or emoji when there's no art)
  private braziers: number[] = [];
  private trapObjs: Phaser.GameObjects.Text[] = []; // the 🪤 on each hidden snare
  private trapKey = '';
  private groundTiles: FieldTile<GroundId>[] = [];
  private cloudTiles: FieldTile<CloudId>[] = [];
  private groundKey = '';
  private mapKey = '';
  private roomKey = '';
  private turnKey = '';
  private hover: Pos | null = null;
  private pointer: Pos | null = null; // mouse position over the canvas in screen pixels, so the tooltip can refresh when the state changes
  private plan: Plan | null = null; // what clicking the hovered tile would do
  private pendingWalk: string | null = null; // a walk through a hazard clicked once (walkKey); the second click sends it
  private spots = new Map<number, string[]>(); // reachable tiles that would give advantage (tile index -> "Goblin: from behind")
  private inset = 0; // pixels at the top of the canvas covered by the Sneak-or-Charge card; the room is fitted below it
  private userCam = false; // the player panned or zoomed, so leave the camera alone

  constructor() {
    super('dungeon');
  }

  /** Loads every sheet. A sheet that fails just isn't marked ready, and whatever needs it is drawn with emoji instead. */
  preload() {
    this.load.on('loaderror', (file: Phaser.Loader.File) => console.warn(`Couldn't load the art ${file.src}: using emoji for it`));
    for (const id of Object.keys(SHEETS) as SheetId[]) {
      const keys = sheetKeys(id);
      sheetFiles(id).forEach((url, i) => this.load.spritesheet(keys[i], url, { frameWidth: SPRITE_PX, frameHeight: SPRITE_PX }));
    }
  }

  create() {
    // Pixel art needs nearest-neighbour filtering. Only these textures get it: the emoji text stays smooth.
    for (const id of Object.keys(SHEETS) as SheetId[]) {
      const keys = sheetKeys(id);
      if (!keys.every((k) => this.textures.exists(k))) continue;
      for (const k of keys) this.textures.get(k).setFilter(Phaser.Textures.FilterMode.NEAREST);
      this.ready.add(id);
    }
    // Sheets that didn't load: the HTML icons that use them fall back to emoji too.
    const lost = (Object.keys(SHEETS) as SheetId[]).filter((id) => !this.ready.has(id));
    if (lost.length) markMissing(lost);
    this.cameras.main.setBackgroundColor(BG);
    this.mapG = this.add.graphics().setDepth(0);
    for (const id of Object.keys(GROUNDS) as GroundId[]) this.groundG.set(id, this.add.graphics().setDepth(1));
    this.fieldFxG = this.add.graphics().setDepth(2);
    this.overlayG = this.add.graphics().setDepth(5);
    this.turnG = this.add.graphics().setDepth(9);
    this.cloudG = this.add.graphics().setDepth(12); // creatures are 10 and 11
    this.focusG = this.add.graphics().setDepth(13);
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
      this.plan = null;
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
    const offMode = onGraphicsMode(() => this.redrawAll());
    this.events.once('shutdown', () => {
      offState();
      offFx();
      offMode();
    });
    this.sync();
    if (lost.length) refresh();
  }

  update(time: number) {
    // Pulsing ring around whoever's turn it is (every hero of a shared turn).
    const g = this.turnG.clear();
    for (const cur of actingNow()) {
      const sp = this.sprites.get(cur.id);
      if (sp) g.lineStyle(3, 0xffd84d, 0.55 + 0.45 * Math.sin(time / 160)).strokeCircle(sp.c.x, sp.c.y, 17);
    }
    for (const t of this.sprites.values()) this.animate(t, time);
    this.drawField(time);
    this.drawFocus(time);
  }

  /**
   * A red reticle around each hero the monsters are hunting (turn.focus: one per pack), turning slowly, and four faint green
   * corner brackets on the monster the NPC allies have picked (turn.allyFocus). Both follow their creature as it walks and go
   * away when the server clears them. Drawn as shapes, so they look the same with the pixel art on or off.
   */
  private drawFocus(time: number) {
    const g = this.focusG.clear();
    const s = store.state;
    const t = s?.turn;
    if (!s || !t || s.phase !== 'combat') return;
    for (const id of huntedIds(s)) {
      const hero = s.entities.find((e) => e.id === id);
      const at = hero && !(hero.kind === 'player' && hero.dead) ? this.sprites.get(id) : undefined;
      if (!at) continue;
      const r = 23 + Math.sin(time / 220); // a slow throb
      const spin = time / 1400;
      for (const [width, color, alpha] of [[5, 0x000000, 0.55], [2.5, FOCUS, 1]] as const) {
        g.lineStyle(width, color, alpha).strokeCircle(at.c.x, at.c.y, r);
        for (let k = 0; k < 4; k++) {
          const a = spin + (k * Math.PI) / 2;
          g.lineBetween(at.c.x + Math.cos(a) * (r - 6), at.c.y + Math.sin(a) * (r - 6), at.c.x + Math.cos(a) * (r + 5), at.c.y + Math.sin(a) * (r + 5));
        }
      }
    }
    const foe = t.allyFocus ? s.entities.find((e) => e.id === t.allyFocus) : undefined;
    const mark = foe?.kind === 'monster' ? this.sprites.get(foe.id) : undefined;
    if (foe?.kind === 'monster' && mark) {
      const h = (foe.boss || foe.elite ? 21 : 16) + Math.sin(time / 260); // half the box, on the tile corners
      const arm = 6;
      g.lineStyle(2, ALLY, 0.8);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const cx = mark.c.x + sx * h;
        const cy = mark.c.y + sy * h;
        g.lineBetween(cx, cy, cx - sx * arm, cy).lineBetween(cx, cy, cx, cy - sy * arm);
      }
    }
  }

  /** The art was switched on or off: draw the room and every creature again. */
  private redrawAll() {
    this.mapKey = '';
    this.groundKey = '';
    for (const t of this.sprites.values()) this.dropToken(t);
    this.sprites.clear();
    this.sync();
  }

  // ---------------------------------------------------------------- state -> pixels

  private sync() {
    const s = store.state;
    if (!s || !s.tiles) {
      if (this.mapKey) this.clearRoom();
      return;
    }
    const inset = this.insetFor(s);
    const insetChanged = inset !== this.inset;
    this.inset = inset;
    const mapKey = s.tiles + JSON.stringify(s.props ?? {});
    if (mapKey !== this.mapKey) {
      this.mapKey = mapKey;
      this.drawMap(s);
    }
    const room = roomKey(s);
    if (room !== this.roomKey) {
      this.roomKey = room;
      this.fitCamera(s);
    } else if (insetChanged && !this.userCam) {
      this.fitCamera(s, true); // the Sneak-or-Charge card came or went: slide the room into the free space
    }
    const key = turnKey(s);
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.pendingWalk = null;
    }
    this.syncField(s);
    this.syncTraps(s);
    this.syncEntities(s);
    this.plan = this.computePlan();
    this.drawOverlay(s);
    this.drawCursor();
    this.showTip();
  }

  private clearRoom() {
    this.mapKey = '';
    this.roomKey = '';
    this.groundKey = '';
    this.inset = 0;
    this.plan = null;
    this.pendingWalk = null;
    this.spots.clear();
    this.groundTiles = [];
    this.cloudTiles = [];
    this.braziers = [];
    this.clearTraps();
    this.mapG.clear();
    for (const g of this.groundG.values()) g.clear();
    this.fieldFxG.clear();
    this.cloudG.clear();
    this.overlayG.clear();
    this.cursorG.clear();
    this.clearTiles();
    this.clearFlames();
    $('#tooltip').hidden = true;
    for (const t of this.sprites.values()) this.dropToken(t);
    this.sprites.clear();
    for (const c of this.ghosts) {
      this.tweens.killTweensOf(c);
      c.destroy();
    }
    this.ghosts.clear();
  }

  private clearTiles() {
    for (const o of [...this.tileObjs, ...this.propTexts]) o.destroy();
    this.tileObjs = [];
    this.propTexts = [];
  }

  private clearFlames() {
    for (const f of this.flames) f.img.destroy();
    this.flames = [];
  }

  /** Is this sheet loaded, with the art switched on? */
  private art(id: SheetId): boolean {
    return spritesOn() && this.ready.has(id);
  }

  private drawMap(s: GameState) {
    this.clearTiles();
    this.braziers = [];
    if (this.art('floor') && this.art('wall')) return this.drawArtMap(s);
    const pal = PALETTES[Math.min(PALETTES.length, s.run?.act ?? 1) - 1];
    const props = s.props ?? {};
    const g = this.mapG.clear();
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const px = x * T;
        const py = y * T;
        const n = hash(x, y);
        const i = y * s.width + x;
        const prop = props[i];
        if (s.tiles[i] === '#' && !prop) {
          g.fillStyle(pal.wall).fillRect(px, py, T, T);
          g.fillStyle(pal.wallTop).fillRect(px, py, T, 5);
          g.fillStyle(pal.wallShadow).fillRect(px, py + T - 3, T, 3);
          g.lineStyle(1, pal.wallShadow, 1).lineBetween(px + (n > 0.5 ? T / 2 : T / 3), py + 5, px + (n > 0.5 ? T / 2 : T / 3), py + T - 3);
          continue;
        }
        g.fillStyle(n < 0.5 ? pal.floorA : pal.floorB).fillRect(px, py, T, T);
        g.lineStyle(1, 0x000000, 0.35).strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        if (s.tiles[i] === LOW_COVER) {
          this.drawCover(g, x, y, i);
          continue;
        }
        if (prop) {
          // Props stand on '#' tiles (they block like walls) but they're things on the floor, not wall.
          g.fillStyle(0x000000, 0.4).fillEllipse(px + T / 2, py + T * 0.8, 22, 7);
          const t = this.add.text(px + T / 2, py + T / 2 - 1, PROPS[prop].icon, { fontFamily: EMOJI_FONT, fontSize: '20px', resolution: 2 });
          this.propTexts.push(t.setOrigin(0.5).setDepth(3));
          if (prop === 'brazier') this.braziers.push(i);
          continue;
        }
        if (n > 0.92) g.fillStyle(pal.speck).fillCircle(px + 6 + n * 18, py + 8 + ((n * 97) % 16), 1.5);
      }
    }
  }

  /** Low cover: a crate or a heap of rubble on the floor, with a shadow like a prop's. Blocks walking, not sight (so it isn't wall). */
  private drawCover(g: Phaser.GameObjects.Graphics, x: number, y: number, i: number) {
    const look = coverLook(i);
    const cx = x * T + T / 2;
    const cy = y * T + T / 2;
    g.fillStyle(0x000000, 0.4).fillEllipse(cx, y * T + T * 0.8, 24, 7);
    const img = this.art(look.sprite.sheet)
      ? this.add.image(cx, cy, sheetKeys(look.sprite.sheet)[0], look.sprite.frame).setScale(ART)
      : this.add.text(cx, cy - 1, look.emoji, { fontFamily: EMOJI_FONT, fontSize: '20px', resolution: 2 }).setOrigin(0.5);
    this.propTexts.push(img.setDepth(3));
  }

  /** The room from sprites: auto-tiled walls, floor tiles, a few decorations, low cover and props standing on the floor. */
  private drawArtMap(s: GameState) {
    const act = s.run?.act ?? 1;
    const props = s.props ?? {};
    const w = s.width;
    const g = this.mapG.clear();
    // Props sit on '#' tiles (they block like walls) but they are furniture, not wall: they don't join the wall lines.
    const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < s.height && s.tiles[y * w + x] === '#' && !props[y * w + x];
    const put = (sheet: SheetId, frame: number, x: number, y: number, depth: number) => {
      const img = this.add.image(x * T, y * T, sheetKeys(sheet)[0], frame).setOrigin(0).setScale(ART).setDepth(depth);
      this.tileObjs.push(img);
      return img;
    };
    const decor = this.art('decor') ? (ACT_TILES[act] ?? ACT_TILES[1]).decor : [];
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (wall(x, y)) {
          const mask = (wall(x, y - 1) ? 1 : 0) | (wall(x + 1, y) ? 2 : 0) | (wall(x, y + 1) ? 4 : 0) | (wall(x - 1, y) ? 8 : 0);
          put('wall', wallFrame(act, mask), x, y, 0);
          continue;
        }
        put('floor', floorFrame(act), x, y, 0);
        if (s.tiles[i] === LOW_COVER) {
          this.drawCover(g, x, y, i);
          continue;
        }
        const prop = props[i];
        if (prop) {
          g.fillStyle(0x000000, 0.4).fillEllipse(x * T + T / 2, y * T + T * 0.8, 22, 7);
          const sp = PROP_SPRITES[prop];
          const img = sp && this.art(sp.sheet)
            ? this.add.image(x * T + T / 2, y * T + T / 2, sheetKeys(sp.sheet)[0], sp.frame).setScale(ART)
            : this.add.text(x * T + T / 2, y * T + T / 2 - 1, PROPS[prop].icon, { fontFamily: EMOJI_FONT, fontSize: '20px', resolution: 2 }).setOrigin(0.5);
          this.propTexts.push(img.setDepth(3));
          if (prop === 'brazier') this.braziers.push(i);
          continue;
        }
        // About DECOR_SHARE of the floor tiles get a skull, some vines or the like, drawn under the pools and the creatures.
        const h = hash32(i);
        if (decor.length && (h % 1000) / 1000 < DECOR_SHARE) {
          const d = decor[(h >>> 10) % decor.length];
          put(d.sheet, d.frame, x, y, 0.5).setAlpha(0.8);
        }
      }
    }
  }

  /** Collects the ground and cloud tiles for the animation, and redraws the ground pools when they changed. */
  private syncField(s: GameState) {
    this.groundTiles = [];
    this.cloudTiles = [];
    let key = '';
    for (const [k, g] of Object.entries(s.ground ?? {})) {
      if (!g) continue;
      const t = { i: Number(k), id: g.id, fade: g.turns === 1, shock: !!g.shock };
      this.groundTiles.push(t);
      key += `${t.i}${t.id}${t.fade ? '-' : ''},`;
    }
    for (const [k, c] of Object.entries(s.clouds ?? {})) {
      if (c) this.cloudTiles.push({ i: Number(k), id: c.id, fade: c.turns === 1, shock: !!c.shock });
    }
    if (key !== this.groundKey) {
      this.groundKey = key;
      this.drawGround(s);
    }
  }

  /** Hidden snares (Ranger Trapper): a small, faint 🪤 on each tile, above the ground and under the creatures. */
  private syncTraps(s: GameState) {
    const traps = s.traps ?? {};
    const key = `${s.width}:${JSON.stringify(traps)}`;
    if (key === this.trapKey) return;
    this.clearTraps();
    this.trapKey = key;
    this.trapObjs = Object.entries(traps).map(([k, t]) => {
      const at = tilePos(s, Number(k));
      return this.add.text(at.x * T + T / 2, at.y * T + T / 2, t.icon, { fontFamily: EMOJI_FONT, fontSize: '17px', resolution: 2 }).setOrigin(0.5).setAlpha(0.85).setDepth(3.5);
    });
  }

  private clearTraps() {
    for (const o of this.trapObjs) o.destroy();
    this.trapObjs = [];
    this.trapKey = '';
  }

  /** The ground layer: one soft-cornered pool per surface, with its static details (oil gloss, ice streaks, lava crust). */
  private drawGround(s: GameState) {
    for (const g of this.groundG.values()) g.clear();
    const w = s.width;
    // A 2-frame flame sprite on each burning tile, on top of the pool and under the creatures (animated in drawField).
    this.clearFlames();
    if (this.art(FLAME.sheet)) {
      for (const t of this.groundTiles) {
        if (t.id !== 'fire') continue;
        const x = t.i % w;
        const y = (t.i - x) / w;
        const img = this.add.image(x * T + T / 2, y * T + T / 2, sheetKeys(FLAME.sheet)[0], FLAME.frame).setScale(ART).setDepth(2.5);
        this.flames.push({ img, n: hash(x, y), fade: t.fade, frame: 0 });
      }
    }
    const same = (x: number, y: number, id: GroundId) => x >= 0 && y >= 0 && x < w && y < s.height && s.ground[y * w + x]?.id === id;
    const R = 9;
    for (const t of this.groundTiles) {
      const g = this.groundG.get(t.id)!;
      const look = GROUND_LOOK[t.id];
      const x = t.i % w;
      const y = (t.i - x) / w;
      const px = x * T;
      const py = y * T;
      const n = hash(x, y);
      const a = t.fade ? 0.5 : 1;
      // Round the corners where the pool ends, so neighbouring tiles merge into one puddle.
      const up = same(x, y - 1, t.id);
      const down = same(x, y + 1, t.id);
      const left = same(x - 1, y, t.id);
      const right = same(x + 1, y, t.id);
      g.fillStyle(look.color, look.alpha * a);
      if (up && down && left && right) g.fillRect(px, py, T, T);
      else g.fillRoundedRect(px, py, T, T, { tl: up || left ? 0 : R, tr: up || right ? 0 : R, bl: down || left ? 0 : R, br: down || right ? 0 : R });
      switch (t.id) {
        case 'oil':
          g.fillStyle(0xffffff, 0.1 * a).fillEllipse(px + T * (0.3 + 0.25 * n), py + T * (0.3 + 0.15 * n), 14, 5);
          g.fillStyle(0x8c7cff, 0.1 * a).fillEllipse(px + T * (0.7 - 0.2 * n), py + T * (0.62 + 0.12 * n), 10, 4);
          break;
        case 'ice':
          g.lineStyle(1, 0xffffff, 0.4 * a).lineBetween(px + 5 + n * 6, py + T - 6, px + T - 8, py + 6 + n * 6);
          g.lineBetween(px + 6, py + T * 0.55, px + T * 0.4, py + T * 0.3);
          break;
        case 'lava':
          g.fillStyle(0xff9a1f, 0.45 * a).fillCircle(px + T * (0.35 + 0.3 * n), py + T * (0.6 - 0.25 * n), 7);
          g.lineStyle(2, 0x3a0a00, 0.5 * a).lineBetween(px + 4, py + T * (0.3 + n * 0.3), px + T * 0.5, py + T * 0.55).lineBetween(px + T * 0.5, py + T * 0.55, px + T - 5, py + T * (0.7 - n * 0.3));
          break;
        case 'poison':
          g.fillStyle(0x2f5a12, 0.55 * a).fillCircle(px + 8 + n * 14, py + 10 + n * 9, 2).fillCircle(px + T - 9, py + T - 8 - n * 8, 1.5);
          break;
      }
    }
  }

  /** The moving parts of the battlefield, every frame: flames, bubbles, ripples, sparks on electrified tiles, clouds. */
  private drawField(time: number) {
    const fx = this.fieldFxG.clear();
    const cg = this.cloudG.clear();
    const s = store.state;
    if (!s?.tiles || !this.mapKey) return;
    this.groundG.get('fire')!.setAlpha(0.82 + 0.18 * Math.sin(time / 83) * Math.sin(time / 137));
    this.groundG.get('lava')!.setAlpha(0.85 + 0.15 * Math.sin(time / 650));
    for (const f of this.flames) {
      const frame = Math.floor(time / 230 + f.n * 4) % 2;
      if (frame !== f.frame) f.img.setTexture(sheetKeys(FLAME.sheet)[(f.frame = frame)], FLAME.frame);
      f.img.setAlpha((0.6 + 0.25 * Math.sin(time / 110 + f.n * 30)) * (f.fade ? 0.5 : 1));
    }
    const w = s.width;
    for (const t of this.groundTiles) {
      const x = t.i % w;
      const y = (t.i - x) / w;
      const px = x * T;
      const py = y * T;
      const n = hash(x, y);
      const a = t.fade ? 0.5 : 1;
      switch (t.id) {
        case 'fire': {
          for (let k = 0; k < 3; k++) {
            const bx = px + T * (0.22 + 0.28 * k) + (hash(x + k, y) - 0.5) * 6;
            const by = py + T * (0.74 + 0.12 * hash(x, y + k));
            const f = Math.sin(time / (70 + k * 13) + n * 40 + k * 2.3) * Math.sin(time / 190 + k);
            const h = 7 + 8 * Math.abs(f);
            const sway = 2.5 * Math.sin(time / 120 + n * 9 + k);
            fx.fillStyle(0xff7a1a, 0.55 * a).fillTriangle(bx - 4.5, by, bx + 4.5, by, bx + sway, by - h);
            fx.fillStyle(0xffd65a, 0.75 * a).fillTriangle(bx - 2.2, by, bx + 2.2, by, bx + sway * 0.6, by - h * 0.55);
          }
          const ph = (time / 1300 + n) % 1; // an ember drifting up
          fx.fillStyle(0xffc56b, (1 - ph) * 0.9 * a).fillCircle(px + T * (0.2 + 0.6 * hash(y, x)) + 2 * Math.sin(ph * 9), py + T * (0.8 - 0.75 * ph), 1.3);
          break;
        }
        case 'lava':
          for (let k = 0; k < 2; k++) {
            const pulse = 0.5 + 0.5 * Math.sin(time / 520 + n * 17 + k * 2);
            fx.fillStyle(0xffe08a, (0.25 + 0.45 * pulse) * a)
              .fillCircle(px + T * (0.25 + 0.5 * hash(x + k * 3, y)), py + T * (0.25 + 0.5 * hash(x, y + k * 5)), 2.5 + 3 * pulse);
          }
          break;
        case 'water':
          for (let k = 0; k < 2; k++) {
            const ph = (time / 2600 + n + k * 0.5) % 1;
            const lx = px + 4 + ph * (T - 16);
            const ly = py + T * (0.3 + 0.4 * hash(x + k, y + 9));
            fx.lineStyle(1.5, 0xd5eeff, Math.sin(ph * Math.PI) * 0.45 * a).lineBetween(lx, ly, lx + 8, ly);
          }
          break;
        case 'ice': {
          const ph = (time / 2400 + n) % 1; // a brief glint now and then
          if (ph < 0.18) {
            const k = Math.sin((ph / 0.18) * Math.PI);
            const gx = px + T * (0.25 + 0.5 * hash(x + 5, y));
            const gy = py + T * (0.25 + 0.5 * hash(x, y + 5));
            fx.lineStyle(1.5, 0xffffff, 0.9 * k * a).lineBetween(gx - 4 * k, gy, gx + 4 * k, gy).lineBetween(gx, gy - 4 * k, gx, gy + 4 * k);
          }
          break;
        }
        case 'poison':
          for (let k = 0; k < 2; k++) {
            const ph = (time / 1400 + n + k * 0.47) % 1;
            const bx = px + T * (0.25 + 0.5 * hash(x + k * 7, y));
            const by = py + T * (0.3 + 0.5 * hash(x, y + k * 7)) - ph * 4;
            fx.lineStyle(1.2, 0xd4ff9a, (1 - ph) * 0.85 * a).strokeCircle(bx, by, 1 + 2.5 * ph);
          }
          break;
      }
      if (t.shock) this.sparks(fx, px, py, t.i, time);
    }
    for (const i of this.braziers) {
      const f = 0.5 + 0.5 * Math.sin(time / 95 + i) * Math.sin(time / 57);
      fx.fillStyle(0xff9a3a, 0.08 + 0.08 * f).fillCircle((i % w) * T + T / 2, Math.floor(i / w) * T + T / 2, 17 + 3 * f);
    }
    // Clouds: a few drifting puffs per tile that overlap into one haze; see-through enough to keep the creatures readable.
    for (const c of this.cloudTiles) {
      const x = c.i % w;
      const y = (c.i - x) / w;
      const n = hash(x, y);
      const look = CLOUD_LOOK[c.id];
      cg.fillStyle(look.color, look.alpha * (c.fade ? 0.55 : 1));
      for (let k = 0; k < 4; k++) {
        const ang = n * 6.283 + k * 1.571 + (time / 2600) * (k % 2 ? 1 : -1);
        cg.fillCircle(x * T + T / 2 + Math.cos(ang) * 7, y * T + T / 2 + Math.sin(ang) * 6, 12 + 3 * Math.sin(time / 900 + n * 10 + k));
      }
      if (c.shock) this.sparks(cg, x * T, y * T, c.i, time);
    }
  }

  /** Electrified water or steam: yellow flashes and a jagged bolt that jumps around a few times a second. */
  private sparks(g: Phaser.GameObjects.Graphics, px: number, py: number, i: number, time: number) {
    const tick = Math.floor(time / 90);
    const flash = hash(i, tick);
    if (flash > 0.55) g.fillStyle(SHOCK, (flash - 0.55) * 0.55).fillRect(px, py, T, T);
    if (hash(tick, i) < 0.45) return;
    g.lineStyle(1.5, 0xfff7a8, 0.95);
    let lx = px + 3;
    let ly = py + T * (0.2 + 0.6 * hash(i + 1, tick));
    for (let k = 1; k <= 4; k++) {
      const nx = px + 3 + (k * (T - 6)) / 4;
      const ny = py + T * (0.15 + 0.7 * hash(i + k, tick + k));
      g.lineBetween(lx, ly, nx, ny);
      lx = nx;
      ly = ny;
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
      let hurt = false;
      if (!sp) {
        sp = this.makeSprite(e);
        sp.c.setPosition(px, py);
        this.sprites.set(e.id, sp);
      } else {
        hurt = e.hp < sp.hp;
        if (sp.c.x !== px || sp.c.y !== py) this.walkTo(sp, px, py);
      }
      sp.hp = e.hp;
      this.styleSprite(sp, e);
      if (hurt) this.flash(sp);
    }
    for (const [id, sp] of this.sprites) {
      if (seen.has(id)) continue;
      this.sprites.delete(id);
      if (sp.kind === 'monster') this.fadeOut(sp);
      else this.dropToken(sp);
    }
  }

  /** Slides a creature to its new tile (while the hero's walk frames play); a long jump just snaps. */
  private walkTo(t: Token, px: number, py: number) {
    this.tweens.killTweensOf(t.c);
    const far = Math.abs(t.c.x - px) > T * 1.5 || Math.abs(t.c.y - py) > T * 1.5;
    t.walking = !far;
    if (far) t.c.setPosition(px, py);
    else this.tweens.add({ targets: t.c, x: px, y: py, duration: 110, onComplete: () => (t.walking = false) });
  }

  private dropToken(t: Token) {
    this.tweens.killTweensOf(t.c);
    t.flash?.remove();
    t.c.destroy();
  }

  /** A defeated monster or ally: a white flash, then it fades and sinks a few pixels. Its bars and tags go at once. */
  private fadeOut(t: Token) {
    this.tweens.killTweensOf(t.c);
    for (const o of [t.ring, t.face, t.bar, t.tagBg, t.tags, t.traitBg, t.traits]) o.setVisible(false);
    this.flash(t);
    this.ghosts.add(t.c);
    this.tweens.add({
      targets: t.c, alpha: 0, y: t.c.y + 5, duration: FADE_MS, delay: FLASH_MS, ease: 'Sine.easeIn',
      onComplete: () => {
        this.ghosts.delete(t.c);
        this.dropToken(t);
      },
    });
  }

  /** What a creature is drawn with: its sprite, if the art is on and that sheet loaded. Else null (the emoji glyph). */
  private artFor(e: Entity): ArtSpec | null {
    if (!spritesOn()) return null;
    const sheet = e.kind === 'player' ? CLASS_SPRITES[e.classId] : undefined;
    const mon = e.kind === 'monster' ? (platinoFor(e.type, e.id) ? PLATINO : MONSTER_SPRITES[e.type]) : undefined;
    const spec = sheet ? { sheet, frame: 0, walk: true } : mon ? { sheet: mon.sheet, frame: mon.frame, walk: false } : null;
    return spec && this.ready.has(spec.sheet) ? spec : null;
  }

  /** The sprite's scale: elites a bit bigger, bosses bigger still. */
  private artScale(e: Entity): number {
    return e.kind === 'monster' ? (e.boss ? ART * 1.4 : e.elite ? ART * 1.2 : ART) : ART;
  }

  /** Per frame: heroes walk while they move and bob a pixel when idle; monsters flip between their 2 idle frames. */
  private animate(t: Token, time: number) {
    const art = t.art;
    const spec = t.spec;
    if (!art || !spec || !art.visible) return;
    if (spec.walk) {
      const frame = t.dir * 4 + (t.walking ? Math.floor(time / WALK_MS) % 4 : 0);
      if (frame !== t.frame) art.setFrame((t.frame = frame));
      art.y = ART_Y - (t.walking || Math.sin(time / 420 + t.phase * 6.283) < 0.35 ? 0 : 1);
    } else {
      const f = Math.floor(time / IDLE_MS + t.phase * 2) % 2;
      if (f !== t.frame) art.setTexture(sheetKeys(spec.sheet)[(t.frame = f)], spec.frame);
    }
  }

  /** Puts the art (or glyph) back to its normal look: no tint, or the status tint. Not while the flash is on. */
  private applyTint(t: Token) {
    if (t.flash) return;
    const o = t.art ?? t.glyph;
    o.clearTint();
    if (t.tint !== null) o.setTint(t.tint);
  }

  /** The white flash of a hit. Hits in quick succession just restart it. */
  private flash(t: Token) {
    const o = t.art ?? t.glyph;
    o.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    t.flash?.remove();
    t.flash = this.time.delayedCall(FLASH_MS, () => {
      t.flash = null;
      if (t.c.active) this.applyTint(t);
    });
  }

  private makeSprite(e: Entity): Token {
    const ring = this.add.graphics();
    const face = this.add.graphics();
    const big = e.kind === 'monster' && (e.boss || e.elite);
    const spec = this.artFor(e);
    const glyph = this.add.text(0, -1, e.glyph, { fontFamily: EMOJI_FONT, fontSize: big ? '26px' : '19px', resolution: 2 }).setOrigin(0.5).setVisible(!spec);
    const art = spec ? this.add.sprite(0, ART_Y, sheetKeys(spec.sheet)[0], spec.frame).setScale(this.artScale(e)) : null;
    const bar = this.add.graphics();
    const tagBg = this.add.graphics();
    const tags = this.add.text(0, 0, '', { fontFamily: EMOJI_FONT, fontSize: '9px', resolution: 2 }).setOrigin(0.5, 0);
    const traitBg = this.add.graphics();
    const traits = this.add.text(0, 0, '', { fontFamily: EMOJI_FONT, fontSize: '9px', resolution: 2 }).setOrigin(0.5, 0);
    const c = this.add.container(0, 0, [ring, face, glyph, ...(art ? [art] : []), bar, tagBg, tags, traitBg, traits]).setDepth(e.kind === 'player' ? 11 : 10);
    return {
      c, ring, face, glyph, art, spec, bar, tags, tagBg, traits, traitBg, key: '', kind: e.kind, hp: e.hp, tint: null, flash: null, walking: false,
      dir: WALK_ROW.down, frame: -1, phase: (hash32(strHash(e.id)) % 1000) / 1000,
    };
  }

  private styleSprite(sp: Token, e: Entity) {
    const dead = e.kind === 'player' && e.dead;
    const down = e.kind === 'player' && e.downed;
    const soak = blockOf(e) + (e.kind === 'player' ? e.tempHp : (e.ward ?? 0)); // damage Block, a hero's temp HP or a Shielded elite's ward still soaks
    const shown = dead ? [] : e.statuses.slice(0, MAX_TAGS);
    const key = `${e.hp}/${e.maxHp}/${soak}/${dead}/${down}/${e.facing?.x},${e.facing?.y}/${e.statuses.map((x) => `${x.id}${stacksShown(x)}`).join(',')}`;
    if (sp.key === key) return;
    sp.key = key;
    const big = e.kind === 'monster' && (e.boss || e.elite);
    const ally = isAllyNpc(e);
    const art = sp.art;
    const r = big ? (art && e.kind === 'monster' && e.boss ? 21 : 19) : 14; // a boss's sprite is drawn bigger, so its ring is too
    const color = e.kind === 'player' ? hexColor(e.color) : ally ? ALLY : big ? 0xe8b04a : 0xd94a3a;
    // Frozen solid: an icy disc and a blue tint, so you can tell at a glance who's losing a turn.
    const frozen = !dead && hasStatus(e, 'frozen');
    sp.ring.clear().fillStyle(frozen ? 0x9fdcff : 0x000000, frozen ? 0.45 : 0.55).fillCircle(0, 0, r).lineStyle(big ? 3 : 2, color, dead ? 0.3 : 1).strokeCircle(0, 0, r);
    if (ally) sp.ring.lineStyle(1.5, ALLY, 0.45).strokeCircle(0, 0, r + 3); // a second, fainter ring marks the party's side
    // Hidden heroes fade out. A small arrow on the ring shows which way the creature faces (attacks from behind have advantage).
    // A fallen hero is a grave (the glyph) even with the art on; a downed one lies on its side.
    const alpha = down ? 0.5 : hasStatus(e, 'hidden') ? 0.55 : 1;
    sp.glyph.setText(dead ? '🪦' : e.glyph).setAlpha(alpha).setAngle(down ? 90 : 0).setVisible(!art || dead);
    if (art) art.setAlpha(alpha).setAngle(down ? 90 : 0).setVisible(!dead);
    sp.tint = frozen ? 0xa8dcff : null;
    this.applyTint(sp);
    if (sp.spec?.walk) sp.dir = walkRow(e.facing);
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
      // Temporary HP, or an elite's ward: a thin cyan strip above the bar.
      if (soak > 0) sp.bar.fillStyle(0x6fd3ff, 0.95).fillRect(-w / 2, r - 4, w * Math.min(1, soak / e.maxHp), 2);
    }
    // Status icons across the top of the token, on a dark pill so they read over the emoji.
    const icons = shown.map((x) => STATUSES[x.id].icon + (stacksShown(x) || '')).join('') + (!dead && e.statuses.length > MAX_TAGS ? '+' : '');
    const top = art && big ? -r - 1 : -T / 2; // a big sprite sticks out above the tile: the pill goes above it
    sp.tags.setText(icons).setPosition(0, top + 1);
    sp.tagBg.clear();
    if (icons) sp.tagBg.fillStyle(0x000000, 0.7).fillRoundedRect(-sp.tags.width / 2 - 2, top, sp.tags.width + 4, sp.tags.height + 2, 4);
    // An elite's traits sit in a matching pill just under its HP bar.
    const marks = dead ? '' : traitIcons(e);
    sp.traits.setText(marks).setPosition(0, r + 4);
    sp.traitBg.clear();
    if (marks) sp.traitBg.fillStyle(0x000000, 0.7).fillRoundedRect(-sp.traits.width / 2 - 2, r + 3, sp.traits.width + 4, sp.traits.height + 2, 4);
  }

  /** Tiles within `range` of the hero that a ranged skill could reach (beyond melee it needs line of sight). */
  private reachTiles(s: GameState, m: PlayerEntity, range: number): Set<number> {
    const out = new Set<number>();
    for (let y = Math.max(0, m.y - range); y <= Math.min(s.height - 1, m.y + range); y++) {
      for (let x = Math.max(0, m.x - range); x <= Math.min(s.width - 1, m.x + range); x++) {
        if (s.tiles[y * s.width + x] === '#') continue; // low cover stays in: it blocks walking, not sight, and a blast can land on it
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

  private fillTiles(g: Phaser.GameObjects.Graphics, s: GameState, tiles: Iterable<number>, color: number, alpha: number) {
    g.fillStyle(color, alpha);
    for (const idx of tiles) {
      const x = idx % s.width;
      g.fillRect(x * T, ((idx - x) / s.width) * T, T, T);
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
        this.fillTiles(g, s, tiles, color, 0.06);
        this.outlineTiles(g, s, tiles, color, 0.5, 2);
      }
      if (st.target === 'area') return; // the hover preview shows what it would hit
      for (const e of s.entities) {
        if (!validTarget(s, m, e, sel)) continue;
        g.lineStyle(2, color, 1).strokeRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
        g.fillStyle(color, 0.15).fillRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
      }
      // Oil barrels and braziers in reach can be hit too.
      if (canHitProps(st)) {
        for (const k of Object.keys(s.props)) {
          const at = tilePos(s, Number(k));
          if (typeof aimAt(s, m, sel, at) === 'string') continue;
          g.lineStyle(2, 0xffa24d, 1).strokeRect(at.x * T + 1, at.y * T + 1, T - 2, T - 2);
          g.fillStyle(0xffa24d, 0.15).fillRect(at.x * T + 1, at.y * T + 1, T - 2, T - 2);
        }
      }
      return;
    }
    const moves = myActs()?.moves ?? 0;
    if (moves > 0) {
      const reach = reachable(s, m, moves, (x, y) => occupied(s, x, y, m.id));
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
      if (!isFoe(mon) || dist(mon, there) !== 1) continue;
      // Walking up to a monster makes it turn to face you (unless you're hidden), so only flanks survive the walk.
      const looking = moved && turnsToFace(mon, m, there) ? { ...mon, facing: dirTo(mon, there) } : mon;
      const why = [isBehind(looking, there) ? 'from behind' : '', isFlanking(there, mon, s.entities) ? 'flanking' : ''].filter(Boolean);
      if (why.length) out.push(`${mon.name}: ${why.join(', ')}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- what a click would do

  private inRoom(s: GameState, t: Pos): boolean {
    return t.x >= 0 && t.y >= 0 && t.x < s.width && t.y < s.height;
  }

  /**
   * The hovered tile's plan: the selected skill aimed there, a basic attack on a monster or prop, or a walk.
   * Runs the skill's battlefield effects on a copy of the field, so the preview shows what will react.
   */
  private computePlan(): Plan | null {
    const s = store.state;
    const h = this.hover;
    const m = me();
    if (!s?.tiles || !h || !m || s.phase !== 'combat' || inApproach(s) || !this.inRoom(s, h)) return null;
    const i = h.y * s.width + h.x;
    const prop = s.props[i];
    if (s.tiles[i] === '#' && !prop) return null;
    const e = this.entityAt(s, h);
    let id = store.selected;
    if (!id) {
      if (isFoe(e)) id = bestAttack(s, m, e); // allies and heroes aren't attacked
      else if (prop) id = bestPropAttack(s, m, h);
      else if (!e) return this.walkPlan(s, m, h);
      if (!id) return null;
    }
    const st = mySkillStats(m, id);
    // Area skills take the tile; the rest a creature, or the tile of a barrel or brazier.
    const aim = st?.target === 'area' ? h : e ? e.id : prop && st && canHitProps(st) ? h : null;
    if (!st || !aim) return null;
    const res = aimAt(s, m, id, aim);
    if (typeof res === 'string') return { kind: 'aim', st, res, area: null, field: null };
    const ops = aimFieldOps(st, m, res, s);
    return {
      kind: 'aim', st, res,
      area: st.target === 'area' ? new Set(tilesAround(s, res.center, st.radius ?? 1)) : null,
      field: ops.length ? previewField(s, ops, s.entities) : null,
    };
  }

  /** The walk a click would start (the same plan the server makes), on my turn. */
  private walkPlan(s: GameState, m: PlayerEntity, to: Pos): WalkPlan | null {
    const moves = myActs()?.moves ?? 0;
    if (moves <= 0 || hasStatus(m, 'stunned') || hasStatus(m, 'frozen')) return null;
    if (occupied(s, to.x, to.y, m.id) || (to.x === m.x && to.y === m.y)) return null;
    const plan = planWalk(s, m, to, moves, (x, y) => occupied(s, x, y, m.id), m);
    return plan?.path.length ? { kind: 'walk', to, ...plan } : null;
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
    const t = this.tileAt(p);
    const moved = !this.hover || t.x !== this.hover.x || t.y !== this.hover.y;
    this.hover = t;
    this.pointer = { x: p.x, y: p.y };
    if (moved) {
      this.plan = this.computePlan();
      this.drawCursor();
    }
    this.showTip();
  }

  /** The tooltip for whatever is under the mouse. Also redrawn when the state changes, so previews stay current. */
  private showTip() {
    const tip = $('#tooltip');
    const s = store.state;
    const h = this.hover;
    const p = this.pointer;
    const inRoom = !!s?.tiles && !!h && this.inRoom(s, h);
    const e = inRoom ? this.entityAt(s!, h!) : undefined;
    const lines = !inRoom || !p ? [] : e ? this.entityTip(s!, e) : this.tileTip(s!, h!);
    if (!lines.length || !p) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    // Keep it on screen: flip to the other side of the pointer near the right or bottom edge.
    const wrap = tip.parentElement!;
    const left = p.x + 16 + tip.offsetWidth > wrap.clientWidth ? Math.max(4, p.x - 12 - tip.offsetWidth) : p.x + 16;
    const top = p.y + 16 + tip.offsetHeight > wrap.clientHeight ? Math.max(4, p.y - 12 - tip.offsetHeight) : p.y + 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  private entityTip(s: GameState, e: Entity): string[] {
    const mon = e.kind === 'monster' ? e : null;
    const tag = mon?.boss ? ' <span class="tag">boss</span>' : mon?.elite ? ' <span class="tag">elite</span>' : isAllyNpc(e) ? ' <span class="tag ally">ally</span>' : '';
    const block = blockOf(e) > 0 ? ` (+${blockOf(e)} 🧱 Block)` : '';
    const soak = block + (e.kind === 'player' ? (e.tempHp > 0 ? ` (+${e.tempHp} temp)` : '') : mon?.ward ? ` (+${mon.ward} 🔰 ward)` : '');
    const lines = [`<b>${esc(e.name)}</b>${tag} ${traitIcons(e)}`.trim(), `${e.hp} / ${e.maxHp} HP${soak} · AC ${e.ac}`];
    if (e.statuses.length) lines.push(e.statuses.map((x) => `${STATUSES[x.id].icon} ${STATUSES[x.id].name}${stacksShown(x) ? ` ×${stacksShown(x)}` : ''} ${x.turns}`).join(' · '));
    const resist = this.resistLine(e);
    if (resist) lines.push(resist);
    // Who the monsters (or the NPC allies) have picked: the red reticle on the map.
    if (e.kind === 'player' && huntedIds(s).includes(e.id)) lines.push(`<span class="tip-adv down">🎯 Hunted: the monsters are ganging up on ${esc(e.name)}</span>`);
    if (s.phase === 'combat' && s.turn?.allyFocus === e.id && mon) lines.push('<span class="tip-adv up">🎯 Your allies are going for it</span>');
    // What it is in the squad, and its tricks.
    const mdef = mon ? MONSTERS[mon.type] : undefined;
    if (mdef) lines.push(...roleLines(mdef, mon ?? undefined));
    // An elite's traits, one short block each, and a boss's signature.
    for (const t of mon?.traits ?? []) {
      const tr = TRAITS[t];
      if (tr) lines.push(`<span class="tip-trait"><b>${tr.icon} ${esc(tr.name)}:</b> ${esc(tr.desc)}</span>`);
    }
    const sig = mdef?.signature && !mon?.ally ? BOSS_SIGNATURES[mdef.signature] : undefined;
    if (sig) lines.push(`<span class="tip-trait"><b>${sig.icon} ${esc(sig.name)}:</b> ${esc(sig.desc)} When it falls, the rest flee.</span>`);
    // An NPC ally: what it is, how long it stays, and what it hits for.
    if (mon && isAllyNpc(mon)) {
      const { def, fights } = allyInfo(s, mon);
      const stats = MONSTERS[mon.type];
      lines.push(`<span class="tip-adv up">🤝 Ally${fights !== undefined ? ` · ${fights} fight${fights === 1 ? '' : 's'} left` : ''}</span>`);
      if (def) lines.push(desc(def.desc));
      if (stats) {
        const dmg = { ...stats.dmg, bonus: (stats.dmg.bonus ?? 0) + (mon.dmgBonus ?? 0) };
        lines.push(`<span class="muted">⚔️ +${stats.atk + (mon.atkBonus ?? 0)} to hit · ${diceText(dmg)}${stats.attacks > 1 ? ` ×${stats.attacks}` : ''}${stats.range > 1 ? ` · range ${stats.range}` : ''}</span>`);
      }
    }
    const death = mon ? MONSTERS[mon.type]?.death : undefined;
    if (death) {
      const icon = death.ground ? GROUNDS[death.ground].icon : death.cloud ? CLOUDS[death.cloud].icon : '💀';
      lines.push(`<span class="tip-death">${icon} When it dies, it ${esc(death.text)}</span>`);
    }
    const under = this.standingIn(s, e);
    if (under) lines.push(under);
    if (s.phase === 'combat') lines.push(...coverLines(s, e));
    const m = me();
    if (isFoe(e) && m && s.phase === 'combat') {
      const sel = store.selected;
      const atk = sel ? null : bestAttack(s, m, e);
      const adv = this.attackPreview(s, m, e);
      if (adv) {
        const line = advantageLine(adv);
        if (line) lines.push(line);
      }
      // Already covered by the "from behind" reason when it's in the preview; otherwise (not your turn, or a skill that doesn't roll to hit) say it here.
      if (isBehind(e, m) && !adv?.adv.includes('from behind')) lines.push('<span class="tip-adv up">🔙 facing away from you</span>');
      const plan = this.plan?.kind === 'aim' ? this.plan : null;
      // Blasts name who is in cover in aimLines; a single target's cover goes with its advantage.
      const note = plan && plan.st.target !== 'area' ? this.coverNotes(s, m, plan).find((n) => n.foe.id === e.id) : undefined;
      if (note) lines.push(coverNote(note, false));
      const use = inApproach(s)
        ? 'Choose Sneak or Charge first'
        : sel
          ? plan && typeof plan.res !== 'string' ? `Click to use ${plan.st.name}` : ''
          : atk ? `Click to attack (${mySkillStats(m, atk)?.name})` : attackProblem(m);
      if (use) lines.push(`<span class="muted">${esc(use)}</span>`);
    }
    if (m && this.plan?.kind === 'aim') lines.push(...this.aimLines(s, m, this.plan, false));
    return lines;
  }

  /** "Immune to fire, poison · Weak to cold": green where it helps you, red where it doesn't. */
  private resistLine(e: Entity): string {
    const by = new Map<Resist, string[]>();
    for (const el of ELEMENTS) {
      const r = resistance(e, el);
      if (r) by.set(r, [...(by.get(r) ?? []), el]);
    }
    const parts = RESIST_ORDER.filter((r) => by.has(r)).map((r) => {
      const good = (r === 'weak') === isFoe(e); // an enemy's weakness, or your own side's resistance
      return `<span class="tip-adv ${good ? 'up' : 'down'}">${RESIST_WORD[r]} ${by.get(r)!.join(', ')}</span>`;
    });
    return parts.join(' · ');
  }

  /** "In 🔥 Fire · 🌫️ Smoke" for whatever the creature stands in. */
  private standingIn(s: GameState, e: Pos): string {
    const i = e.y * s.width + e.x;
    const g = s.ground[i];
    const c = s.clouds[i];
    const parts = [
      g ? `${GROUNDS[g.id].icon} ${GROUNDS[g.id].name}${g.shock ? ` ${ELECTRIFIED.icon}` : ''}` : '',
      c ? `${CLOUDS[c.id].icon} ${CLOUDS[c.id].name}${c.shock ? ` ${ELECTRIFIED.icon}` : ''}` : '',
    ].filter(Boolean);
    return parts.length ? `<span class="muted">Standing in ${parts.join(' · ')}</span>` : '';
  }

  /** A tile with no creature: the prop, ground and cloud on it, the advantage spots, then what a click would do. */
  private tileTip(s: GameState, h: Pos): string[] {
    const i = h.y * s.width + h.x;
    const lines: string[] = [];
    const prop = s.props[i];
    const g = s.ground[i];
    const c = s.clouds[i];
    if (prop) lines.push(`<b>${PROPS[prop].icon} ${PROPS[prop].name}</b>`, desc(PROPS[prop].desc));
    if (s.tiles[i] === LOW_COVER) lines.push(`<b>${coverLook(i).emoji} Low cover</b>`, desc(`Can't walk through it, but you can shoot over it. Stand next to it: +${HALF_COVER} AC against ranged attacks from its side.`));
    const trap = s.traps?.[i];
    if (trap) {
      const by = s.entities.find((e) => e.id === trap.by)?.name;
      lines.push(`<b>${trap.icon} Snare${by ? ` (set by ${esc(by)})` : ''}</b>`, desc('The first monster to step in is snared.'));
    }
    if (g) lines.push(`<b>${GROUNDS[g.id].icon} ${GROUNDS[g.id].name}</b> <span class="muted">· ${roundsLeft(g.turns)}</span>`, desc(GROUNDS[g.id].desc));
    if (g?.shock) lines.push(`<b class="tip-shock">${ELECTRIFIED.icon} ${ELECTRIFIED.name}</b>`, desc(ELECTRIFIED.desc));
    if (c) lines.push(`<b>${CLOUDS[c.id].icon} ${CLOUDS[c.id].name}</b> <span class="muted">· ${roundsLeft(c.turns)}</span>`, desc(CLOUDS[c.id].desc));
    if (c?.shock) lines.push(`<b class="tip-shock">${ELECTRIFIED.icon} Electrified steam</b>`, desc(ELECTRIFIED.desc));
    const why = this.spots.get(i);
    if (why) lines.push('<b>🎯 Advantage from here</b>', ...why.map((w) => `<span class="tip-adv up">${esc(w)}</span>`));
    const m = me();
    const plan = this.plan;
    if (!m || !plan) return lines;
    if (plan.kind === 'walk') {
      if (arrives(plan)) lines.push(...coverLines(s, h));
      if (plan.hazards.length) {
        lines.push(`<span class="tip-adv down">⚠ Walks through ${esc(hazardWords(s, plan.hazards, m))}</span>`);
        lines.push(`<span class="muted">${this.pendingWalk === walkKey(plan) ? 'Click again to go' : 'Click twice to walk through it'}</span>`);
      }
      return lines;
    }
    if (prop && typeof plan.res !== 'string') lines.push(`<span class="muted">Click to ${store.selected ? 'use' : 'hit it with'} ${esc(plan.st.name)}</span>`);
    lines.push(...this.aimLines(s, m, plan, !prop));
    return lines;
  }

  /**
   * The aiming preview in words: who an area attack hits (heroes in red), what the battlefield will do
   * ("🔥 Ignited! (6 tiles)"), and who gets caught in it. `header` names the skill when nothing else on the tooltip does.
   */
  private aimLines(s: GameState, m: PlayerEntity, p: AimPlan, header: boolean): string[] {
    const res = p.res;
    if (typeof res === 'string') return store.selected ? [`<span class="muted">${esc(res)}</span>`] : [];
    const lines: string[] = [];
    if (header) lines.push(`<b>${p.st.icon} ${esc(p.st.name)}</b>`);
    if (hitsArea(p.st)) lines.push(res.foes.length ? `Hits ${names(res.foes, m)}` : '<span class="muted">No enemies in the area</span>');
    if (p.st.target === 'area') lines.push(...this.coverNotes(s, m, p).map((n) => coverNote(n, true)));
    if (res.caught?.length) lines.push(`<span class="tip-adv down">⚠ Friendly fire: ${res.caught.map((e) => (e.id === m.id ? 'you' : esc(e.name))).join(', ')}</span>`);
    const f = p.field;
    if (f) {
      reactionSummary(f.result).forEach((text, k) => {
        lines.push(`<span class="tip-react" style="color:${REACTIONS[f.result.reactions[k].kind].color}">${esc(text)}</span>`);
      });
      if (f.blasted.length) lines.push(`💥 Explosion hits ${names(f.blasted, m)}`);
      if (f.exposed.length) lines.push(`⚠ Caught in it: ${names(f.exposed, m)}`);
    }
    return lines;
  }

  /**
   * The cover the monsters this aim would hit have against it. Only attack rolls (+AC) and DEX saves (+to the save) get any.
   * An attack comes from me; a blast's save from where it lands (the hovered tile).
   */
  private coverNotes(s: GameState, m: PlayerEntity, p: AimPlan): { foe: MonsterEntity; cover: number; vs: string }[] {
    const res = p.res;
    const dex = p.st.roll === 'save' && (p.st.save ?? 'dex') === 'dex';
    if (typeof res === 'string' || (p.st.roll !== 'attack' && !dex)) return [];
    const from = dex && p.st.target === 'area' ? res.center : m;
    return res.foes
      .map((foe) => ({ foe, cover: coverFrom(s, from, foe), vs: dex ? 'on its DEX save' : 'AC' }))
      .filter((n) => n.cover > 0);
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

  private drawCursor() {
    const g = this.cursorG.clear();
    const s = store.state;
    const h = this.hover;
    if (!s?.tiles || !h || !this.inRoom(s, h)) return;
    const prop = s.props[h.y * s.width + h.x];
    const tile = s.tiles[h.y * s.width + h.x];
    if ((tile === '#' && !prop) || (tile === LOW_COVER && !this.plan)) return; // walls and crates get no cursor, unless a blast can land there
    const e = this.entityAt(s, h);
    const plan = this.plan;
    if (plan?.kind === 'walk') {
      this.drawWalk(g, s, plan);
      if (arrives(plan)) this.drawShields(g, plan.to, coverSides(s, plan.to));
    }
    if (plan?.kind === 'aim') {
      if (typeof plan.res === 'string' && plan.st.target === 'area') {
        g.lineStyle(2, 0x8c8478, 0.8).strokeRect(h.x * T + 1, h.y * T + 1, T - 2, T - 2); // out of range or no line of sight
        return;
      }
      if (typeof plan.res !== 'string') this.drawAim(g, s, plan, plan.res);
    }
    const color = isFoe(e) ? 0xff5e5e : e ? 0x7ddc6f : prop ? 0xffa24d : 0xf4ead5; // red for enemies, green for heroes and allies
    g.lineStyle(2, plan?.kind === 'aim' && plan.area ? 0xf4ead5 : color, plan?.kind === 'aim' && plan.area ? 0.9 : 0.8);
    g.strokeRect(h.x * T + 1, h.y * T + 1, T - 2, T - 2);
  }

  /** The path a click would walk; tiles that would hurt in red (bolder once you've clicked and it's waiting for the second click). */
  private drawWalk(g: Phaser.GameObjects.Graphics, s: GameState, plan: WalkPlan) {
    const m = me();
    if (!m) return;
    const pending = this.pendingWalk === walkKey(plan);
    const pts = [m, ...plan.path];
    g.lineStyle(pending ? 3 : 2, plan.hazards.length ? 0xffb0a0 : 0xf4ead5, pending ? 0.9 : 0.45);
    for (let k = 1; k < pts.length; k++) g.lineBetween(pts[k - 1].x * T + T / 2, pts[k - 1].y * T + T / 2, pts[k].x * T + T / 2, pts[k].y * T + T / 2);
    for (const p of plan.hazards) {
      g.fillStyle(WARN, pending ? 0.4 : 0.25).fillRect(p.x * T, p.y * T, T, T);
      g.lineStyle(2, WARN, 1).strokeRect(p.x * T + 1, p.y * T + 1, T - 2, T - 2);
    }
    // Not enough movement to get all the way: mark where the walk stops.
    const end = plan.path[plan.path.length - 1];
    if (!arrives(plan)) g.fillStyle(0xf4ead5, 0.8).fillCircle(end.x * T + T / 2, end.y * T + T / 2, 4);
  }

  /**
   * XCOM-style shields on the sides of a tile that have cover, just inside its edge: a whole shield for a wall, one with
   * only its lower half filled for low cover or a prop. Shields only: high ground, if it comes, needs its own look.
   */
  private drawShields(g: Phaser.GameObjects.Graphics, t: Pos, sides: CoverSide[]) {
    const SHIELD = [[-6.5, -8], [6.5, -8], [6.5, 0], [4, 5.5], [0, 9], [-4, 5.5], [-6.5, 0]] as const;
    const LOWER = [[-6.5, 0], [6.5, 0], [4, 5.5], [0, 9], [-4, 5.5]] as const; // the half that is filled on a half shield
    for (const d of sides) {
      // In a corner the shields would pile up: slide each along its edge, away from the covered side next to it.
      const next = sides.filter((o) => o.dx * d.dx + o.dy * d.dy === 0);
      const cx = t.x * T + T / 2 + d.dx * 8 - next.reduce((n, o) => n + o.dx, 0) * 3.5;
      const cy = t.y * T + T / 2 + d.dy * 7 - next.reduce((n, o) => n + o.dy, 0) * 3.5;
      const trace = (pts: readonly (readonly [number, number])[]) => {
        g.beginPath();
        pts.forEach(([x, y], k) => (k ? g.lineTo(cx + x, cy + y) : g.moveTo(cx + x, cy + y)));
        g.closePath();
      };
      trace(SHIELD);
      g.fillStyle(0x0b1a26, 0.85).fillPath();
      trace(d.cover >= FULL_COVER ? SHIELD : LOWER);
      g.fillStyle(0x5fb8ff, 1).fillPath();
      trace(SHIELD);
      g.lineStyle(3.5, 0x000000, 0.6).strokePath();
      g.lineStyle(1.5, 0xe8f4ff, 1).strokePath();
    }
  }

  /** An aimed skill: the area, the monsters it hits, allies caught in it, and the tiles the battlefield reaction reaches. */
  private drawAim(g: Phaser.GameObjects.Graphics, s: GameState, plan: AimPlan, res: AimResult) {
    if (plan.area) {
      this.fillTiles(g, s, plan.area, 0xff5e5e, 0.2);
      this.outlineTiles(g, s, plan.area, 0xff5e5e, 0.9, 2);
    }
    const f = plan.field;
    if (f) {
      // Every tile that turns into something new, in the color of what it becomes; explosions in orange.
      for (const i of f.result.changed) {
        const gr = f.field.ground[i];
        const cl = f.field.clouds[i];
        const color = gr?.shock || cl?.shock ? SHOCK : gr ? GROUND_LOOK[gr.id].color : cl ? hexColor(CLOUDS[cl.id].color) : 0xf4ead5;
        this.fillTiles(g, s, [i], color, 0.35);
      }
      this.outlineTiles(g, s, new Set(f.result.changed), 0xfff0c0, 0.7, 1.5);
      if (f.result.blasts.length) {
        const blasts = new Set(f.result.blasts);
        this.fillTiles(g, s, blasts, BLAST, 0.35);
        this.outlineTiles(g, s, blasts, BLAST, 1, 2);
      }
    }
    const box = (e: Pos, color: number, width: number, fill: number) => {
      if (fill) g.fillStyle(color, fill).fillRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
      g.lineStyle(width, color, 1).strokeRect(e.x * T + 1, e.y * T + 1, T - 2, T - 2);
    };
    const warn = (e: Pos) => {
      g.lineStyle(3, WARN, 1).strokeCircle(e.x * T + T / 2, e.y * T + T / 2, 16);
      g.lineStyle(1.5, 0xffffff, 0.85).strokeCircle(e.x * T + T / 2, e.y * T + T / 2, 19.5);
    };
    if (plan.area) for (const foe of res.foes) box(foe, 0xff3b3b, 3, 0.3);
    else for (const foe of res.foes) if (foe !== res.main) box(foe, 0xffa24d, 2, 0); // chain skills: the extra targets
    if (res.prop !== undefined) box(tilePos(s, res.prop), 0xffa24d, 3, 0.25);
    for (const e of [...(f?.blasted ?? []), ...(f?.exposed ?? [])]) {
      if (isFoe(e)) box(e, BLAST, 2, 0);
      else warn(e); // a hero or an NPC ally
    }
    for (const e of res.caught ?? []) warn(e);
  }

  private onClick(p: Phaser.Input.Pointer) {
    if (p.rightButtonDown()) return select(null);
    const s = store.state;
    const m = me();
    if (!s || !m || s.phase !== 'combat' || inApproach(s)) return; // no moves before the first turn
    const t = this.tileAt(p);
    const target = this.entityAt(s, t);
    const prop = this.inRoom(s, t) ? s.props[t.y * s.width + t.x] : undefined;

    if (store.selected) {
      const sel = store.selected;
      const st = mySkillStats(m, sel);
      if (!st) return select(null);
      // Area skills take a tile, the rest a creature, or the tile of a barrel or brazier.
      const aim = st.target === 'area' ? t : (target?.id ?? (prop && canHitProps(st) ? t : undefined));
      const res = aimAt(s, m, sel, aim);
      if (typeof res === 'string') return toast(res);
      send('act', sel, aim);
      select(null);
      return;
    }
    if (isFoe(target)) {
      const ab = bestAttack(s, m, target);
      if (ab) send('act', ab, target.id);
      else toast(attackProblem(m));
      return;
    }
    if (target) return; // clicked a hero or an NPC ally
    if (prop) {
      const ab = bestPropAttack(s, m, t);
      if (ab) send('act', ab, t);
      else toast(attackProblem(m));
      return;
    }
    // Walking into fire, poison or the like takes a second click. The server walks around it when it can.
    const walk = this.inRoom(s, t) ? this.walkPlan(s, m, t) : null;
    if (walk?.hazards.length && this.pendingWalk !== walkKey(walk)) {
      this.pendingWalk = walkKey(walk);
      toast(`⚠ Walks through ${hazardWords(s, walk.hazards, m)}. Click again to go.`);
      this.plan = walk;
      this.drawCursor();
      this.showTip();
      return;
    }
    this.pendingWalk = null;
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
let starting = false;

/**
 * Creates the Phaser canvas the first time the game screen is shown. It waits for the palette-swapped class sheets to be
 * painted (a few milliseconds, long done by then) so the loader finds the Barbarian, Ranger, Bard and Cleric in their colors.
 */
export function ensureGame() {
  if (game || starting) return;
  starting = true;
  void sheetsReady.then(() => {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'canvas-wrap',
      backgroundColor: '#0b0a09',
      scale: { mode: Phaser.Scale.RESIZE },
      scene: [DungeonScene],
      banner: false,
    });
  });
}
