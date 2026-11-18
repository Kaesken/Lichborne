// Da'Maps layout — every Lich room on a grid, every exit a straight line.
//
// Each area is laid out on a square grid (PITCH world units per cell), the
// way Genie's and Mudlet's maps are: an east exit is a level line, north is
// vertical, the diagonals are 45°.
//
//  1. Hand-placed rooms (Lich `image_coords`) are snapped to the grid, then
//     straightened: rooms joined by an east/west exit share a row, by a
//     north/south exit share a column, and a diagonal exit is pulled onto 45°
//     where the rooms aren't held in place by another exit.
//  2. Buildings Lich draws on their own image (a guild, a society, a block of
//     shops — see findInteriorTiles) are straightened the same way and set
//     down whole beside their door in the town, so a building's rooms stay
//     together.
//  3. Rooms with no position (shop back rooms, upstairs, boats, homes) are put
//     on the grid out along the line of the exit that leads there.
//
// Nothing overlaps: one room per cell, a room never sits on another room's
// line, and a new line may not pass through a room. Rooms that never connect
// to a positioned room go into "<location> (unmapped)" areas.
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
/** world units per grid cell */
export const PITCH = 22
/** every room square is this size, like Genie's */
export const ROOM_SIZE = 12

type Dir = [number, number]

const DIRS: Record<string, Dir> = {
  north: [0, -1], n: [0, -1],
  south: [0, 1], s: [0, 1],
  east: [1, 0], e: [1, 0],
  west: [-1, 0], w: [-1, 0],
  northeast: [1, -1], ne: [1, -1],
  northwest: [-1, -1], nw: [-1, -1],
  southeast: [1, 1], se: [1, 1],
  southwest: [-1, 1], sw: [-1, 1],
}

/** Exits that go into a building/up/down have no compass bearing. */
function moveDir(move: unknown): Dir | null {
  if (typeof move !== 'string') return null
  const m = move.trim().toLowerCase().replace(/^(go|climb)\s+/, '')
  return DIRS[m] ?? null
}

function hasCoords(r: LichRoom): boolean {
  return !!r.image && Array.isArray(r.image_coords) && r.image_coords.length >= 4
}
const center = (r: LichRoom): [number, number] => {
  const c = r.image_coords!
  return [(c[0] + c[2]) / 2, (c[1] + c[3]) / 2]
}
const key = (x: number, y: number) => x + ',' + y

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

class UF {
  private p = new Map<number, number>()
  find(x: number): number {
    let r = x
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!
    let c = x
    while (c !== r) { const n = this.p.get(c) ?? c; this.p.set(c, r); c = n }
    return r
  }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb) }
}

/** Nearest cell to (x, y), ring by ring, that passes `ok`. */
function spiral(x: number, y: number, maxRing: number, ok: (x: number, y: number) => boolean): [number, number] | null {
  for (let ring = 1; ring <= maxRing; ring++) {
    let best: [number, number] | null = null, bd = Infinity
    for (let ix = -ring; ix <= ring; ix++) for (let iy = -ring; iy <= ring; iy++) {
      if (Math.max(Math.abs(ix), Math.abs(iy)) !== ring) continue
      const d = ix * ix + iy * iy
      if (d < bd && ok(x + ix, y + iy)) { bd = d; best = [x + ix, y + iy] }
    }
    if (best) return best
  }
  return null
}

type Links = Map<number, { to: number; dir: Dir | null }[]>

/**
 * Snap a set of hand-placed rooms to a grid and straighten their exits.
 * Returns each room's grid cell (in this set's own grid, origin arbitrary).
 */
