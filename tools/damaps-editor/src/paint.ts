// DaMaps Editor — paints a floor's picture from the map itself.
//
// Links with a surface (Road, Dirt path, Bridge, River) become smooth strips
// drawn with Kaesken's Clip Studio brushes (brushes/, 32 px per map unit, the
// strip running along the image's long side). Rooms marked as a building get
// ONE roof per building: joined rooms with the same building name are joined
// into one shape and roofed together, with the ridge following the rooms.
//
// Drawn with the 2D canvas, so the editor's live preview and the exported
// picture are the same pixels at different sizes. Nothing here knows about the
// editor's state; it only reads the map.
//
// Order, bottom to top: ground, river, dirt paths, roads, bridges, roofs.
// Within a kind, short pieces go first, so a side street that ends in a main
// road tucks under it rather than drawing across it.

import { type DaMapFile, type DaMapRoom } from '../../damaps/damapFormat'

/** The palette from the brush pack's palette.txt ("night town"). */
const GROUND = '#0B0C0E'
const ROOF_EDGE = '#2C2F36'
const ROOF_RIDGE = '#30343B'
const BRUSH_PX = 32                 // the brush images' pixels per map unit

export interface Brushes {
  road: CanvasImageSource; dirt: CanvasImageSource; bridge: CanvasImageSource; river: CanvasImageSource
  bridgeStone: CanvasImageSource; roofTiles: CanvasImageSource; grain: CanvasImageSource
}
type Strip = 'road' | 'dirt' | 'bridge' | 'river'
/** How wide each strip is, in map units (a room is 8). */
const WIDTH: Record<Strip, number> = { river: 16, dirt: 6, road: 7, bridge: 7 }
const ORDER: string[] = ['river', 'dirt', 'road', 'bridge', 'bridge-stone']

/** Load the brush images (from the editor's brushes/ folder), turned so every strip runs top to bottom. */
export async function loadBrushes(base = 'brushes/'): Promise<Brushes> {
  const img = (f: string) => new Promise<HTMLImageElement>((ok, bad) => {
    const i = new Image()
    i.onload = () => ok(i); i.onerror = () => bad(new Error(`brush ${f} didn't load`))
    i.src = base + f
  })
  const upright = (i: HTMLImageElement): CanvasImageSource => {
    if (i.naturalHeight >= i.naturalWidth) return i
    const c = document.createElement('canvas')
    c.width = i.naturalHeight; c.height = i.naturalWidth
    const g = c.getContext('2d')!
    g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(i, 0, 0)
    return c
  }
  const [road, dirt, bridge, river, bridgeStone, roofTiles, grain] = await Promise.all(
    ['road.png', 'dirt.png', 'bridge.png', 'river.png', 'bridge-stone.png', 'roof-tiles.png', 'grain.png'].map(img))
  return { road: upright(road), dirt: upright(dirt), bridge: upright(bridge), river: upright(river), bridgeStone, roofTiles, grain }
}

const sizeOf = (s: CanvasImageSource) => {
  const o = s as { naturalWidth?: number; width: number; naturalHeight?: number; height: number }
  return { w: o.naturalWidth || o.width, h: o.naturalHeight || o.height }
}

/** Whether a floor has anything to paint. */
export function floorHasArt(m: DaMapFile, z: number): boolean {
  return m.rooms.some(r => r.z === z && (r.building || r.exits.some(e => e.surface)))
}

/** The area a floor's picture covers, in map units: every room and place name, with a margin. */
export function floorBounds(m: DaMapFile, z: number, margin = 30) {
  const xs: number[] = [], ys: number[] = []
  for (const r of m.rooms) if (r.z === z) { xs.push(r.x); ys.push(r.y) }
  for (const l of m.labels) if (l.z === z) { xs.push(l.x); ys.push(l.y) }
  if (!xs.length) return null
  const x = Math.floor(Math.min(...xs) - margin), y = Math.floor(Math.min(...ys) - margin)
  return { x, y, w: Math.ceil(Math.max(...xs) + margin) - x, h: Math.ceil(Math.max(...ys) + margin) - y }
}

