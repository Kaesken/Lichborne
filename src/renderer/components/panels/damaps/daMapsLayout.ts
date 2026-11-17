// Da'Maps layout — gives EVERY Lich room a place on the map.
//
// About three quarters of the Lich map DB carries hand-placed `image_coords`.
// The rest (mostly shop interiors, upstairs rooms, boats and homes) has no
// position at all. This module places each of those next to the nearest room
// that does have one, stepping in the direction of the exit that leads there
// (north = up, east = right …), so a shop's rooms fan out from its doorway the
// way Genie's hand-drawn maps show them.
//
// Rooms that can't reach any positioned room (about 240 of them) are grouped
// into their own "Unmapped" areas by their Lich `location`, laid out the same
// way from an arbitrary first room.
//
// Pure and React-free; run once per map database (≈50 ms on the full DB).

import type { LichRoom } from '../mapTypes'

export interface DaLayout {
  /** area key → rooms in it (the Lich image name, or `~<location>` for an unmapped group) */
  imageIndex: Map<string, LichRoom[]>
  /** room id → [x1, y1, x2, y2] for rooms placed by this module */
  coords: Map<number, [number, number, number, number]>
  /** room id → area key, for every room */
  areaOf: Map<number, string>
}

export const UNMAPPED_PREFIX = '~'

const DIRS: Record<string, [number, number]> = {
  north: [0, -1], n: [0, -1],
  south: [0, 1], s: [0, 1],
  east: [1, 0], e: [1, 0],
  west: [-1, 0], w: [-1, 0],
  northeast: [1, -1], ne: [1, -1],
  northwest: [-1, -1], nw: [-1, -1],
  southeast: [1, 1], se: [1, 1],
  southwest: [-1, 1], sw: [-1, 1],
  up: [0.5, -1], u: [0.5, -1],
  down: [-0.5, 1], d: [-0.5, 1],
}

function moveDir(move: unknown): [number, number] | null {
  if (typeof move !== 'string') return null
  const m = move.trim().toLowerCase().replace(/^(go|climb)\s+/, '')
  return DIRS[m] ?? null
}

function hasCoords(r: LichRoom): boolean {
  return !!r.image && Array.isArray(r.image_coords) && r.image_coords.length >= 4
}

/** One area's occupancy grid, so placed rooms don't land on top of each other. */
class Occupancy {
  private cells = new Map<string, true>()
  constructor(private cell: number) {}
  private key(x: number, y: number) { return `${Math.round(x / this.cell)},${Math.round(y / this.cell)}` }
  taken(x: number, y: number) { return this.cells.has(this.key(x, y)) }
  take(x: number, y: number) { this.cells.set(this.key(x, y), true) }
  /** nearest free spot to (x, y), searching outward ring by ring */
  free(x: number, y: number, step: number): [number, number] {
    if (!this.taken(x, y)) return [x, y]
    for (let ring = 1; ring < 40; ring++) {
      let best: [number, number] | null = null, bd = Infinity
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const px = x + dx * step, py = y + dy * step
          if (this.taken(px, py)) continue
          const d = dx * dx + dy * dy
          if (d < bd) { bd = d; best = [px, py] }
        }
      }
      if (best) return best
    }
    return [x, y]
  }
}

interface AreaGeo { step: number; size: number; occ: Occupancy }

/** Typical spacing and room size of an area, from its hand-placed rooms. */
function areaGeometry(rooms: LichRoom[], db: Map<number, LichRoom>): AreaGeo {
  const lens: number[] = [], sizes: number[] = []
  const center = (r: LichRoom) => {
    const c = r.image_coords!
    return [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2]
  }
  for (const r of rooms) {
    if (!hasCoords(r)) continue
    const c = r.image_coords!
    sizes.push(Math.min(Math.abs(c[2] - c[0]), Math.abs(c[3] - c[1])) || 12)
    const [ax, ay] = center(r)
    for (const [k, mv] of Object.entries(r.wayto ?? {})) {
      const t = db.get(Number(k))
      if (!t || t.image !== r.image || !hasCoords(t) || !moveDir(mv)) continue
      const [bx, by] = center(t)
      const d = Math.hypot(bx - ax, by - ay)
      if (d > 2) lens.push(d)
    }
  }
  const median = (a: number[], dflt: number) => {
    if (!a.length) return dflt
    a.sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)]
  }
  const size = Math.max(8, Math.min(20, median(sizes, 14)))
  const step = Math.max(size * 1.6, Math.min(40, median(lens, 24)))
  const occ = new Occupancy(step * 0.7)
  for (const r of rooms) if (hasCoords(r)) { const [x, y] = center(r); occ.take(x, y) }
  return { step, size, occ }
}