function straighten(rooms: LichRoom[], links: Links): Map<number, [number, number]> {
  const ids = new Set(rooms.map(r => r.id))
  const raw = new Map(rooms.map(r => [r.id, center(r)] as const))

  // Grid pitch from the typical exit length: half of it, so a normal exit is
  // two cells (one empty cell between rooms) and short corridors keep detail.
  const lens: number[] = []
  for (const r of rooms) for (const { to, dir } of links.get(r.id) ?? []) {
    if (!dir || !ids.has(to)) continue
    const [ax, ay] = raw.get(r.id)!, [bx, by] = raw.get(to)!
    const d = Math.hypot(bx - ax, by - ay)
    if (d > 2) lens.push(d)
  }
  lens.sort((a, b) => a - b)
  const edge = lens.length ? lens[Math.floor(lens.length / 2)] : 32
  const p = Math.max(4, edge / 2)

  const gx = new Map<number, number>(), gy = new Map<number, number>()
  for (const r of rooms) { const [x, y] = raw.get(r.id)!; gx.set(r.id, x / p); gy.set(r.id, y / p) }

  // East/west exits share a row, north/south share a column. Only join groups
  // that are already close, so a loop the Lich data draws a little out of
  // true doesn't drag far-apart streets onto one line.
  const align = (axis: 'x' | 'y') => {
    const val = axis === 'x' ? gx : gy
    const uf = new UF()
    for (const r of rooms) for (const { to, dir } of links.get(r.id) ?? []) {
      if (!dir || !ids.has(to)) continue
      if (axis === 'y' ? dir[1] !== 0 : dir[0] !== 0) continue
      if (Math.abs(val.get(r.id)! - val.get(to)!) <= 1.6) uf.union(r.id, to)
    }
    const groups = new Map<number, number[]>()
    for (const r of rooms) { const g = uf.find(r.id); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(r.id) }
    for (const m of groups.values()) {
      const vs = m.map(id => val.get(id)!).sort((a, b) => a - b)
      const v = Math.round(vs[Math.floor(vs.length / 2)])
      for (const id of m) val.set(id, v)
    }
  }
  align('y'); align('x')

  const out = new Map<number, [number, number]>()
  for (const r of rooms) out.set(r.id, [Math.round(gx.get(r.id)!), Math.round(gy.get(r.id)!)])

  // Diagonals: put the far room on the 45° line when it has no row/column
  // exit holding it in place on the axis that has to move.
  const pinnedX = new Set<number>(), pinnedY = new Set<number>()
  for (const r of rooms) for (const { to, dir } of links.get(r.id) ?? []) {
    if (!dir || !ids.has(to)) continue
    if (dir[0] === 0) { pinnedX.add(r.id); pinnedX.add(to) }
    if (dir[1] === 0) { pinnedY.add(r.id); pinnedY.add(to) }
  }
  for (const r of rooms) for (const { to, dir } of links.get(r.id) ?? []) {
    if (!dir || !ids.has(to) || dir[0] === 0 || dir[1] === 0) continue
    const [ax, ay] = out.get(r.id)!, [bx, by] = out.get(to)!
    const dx = (bx - ax) * dir[0], dy = (by - ay) * dir[1]
    if (dx > 0 && dx === dy) continue                 // already on the line
    const k = Math.max(1, dx > 0 ? dx : 0, dy > 0 ? dy : 0)
    if (!pinnedY.has(to) && dx > 0) out.set(to, [bx, ay + dir[1] * dx])
    else if (!pinnedX.has(to) && dy > 0) out.set(to, [ax + dir[0] * dy, by])
    else if (!pinnedX.has(to) && !pinnedY.has(to)) out.set(to, [ax + dir[0] * k, ay + dir[1] * k])
  }

  // One room per cell.
  const cells = new Map<string, number>()
  for (const r of rooms) {
    let [x, y] = out.get(r.id)!
    if (cells.has(key(x, y))) {
      const free = spiral(x, y, 12, (cx, cy) => !cells.has(key(cx, cy)))
      if (free) [x, y] = free
      out.set(r.id, [x, y])
    }
    cells.set(key(x, y), r.id)
  }

  // Relax: a room whose exit still isn't straight moves onto that exit's line
  // when the cell is free and the move doesn't bend more of its exits than it
  // straightens.
  const straightCount = (id: number, x: number, y: number) => {
    let n = 0
    for (const { to, dir } of links.get(id) ?? []) {
      if (!dir || !ids.has(to)) continue
      const [tx, ty] = out.get(to)!
      if (isStraight(x, y, tx, ty, dir)) n++
    }
    return n
  }
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0
    for (const r of rooms) for (const { to, dir } of links.get(r.id) ?? []) {
      if (!dir || !ids.has(to)) continue
      const [ax, ay] = out.get(r.id)!, [bx, by] = out.get(to)!
      if (isStraight(ax, ay, bx, by, dir)) continue
      const now = straightCount(to, bx, by)
      const dist = Math.max(1, Math.round(Math.max(Math.abs(bx - ax), Math.abs(by - ay))))
      let best: [number, number] | null = null, bestN = now
      for (let k = 1; k <= Math.max(4, dist + 1); k++) {
        const nx = ax + dir[0] * k, ny = ay + dir[1] * k
        if (cells.has(key(nx, ny))) continue
        const n = straightCount(to, nx, ny)
        if (n > bestN) { bestN = n; best = [nx, ny] }
      }
      if (best) {
        cells.delete(key(bx, by)); cells.set(key(best[0], best[1]), to)
        out.set(to, best); moved++
      }
    }
    if (!moved) break
  }
  return out
}