interface Paint { g: CanvasRenderingContext2D; s: number; ox: number; oy: number }
const px = (p: Paint, x: number, y: number): [number, number] => [(x - p.ox) * p.s, (y - p.oy) * p.s]

/**
 * Paint floor `z` into `g`. The canvas's top-left is map point (ox, oy) and it
 * has `scale` pixels per map unit. `ground` fills the background; without it
 * the picture is transparent where nothing is drawn.
 */
export function paintFloor(g: CanvasRenderingContext2D, m: DaMapFile, z: number, b: Brushes,
  opts: { ox: number; oy: number; scale: number; ground?: boolean }) {
  const p: Paint = { g, s: opts.scale, ox: opts.ox, oy: opts.oy }
  const { width: W, height: H } = g.canvas
  g.save()
  g.imageSmoothingQuality = 'high'
  if (opts.ground !== false) {
    g.fillStyle = GROUND
    g.fillRect(0, 0, W, H)
    // a whisper of grain keeps big dark areas from looking flat (palette.txt)
    const grain = g.createPattern(b.grain, 'repeat')
    if (grain) {
      grain.setTransform(new DOMMatrix().scaleSelf(opts.scale / BRUSH_PX * 2))
      g.globalAlpha = 0.06; g.globalCompositeOperation = 'overlay'
      g.fillStyle = grain; g.fillRect(0, 0, W, H)
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'
    }
  }
  const rooms = m.rooms.filter(r => r.z === z)
  const byId = new Map(rooms.map(r => [r.id, r]))
  const edges = surfaceEdges(rooms, byId)
  for (const kind of ORDER) {
    const mine = edges.filter(e => e.kind === kind)
    if (!mine.length) continue
    if (kind === 'bridge-stone') { for (const e of mine) stoneBridge(p, b, byId.get(e.a)!, byId.get(e.b)!); continue }
    const chains = chainsOf(mine, byId).sort((x, y) => chainLength(x, byId) - chainLength(y, byId))
    for (const c of chains) strip(p, b[kind as Strip], WIDTH[kind as Strip], c.map(id => byId.get(id)!), kind === 'bridge')
  }
  for (const bld of buildingsOf(rooms, byId)) roof(p, b, bld)
  g.restore()
}

// ── Paths ───────────────────────────────────────────────────────────────────

interface Edge { a: number; b: number; kind: string }
/** One edge per pair of linked rooms that has a surface (either way's exit may carry it). */
function surfaceEdges(rooms: DaMapRoom[], byId: Map<number, DaMapRoom>): Edge[] {
  const seen = new Map<string, Edge>()
  for (const r of rooms) for (const e of r.exits) {
    if (!e.surface || !byId.has(e.to) || e.to === r.id) continue
    const key = r.id < e.to ? `${r.id}-${e.to}` : `${e.to}-${r.id}`
    if (!seen.has(key)) seen.set(key, { a: r.id, b: e.to, kind: e.surface })
  }
  return [...seen.values()]
}

/**
 * Join edges into runs that a single curve can follow. Where several edges meet,
 * the two that line up best (nearest to straight on) carry on through; the rest
 * end there, under the through road.
 */
