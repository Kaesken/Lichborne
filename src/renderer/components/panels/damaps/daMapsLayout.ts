// Da'Maps layout — gives EVERY Lich room a place on the map, with nothing
// overlapping.
//
// About three quarters of the Lich map DB carries hand-placed `image_coords`.
// The rest (mostly shop interiors, upstairs rooms, boats and homes) has no
// position at all. This module:
//
//  1. spreads each area's hand-placed rooms apart (SPREAD) while keeping room
//     squares their original size, so the streets keep their shape but gain
//     the space between them that Genie's maps use for shop interiors;
//  2. places each unpositioned room next to the nearest positioned one, in the
//     direction of the exit that leads there (north = up, east = right …),
//     on the nearest spot where its square keeps a clear gap from every other
//     square and the line to its doorway doesn't cross another room.
//
// Rooms that can't reach any positioned room (about 240) are grouped into
// "<location> (unmapped)" areas, laid out the same way.
//
// Pure and React-free; run once per map database.

import type { LichRoom } from '../mapTypes'

export interface DaLayout {
  /** area key → rooms in it (the Lich image name, or `~<location>` for an unmapped group) */
  imageIndex: Map<string, LichRoom[]>
  /** room id → centre, for every room */
  pos: Map<number, [number, number]>
  /** room id → square size */
  size: Map<number, number>
  /** room id → area key, for every room */
  areaOf: Map<number, string>
}

export const UNMAPPED_PREFIX = '~'
/** how far apart hand-placed rooms are moved (room squares keep their size) */
export const SPREAD = 2.5
/** interior tiles keep their drawn shape at this scale (tighter than streets) */
const BLOCK_SCALE = 1.6

const DIRS: Record<string, [number, number]> = {
  north: [0, -1], n: [0, -1],
  south: [0, 1], s: [0, 1],
  east: [1, 0], e: [1, 0],
  west: [-1, 0], w: [-1, 0],
  northeast: [1, -1], ne: [1, -1],
  northwest: [-1, -1], nw: [-1, -1],
  southeast: [1, 1], se: [1, 1],
  southwest: [-1, 1], sw: [-1, 1],
  up: [1, -1], u: [1, -1],
  down: [-1, 1], d: [-1, 1],
}

function moveDir(move: unknown): [number, number] | null {
  if (typeof move !== 'string') return null
  const m = move.trim().toLowerCase().replace(/^(go|climb)\s+/, '')
  return DIRS[m] ?? null
}

function hasCoords(r: LichRoom): boolean {
  return !!r.image && Array.isArray(r.image_coords) && r.image_coords.length >= 4
}

/** Square size of a hand-placed room: 70% of its Lich rect, like the Genie gaps. */
export function handSize(r: LichRoom): number {
  const c = r.image_coords!
  const w = Math.abs(c[2] - c[0]), h = Math.abs(c[3] - c[1])
  return Math.max(6, Math.min(16, Math.min(w || 12, h || 12) * 0.7))
}

/** Spatial hash of room squares and of the lines between them, for one area. */
class Space {
  private cells = new Map<string, number[]>()
  private segs: [number, number, number, number][] = []
  private segCells = new Map<string, number[]>()
  readonly sq: { x: number; y: number; h: number }[] = []
  constructor(private cell: number) {}

