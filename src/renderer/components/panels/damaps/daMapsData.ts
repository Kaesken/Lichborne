// Da'Maps — data layer.
//
// Da'Maps draws Lich's own map database (map-*.json) in the Genie-map style,
// with NO Genie data at all:
//   - room identity, travel and "you are here" = Lich room ids (+ `;go2`)
//   - room positions = Lich's hand-placed `image_coords` on each area tile
//     (the same coordinates the Lich Map view uses to put its marker on the
//     PNG), so there is no auto-layout (the LichGraphView lesson, DESIGN §19.15)
//   - room categories / forage / hunting = Lich `tags`
//   - indoor vs outdoor = "Obvious exits" (indoor) vs "Obvious paths" (outdoor)
//
// It also keeps a small local store of what players OBSERVE in a room: PERCEIVE
// mana readings and successful forages, captured from the game text by
// `daMapsObserveLine` / `daMapsObserveCommand` (called from GameWindow).

import { segHitsBox, PITCH } from './daMapsLayout'
import type { LichRoom } from '../mapTypes'
import { lichTitle } from '../mapTypes'
import { scopedKey } from '../../../characterScope'

/** The display name, kept in one place so it is easy to rename later. */
export const DA_MAPS_NAME = "Da'Maps"

// ── Arc categories (same three as the Genie view, so the theme vars line up) ──

export type DaArcCategory = 'cardinal' | 'climb' | 'go'

const COMPASS: Record<string, [number, number]> = {
  n: [0, -1], north: [0, -1], s: [0, 1], south: [0, 1], e: [1, 0], east: [1, 0], w: [-1, 0], west: [-1, 0],
  ne: [1, -1], northeast: [1, -1], nw: [-1, -1], northwest: [-1, -1],
  se: [1, 1], southeast: [1, 1], sw: [-1, 1], southwest: [-1, 1],
}
const CARDINALS = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest',
])

export function classifyMove(move: string): DaArcCategory {
  const m = move.trim().toLowerCase()
  if (CARDINALS.has(m)) return 'cardinal'
  if (/^climb\b/.test(m)) return 'climb'
  return 'go'   // go/up/down/out/swim/StringProc (;e …) — anything non-cardinal
}

export const DA_ARC_COLOR: Record<DaArcCategory, string> = {
  cardinal: 'var(--map-arc-cardinal, #888)',
  climb:    'var(--map-arc-vertical, #d4a574)',
  go:       'var(--map-arc-special, #ffb74d)',
}

// ── Room categories from Lich tags (colours match COLOR_LEGEND hexes) ─────────

export interface DaCategory { color: string; name: string; desc: string }

export const DA_CATEGORIES: Record<string, DaCategory> = {
  transport: { color: '#FF00FF', name: 'Fuchsia',    desc: 'Transport (portal, etc.)' },
  healer:    { color: '#00BF80', name: 'Mint',       desc: 'Healer' },
  guild:     { color: '#FF8000', name: 'Orange',     desc: 'Guild' },
  stat:      { color: '#FFFF00', name: 'Yellow',     desc: 'Stat training' },
  shop:      { color: '#FF0000', name: 'Red',        desc: 'Shop' },
  service:   { color: '#00FF00', name: 'Lime',       desc: 'Interesting room (bank, vault, etc.)' },
  water:     { color: '#0000FF', name: 'Blue',       desc: 'Water (swimming)' },
  shrine:    { color: '#A6A3D9', name: 'Periwinkle', desc: 'Shrine' },
}

