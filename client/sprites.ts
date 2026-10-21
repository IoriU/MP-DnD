// Which sprite draws what: classes, monsters, NPC allies, walls and floors, props, items and map icons.
// The art is DawnLike by DragonDePlatino, on DawnBringer's palette (CC-BY 4.0: see CREDITS.md), in client/assets/dawnlike/
// (Vite serves client/assets/ at the site root). Anything without a sprite here keeps its emoji.

import type { ItemId } from '../shared/items.ts';
import { CLASSES } from '../shared/rules.ts';
import type { PropId } from '../shared/surfaces.ts';
import type { ClassId, NodeType } from '../shared/types.ts';
import { loadPref, savePref } from './util.ts';

export const SPRITE_ROOT = 'dawnlike/';
export const SPRITE_PX = 16; // every DawnLike tile is 16x16

/**
 * DawnLike's 16 colors (DawnBringer's palette, exactly as they are in the sheets), plus two that aren't (they are for the
 * Bard, tuned to sit with the rest). A sheet's `swap` repaints one color as another, by these names.
 */
const COLORS = {
  black: 0x140c1c, wine: 0x452434, navy: 0x30346d, grey: 0x4d494d, brown: 0x864d30, forest: 0x346524, red: 0xd34549, olive: 0x757161,
  blue: 0x597dcf, orange: 0xd37d2c, steel: 0x8696a2, green: 0x6daa2c, skin: 0xd3aa9a, cyan: 0x6dc3cb, yellow: 0xdbd75d, white: 0xdfefd7,
  purple: 0xa050c8, pink: 0xe070b0,
} as const;
type ColorName = keyof typeof COLORS;
type Swap = Partial<Record<ColorName, ColorName>>;

/**
 * The sheets in use. `frames: 2` sheets come as a pair (Undead0.png, Undead1.png): the same tile in each is one frame
 * of a 2-frame idle animation. `walk` sheets (the commissioned player classes) are 4 columns x 4 rows: one row per
 * direction (down, left, right, up), 4 walking frames each. A sheet with a `swap` is another sheet's art in other colors
 * (see bakeSheets): that is how classes that share a commissioned sheet still look different.
 */