function chainsOf(edges: Edge[], byId: Map<number, DaMapRoom>): number[][] {
  const adj = new Map<number, number[]>()
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a)!.push(e.b); adj.get(e.b)!.push(e.a)
  }
  // at each room, which neighbour continues the run from which
  const through = new Map<string, number>()
  const ang = (from: number, to: number) => { const a = byId.get(from)!, b = byId.get(to)!; return Math.atan2(b.y - a.y, b.x - a.x) }
  for (const [n, ns] of adj) {
    if (ns.length < 2) continue
    const pairs: [number, number, number][] = []
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      let d = Math.abs(ang(n, ns[i]) - ang(n, ns[j])); if (d > Math.PI) d = 2 * Math.PI - d
      pairs.push([d, ns[i], ns[j]])
    }
    pairs.sort((x, y) => y[0] - x[0])
    const used = new Set<number>()
    for (const [d, x, y] of pairs) {
      if (used.has(x) || used.has(y)) continue
      // a bend sharper than ~70° from straight reads as two roads meeting, not one road turning,
      // except where only two meet (a street that turns a corner)
      if (ns.length > 2 && d < Math.PI * 0.6) continue
      used.add(x); used.add(y)
      through.set(`${n}:${x}`, y); through.set(`${n}:${y}`, x)
    }
  }
  const done = new Set<string>()
  const ek = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
  const walk = (prev: number, cur: number, out: number[]) => {
    for (;;) {
      const next = through.get(`${cur}:${prev}`)
      if (next == null || done.has(ek(cur, next))) return
      done.add(ek(cur, next)); out.push(next)
      prev = cur; cur = next
    }
  }
  const chains: number[][] = []
  for (const e of edges) {
    if (done.has(ek(e.a, e.b))) continue
    done.add(ek(e.a, e.b))
    const fwd = [e.b]; walk(e.a, e.b, fwd)
    const back: number[] = []; walk(e.b, e.a, back)
    chains.push([...back.reverse(), e.a, ...fwd])
  }
  return chains
}
const chainLength = (c: number[], byId: Map<number, DaMapRoom>) => {
  let L = 0
  for (let i = 1; i < c.length; i++) { const a = byId.get(c[i - 1])!, b = byId.get(c[i])!; L += Math.hypot(b.x - a.x, b.y - a.y) }
  return L
}

/** A smooth curve through the rooms' centres (centripetal Catmull-Rom), as points about half a unit apart. */
function smooth(pts: { x: number; y: number }[], closed: boolean): { x: number; y: number }[] {
  if (pts.length < 3) return densify(pts)
  const P = closed ? [pts[pts.length - 2], ...pts, pts[1]] : [mirror(pts[1], pts[0]), ...pts, mirror(pts[pts.length - 2], pts[pts.length - 1])]
  const out: { x: number; y: number }[] = []
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]]
    const t = (a: typeof p0, b: typeof p0) => Math.pow(Math.hypot(b.x - a.x, b.y - a.y), 0.5) || 1e-3
    const t1 = t(p0, p1), t2 = t1 + t(p1, p2), t3 = t2 + t(p2, p3)
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 0.5))
    for (let k = 0; k < n; k++) {
      const u = t1 + (t2 - t1) * (k / n)
      const lerp = (a: typeof p0, b: typeof p0, ta: number, tb: number) => {
        const w = (u - ta) / (tb - ta)
        return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }
      }
      const A1 = lerp(p0, p1, 0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3)
      const B1 = lerp(A1, A2, 0, t2), B2 = lerp(A2, A3, t1, t3)
      out.push(lerp(B1, B2, t1, t2))
    }
  }
  out.push(pts[pts.length - 1])
  return out
}
const mirror = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: 2 * b.x - a.x, y: 2 * b.y - a.y })
function densify(pts: { x: number; y: number }[]) {
  const out: { x: number; y: number }[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5))
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * Draw a brush image along a curve, the way a Clip Studio ribbon brush does:
 * the image's width spans the path and its length repeats along it, bending
 * with the curve a sliver at a time.
 */
function strip(p: Paint, img: CanvasImageSource, width: number, rooms: DaMapRoom[], shadow: boolean) {
  const closed = rooms.length > 3 && rooms[0].id === rooms[rooms.length - 1].id
  const pts = smooth(rooms.map(r => ({ x: r.x, y: r.y })), closed)
  const { w: iw, h: ih } = sizeOf(img)
  const unitsPerImg = width * ih / iw          // how long one copy of the image is, along the path
  const g = p.g
  if (shadow) {
    // bridges cast a soft shadow down-right (palette.txt)
    g.save()
    // shadowBlur, not a blur filter: a filter blurs a layer the size of the whole picture, every time
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = width * p.s; g.lineCap = 'round'; g.lineJoin = 'round'
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 1.2 * p.s; g.shadowOffsetX = 1.2 * p.s; g.shadowOffsetY = 1.6 * p.s
    g.beginPath()
    pts.forEach((q, i) => { const [x, y] = px(p, q.x, q.y); if (i) g.lineTo(x, y); else g.moveTo(x, y) })
    g.stroke(); g.restore()
  }
  let along = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-6) continue
    const angle = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2
    // source rows for this sliver, wrapping round the image
    let v = (along / unitsPerImg % 1) * ih
    let left = len / unitsPerImg * ih
    let d = 0
    const [x0, y0] = px(p, a.x, a.y)
    g.save()
    g.translate(x0, y0); g.rotate(angle)
    const scale = len * p.s / (len / unitsPerImg * ih)   // destination px per source row
    while (left > 1e-6) {
      const take = Math.min(left, ih - v)
      // a hair of overlap so slivers never show a seam
      g.drawImage(img, 0, v, iw, take, -width * p.s / 2, d * scale, width * p.s, take * scale + 0.75)
      d += take; left -= take; v = 0
    }
    g.restore()
    along += len
  }
}