const TAG_CATEGORY: Record<string, string> = {
  portal: 'transport', nexus: 'transport', ferry: 'transport',
  npchealer: 'healer',
  empath: 'guild', cleric: 'guild', bard: 'guild', paladin: 'guild', moonmage: 'guild',
  trader: 'guild', ranger: 'guild', thief: 'guild', barbarian: 'guild', necromancer: 'guild',
  warriormage: 'guild', 'warrior mage': 'guild', commoner: 'guild',
  stamina: 'stat', wisdom: 'stat', intelligence: 'stat', charisma: 'stat', agility: 'stat',
  strength: 'stat', discipline: 'stat', reflex: 'stat',
  gemshop: 'shop', 'gem shop': 'shop', weaponshop: 'shop', armorshop: 'shop', pawnshop: 'shop',
  pawn: 'shop', furrier: 'shop', tannery: 'shop', 'general store': 'shop', shop: 'shop',
  locksmith: 'shop', herbalist: 'shop', grocer: 'shop',
  bank: 'service', exchange: 'service', vault: 'service', debt: 'service', jail: 'service',
  registration: 'service', mail: 'service', stable: 'service', stables: 'service',
  caravan_stable: 'service', repair: 'service', forging: 'service', outfitting: 'service',
  engineering: 'service', alchemy: 'service', origami: 'service', trashbin: 'service',
  shrine: 'shrine',
}

// Tags that are neither forage items nor hunting areas.
const NON_FORAGE = new Set([
  ...Object.keys(TAG_CATEGORY), 'town', 'carousel', 'lich-map-no-uid-room', 'intercessor',
  'wisdom', 'stable', 'debt',
])

// Order is a guild's priority when it has several (healer beats shop, etc.).
const CATEGORY_PRIORITY = ['transport', 'healer', 'guild', 'stat', 'shop', 'service', 'shrine', 'water']

// ── Mana ───────────────────────────────────────────────────────────────────────

export type Realm = 'Life' | 'Holy' | 'Elemental' | 'Arcane' | 'Lunar'
/** Realms whose mana depends on the ROOM. Lunar does not (it follows the sky). */
export const ROOM_REALMS: Realm[] = ['Life', 'Holy', 'Elemental', 'Arcane']

/** PERCEIVE mana words, weakest → strongest (Elanthipedia "Mana", >75 attunement column). */
export const MANA_WORDS = [
  'faint', 'dim', 'hazy', 'dull', 'muted', 'dusky', 'pale', 'flickering', 'shimmering',
  'pulsating', 'glowing', 'lambent', 'shining', 'luminous', 'radiant', 'fulgent',
  'brilliant', 'flaring', 'glaring', 'blazing', 'blinding',
]

