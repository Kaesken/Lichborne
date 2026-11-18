// Da'Maps — its own map.
//
// `damaps-world.json` (in src/renderer/public, shipped beside the app) is Da'Maps' map of the world: every area, every room
// square with its position, colour and Lich room id, the lines between them,
// the place names and the building outlines. It is made once, offline, by
// tools/damaps/build-damaps.mjs (from a folder of Genie map files, matched to
// Lich's map database) and committed, so while you play Da'Maps reads no other
// map: not Genie's, not Lich's tiles.
//
// At run time each square is filled in from the Lich room it carries (indoor,
// forage, hunting, services, exits), which is also what the mana/forage notes
// and `;go2` use.

import type { LichRoom } from '../mapTypes'
import { lichTitle } from '../mapTypes'
import {
  type DaArea, type DaArc, type DaArcCategory, type DaBuilding, type DaRoom, type Realm, type ManaReading,
  splitTags, isIndoor,
} from './daMapsData'

/** square size on Da'Maps' map, in map units */
export const DA_ROOM_SIZE = 8

export const DA_WORLD_VERSION = 1
const CATS: DaArcCategory[] = ['cardinal', 'climb', 'go']

/** [id, lich id (0 = none), x, y, fill ('' = none), marker target area ('' = none), title, marker's go2 Lich room (0 = none)] */
export type DaWorldRoom = [number, number, number, number, string, string, string, number?]
/** [from id, to id, 0 cardinal | 1 climb | 2 go] */
export type DaWorldLine = [number, number, number]
/** [name, x1, y1, x2, y2, room ids, 1 = draw its dotted outline] */
export type DaWorldBuilding = [string, number, number, number, number, number[], number]

export interface DaWorldArea {
  key:       string
  name:      string
  province:  string
  /** all floors of this map, ground floor first (keys); [key] for one floor */
  floors:    string[]
  rooms:     DaWorldRoom[]
  lines:     DaWorldLine[]
  texts:     [string, number, number][]
  buildings: DaWorldBuilding[]
}

export interface DaWorldFile {
  version: number
  made:    string
  /** where it was built from, for the record */
  sources: { maps: string; lich: string }
  stats:   { areas: number; squares: number; matched: number }
  areas:   DaWorldArea[]
}

export interface DaWorld {
  file: DaWorldFile
  byKey: Map<string, DaWorldArea>
  /** Lich room id → every area key it's drawn in */
  keysOf: Map<number, string[]>
  /** one area per map for Global: each map's ground floor */
  globalKeys: string[]
}

/** shipped beside the app (src/renderer/public), so it is read only when Da'Maps opens */
const WORLD_URL = './damaps-world.json'

function readJson(url: string): Promise<unknown> {
  // XHR, not fetch: fetch of a file:// resource is unreliable in Electron.
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('GET', url)
    x.responseType = 'text'
    x.onload = () => {
      if (x.status !== 0 && x.status !== 200) { reject(new Error(`HTTP ${x.status}`)); return }
      try { resolve(JSON.parse(x.responseText)) } catch (e) { reject(e) }
    }
    x.onerror = () => reject(new Error(`couldn't read ${url}`))
    x.send()
  })
}

let loading: Promise<DaWorld> | null = null
/** Load Da'Maps' map, once, the first time Da'Maps opens. */
export function loadDaWorld(): Promise<DaWorld> {
  if (!loading) {
    loading = readJson(WORLD_URL).then(raw => {
      const file = raw as DaWorldFile
      if (file?.version !== DA_WORLD_VERSION || !Array.isArray(file.areas)) throw new Error('unknown map file version')
      const byKey = new Map(file.areas.map(a => [a.key, a]))
      const keysOf = new Map<number, string[]>()
      for (const a of file.areas) for (const r of a.rooms) {
        if (!r[1]) continue
        if (!keysOf.has(r[1])) keysOf.set(r[1], [])
        const ks = keysOf.get(r[1])!
        if (!ks.includes(a.key)) ks.push(a.key)
      }
      const globalKeys = file.areas.filter(a => a.floors[0] === a.key).map(a => a.key)
      return { file, byKey, keysOf, globalKeys }
    })
    loading.catch(() => { loading = null })
  }
  return loading
}