/** is b on the straight line out from a in direction d? */
function isStraight(ax: number, ay: number, bx: number, by: number, d: Dir): boolean {
  const dx = bx - ax, dy = by - ay
  return dx * d[1] - dy * d[0] === 0 && dx * d[0] + dy * d[1] > 0
}

/** One area's grid: which cells hold rooms, and the lines drawn so far. */
class Grid {
  cells = new Map<string, number>()
  private lines: [number, number, number, number][] = []
  private lineCells = new Map<string, number[]>()
  private static readonly B = 4   // line bucket size, in cells
  private static readonly H = (ROOM_SIZE / 2 + 2) / PITCH

  has(x: number, y: number) { return this.cells.has(key(x, y)) }
  put(x: number, y: number, id: number) { this.cells.set(key(x, y), id) }
  /** empty, not on a line, and (if `near` given) no room next to it but those */
  free(x: number, y: number, near: Set<number> | null = null): boolean {
    if (this.has(x, y)) return false
    if (near) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const id = this.cells.get(key(x + dx, y + dy))
      if (id !== undefined && !near.has(id)) return false
    }
    return !this.onLine(x, y)
  }
  addLine(x1: number, y1: number, x2: number, y2: number) {
    const i = this.lines.push([x1, y1, x2, y2]) - 1
    const B = Grid.B
    for (let bx = Math.floor(Math.min(x1, x2) / B); bx <= Math.floor(Math.max(x1, x2) / B); bx++)
      for (let by = Math.floor(Math.min(y1, y2) / B); by <= Math.floor(Math.max(y1, y2) / B); by++) {
        const k = key(bx, by)
        if (!this.lineCells.has(k)) this.lineCells.set(k, [])
        this.lineCells.get(k)!.push(i)
      }
  }
  /** does an existing line pass through this cell's room square? */
  onLine(x: number, y: number): boolean {
    const B = Grid.B
    for (const i of this.lineCells.get(key(Math.floor(x / B), Math.floor(y / B))) ?? []) {
      const s = this.lines[i]
      if ((s[0] === x && s[1] === y) || (s[2] === x && s[3] === y)) continue
      if (segHitsBox(s, x, y, Grid.H)) return true
    }
    return false
  }
  /** would a line from a to b pass through any room other than its ends? */
  blocked(ax: number, ay: number, bx: number, by: number): boolean {
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
        if ((x === ax && y === ay) || (x === bx && y === by) || !this.has(x, y)) continue
        if (segHitsBox([ax, ay, bx, by], x, y, Grid.H)) return true
      }
    return false
  }
}

const ALL_DIRS: Dir[] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