export function guildRealm(guild: string | null | undefined): Realm | null {
  const g = (guild ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (!g) return null
  if (g.includes('empath') || g.includes('ranger')) return 'Life'
  if (g.includes('cleric') || g.includes('paladin')) return 'Holy'
  if (g.includes('warriormage') || g === 'wm' || g.includes('bard')) return 'Elemental'
  if (g.includes('necromancer') || g === 'necro') return 'Arcane'
  if (g.includes('moonmage') || g === 'mm' || g.includes('trader')) return 'Lunar'
  return null
}

// ── Area model ────────────────────────────────────────────────────────────────

export interface DaRoom {
  id:       number           // unique within the area (the Lich id when it has one)
  lich:     number | null    // the Lich room behind this square (null = not matched)
  fill?:    string           // colour set by the map maker (Genie maps)
  stubTo?:  string           // area key this square stands in for (Genie boundary marker)
  x:        number           // centre, in the area tile's pixel space
  y:        number
  size:     number           // drawn square size
  title:    string
  indoor:   boolean
  category: string | null    // key into DA_CATEGORIES
  forage:   string[]         // from Lich tags
  hunting:  string[]         // from Lich tags (creature/hunting-area tags)
  services: string[]         // the category-ish tags, for the details panel
  exits:    string[]         // wayto commands, as Lich lists them
  crossTo:  string[]         // other area tiles this room leads to
  label:    string           // place name drawn beside the room ('' = none)
  lx:       number           // where the label goes (text start, baseline)
  ly:       number
  building: number | null    // index into DaArea.buildings (indoor rooms only)
  location: string
}

export interface DaArc { a: number; b: number; cat: DaArcCategory }

export interface DaBuilding {
  name:  string
  rooms: number[]
  x1: number; y1: number; x2: number; y2: number
  outline: boolean   // false when a dotted box would overlap other rooms or boxes
  lx: number; ly: number; showLabel: boolean
}

export interface DaArea {
  image:     string
  name:      string
  rooms:     DaRoom[]
  byId:      Map<number, DaRoom>
  arcs:      DaArc[]
  buildings: DaBuilding[]
  bbox:      { x1: number; y1: number; x2: number; y2: number }
  /** the square for a Lich room id */
  byLich:    Map<number, DaRoom>
  /** free-standing place names drawn by the map maker (Genie maps) */
  texts?:    { text: string; x: number; y: number }[]
}

/** "zoluren-1-crossing-1377284934.png" → "Zoluren 1 Crossing". */
export function areaDisplayName(image: string): string {
  if (image.startsWith('~')) return `${image.slice(1)} (unmapped)`
  let s = image.replace(/\.(png|gif|jpe?g)$/i, '')
  s = s.replace(/[-_ ]\d{9,}$/, '')            // trailing upload timestamps
  s = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.replace(/\b([a-z])/g, c => c.toUpperCase())
}

// ── Provinces (for the Global view) ─────────────────────────────────────────

export const PROVINCE_ORDER = ['Zoluren', 'Therengia', 'Ilithi', 'Forfedhdar', "Qi'Reshalia", 'Taisidon', 'Other']

const PROVINCE_BY_PREFIX: Record<string, string> = {
  zoluren: 'Zoluren', therengia: 'Therengia', forfedhdar: 'Forfedhdar',
  ilithi: 'Ilithi', ilitha: 'Ilithi', ilithia: 'Ilithi', illithi: 'Ilithi',
  qi: "Qi'Reshalia", taisidon: 'Taisidon',
}

/** Which province an area belongs to: the tile name's prefix, else its rooms' location. */
export function areaProvince(image: string, rooms: LichRoom[]): string {
  const prefix = image.split(/[,\-_ ]/)[0].trim().toLowerCase()
  if (PROVINCE_BY_PREFIX[prefix]) return PROVINCE_BY_PREFIX[prefix]
  const counts = new Map<string, number>()
  for (const r of rooms) {
    const l = (r.location ?? '').trim()
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  for (const [loc] of [...counts].sort((x, y) => y[1] - x[1])) {
    const hit = PROVINCE_ORDER.find(p => p.toLowerCase() === loc.toLowerCase())
    if (hit) return hit
  }
  return 'Other'
}

export function buildingName(title: string): string {
  const i = title.indexOf(',')
  return (i > 0 ? title.slice(0, i) : title).trim()
}

export function isIndoor(r: LichRoom): boolean {
  const p = (r.paths ?? [])[0] ?? ''
  return /^Obvious exits/i.test(p)
}

export function splitTags(tags: string[] | undefined): { forage: string[]; hunting: string[]; services: string[]; category: string | null } {
  const forage: string[] = [], hunting: string[] = [], services: string[] = []
  let best: string | null = null
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue   // the map DB has a few null tags
    const t = raw.trim()
    if (!t || t.startsWith('meta:')) continue
    const key = t.toLowerCase()
    const cat = TAG_CATEGORY[key]
    if (cat) {
      services.push(t)
      if (best === null || CATEGORY_PRIORITY.indexOf(cat) < CATEGORY_PRIORITY.indexOf(best)) best = cat
      continue
    }
    if (NON_FORAGE.has(key)) continue
    // Hunting-area tags are snake_case ids ("pale_grey_death_squirrels").
    if (key.includes('_')) { hunting.push(t.replace(/_/g, ' ').replace(/\d+$/, '').trim()); continue }
    forage.push(t)
  }
  return { forage, hunting: [...new Set(hunting)], services, category: best }
}

/**
 * Build one area (one Lich tile) for drawing. Pure; cache the result per
 * (database, image). `lichDb` resolves exits that leave the area.
 */
export function buildArea(
  image: string, rooms: LichRoom[], lichDb: Map<number, LichRoom>,
  layout?: { pos: Map<number, [number, number]>; size: Map<number, number>; areaOf: Map<number, string> },
): DaArea {
  const placed: DaRoom[] = []
  const byId = new Map<number, DaRoom>()

  for (const r of rooms) {
    let cx: number, cy: number, size: number
    const lp = layout?.pos.get(r.id)
    if (layout) {
      if (!lp) continue
      ;[cx, cy] = lp
      size = layout.size.get(r.id) ?? 11
    } else {
      const c = r.image_coords
      if (!c || c.length < 4) continue
      const [x1, y1, x2, y2] = c
      const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1)
      cx = (x1 + x2) / 2; cy = (y1 + y2) / 2
      // Lich tiles draw ~16px rooms; 70% of that leaves the Genie-style gaps.
      size = Math.max(6, Math.min(24, Math.min(w || 12, h || 12) * 0.7))
    }
    const { forage, hunting, services, category } = splitTags(r.tags)
    // A few wayto values in the map DB are null (scripted moves Lich couldn't
    // serialize); keep only real command strings.
    const exits = Object.values(r.wayto ?? {}).filter((m): m is string => typeof m === 'string')
    const swim = exits.some(m => /^swim\b/i.test(m))
    const crossTo = new Set<string>()
    const crossNames: string[] = []
    for (const k of Object.keys(r.wayto ?? {})) {
      const t = lichDb.get(Number(k))
      const tArea = t ? (layout ? layout.areaOf.get(t.id) : (t.image_coords ? t.image : undefined)) : undefined
      if (t && tArea && tArea !== image) {
        crossTo.add(tArea)
        crossNames.push(buildingName(lichTitle(t)))
      }
    }
    const room: DaRoom = {
      id: r.id, lich: r.id,
      x: cx, y: cy, size,
      lx: 0, ly: 0,
      title: lichTitle(r),
      indoor: isIndoor(r),
      category: category ?? (swim ? 'water' : null),
      forage, hunting, services,
      exits,
      crossTo: [...crossTo],
      label: crossNames[0] ?? '',
      building: null,
      location: r.location ?? '',
    }
    placed.push(room)
    byId.set(room.id, room)
  }

  // Labels: a room that leads into another area is named after where it leads
  // ("Emmiline's Cottage", "Empath Guild") — the same kind of landmark text the
  // Genie maps draw. A room in a named building/shop gets that name. Names that
  // are just this area's street prefix ("The Crossing") are dropped, and so are
  // repeats of the same name close together.
  const prefixCount = new Map<string, number>()
  for (const room of placed) {
    const n = buildingName(room.title)
    prefixCount.set(n, (prefixCount.get(n) ?? 0) + 1)
  }
  const streetPrefix = [...prefixCount.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? ''
  const kept: DaRoom[] = []
  for (const room of placed) {
    let name = room.label
    if (!name && room.category && !room.indoor) name = buildingName(room.title)
    if (!name || name === streetPrefix || name === buildingName(room.title) && room.crossTo.length === 0 && !room.category) {
      room.label = ''
      continue
    }
    const near = kept.some(k => k.label === name && Math.hypot(k.x - room.x, k.y - room.y) < (layout ? 200 : 80))
    room.label = near ? '' : name
    if (room.label) kept.push(room)
  }

  // Arcs inside the area, de-duplicated. Very long lines are skipped (portal /
  // "go" exits whose far end sits across the tile) — they're walkable but would
  // just draw a line across the map, the same reason Genie hides such arcs.
  const MAX_ARC = layout ? 650 : 260
  const seen = new Set<string>()
  const arcs: DaArc[] = []
  for (const r of rooms) {
    const a = byId.get(r.id)
    if (!a) continue
    for (const [k, move] of Object.entries(r.wayto ?? {})) {
      const b = byId.get(Number(k))
      if (!b || b.id === a.id) continue
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (Math.hypot(a.x - b.x, a.y - b.y) > MAX_ARC) continue
      arcs.push({ a: a.id, b: b.id, cat: classifyMove(typeof move === 'string' ? move : '') })
    }
  }

  // Buildings: connected indoor rooms that share a name ("Half Pint, Bar" +
  // "Half Pint, Kitchen"), drawn as a dotted outline. Requiring the same name
  // stops one long chain of indoor rooms (sewers, guild tunnels) from being
  // boxed together across half the town.
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let p = parent.get(x) ?? x
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p
    parent.set(x, p)
    return p
  }
  for (const room of placed) if (room.indoor) parent.set(room.id, room.id)
  for (const r of rooms) {
    if (!parent.has(r.id)) continue
    const nm = buildingName(lichTitle(r))
    for (const k of Object.keys(r.wayto ?? {})) {
      const t = Number(k)
      if (!parent.has(t)) continue
      const tr = lichDb.get(t)
      if (!tr || buildingName(lichTitle(tr)) !== nm) continue
      const ra = find(r.id), rb = find(t)
      if (ra !== rb) parent.set(ra, rb)
    }
  }
  const groups = new Map<number, DaRoom[]>()
  for (const room of placed) {
    if (!room.indoor) continue
    const g = find(room.id)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(room)
  }
  const buildings: DaBuilding[] = []
  for (const members of groups.values()) {
    const names = new Map<string, number>()
    for (const m of members) {
      const n = buildingName(m.title)
      names.set(n, (names.get(n) ?? 0) + 1)
    }
    const name = [...names.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? ''
    const pad = 4
    const b: DaBuilding = {
      name, outline: true, lx: 0, ly: 0, showLabel: false,
      rooms: members.map(m => m.id),
      x1: Math.min(...members.map(m => m.x - m.size / 2)) - pad,
      y1: Math.min(...members.map(m => m.y - m.size / 2)) - pad,
      x2: Math.max(...members.map(m => m.x + m.size / 2)) + pad,
      y2: Math.max(...members.map(m => m.y + m.size / 2)) + pad,
    }
    // One-room shops are just a square (like Genie); an outline that would
    // span a big part of the map means the rooms aren't really one building.
    if (members.length < 2) continue
    const idx = buildings.push(b) - 1
    for (const m of members) m.building = idx
  }

  // Nothing may overlap: a line that would run through a room it doesn't
  // connect is left out (the exit still works for go2), then outlines and
  // labels are fitted around what's left.
  // A long line that isn't a straight compass exit (a door into a building
  // set down a few cells away, a loop the Lich data draws out of true) would
  // cut across the town, so only short ones are drawn.
  const tidyArcs = layout ? arcs.filter(arc => {
    const p = byId.get(arc.a)!, q = byId.get(arc.b)!
    const len = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) / PITCH
    if (len <= 4) return true
    const move = lichDb.get(p.id)?.wayto?.[String(q.id)]
    const back = lichDb.get(q.id)?.wayto?.[String(p.id)]
    const straight = (m: unknown, from: DaRoom, to: DaRoom) => {
      const d = typeof m === 'string' ? COMPASS[m.trim().toLowerCase()] : undefined
      if (!d) return false
      const dx = to.x - from.x, dy = to.y - from.y
      return Math.abs(dx * d[1] - dy * d[0]) < 0.5 && dx * d[0] + dy * d[1] > 0
    }
    return straight(move, p, q) || straight(back, q, p)
  }) : arcs
  const visibleArcs = dropArcsThroughRooms(tidyArcs, placed, byId)
  placeLabelsAndOutlines(placed, buildings, visibleArcs, byId)

  const bbox = placed.length
    ? {
        x1: Math.min(...placed.map(r => r.x)), y1: Math.min(...placed.map(r => r.y)),
        x2: Math.max(...placed.map(r => r.x)), y2: Math.max(...placed.map(r => r.y)),
      }
    : { x1: 0, y1: 0, x2: 100, y2: 100 }

  return { image, name: areaDisplayName(image), rooms: placed, byId, byLich: byId, arcs: visibleArcs, buildings, bbox }
}