export const SHEETS = {
  player: { file: 'Characters/Player', cols: 8, frames: 2 },
  humanoid: { file: 'Characters/Humanoid', cols: 8, frames: 2 },
  undead: { file: 'Characters/Undead', cols: 8, frames: 2 },
  rodent: { file: 'Characters/Rodent', cols: 8, frames: 2 },
  dog: { file: 'Characters/Dog', cols: 8, frames: 2 },
  pest: { file: 'Characters/Pest', cols: 8, frames: 2 },
  reptile: { file: 'Characters/Reptile', cols: 8, frames: 2 },
  demon: { file: 'Characters/Demon', cols: 8, frames: 2 },
  misc: { file: 'Characters/Misc', cols: 8, frames: 2 },
  elemental: { file: 'Characters/Elemental', cols: 8, frames: 2 },
  avian: { file: 'Characters/Avian', cols: 8, frames: 2 }, // bats and gargoyles (the flyers)
  warrior: { file: 'Commissions/Warrior', cols: 4, frames: 1, walk: true },
  rogue: { file: 'Commissions/Rogue', cols: 4, frames: 1, walk: true },
  mage: { file: 'Commissions/Mage', cols: 4, frames: 1, walk: true },
  paladin: { file: 'Commissions/Paladin', cols: 4, frames: 1, walk: true },
  // The same four sheets in other colors, one line per class that wants its own look (CLASS_SPRITES picks them).
  barbarian: { file: 'Commissions/Warrior', cols: 4, frames: 1, walk: true, swap: { steel: 'red', olive: 'brown', grey: 'wine', cyan: 'yellow', white: 'skin' } }, // a red warrior, bone horns
  ranger: { file: 'Commissions/Rogue', cols: 4, frames: 1, walk: true, swap: { red: 'green', orange: 'forest' } }, // a green hood
  bard: { file: 'Commissions/Mage', cols: 4, frames: 1, walk: true, swap: { blue: 'purple', cyan: 'pink' } }, // a purple robe
  cleric: { file: 'Commissions/Paladin', cols: 4, frames: 1, walk: true, swap: { orange: 'cyan', yellow: 'white', brown: 'steel' } }, // white and pale blue, where the Paladin is gold
  wall: { file: 'Objects/Wall', cols: 20, frames: 1 },
  floor: { file: 'Objects/Floor', cols: 21, frames: 1 },
  decor: { file: 'Objects/Decor', cols: 8, frames: 2 },
  effect: { file: 'Objects/Effect', cols: 8, frames: 2 },
  potion: { file: 'Items/Potion', cols: 8, frames: 1 },
  scroll: { file: 'Items/Scroll', cols: 8, frames: 1 },
  medwep: { file: 'Items/MedWep', cols: 8, frames: 1 },
  longwep: { file: 'Items/LongWep', cols: 8, frames: 1 },
  armor: { file: 'Items/Armor', cols: 8, frames: 1 },
  ring: { file: 'Items/Ring', cols: 8, frames: 1 },
  amulet: { file: 'Items/Amulet', cols: 8, frames: 1 },
  boot: { file: 'Items/Boot', cols: 8, frames: 1 },
  glove: { file: 'Items/Glove', cols: 8, frames: 1 },
  tool: { file: 'Items/Tool', cols: 8, frames: 1 },
  rock: { file: 'Items/Rock', cols: 8, frames: 1 },
  wand: { file: 'Items/Wand', cols: 8, frames: 1 },
  money: { file: 'Items/Money', cols: 8, frames: 1 },
  chest: { file: 'Items/Chest', cols: 8, frames: 2 },
  hat: { file: 'Items/Hat', cols: 8, frames: 1 },
} as const satisfies Record<string, { file: string; cols: number; frames: 1 | 2; walk?: boolean; swap?: Swap }>;

export type SheetId = keyof typeof SHEETS;

/** One tile of a sheet. */
export interface Sprite {
  sheet: SheetId;
  frame: number; // tile index: row * cols + col
}

const s = (sheet: SheetId, frame: number): Sprite => ({ sheet, frame });

/**
 * The file(s) of a sheet, relative to the site root: one per animation frame. A swapped sheet is its repainted copy (a
 * data: URL) once bakeSheets has made it, else the plain file it is made from.
 */
export const sheetFiles = (id: SheetId): string[] => {
  const { file, frames } = SHEETS[id];
  return frames === 2 ? [`${SPRITE_ROOT}${file}0.png`, `${SPRITE_ROOT}${file}1.png`] : [baked.get(id) ?? `${SPRITE_ROOT}${file}.png`];
};

// ---------------------------------------------------------------- palette swaps

const swapOf = (id: SheetId): Swap | undefined => (SHEETS[id] as { swap?: Swap }).swap;

const baked = new Map<SheetId, string>(); // swapped sheet -> its repainted PNG as a data: URL

/** The sheet with its `swap` applied, as a PNG data: URL. Only pixels that are exactly a swapped color change. */
function repaint(img: HTMLImageElement, swap: Swap): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height);
  const map = new Map<number, number>(); // 0xRRGGBB -> 0xRRGGBB
  for (const [from, to] of Object.entries(swap) as [ColorName, ColorName][]) map.set(COLORS[from], COLORS[to]);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const to = d[i + 3] === 255 ? map.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) : undefined;
    if (to === undefined) continue;
    d[i] = to >> 16;
    d[i + 1] = (to >> 8) & 255;
    d[i + 2] = to & 255;
  }
  g.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });

/**
 * Paints every swapped sheet once, as the page starts. HTML icons pick the result up by themselves (spriteHtml points at a
 * CSS variable, set here); the Phaser loader takes it as an ordinary file, so the game waits for `sheetsReady`. If a sheet
 * can't be painted it just keeps the colors of the sheet it is made from.
 */