/** A stone bridge: the bridge picture stretched along a straight link. */
function stoneBridge(p: Paint, b: Brushes, r1: DaMapRoom, r2: DaMapRoom) {
  const { w: iw, h: ih } = sizeOf(b.bridgeStone)
  const len = Math.hypot(r2.x - r1.x, r2.y - r1.y)
  if (!len) return
  const thick = 9, g = p.g
  const [x, y] = px(p, r1.x, r1.y)
  g.save()
  g.translate(x, y); g.rotate(Math.atan2(r2.y - r1.y, r2.x - r1.x))
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 1.5 * p.s; g.shadowOffsetX = 1 * p.s; g.shadowOffsetY = 1.4 * p.s
  g.drawImage(b.bridgeStone, 0, 0, iw, ih, -2 * p.s, -thick / 2 * p.s, (len + 4) * p.s, thick * p.s)
  g.restore()
}

// ── Buildings ───────────────────────────────────────────────────────────────

/** Joined rooms with the same building name, each set one building. */
export function buildingsOf(rooms: DaMapRoom[], byId: Map<number, DaMapRoom>): DaMapRoom[][] {
  const parent = new Map<number, number>()
  const find = (x: number): number => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  const name = (r: DaMapRoom) => r.building!.trim().toLowerCase()
  for (const r of rooms) if (r.building) parent.set(r.id, r.id)
  for (const r of rooms) {
    if (!r.building) continue
    for (const e of r.exits) {
      const o = byId.get(e.to)
      if (o?.building && name(o) === name(r)) parent.set(find(r.id), find(o.id))
    }
  }
  const groups = new Map<number, DaMapRoom[]>()
  for (const r of rooms) if (r.building) {
    const k = find(r.id)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  return [...groups.values()]
}

/** Half a room's footprint under a roof, in map units (a room is 8 across, rooms usually 20 apart). */
const HALF = 9

/**
 * One roof over a whole building: the rooms' squares, joined along their
 * links, filled with roof tiles, edged, with the ridge running room to room and
 * hip lines out to the corners at its ends.
 */
function roof(p: Paint, b: Brushes, rooms: DaMapRoom[]) {
  const g = p.g
  const ids = new Set(rooms.map(r => r.id))
  const links: [DaMapRoom, DaMapRoom][] = []
  const seen = new Set<string>()
  for (const r of rooms) for (const e of r.exits) {
    if (!ids.has(e.to) || e.to === r.id) continue
    const k = r.id < e.to ? `${r.id}-${e.to}` : `${e.to}-${r.id}`
    if (seen.has(k)) continue
    seen.add(k)
    links.push([r, rooms.find(o => o.id === e.to)!])
  }
  const shape = (half: number) => {
    const path = new Path2D()
    for (const r of rooms) {
      const [x, y] = px(p, r.x - half, r.y - half)
      path.rect(x, y, half * 2 * p.s, half * 2 * p.s)
    }
    for (const [a, c] of links) {
      // a band between the two squares, as wide as a square, so they read as one building
      const dx = c.x - a.x, dy = c.y - a.y, L = Math.hypot(dx, dy)
      if (!L) continue
      const nx = -dy / L * half, ny = dx / L * half
      const pts = [[a.x + nx, a.y + ny], [c.x + nx, c.y + ny], [c.x - nx, c.y - ny], [a.x - nx, a.y - ny]].map(([x, y]) => px(p, x, y))
      // wind it the same way as rect() (clockwise on screen), or "nonzero" would cut a hole where they overlap
      let area = 0
      for (let i = 0; i < 4; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4]; area += x1 * y2 - x2 * y1 }
      if (area < 0) pts.reverse()
      path.moveTo(...pts[0]); for (const q of pts.slice(1)) path.lineTo(...q); path.closePath()
    }
    return path
  }
  const outer = shape(HALF), inner = shape(HALF - 0.7)
  // which way the roof runs: along the building's longer side
  const xs = rooms.map(r => r.x), ys = rooms.map(r => r.y)
  const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)

  g.save()
  // the edge, casting a soft shadow down-right
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.58)'; g.shadowBlur = 1.5 * p.s; g.shadowOffsetX = 1.2 * p.s; g.shadowOffsetY = 1.8 * p.s
  g.fillStyle = ROOF_EDGE; g.fill(outer, 'nonzero')
  g.restore()
  const tiles = g.createPattern(b.roofTiles, 'repeat')
  if (tiles) {
    const k = p.s / BRUSH_PX * 1.4
    tiles.setTransform(wide ? new DOMMatrix().scaleSelf(k) : new DOMMatrix().rotateSelf(90).scaleSelf(k))
    g.fillStyle = tiles
  } else g.fillStyle = '#202228'
  g.fill(inner, 'nonzero')
  // light from the top-left: one slope a shade lighter than the other
  g.save()
  g.clip(inner, 'nonzero')
  const [cx0, cy0] = px(p, Math.min(...xs) - HALF, Math.min(...ys) - HALF)
  const [cx1, cy1] = px(p, Math.max(...xs) + HALF, Math.max(...ys) + HALF)
  const grad = g.createLinearGradient(cx0, cy0, wide ? cx0 : cx1, wide ? cy1 : cy0)
  grad.addColorStop(0, 'rgba(255,255,255,0.05)'); grad.addColorStop(0.5, 'rgba(255,255,255,0)')
  grad.addColorStop(0.5, 'rgba(0,0,0,0.10)'); grad.addColorStop(1, 'rgba(0,0,0,0.14)')
  g.fillStyle = grad; g.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0)

  // ridge and hips
  g.strokeStyle = ROOF_RIDGE; g.lineWidth = Math.max(1, 0.45 * p.s); g.lineCap = 'round'
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const [a, c] = [px(p, x1, y1), px(p, x2, y2)]
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke()
  }
  const h = HALF - 0.7
  if (rooms.length === 1 || !links.length) {
    for (const r of rooms) {
      // a hipped roof on one square: a short ridge along the long way and four hips
      const rx = wide ? 3 : 0, ry = wide ? 0 : 3
      line(r.x - rx, r.y - ry, r.x + rx, r.y + ry)
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const ex = r.x + (wide ? sx * rx : 0), ey = r.y + (wide ? 0 : sy * ry)
        line(r.x + sx * h, r.y + sy * h, ex, ey)
      }
    }
  } else {
    for (const [a, c] of links) line(a.x, a.y, c.x, c.y)
    const degree = new Map<number, DaMapRoom[]>()
    for (const [a, c] of links) {
      if (!degree.has(a.id)) degree.set(a.id, [])
      if (!degree.has(c.id)) degree.set(c.id, [])
      degree.get(a.id)!.push(c); degree.get(c.id)!.push(a)
    }
    for (const r of rooms) {
      const ns = degree.get(r.id) ?? []
      if (ns.length !== 1) continue
      // the end of the ridge: hips out to the two corners facing away from the rest of the building
      const n = ns[0], dx = n.x - r.x, dy = n.y - r.y
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        .map(([sx, sy]) => ({ x: r.x + sx * h, y: r.y + sy * h, d: sx * dx + sy * dy }))
        .sort((u, v) => u.d - v.d)
      line(corners[0].x, corners[0].y, r.x, r.y)
      line(corners[1].x, corners[1].y, r.x, r.y)
    }
  }
  g.restore()
  g.restore()
}