export function buildLayout(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): DaLayout {
  const out: DaLayout = { imageIndex: new Map(), coords: new Map(), areaOf: new Map() }
  const pos = new Map<number, [number, number]>()   // centre of every positioned room
  const geo = new Map<string, AreaGeo>()

  // Hand-placed rooms first.
  for (const [image, rooms] of imageIndex) {
    const list: LichRoom[] = []
    for (const r of rooms) {
      if (!hasCoords(r)) continue
      list.push(r)
      const c = r.image_coords!
      pos.set(r.id, [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2])
      out.areaOf.set(r.id, image)
    }
    if (list.length) {
      out.imageIndex.set(image, list)
      geo.set(image, areaGeometry(list, lichDb))
    }
  }

  // Both directions of every exit, since many shop exits are one-way in the DB.
  const links = new Map<number, { to: number; dir: [number, number] | null }[]>()
  const link = (a: number, b: number, dir: [number, number] | null) => {
    if (!links.has(a)) links.set(a, [])
    links.get(a)!.push({ to: b, dir })
  }
  for (const r of lichDb.values()) {
    for (const [k, mv] of Object.entries(r.wayto ?? {})) {
      const t = Number(k)
      if (!lichDb.has(t) || t === r.id) continue
      const d = moveDir(mv)
      link(r.id, t, d)
      link(t, r.id, d ? [-d[0], -d[1]] : null)
    }
  }

  const place = (id: number, area: string, fromPos: [number, number], dir: [number, number] | null) => {
    const g = geo.get(area)!
    const [fx, fy] = fromPos
    const [dx, dy] = dir ?? [1, 0]
    const [x, y] = g.occ.free(fx + dx * g.step, fy + dy * g.step, g.step)
    g.occ.take(x, y)
    pos.set(id, [x, y])
    const h = g.size / 2
    out.coords.set(id, [x - h, y - h, x + h, y + h])
    out.areaOf.set(id, area)
    out.imageIndex.get(area)!.push(lichDb.get(id)!)
  }

  // Breadth-first from every positioned room at once, so each unplaced room
  // joins the area of the nearest positioned room.
  let frontier = [...pos.keys()]
  while (frontier.length) {
    const next: number[] = []
    for (const id of frontier) {
      const area = out.areaOf.get(id)!
      for (const { to, dir } of links.get(id) ?? []) {
        if (pos.has(to)) continue
        place(to, area, pos.get(id)!, dir)
        next.push(to)
      }
    }
    frontier = next
  }

  // Islands: rooms that never connect to a positioned room.
  for (const r of lichDb.values()) {
    if (pos.has(r.id)) continue
    const loc = (r.location ?? '').trim() || 'Unmapped'
    const area = UNMAPPED_PREFIX + loc
    if (!geo.has(area)) {
      geo.set(area, { step: 24, size: 14, occ: new Occupancy(24 * 0.7) })
      out.imageIndex.set(area, [])
    }
    const g = geo.get(area)!
    // Start each island below the previous ones.
    const placedHere = out.imageIndex.get(area)!
    let maxY = 0
    for (const p of placedHere) maxY = Math.max(maxY, pos.get(p.id)![1])
    const start: [number, number] = [0, placedHere.length ? maxY + g.step * 2 : 0]
    const [x, y] = g.occ.free(start[0], start[1], g.step)
    g.occ.take(x, y)
    pos.set(r.id, [x, y])
    const h = g.size / 2
    out.coords.set(r.id, [x - h, y - h, x + h, y + h])
    out.areaOf.set(r.id, area)
    placedHere.push(r)
    let fr = [r.id]
    while (fr.length) {
      const nx: number[] = []
      for (const id of fr) {
        for (const { to, dir } of links.get(id) ?? []) {
          if (pos.has(to)) continue
          place(to, area, pos.get(id)!, dir)
          nx.push(to)
        }
      }
      fr = nx
    }
  }
  return out
}