export function buildLayout(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): DaLayout {
  const out: DaLayout = { imageIndex: new Map(), pos: new Map(), size: new Map(), areaOf: new Map() }
  const cell = new Map<number, [number, number]>()   // room id → grid cell in its area
  const grids = new Map<string, Grid>()

  // Both directions of every exit, since many shop exits are one-way in the DB.
  const links: Links = new Map()
  const link = (a: number, b: number, dir: Dir | null) => {
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

  const setRoom = (id: number, area: string, x: number, y: number) => {
    grids.get(area)!.put(x, y, id)
    cell.set(id, [x, y])
    out.areaOf.set(id, area)
    out.imageIndex.get(area)!.push(lichDb.get(id)!)
  }
  /** record the lines from a room to every neighbour already on the grid */
  const addLines = (id: number, area: string) => {
    const g = grids.get(area)!, [x, y] = cell.get(id)!
    for (const { to } of links.get(id) ?? []) {
      if (out.areaOf.get(to) !== area) continue
      const [tx, ty] = cell.get(to)!
      if (Math.max(Math.abs(tx - x), Math.abs(ty - y)) <= 12) g.addLine(x, y, tx, ty)
    }
  }
  /** an offset that puts these cells below everything else in the area */
  const belowEverything = (area: string, cells: [number, number][]): [number, number] => {
    let maxY = -Infinity, minX = Infinity
    for (const r of out.imageIndex.get(area) ?? []) { const c = cell.get(r.id)!; maxY = Math.max(maxY, c[1]); minX = Math.min(minX, c[0]) }
    if (maxY === -Infinity) { maxY = -3; minX = 0 }
    const minY = Math.min(...cells.map(c => c[1])), cMinX = Math.min(...cells.map(c => c[0]))
    return [minX - cMinX, maxY + 3 - minY]
  }

  // 1. Towns and other hand-drawn areas, straightened.
  const interiorOf = findInteriorTiles(lichDb, imageIndex)
  for (const [image, rooms] of imageIndex) {
    if (interiorOf.has(image)) continue
    const list = rooms.filter(hasCoords)
    if (!list.length) continue
    out.imageIndex.set(image, [])
    grids.set(image, new Grid())
    const g = straighten(list, links)
    for (const r of list) { const [x, y] = g.get(r.id)!; setRoom(r.id, image, x, y) }
    for (const r of list) addLines(r.id, image)
  }

  // 2. Building tiles: each connected group keeps its straightened shape and
  // is set down whole beside its door, with an empty cell all round it.
  const placeBlock = (area: string, comp: LichRoom[]) => {
    const grid = grids.get(area)!
    const local = straighten(comp, links)
    const ids = new Set(comp.map(r => r.id))
    let door: { inner: number; outer: [number, number]; dir: Dir | null } | null = null
    for (const r of comp) {
      for (const { to, dir } of links.get(r.id) ?? []) {
        if (out.areaOf.get(to) === area && !ids.has(to)) { door = { inner: r.id, outer: cell.get(to)!, dir: dir ? [-dir[0], -dir[1]] : null }; break }
      }
      if (door) break
    }
    const inner: [number, number, number, number][] = []
    for (const r of comp) for (const { to } of links.get(r.id) ?? []) {
      if (ids.has(to) && to > r.id) { const a = local.get(r.id)!, b = local.get(to)!; inner.push([a[0], a[1], b[0], b[1]]) }
    }
    const fits = (ox: number, oy: number) => {
      for (const [x, y] of local.values()) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (grid.has(x + ox + dx, y + oy + dy)) return false
        if (grid.onLine(x + ox, y + oy)) return false
      }
      for (const [x1, y1, x2, y2] of inner) if (grid.blocked(x1 + ox, y1 + oy, x2 + ox, y2 + oy)) return false
      if (door) {
        const [ix, iy] = local.get(door.inner)!
        if (grid.blocked(door.outer[0], door.outer[1], ix + ox, iy + oy)) return false
      }
      return true
    }
    let off: [number, number] | null = null
    if (door) {
      // Straight out from the door first, then the nearest clear spot.
      const [ix, iy] = local.get(door.inner)!
      for (const [dx, dy] of door.dir ? [door.dir] : ALL_DIRS) {
        for (let k = 2; k <= 6 && !off; k++) {
          const ox = door.outer[0] + dx * k - ix, oy = door.outer[1] + dy * k - iy
          if (fits(ox, oy)) off = [ox, oy]
        }
        if (off) break
      }
      if (!off) {
        const [dx, dy] = door.dir ?? [0, 1]
        const bx = door.outer[0] + dx * 2 - ix, by = door.outer[1] + dy * 2 - iy
        off = spiral(bx, by, 40, fits)
      }
    }
    if (!off) off = belowEverything(area, [...local.values()])
    for (const r of comp) { const [x, y] = local.get(r.id)!; setRoom(r.id, area, x + off[0], y + off[1]) }
    for (const r of comp) addLines(r.id, area)
  }

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

  // 3. Rooms with no position: out along the line of the exit that leads
  // there, as close as a clear cell allows.
  const placeOne = (id: number, area: string, from: number, dir: Dir | null) => {
    const grid = grids.get(area)!
    const [fx, fy] = cell.get(from)!
    // Every neighbour already on the map, with the bearing from it to this room.
    const placed = (links.get(id) ?? [])
      .filter(l => out.areaOf.get(l.to) === area)
      .map(l => ({ at: cell.get(l.to)!, dir: l.dir ? [-l.dir[0], -l.dir[1]] as Dir : null }))
    const near = new Set((links.get(id) ?? []).filter(l => out.areaOf.get(l.to) === area).map(l => l.to))
    const clear = (x: number, y: number) => grid.free(x, y, near) && !grid.blocked(fx, fy, x, y)
    const straight = (x: number, y: number) => placed.reduce((n, p) => n + (p.dir && isStraight(p.at[0], p.at[1], x, y, p.dir) ? 1 : 0), 0)
    // Candidates: out along every placed neighbour's exit line; the cell that
    // makes the most of this room's exits straight wins, then the closest.
    let best: [number, number] | null = null, bestScore = -Infinity
    const consider = (x: number, y: number, k: number) => {
      if (!clear(x, y)) return
      const score = straight(x, y) * 100 - k
      if (score > bestScore) { bestScore = score; best = [x, y] }
    }
    for (const p of placed) {
      if (!p.dir) continue
      for (let k = 1; k <= 8; k++) consider(p.at[0] + p.dir[0] * k, p.at[1] + p.dir[1] * k, k)
    }
    if (!best) for (const d of dir ? [dir, ...ALL_DIRS] : ALL_DIRS) for (let k = 2; k <= 8; k++) consider(fx + d[0] * k, fy + d[1] * k, k + 10)
    const at: [number, number] = best ?? spiral(fx, fy, 40, (x, y) => grid.free(x, y)) ?? [fx, fy + 50]
    setRoom(id, area, at[0], at[1])
    addLines(id, area)
  }
  const grow = (start: number[]) => {
    let frontier = start
    while (frontier.length) {
      const next: number[] = []
      for (const id of frontier) {
        const area = out.areaOf.get(id)!
        for (const { to, dir } of links.get(id) ?? []) {
          if (out.areaOf.has(to)) continue
          placeOne(to, area, id, dir)
          next.push(to)
        }
      }
      frontier = next
    }
  }
  grow([...cell.keys()])

  // 4. Islands that never connect to a positioned room.
  for (const r of lichDb.values()) {
    if (out.areaOf.has(r.id)) continue
    // A room with no exit in or out at all (Lich can't reach it either) would
    // be a lone square on a map of its own; leave it off.
    if (!links.get(r.id)?.length) continue
    const area = UNMAPPED_PREFIX + ((r.location ?? '').trim() || 'Unmapped')
    if (!grids.has(area)) { grids.set(area, new Grid()); out.imageIndex.set(area, []) }
    const [ox, oy] = belowEverything(area, [[0, 0]])
    setRoom(r.id, area, ox, oy)
    grow([r.id])
  }

  for (const [id, [x, y]] of cell) { out.pos.set(id, [x * PITCH, y * PITCH]); out.size.set(id, ROOM_SIZE) }
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
    const outN = new Map<string, number>(), back = new Map<string, number>()
    for (const r of list) for (const [k, m] of Object.entries(r.wayto ?? {})) {
      const t = areaOf.get(Number(k))
      if (t && t !== image && walk(m)) outN.set(t, (outN.get(t) ?? 0) + 1)
    }
    for (const [other, rs] of imageIndex) {
      if (other === image || !outN.has(other)) continue
      for (const r of rs) for (const [k, m] of Object.entries(r.wayto ?? {})) {
        if (areaOf.get(Number(k)) === image && walk(m)) back.set(other, (back.get(other) ?? 0) + 1)
      }
    }
    const best = [...outN.entries()].filter(([o]) => back.has(o)).sort((a, b) => (b[1] + back.get(b[0])!) - (a[1] + back.get(a[0])!))[0]
    if (!best) continue
    if ((count.get(best[0]) ?? 0) <= list.length) continue
    result.set(image, best[0])
  }
  // Don't chain: a tile folded into another interior tile stays separate.
  for (const [child, parent] of [...result]) if (result.has(parent)) result.delete(child)
  return result
}