  private k(cx: number, cy: number) { return cx + ',' + cy }
  private cellsOf(x1: number, y1: number, x2: number, y2: number): string[] {
    const out: string[] = []
    const ax = Math.floor(Math.min(x1, x2) / this.cell), bx = Math.floor(Math.max(x1, x2) / this.cell)
    const ay = Math.floor(Math.min(y1, y2) / this.cell), by = Math.floor(Math.max(y1, y2) / this.cell)
    for (let cx = ax; cx <= bx; cx++) for (let cy = ay; cy <= by; cy++) out.push(this.k(cx, cy))
    return out
  }
  addRoom(x: number, y: number, size: number) {
    const i = this.sq.push({ x, y, h: size / 2 }) - 1
    for (const c of this.cellsOf(x - size / 2, y - size / 2, x + size / 2, y + size / 2)) {
      if (!this.cells.has(c)) this.cells.set(c, [])
      this.cells.get(c)!.push(i)
    }
  }
  addLine(x1: number, y1: number, x2: number, y2: number) {
    const i = this.segs.push([x1, y1, x2, y2]) - 1
    if (Math.hypot(x2 - x1, y2 - y1) > this.cell * 12) return   // long portal lines: ignore
    for (const c of this.cellsOf(x1, y1, x2, y2)) {
      if (!this.segCells.has(c)) this.segCells.set(c, [])
      this.segCells.get(c)!.push(i)
    }
  }
  /** any room square within `gap` of the box (x±h, y±h)? */
  roomNear(x: number, y: number, h: number, gap: number, skip = -1): boolean {
    for (const c of this.cellsOf(x - h - gap, y - h - gap, x + h + gap, y + h + gap)) {
      for (const i of this.cells.get(c) ?? []) {
        if (i === skip) continue
        const s = this.sq[i]
        if (Math.abs(s.x - x) < s.h + h + gap && Math.abs(s.y - y) < s.h + h + gap) return true
      }
    }
    return false
  }
  /** does a line pass through the box (x±h, y±h)? */
  lineThrough(x: number, y: number, h: number): boolean {
    for (const c of this.cellsOf(x - h, y - h, x + h, y + h)) {
      for (const i of this.segCells.get(c) ?? []) {
        if (segHitsBox(this.segs[i], x, y, h)) return true
      }
    }
    return false
  }
  /** does the segment pass through any room square other than its two ends? */
  segmentBlocked(x1: number, y1: number, x2: number, y2: number, pad: number): boolean {
    const seen = new Set<number>()
    for (const c of this.cellsOf(x1, y1, x2, y2)) {
      for (const i of this.cells.get(c) ?? []) {
        if (seen.has(i)) continue
        seen.add(i)
        const s = this.sq[i]
        if ((Math.abs(s.x - x1) < 0.5 && Math.abs(s.y - y1) < 0.5) || (Math.abs(s.x - x2) < 0.5 && Math.abs(s.y - y2) < 0.5)) continue
        if (segHitsBox([x1, y1, x2, y2], s.x, s.y, s.h + pad)) return true
      }
    }
    return false
  }
}

/** Liang–Barsky: does the segment touch the square centred (x, y) with half-side h? */
export function segHitsBox(seg: [number, number, number, number], x: number, y: number, h: number): boolean {
  const [x1, y1, x2, y2] = seg
  const dx = x2 - x1, dy = y2 - y1
  let t0 = 0, t1 = 1
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r }
    else { if (r < t0) return false; if (r < t1) t1 = r }
    return true
  }
  return clip(-dx, x1 - (x - h)) && clip(dx, (x + h) - x1) && clip(-dy, y1 - (y - h)) && clip(dy, (y + h) - y1)
}

interface AreaGeo { unit: number; space: Space }

