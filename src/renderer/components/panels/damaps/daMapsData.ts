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

import type { LichRoom } from '../mapTypes'
import { lichTitle } from '../mapTypes'
import { scopedKey } from '../../../characterScope'

/** The display name, kept in one place so it is easy to rename later. */
export const DA_MAPS_NAME = "Da'Maps"

// ── Arc categories (same three as the Genie view, so the theme vars line up) ──

export type DaArcCategory = 'cardinal' | 'climb' | 'go'

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
  id:       number
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
  building: number | null    // index into DaArea.buildings (indoor rooms only)
  location: string
}

export interface DaArc { a: number; b: number; cat: DaArcCategory }

export interface DaBuilding {
  name:  string
  rooms: number[]
  x1: number; y1: number; x2: number; y2: number
}

export interface DaArea {
  image:     string
  name:      string
  rooms:     DaRoom[]
  byId:      Map<number, DaRoom>
  arcs:      DaArc[]
  buildings: DaBuilding[]
  bbox:      { x1: number; y1: number; x2: number; y2: number }
}

/** "zoluren-1-crossing-1377284934.png" → "Zoluren 1 Crossing". */
export function areaDisplayName(image: string): string {
  let s = image.replace(/\.(png|gif|jpe?g)$/i, '')
  s = s.replace(/[-_ ]\d{9,}$/, '')            // trailing upload timestamps
  s = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.replace(/\b([a-z])/g, c => c.toUpperCase())
}

function buildingName(title: string): string {
  const i = title.indexOf(',')
  return (i > 0 ? title.slice(0, i) : title).trim()
}

function isIndoor(r: LichRoom): boolean {
  const p = (r.paths ?? [])[0] ?? ''
  return /^Obvious exits/i.test(p)
}

function splitTags(tags: string[] | undefined): { forage: string[]; hunting: string[]; services: string[]; category: string | null } {
  const forage: string[] = [], hunting: string[] = [], services: string[] = []
  let best: string | null = null
  for (const raw of tags ?? []) {
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
export function buildArea(image: string, rooms: LichRoom[], lichDb: Map<number, LichRoom>): DaArea {
  const placed: DaRoom[] = []
  const byId = new Map<number, DaRoom>()

  for (const r of rooms) {
    const c = r.image_coords
    if (!c || c.length < 4) continue
    const [x1, y1, x2, y2] = c
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1)
    const { forage, hunting, services, category } = splitTags(r.tags)
    const exits = Object.values(r.wayto ?? {})
    const swim = exits.some(m => /^swim\b/i.test(m))
    const crossTo = new Set<string>()
    const crossNames: string[] = []
    for (const k of Object.keys(r.wayto ?? {})) {
      const t = lichDb.get(Number(k))
      if (t?.image && t.image !== image && t.image_coords) {
        crossTo.add(t.image)
        crossNames.push(buildingName(lichTitle(t)))
      }
    }
    const room: DaRoom = {
      id: r.id,
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      // Lich tiles draw ~16px rooms; 70% of that leaves the Genie-style gaps.
      size: Math.max(6, Math.min(w || 12, h || 12) * 0.7),
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
    const near = kept.some(k => k.label === name && Math.hypot(k.x - room.x, k.y - room.y) < 80)
    room.label = near ? '' : name
    if (room.label) kept.push(room)
  }

  // Arcs inside the area, de-duplicated. Very long lines are skipped (portal /
  // "go" exits whose far end sits across the tile) — they're walkable but would
  // just draw a line across the map, the same reason Genie hides such arcs.
  const MAX_ARC = 260
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
      arcs.push({ a: a.id, b: b.id, cat: classifyMove(move) })
    }
  }

  // Buildings: connected groups of indoor rooms (joined by any exit). Zoomed
  // out, each one is drawn as a single outline; zoomed in, its rooms appear.
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
    for (const k of Object.keys(r.wayto ?? {})) {
      const t = Number(k)
      if (!parent.has(t)) continue
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
      name,
      rooms: members.map(m => m.id),
      x1: Math.min(...members.map(m => m.x - m.size / 2)) - pad,
      y1: Math.min(...members.map(m => m.y - m.size / 2)) - pad,
      x2: Math.max(...members.map(m => m.x + m.size / 2)) + pad,
      y2: Math.max(...members.map(m => m.y + m.size / 2)) + pad,
    }
    const idx = buildings.push(b) - 1
    for (const m of members) m.building = idx
  }

  const bbox = placed.length
    ? {
        x1: Math.min(...placed.map(r => r.x)), y1: Math.min(...placed.map(r => r.y)),
        x2: Math.max(...placed.map(r => r.x)), y2: Math.max(...placed.map(r => r.y)),
      }
    : { x1: 0, y1: 0, x2: 100, y2: 100 }

  return { image, name: areaDisplayName(image), rooms: placed, byId, arcs, buildings, bbox }
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