/** One area of Da'Maps' map, filled in from the Lich rooms its squares carry. */
export function hydrateArea(a: DaWorldArea, lichDb: Map<number, LichRoom>): DaArea {
  const rooms: DaRoom[] = []
  const byId = new Map<number, DaRoom>()
  const byLich = new Map<number, DaRoom>()
  for (const [id, lid, x, y, fill, to, title, goTo] of a.rooms) {
    const lr = lid ? lichDb.get(lid) : undefined
    const tags = splitTags(lr?.tags)
    const room: DaRoom = {
      id, lich: lid || null,
      fill: fill || undefined, stubTo: to || undefined, goTo: (to && goTo) || undefined,
      x, y, size: DA_ROOM_SIZE, lx: 0, ly: 0,
      title: lr ? lichTitle(lr) : title,
      indoor: lr ? isIndoor(lr) : false,
      category: tags.category,
      forage: tags.forage, hunting: tags.hunting, services: tags.services,
      exits: lr ? Object.values(lr.wayto ?? {}).filter((m): m is string => typeof m === 'string') : [],
      crossTo: to ? [to] : [],
      label: '', building: null, location: lr?.location ?? '',
    }
    rooms.push(room)
    byId.set(id, room)
    if (room.lich !== null && !byLich.has(room.lich)) byLich.set(room.lich, room)
  }
  const arcs: DaArc[] = a.lines.filter(([x, y]) => byId.has(x) && byId.has(y)).map(([x, y, c]) => ({ a: x, b: y, cat: CATS[c] ?? 'go' }))
  const buildings: DaBuilding[] = a.buildings.map(([name, x1, y1, x2, y2, ids, outline]) => ({
    name, x1, y1, x2, y2, rooms: ids, outline: !!outline, lx: 0, ly: 0, showLabel: false,
  }))
  buildings.forEach((b, i) => { for (const id of b.rooms) { const r = byId.get(id); if (r) r.building = i } })
  const texts = a.texts.map(([text, x, y]) => ({ text, x, y }))
  const xs = rooms.map(r => r.x).concat(texts.map(t => t.x)), ys = rooms.map(r => r.y).concat(texts.map(t => t.y))
  const bbox = rooms.length
    ? { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
    : { x1: 0, y1: 0, x2: 100, y2: 100 }
  return { image: a.key, name: a.name, rooms, byId, byLich, arcs, buildings, bbox, texts }
}

// ── Mana readings built into Da'Maps ─────────────────────────────────────────
//
// public/damaps-mana-seed.json, built by tools/damaps/build-mana-seed.mjs from
// damaps-mana.log files: one reading per room and realm, shipped so every
// player sees mana without perceiving first. A room's mana doesn't change, and
// these come from full-scale (21-step) readings, so they win over a player's
// own; a player's readings only fill rooms these don't cover.

export interface DaManaSeed {
  made: string
  /** Lich room id → realm → reading (built into Da'Maps) */
  rooms: Record<string, Partial<Record<Realm, ManaReading>>>
}

let seedLoading: Promise<DaManaSeed | null> | null = null
export function loadManaSeed(): Promise<DaManaSeed | null> {
  if (!seedLoading) {
    seedLoading = readJson('./damaps-mana-seed.json').then(raw => {
      const f = raw as { version?: number; made?: string; words?: string[]; rooms?: Record<string, Record<string, number[]>> }
      if (f?.version !== 1 || !f.rooms || !Array.isArray(f.words)) return null
      const at = Date.parse(f.made ?? '') || 0
      const rooms: DaManaSeed['rooms'] = {}
      for (const [id, realms] of Object.entries(f.rooms)) {
        const out: Partial<Record<Realm, ManaReading>> = {}
        for (const [realm, [lv, near]] of Object.entries(realms)) {
          if (!(lv >= 1 && lv <= f.words.length)) continue
          out[realm as Realm] = { word: f.words[lv - 1], rank: lv - 1, at, near: !!near, shared: true,
            text: 'Read by the Da\'Maps mana tour' }
        }
        rooms[id] = out
      }
      return { made: f.made ?? '', rooms }
    }, () => null)
  }
  return seedLoading
}