export function buildLayout(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): DaLayout {
  const out: DaLayout = { imageIndex: new Map(), pos: new Map(), size: new Map(), areaOf: new Map() }
  const geo = new Map<string, AreaGeo>()

  // Interior tiles (a guild, a society, a block of shops drawn on their own
  // Lich image) are folded into the town they open onto.
  const interiorOf = findInteriorTiles(lichDb, imageIndex)

  // 1. Hand-placed rooms, spread apart.
  for (const [image, rooms] of imageIndex) {
    if (interiorOf.has(image)) continue
    const list = rooms.filter(hasCoords)
    if (!list.length) continue
    const sizes: number[] = []
    for (const r of list) {
      const c = r.image_coords!
      const s = handSize(r)
      sizes.push(s)
      out.pos.set(r.id, [((c[0] + c[2]) / 2) * SPREAD, ((c[1] + c[3]) / 2) * SPREAD])
      out.size.set(r.id, s)
      out.areaOf.set(r.id, image)
    }
    sizes.sort((a, b) => a - b)
    const unit = sizes[Math.floor(sizes.length / 2)]
    const space = new Space(unit * 2)
    for (const r of list) {
      let [x, y] = out.pos.get(r.id)!
      const sz = out.size.get(r.id)!
      // A few rooms sit on top of each other in the Lich data (event copies,
      // duplicates): nudge each onto the nearest clear spot.
      if (space.roomNear(x, y, sz / 2, 2)) {
        let found: [number, number] | null = null
        for (let ring = 1; ring <= 12 && !found; ring++) {
          for (let ix = -ring; ix <= ring && !found; ix++) for (let iy = -ring; iy <= ring && !found; iy++) {
            if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
            const nx = x + ix * sz * 1.5, ny = y + iy * sz * 1.5
            if (!space.roomNear(nx, ny, sz / 2, 2)) found = [nx, ny]
          }
        }
        if (found) { [x, y] = found; out.pos.set(r.id, found) }
      }
      space.addRoom(x, y, sz)
    }
    for (const r of list) {
      const [x, y] = out.pos.get(r.id)!
      for (const k of Object.keys(r.wayto ?? {})) {
        const t = Number(k)
        if (t !== r.id && out.areaOf.get(t) === image) { const [bx, by] = out.pos.get(t)!; space.addLine(x, y, bx, by) }
      }
    }
    out.imageIndex.set(image, list)
    geo.set(image, { unit, space })
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

  // 2. Place one room beside `from`. The spot must keep a clear gap to every
  // square, sit on no existing line, and the lines to every neighbour that is
  // already on the map must not cross another room.
  const place = (id: number, area: string, from: [number, number], dir: [number, number] | null) => {
    const g = geo.get(area)!
    const u = g.unit, h = u / 2, step = u * 2, gap = u * 0.75
    const [fx, fy] = from
    const [dx, dy] = dir ?? [1, 0]
    const tx = fx + dx * step, ty = fy + dy * step
    const nbrs: [number, number][] = []
    for (const { to } of links.get(id) ?? []) {
      if (out.areaOf.get(to) === area) { const p = out.pos.get(to)!; if (Math.hypot(p[0] - fx, p[1] - fy) < step * 12 || (p[0] === fx && p[1] === fy)) nbrs.push(p) }
    }
    const ok = (x: number, y: number, strict: boolean) => {
      if (g.space.roomNear(x, y, h, gap)) return false
      if (g.space.lineThrough(x, y, h + gap / 2)) return false
      if (strict) for (const [nx, ny] of nbrs) if (g.space.segmentBlocked(nx, ny, x, y, gap / 3)) return false
      return true
    }
    let best: [number, number] | null = null
    for (const [maxRing, strict] of [[10, true], [40, false]] as const) {
      for (let ring = 0; ring <= maxRing && !best; ring++) {
        let bd = Infinity
        for (let ix = -ring; ix <= ring; ix++) {
          for (let iy = -ring; iy <= ring; iy++) {
            if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
            const x = tx + ix * step, y = ty + iy * step
            const d = (x - tx) ** 2 + (y - ty) ** 2 + ((x - fx) ** 2 + (y - fy) ** 2) * 0.25
            if (d >= bd || !ok(x, y, strict)) continue
            bd = d; best = [x, y]
          }
        }
      }
      if (best) break
    }
    if (!best) {
      // Nowhere near: go straight out from the doorway until it's clear.
      let k = 1
      while (g.space.roomNear(tx + dx * step * k, ty + dy * step * k + (dir ? 0 : step * k), h, gap)) k++
      best = [tx + dx * step * k, ty + dy * step * k + (dir ? 0 : step * k)]
    }
    const [x, y] = best
    g.space.addRoom(x, y, u)
    for (const [nx, ny] of nbrs) g.space.addLine(nx, ny, x, y)
    out.pos.set(id, [x, y])
    out.size.set(id, u)
    out.areaOf.set(id, area)
    out.imageIndex.get(area)!.push(lichDb.get(id)!)
  }

  function placeBlock(area: string, comp: LichRoom[]) {
    const g = geo.get(area)!
    const u = g.unit, step = u * 2, gap = u * 0.75
    const ids = new Set(comp.map(r => r.id))
    // The block's own shape, from its hand-drawn coords.
    const local = new Map<number, [number, number]>()
    for (const r of comp) {
      const c = r.image_coords!
      local.set(r.id, [((c[0] + c[2]) / 2) * BLOCK_SCALE, ((c[1] + c[3]) / 2) * BLOCK_SCALE])
    }
    // Rooms the tile draws on top of each other get nudged apart.
    const own = new Space(step)
    for (const r of comp) {
      let [x, y] = local.get(r.id)!
      for (let ring = 1; ring <= 12 && own.roomNear(x, y, u / 2, 2); ring++) {
        let done = false
        for (let ix = -ring; ix <= ring && !done; ix++) for (let iy = -ring; iy <= ring && !done; iy++) {
          if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
          const nx = x + ix * u * 1.5, ny = y + iy * u * 1.5
          if (!own.roomNear(nx, ny, u / 2, 2)) { x = nx; y = ny; done = true }
        }
      }
      local.set(r.id, [x, y])
      own.addRoom(x, y, u)
    }
    // Its door: a room in the block joined to a positioned room in the town.
    let door: { inner: number; outer: [number, number]; dir: [number, number] | null } | null = null
    for (const r of comp) {
      for (const { to, dir } of links.get(r.id) ?? []) {
        if (out.areaOf.get(to) === area && !ids.has(to)) { door = { inner: r.id, outer: out.pos.get(to)!, dir: dir ? [-dir[0], -dir[1]] : null }; break }
      }
      if (door) break
    }
    const anchorLocal = door ? local.get(door.inner)! : local.get(comp[0].id)!
    let anchor: [number, number]
    if (door) {
      const [dx, dy] = door.dir ?? [0, 1]
      anchor = [door.outer[0] + dx * step * 2, door.outer[1] + dy * step * 2]
    } else {
      let maxY = 0
      for (const r of out.imageIndex.get(area)!) maxY = Math.max(maxY, out.pos.get(r.id)![1])
      anchor = [0, maxY + step * 4]
    }
    const inner: [number, number, number, number][] = []
    for (const r of comp) for (const { to } of links.get(r.id) ?? []) {
      if (ids.has(to) && to > r.id) {
        const a = local.get(r.id)!, b = local.get(to)!
        inner.push([a[0], a[1], b[0], b[1]])
      }
    }
    const fits = (ox: number, oy: number) => {
      for (const [x, y] of local.values()) {
        if (g.space.roomNear(x + ox, y + oy, u / 2, gap)) return false
        if (g.space.lineThrough(x + ox, y + oy, u / 2 + gap / 2)) return false
      }
      for (const [x1, y1, x2, y2] of inner) if (g.space.segmentBlocked(x1 + ox, y1 + oy, x2 + ox, y2 + oy, gap / 3)) return false
      if (door) {
        const [ix, iy] = local.get(door.inner)!
        if (g.space.segmentBlocked(door.outer[0], door.outer[1], ix + ox, iy + oy, gap / 3)) return false
      }
      return true
    }
    const baseX = anchor[0] - anchorLocal[0], baseY = anchor[1] - anchorLocal[1]
    let off: [number, number] | null = null
    for (let ring = 0; ring <= 40 && !off; ring++) {
      let bd = Infinity
      for (let ix = -ring; ix <= ring; ix++) for (let iy = -ring; iy <= ring; iy++) {
        if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
        const d = ix * ix + iy * iy
        if (d >= bd) continue
        const ox = baseX + ix * step, oy = baseY + iy * step
        if (fits(ox, oy)) { bd = d; off = [ox, oy] }
      }
    }
    if (!off) {
      // Nowhere near: set it down below everything else in the area.
      let maxY = 0
      for (const r of out.imageIndex.get(area)!) maxY = Math.max(maxY, out.pos.get(r.id)![1])
      const minY = Math.min(...[...local.values()].map(p => p[1]))
      off = [baseX, maxY + step * 3 - minY]
    }
    for (const r of comp) {
      const [x, y] = local.get(r.id)!
      const p: [number, number] = [x + off[0], y + off[1]]
      out.pos.set(r.id, p)
      out.size.set(r.id, u)
      out.areaOf.set(r.id, area)
      out.imageIndex.get(area)!.push(r)
      g.space.addRoom(p[0], p[1], u)
    }
    for (const [x1, y1, x2, y2] of inner) g.space.addLine(x1 + off[0], y1 + off[1], x2 + off[0], y2 + off[1])
    if (door) { const p = out.pos.get(door.inner)!; g.space.addLine(door.outer[0], door.outer[1], p[0], p[1]) }
  }

  const grow = (start: number[]) => {
    let frontier = start
    while (frontier.length) {
      const next: number[] = []
      for (const id of frontier) {
        const area = out.areaOf.get(id)!
        for (const { to, dir } of links.get(id) ?? []) {
          if (out.pos.has(to)) continue
          place(to, area, out.pos.get(id)!, dir)
          next.push(to)
        }
      }
      frontier = next
    }
  }

  // 1b. Interior tiles: each connected group of their rooms keeps its own
  // hand-drawn shape and is set down as a block beside its door in the town,
  // on the nearest spot where none of it overlaps anything.
  const blocks: { area: string; rooms: LichRoom[] }[] = []
  for (const [child, parent] of interiorOf) {
    const list = (imageIndex.get(child) ?? []).filter(hasCoords)
    const ids = new Set(list.map(r => r.id))
    const seen = new Set<number>()
    for (const r of list) {
      if (seen.has(r.id)) continue
      const comp: LichRoom[] = []
      const stack = [r.id]; seen.add(r.id)
      while (stack.length) {
        const id = stack.pop()!
        comp.push(lichDb.get(id)!)
        for (const { to } of links.get(id) ?? []) if (ids.has(to) && !seen.has(to)) { seen.add(to); stack.push(to) }
      }
      blocks.push({ area: parent, rooms: comp })
    }
  }
  blocks.sort((a, b) => b.rooms.length - a.rooms.length)
  for (const b of blocks) placeBlock(b.area, b.rooms)

  // Breadth-first from every positioned room at once, so each unplaced room
  // joins the area of the nearest positioned room.
  grow([...out.pos.keys()])

  // 3. Islands: rooms that never connect to a positioned room.
  for (const r of lichDb.values()) {
    if (out.pos.has(r.id)) continue
    const loc = (r.location ?? '').trim() || 'Unmapped'
    const area = UNMAPPED_PREFIX + loc
    if (!geo.has(area)) {
      geo.set(area, { unit: 11, space: new Space(22) })
      out.imageIndex.set(area, [])
    }
    const g = geo.get(area)!
    const here = out.imageIndex.get(area)!
    let maxY = -g.unit * 4
    for (const p of here) maxY = Math.max(maxY, out.pos.get(p.id)![1])
    let y = maxY + g.unit * 4
    while (g.space.roomNear(0, y, g.unit / 2, g.unit)) y += g.unit * 2
    g.space.addRoom(0, y, g.unit)
    out.pos.set(r.id, [0, y])
    out.size.set(r.id, g.unit)
    out.areaOf.set(r.id, area)
    here.push(r)
    grow([r.id])
  }
  return out
}

/**
 * Lich draws many buildings on their own image (a guild, a society, a block
 * of shops). Such a tile belongs in the town it opens onto when:
 *  - most of its rooms are indoors,
 *  - the town is the area it connects to most, and is bigger than it,
 *  - it is reached by walking both ways (a door, not a portal or a script),
 *    which keeps event realms and portal destinations out.
 */
export function findInteriorTiles(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): Map<string, string> {
  const areaOf = new Map<number, string>()
  const count = new Map<string, number>()
  for (const [image, rooms] of imageIndex) for (const r of rooms) if (hasCoords(r)) {
    areaOf.set(r.id, image); count.set(image, (count.get(image) ?? 0) + 1)
  }
  const walk = (m: unknown) => typeof m === 'string' && !/^;|portal/i.test(m.trim())
  const result = new Map<string, string>()
  for (const [image, rooms] of imageIndex) {
    const list = rooms.filter(hasCoords)
    if (!list.length) continue
    const indoor = list.filter(r => (r.paths?.[0] ?? '').startsWith('Obvious exits')).length
    if (indoor < list.length * 0.5) continue
    const out = new Map<string, number>(), back = new Map<string, number>()
    for (const r of list) for (const [k, m] of Object.entries(r.wayto ?? {})) {
      const t = areaOf.get(Number(k))
      if (t && t !== image && walk(m)) out.set(t, (out.get(t) ?? 0) + 1)
    }
    for (const [other, rs] of imageIndex) {
      if (other === image || !out.has(other)) continue
      for (const r of rs) for (const [k, m] of Object.entries(r.wayto ?? {})) {
        if (areaOf.get(Number(k)) === image && walk(m)) back.set(other, (back.get(other) ?? 0) + 1)
      }
    }
    const best = [...out.entries()].filter(([o]) => back.has(o)).sort((a, b) => (b[1] + back.get(b[0])!) - (a[1] + back.get(a[0])!))[0]
    if (!best) continue
    if ((count.get(best[0]) ?? 0) <= list.length) continue
    result.set(image, best[0])
  }
  // Don't chain: a tile folded into another interior tile stays separate.
  for (const [child, parent] of [...result]) if (result.has(parent)) result.delete(child)
  return result
}