async function bakeSheets(): Promise<void> {
  if (typeof document === 'undefined') return; // Node (the tests) has no canvas, and no art to show
  const ids = (Object.keys(SHEETS) as SheetId[]).filter((id) => swapOf(id));
  const images = new Map<string, Promise<HTMLImageElement | null>>(); // several swaps can share one source file
  await Promise.all(
    ids.map(async (id) => {
      const url = `${SPRITE_ROOT}${SHEETS[id].file}.png`;
      if (!images.has(url)) images.set(url, loadImage(url));
      const img = await images.get(url);
      if (!img) return;
      try {
        const data = repaint(img, swapOf(id)!);
        baked.set(id, data);
        document.documentElement.style.setProperty(`--sheet-${id}`, `url('${data}')`);
      } catch (err) {
        console.warn(`Couldn't repaint the art for ${id}: keeping the colors it is made from`, err);
      }
    }),
  );
}

export const sheetsReady: Promise<void> = bakeSheets();

/** The Phaser texture keys of a sheet, one per file: `undead:0`, `undead:1`, or just `warrior`. */
export const sheetKeys = (id: SheetId): string[] => (SHEETS[id].frames === 2 ? [`${id}:0`, `${id}:1`] : [id]);

// ---------------------------------------------------------------- graphics mode

let pixelArt = loadPref('graphics') !== 'classic'; // pixel art unless the player chose the emoji look
const modeListeners = new Set<() => void>();

export const spritesOn = (): boolean => pixelArt;

const missing = new Set<SheetId>(); // sheets that failed to load: whatever needs one is drawn with emoji

/** Called once the sheets have loaded, with the ones that didn't. */
export function markMissing(ids: Iterable<SheetId>) {
  for (const id of ids) missing.add(id);
}

/** Changes whenever the art mode or the set of loadable sheets does: part of the render keys of the HTML panels. */
export const artKey = (): number => (pixelArt ? 1 + missing.size : 0);

/** Switches between the pixel art and the classic emoji look (remembered), and tells whoever draws. */
export function setSpritesOn(on: boolean) {
  if (on === pixelArt) return;
  pixelArt = on;
  savePref('graphics', on ? 'sprites' : 'classic');
  for (const fn of modeListeners) fn();
}

export const toggleSprites = () => setSpritesOn(!pixelArt);