// ── Observations: mana + forage seen by players (local store) ─────────────────

export interface ManaReading { word: string; rank: number; text: string; at: number }
export interface ForageFind  { n: number; at: number }
export interface DaObservations {
  mana:   Record<string, Partial<Record<Realm, ManaReading>>>   // by Lich room id
  forage: Record<string, Record<string, ForageFind>>            // by Lich room id → item
}

const OBS_KEY = 'lichborne.damaps.observations.v1'
export const DA_OBS_EVENT = 'lichborne:damaps-observed'

let obsCache: DaObservations | null = null

export function loadObservations(): DaObservations {
  if (obsCache) return obsCache
  try {
    const raw = localStorage.getItem(OBS_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    obsCache = {
      mana:   parsed?.mana   && typeof parsed.mana   === 'object' ? parsed.mana   : {},
      forage: parsed?.forage && typeof parsed.forage === 'object' ? parsed.forage : {},
    }
  } catch {
    obsCache = { mana: {}, forage: {} }
  }
  return obsCache!
}

function saveObservations(o: DaObservations): void {
  obsCache = o
  try { localStorage.setItem(OBS_KEY, JSON.stringify(o)) } catch { /* quota — keep in memory */ }
  try { document.dispatchEvent(new CustomEvent(DA_OBS_EVENT)) } catch { /* no DOM */ }
}

export function recordMana(roomId: number, realm: Realm, word: string, text: string): void {
  const o = loadObservations()
  const rank = MANA_WORDS.indexOf(word.toLowerCase())
  const room = { ...(o.mana[roomId] ?? {}) }
  room[realm] = { word: word.toLowerCase(), rank, text, at: Date.now() }
  saveObservations({ ...o, mana: { ...o.mana, [roomId]: room } })
}

export function recordForage(roomId: number, item: string): void {
  const o = loadObservations()
  const key = item.trim().toLowerCase()
  if (!key) return
  const room = { ...(o.forage[roomId] ?? {}) }
  room[key] = { n: (room[key]?.n ?? 0) + 1, at: Date.now() }
  saveObservations({ ...o, forage: { ...o.forage, [roomId]: room } })
}

// ── Capture from the game stream ──────────────────────────────────────────────
//
// GameWindow calls `daMapsObserveCommand` for every command it sends and
// `daMapsObserveLine` for every main-stream line. Both are cheap no-ops unless
// the player recently sent PERCEIVE or FORAGE. The room the reading belongs to
// is the one the map last resolved (`daMapsSetRoom`, fed by MapPanel).
//
// NOTE: the exact game wording below is a first guess, built from the
// Elanthipedia mana-word table. Verify against real PERCEIVE / FORAGE output
// and adjust MANA_LINE_RE / FORAGE_FIND_RE if needed.

const currentRoomByChar = new Map<string, number>()
const pendingPerceive   = new Map<string, number>()
const pendingForage     = new Map<string, { at: number; item: string }>()
const WINDOW_MS = 10_000

export function daMapsSetRoom(character: string, roomId: number | undefined): void {
  if (roomId === undefined) currentRoomByChar.delete(character)
  else currentRoomByChar.set(character, roomId)
}

export function daMapsObserveCommand(character: string, cmd: string): void {
  const c = cmd.trim().toLowerCase()
  if (/^perc(?:eive|eiv|ei|e)?(?:\s+mana)?$/.test(c)) pendingPerceive.set(character, Date.now())
  const f = /^forag(?:e|)\b\s*(.*)$/.exec(c)
  if (f) pendingForage.set(character, { at: Date.now(), item: f[1].trim() })
}

const MANA_WORD_RE  = new RegExp(`\\b(${MANA_WORDS.join('|')})\\b`, 'i')
const REALM_RE      = /\b(life|holy|elemental|arcane|lunar)\b/i
const FORAGE_FIND_RE = /\b(?:find|found|manage to find|come up with|gather)\s+(?:a|an|some|several)\s+([a-z][a-z' -]{1,40}?)(?=[.!,]|\s+(?:and|which|that|among|in|from)\b)/i
const FORAGE_FAIL_RE = /\b(?:unable to find|fail to find|find nothing|don't find|do not find)\b/i

function realmFromGuild(character: string): Realm | null {
  try {
    return guildRealm(localStorage.getItem(scopedKey(character, 'detectedGuild')))
  } catch { return null }
}

export function daMapsObserveLine(character: string, line: string): void {
  const now = Date.now()

  const p = pendingPerceive.get(character)
  if (p !== undefined) {
    if (now - p > WINDOW_MS) pendingPerceive.delete(character)
    else if (/mana/i.test(line)) {
      const room = currentRoomByChar.get(character)
      const w = MANA_WORD_RE.exec(line)
      const realm = (REALM_RE.exec(line)?.[1] as string | undefined)
      const r = realm ? (realm[0].toUpperCase() + realm.slice(1).toLowerCase()) as Realm : realmFromGuild(character)
      if (room !== undefined && w && r && r !== 'Lunar') recordMana(room, r, w[1], line.trim())
    }
  }

  const f = pendingForage.get(character)
  if (f !== undefined) {
    if (now - f.at > WINDOW_MS) { pendingForage.delete(character); return }
    if (FORAGE_FAIL_RE.test(line)) { pendingForage.delete(character); return }
    const m = FORAGE_FIND_RE.exec(line)
    if (m) {
      const room = currentRoomByChar.get(character)
      if (room !== undefined) recordForage(room, m[1])
      pendingForage.delete(character)
    }
  }
}

// ── No-overlap pass: building outlines and labels ────────────────────────────

export const LABEL_FONT = 9
/** labels are drawn exactly this wide per character (SVG textLength), so their
 * boxes here match the screen at any zoom */
export const CHAR_W = LABEL_FONT * 0.6
type Box = [number, number, number, number]   // x1, y1, x2, y2

function boxesHit(a: Box, b: Box, pad = 0): boolean {
  return a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad
}

/** Grid of boxes for overlap tests. */
class BoxGrid {
  private cells = new Map<string, Box[]>()
  constructor(private cell = 40) {}
  private keys(b: Box): string[] {
    const out: string[] = []
    for (let x = Math.floor(b[0] / this.cell); x <= Math.floor(b[2] / this.cell); x++)
      for (let y = Math.floor(b[1] / this.cell); y <= Math.floor(b[3] / this.cell); y++) out.push(x + ',' + y)
    return out
  }
  add(b: Box) { for (const k of this.keys(b)) { if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k)!.push(b) } }
  /** every stored box whose cells overlap `b` (may repeat) */
  within(b: Box): Box[] {
    const out = new Set<Box>()
    for (const k of this.keys(b)) for (const o of this.cells.get(k) ?? []) out.add(o)
    return [...out]
  }
  hits(b: Box, pad = 0): boolean {
    for (const k of this.keys(b)) for (const o of this.cells.get(k) ?? []) if (boxesHit(b, o, pad)) return true
    return false
  }
}

/**
 * Nothing on the map may overlap. A building's dotted outline is only drawn
 * when it wraps no other room and touches no other outline; each label goes
 * in the first spot around its room/building that's clear of every room
 * square and every other label, or isn't drawn.
 */
function dropArcsThroughRooms(arcs: DaArc[], rooms: DaRoom[], byId: Map<number, DaRoom>): DaArc[] {
  const grid = new BoxGrid()
  const boxes = new Map<Box, DaRoom>()
  for (const r of rooms) {
    const b: Box = [r.x - r.size / 2, r.y - r.size / 2, r.x + r.size / 2, r.y + r.size / 2]
    grid.add(b); boxes.set(b, r)
  }
  return arcs.filter(arc => {
    const p = byId.get(arc.a)!, q = byId.get(arc.b)!
    const seg: [number, number, number, number] = [p.x, p.y, q.x, q.y]
    for (const b of grid.within([Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)])) {
      const r = boxes.get(b)!
      if (r.id === p.id || r.id === q.id) continue
      if (segHitsBox(seg, r.x, r.y, r.size / 2)) return false
    }
    return true
  })
}

export function placeLabelsAndOutlines(rooms: DaRoom[], buildings: DaBuilding[], arcs: DaArc[], byId: Map<number, DaRoom>, opts: { labels: boolean } = { labels: true }) {
  const roomGrid = new BoxGrid()
  const roomBox = (r: DaRoom): Box => [r.x - r.size / 2, r.y - r.size / 2, r.x + r.size / 2, r.y + r.size / 2]
  for (const r of rooms) roomGrid.add(roomBox(r))

  // Outlines, smallest first so a small building wins over a sprawling one.
  const outlineGrid = new BoxGrid(80)
  const order = buildings.map((_, i) => i).sort((a, b) => {
    const A = buildings[a], B = buildings[b]
    return (A.x2 - A.x1) * (A.y2 - A.y1) - (B.x2 - B.x1) * (B.y2 - B.y1)
  })
  const members = new Map<number, Set<number>>()
  buildings.forEach((b, i) => members.set(i, new Set(b.rooms)))
  for (const i of order) {
    const b = buildings[i]
    const box: Box = [b.x1, b.y1, b.x2, b.y2]
    const mine = members.get(i)!
    const foreign = rooms.some(r => !mine.has(r.id) && boxesHit(roomBox(r), box, 1))
    b.outline = !foreign && !outlineGrid.hits(box, 2)
    if (b.outline) outlineGrid.add(box)
  }

  const labelGrid = new BoxGrid()
  // Lines, as boxes along their length, so labels can be kept off them.
  const lineSegs: [number, number, number, number][] = arcs.map(a => {
    const p = byId.get(a.a)!, q = byId.get(a.b)!
    return [p.x, p.y, q.x, q.y]
  })
  const lineGrid = new BoxGrid()
  const segOf = new Map<Box, [number, number, number, number]>()
  for (const sg of lineSegs) {
    const b: Box = [Math.min(sg[0], sg[2]), Math.min(sg[1], sg[3]), Math.max(sg[0], sg[2]), Math.max(sg[1], sg[3])]
    lineGrid.add(b); segOf.set(b, sg)
  }
  const onLine = (box: Box) => lineGrid.within(box).some(b => segHitsRect(segOf.get(b)!, box))
  const outlineBoxes: Box[] = buildings.filter(b => b.outline).map(b => [b.x1, b.y1, b.x2, b.y2])
  const onOutline = (box: Box) => outlineBoxes.some(o => boxesHit(box, o) && !(box[0] > o[0] && box[2] < o[2] && box[1] > o[1] && box[3] < o[3]))
  const fits = (box: Box) => !roomGrid.hits(box, 1.5) && !labelGrid.hits(box, 2) && !onLine(box) && !onOutline(box)
  const tryPlace = (text: string, spots: [number, number][]): [number, number] | null => {
    const w = text.length * CHAR_W, h = LABEL_FONT
    for (const [x, y] of spots) {
      const box: Box = [x, y - h + 1, x + w, y + 2]
      if (fits(box)) { labelGrid.add(box); return [x, y] }
    }
    return null
  }

  if (!opts.labels) return
  // Building names first (they name a whole group), then room landmarks.
  const byIdLocal = new Map(rooms.map(r => [r.id, r]))
  for (const b of buildings) {
    if (!b.name) continue
    if (!b.outline) {
      // No outline to hang the name on: name one of its rooms instead, so the
      // label sits right beside the rooms it describes.
      const r = b.rooms.map(id => byIdLocal.get(id)!).find(m => !m.label)
      if (r) r.label = b.name
      continue
    }
    const w = b.name.length * CHAR_W
    const at = tryPlace(b.name, [
      [b.x1, b.y2 + LABEL_FONT], [b.x1, b.y1 - 3],
      [b.x2 - w, b.y2 + LABEL_FONT], [b.x2 - w, b.y1 - 3],
      [b.x2 + 3, (b.y1 + b.y2) / 2 + 3], [b.x1 - w - 3, (b.y1 + b.y2) / 2 + 3],
    ])
    b.showLabel = !!at
    if (at) [b.lx, b.ly] = at
  }
  for (const r of rooms) {
    if (!r.label) continue
    const w = r.label.length * CHAR_W, h = r.size / 2
    const at = tryPlace(r.label, [
      [r.x + h + 3, r.y + 3], [r.x - h - 3 - w, r.y + 3],
      [r.x - w / 2, r.y - h - 3], [r.x - w / 2, r.y + h + LABEL_FONT],
      [r.x + h + 3, r.y - h - 2], [r.x + h + 3, r.y + h + LABEL_FONT - 1],
    ])
    if (at) [r.lx, r.ly] = at
    else r.label = ''
  }
}

/** does the segment cross the (non-square) rectangle? */
function segHitsRect(seg: [number, number, number, number], r: Box): boolean {
  const [x1, y1, x2, y2] = seg
  const dx = x2 - x1, dy = y2 - y1
  let t0 = 0, t1 = 1
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, x1 - r[0]) && clip(dx, r[2] - x1) && clip(-dy, y1 - r[1]) && clip(dy, r[3] - y1)
}