export function onGraphicsMode(fn: () => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

// ---------------------------------------------------------------- creatures

/** The heroes walk in 4 directions (rows: down, left, right, up; 4 frames each). */
export const CLASS_SPRITES: Record<ClassId, SheetId> = {
  fighter: 'warrior', barbarian: 'barbarian', // steel and red
  rogue: 'rogue', ranger: 'ranger', // a red hood, a green one
  wizard: 'mage', bard: 'bard', // a blue robe, a purple one
  paladin: 'paladin', cleric: 'cleric', // gold, white and pale blue
};
export const WALK_ROW = { down: 0, left: 1, right: 2, up: 3 } as const;

/** Monsters and NPC allies, by their MONSTERS key (shared/rules.ts). */
export const MONSTER_SPRITES: Record<string, Sprite> = {
  // Act 1: Goblin Warrens
  rat: s('rodent', 9),
  bat: s('avian', 88),
  kobold: s('player', 112),
  goblin: s('misc', 8),
  archer: s('misc', 10),
  firebomber: s('misc', 11),
  shaman: s('player', 113),
  hobgoblin: s('player', 97),
  goblin_king: s('humanoid', 154),
  mimic: s('elemental', 64),
  // Act 2: Forgotten Crypt
  skeleton: s('undead', 16),
  zombie: s('undead', 2),
  bloated: s('undead', 6),
  wolf: s('dog', 8),
  spider: s('pest', 33),
  necromancer: s('undead', 26),
  wight: s('undead', 42),
  broodmother: s('pest', 21),
  bone_knight: s('undead', 17),
  // Act 3: Dragon's Lair
  orc: s('player', 96),
  cultist: s('humanoid', 19),
  imp: s('demon', 26),
  gargoyle: s('avian', 96),
  ogre: s('misc', 25),
  priest: s('player', 64),
  warchief: s('player', 102),
  drake: s('reptile', 1),
  wyrm: s('reptile', 24),
  // NPC allies
  sellsword: s('player', 29),
  acolyte: s('player', 33),
  ranger: s('player', 26),
  war_hound: s('dog', 1),
};

/**
 * DragonDePlatino asks every game using DawnLike to hide his "Platino" sprite somewhere. Ours: now and then a Giant Rat
 * isn't a rat at all (see platinoFor).
 */
export const PLATINO: Sprite = s('reptile', 99);
export const PLATINO_ODDS = 150; // about one Giant Rat in this many

/** Is this Giant Rat secretly Platino? Decided by its entity id, so every client agrees and it doesn't flicker. */
export function platinoFor(type: string, entityId: string): boolean {
  if (type !== 'rat') return false;
  let h = 7;
  for (const ch of entityId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % PLATINO_ODDS === 0;
}

// ---------------------------------------------------------------- the room

/**
 * DawnLike walls are connecting line-art pieces in 7x3 blocks (one block per material). The piece for a wall tile
 * depends on which of its 4 neighbours are walls too: bit 1 = north, 2 = east, 4 = south, 8 = west. A wall with no
 * wall neighbours is a lone pillar; dead ends use the straight piece.
 */
const PIECE: Record<number, [number, number]> = {
  0: [3, 0], // lone pillar
  1: [0, 1], 4: [0, 1], 5: [0, 1], // vertical
  2: [1, 0], 8: [1, 0], 10: [1, 0], // horizontal
  6: [0, 0], // ┌
  12: [2, 0], // ┐
  3: [0, 2], // └
  9: [2, 2], // ┘
  14: [4, 0], // ┬
  7: [3, 1], // ├
  13: [5, 1], // ┤
  11: [4, 2], // ┴
  15: [4, 1], // ┼
};

/** Each act's look: the wall material (top-left of its 7x3 block in Wall.png), the floor tile, and floor decorations. */
export const ACT_TILES: Record<number, { wall: { x: number; y: number }; floor: number; decor: Sprite[] }> = {
  1: { wall: { x: 0, y: 21 }, floor: 162, decor: [s('decor', 98), s('decor', 21)] }, // earthy stone, cobbles; a skull, vines
  2: { wall: { x: 0, y: 6 }, floor: 211, decor: [s('decor', 96), s('decor', 98), s('decor', 152)] }, // grey brick; skulls, cobwebs
  3: { wall: { x: 14, y: 18 }, floor: 225, decor: [s('decor', 96), s('decor', 98)] }, // red stone and cobbles; skulls
};

/** The Wall.png tile for a wall in this act, from its neighbour mask (see PIECE). */
export function wallFrame(act: number, mask: number): number {
  const set = (ACT_TILES[act] ?? ACT_TILES[1]).wall;
  const [cx, cy] = PIECE[mask & 15] ?? PIECE[0];
  return (set.y + cy) * SHEETS.wall.cols + set.x + cx;
}

export const floorFrame = (act: number): number => (ACT_TILES[act] ?? ACT_TILES[1]).floor;

/** About this share of floor tiles get a decoration (deterministic per tile, so it doesn't change on redraw). */
export const DECOR_SHARE = 0.04;

export const PROP_SPRITES: Record<PropId, Sprite> = {
  barrel: s('decor', 76),
  brazier: s('decor', 67),
};

/** Low cover (shared/grid.ts LOW_COVER) is a crate or a heap of rubble, picked per tile: the sprite, and the emoji for the classic look. */
export const COVER_LOOKS: { sprite: Sprite; emoji: string }[] = [
  { sprite: s('decor', 75), emoji: '📦' },
  { sprite: s('rock', 10), emoji: '🪨' },
  { sprite: s('rock', 11), emoji: '🪨' },
];

/** A flame drawn on burning tiles, on top of the procedural fire pool. */
export const FLAME: Sprite = s('effect', 169);

// ---------------------------------------------------------------- items and the map

export const ITEM_SPRITES: Partial<Record<ItemId | 'potion', Sprite>> = {
  // weapons
  fine_blade: s('medwep', 0),
  heavy_maul: s('longwep', 32),
  venom_edge: s('medwep', 1),
  arcane_focus: s('tool', 1),
  holy_symbol: s('amulet', 1),
  flametongue: s('medwep', 2),
  frostbrand: s('medwep', 4),
  stormcaller: s('wand', 2),
  // armor
  padded_vest: s('armor', 1),
  chain_shirt: s('armor', 5),
  plate_armor: s('armor', 52),
  elven_cloak: s('armor', 58),
  dragonscale: s('armor', 3),
  archmage_robe: s('armor', 59),
  // trinkets
  protection_ring: s('ring', 1),
  health_amulet: s('amulet', 2),
  speed_boots: s('boot', 9),
  vigilant_eye: s('amulet', 6),
  ogre_gauntlets: s('glove', 2),
  lucky_charm: s('amulet', 5),
  antidote_charm: s('amulet', 12),
  ember_ring: s('ring', 16),
  // consumables
  potion: s('potion', 0),
  greater_potion: s('potion', 33),
  ether: s('potion', 7),
  oil_flask: s('potion', 20),
  water_flask: s('potion', 21),
  fire_bomb: s('potion', 19),
  frost_bomb: s('potion', 17),
  thunderstone: s('rock', 1),
  smoke_pellet: s('potion', 18),
  stink_bomb: s('potion', 4),
  scroll_healing: s('scroll', 2),
  scroll_blessing: s('scroll', 4),
};

export const NODE_SPRITES: Record<NodeType, Sprite> = {
  combat: s('medwep', 0),
  elite: s('decor', 96),
  event: s('elemental', 66),
  rest: s('effect', 169),
  treasure: s('chest', 0),
  shop: s('money', 9),
  boss: s('hat', 26),
};

/**
 * An item or map icon as HTML: a <span> showing one tile of a sheet, scaled up crisply. `px` is the drawn size.
 * Returns '' when there's no sprite, so callers can fall back to the emoji.
 */
export function spriteHtml(sp: Sprite | undefined, px = 32, title = ''): string {
  if (!sp || missing.has(sp.sheet)) return '';
  const sheet = SHEETS[sp.sheet];
  const k = px / SPRITE_PX;
  const col = sp.frame % sheet.cols;
  const row = Math.floor(sp.frame / sheet.cols);
  // A swapped sheet reads its repainted copy from a CSS variable (see bakeSheets), so icons drawn before it was ready change by themselves.
  const url = swapOf(sp.sheet) ? `var(--sheet-${sp.sheet},url('${SPRITE_ROOT}${sheet.file}.png'))` : `url('${sheetFiles(sp.sheet)[0]}')`;
  return `<span class="sprite" style="width:${px}px;height:${px}px;background-image:${url};background-position:-${col * px}px -${row * px}px;background-size:${sheet.cols * SPRITE_PX * k}px auto"${title ? ` title="${title}"` : ''}></span>`;
}

/** An icon as HTML: the sprite while pixel art is on, else (or when it has none) the emoji. */
export const iconHtml = (sp: Sprite | undefined, emoji: string, px = 32, title = ''): string => (pixelArt && spriteHtml(sp, px, title)) || emoji;

/** A class's icon as HTML: its hero standing facing you, in its colors, while pixel art is on, else the class glyph. */
export const classIcon = (id: ClassId, px = 32, title = ''): string => iconHtml({ sheet: CLASS_SPRITES[id], frame: 0 }, CLASSES[id].glyph, px, title);
