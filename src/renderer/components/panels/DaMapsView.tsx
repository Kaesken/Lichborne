// Da'Maps view — the third map mode behind MapPanel ("Lich Map" / "Genie Maps"
// / "Da'Maps"). Two sources for WHERE rooms are drawn:
//   - the player's Genie maps (when Lichborne has their folder): the hand-laid
//     community layout, each square matched to a Lich room (damaps/genieMatch.ts,
//     damaps/genieArea.ts);
//   - otherwise Lich's own map tiles, laid out on a grid (damaps/daMapsLayout.ts).
// Identity and travel are always Lich: room ids and `;go2`. See
// damaps/daMapsData.ts for the data model and the PERCEIVE / FORAGE capture.
//
// Interaction model:
//   - hover a room        → the side panel's "Room" tab shows it
//   - left-click a room   → pin it in the "Room" tab (click again to unpin);
//                           a boundary marker opens the map it leads to
//   - right-click a room  → `;go2 <lich id>`
//   - drag to pan, wheel to zoom
import { useState, useRef, useEffect, useMemo, useCallback, type CSSProperties } from 'react'
import { buildLayout, type DaLayout } from './damaps/daMapsLayout'
import type { LichRoom, GenieZone } from './mapTypes'
import { COLOR_LEGEND } from './mapTypes'
import { matchGenieToLich, type GenieMatch } from './damaps/genieMatch'
import { buildGenieArea, genieAreaKey, genieLevels, parseGenieAreaKey, zoneIdByFile } from './damaps/genieArea'
import { lichTitle } from './mapTypes'
import { scopedKey } from '../../characterScope'
import {
  DA_MAPS_NAME, DA_ARC_COLOR, DA_CATEGORIES, DA_OBS_EVENT, ROOM_REALMS, MANA_WORDS,
  buildArea, areaProvince, LABEL_FONT, CHAR_W, guildRealm, loadObservations, PROVINCE_ORDER,
  type DaArea, type DaRoom, type DaArcCategory, type Realm, type DaObservations,
} from './damaps/daMapsData'

interface Props {
  lichDb:        Map<number, LichRoom>
  imageIndex:    Map<string, LichRoom[]>
  currentRoom?:  LichRoom
  /** the player's Genie maps, when loaded — used for room placement only */
  genieZones?:   Map<string, GenieZone>
  character:     string
  onSendCommand: (cmd: string) => void
}

interface Transform { x: number; y: number; scale: number }

const PANEL_FONT = 'calc(var(--panel-font-size, var(--game-font-size, 12px)) * 0.9)'
const MIN_SCALE = 0.05
const MAX_SCALE = 8
/** At or above this zoom, indoor rooms are drawn; below it, buildings are outlines. */
const INDOOR_SCALE = 1.4
const PANEL_W = 270
// Global view layout (world units): each area is a thumbnail in a grid cell,
// grouped by province.
const G_COLS = 10, G_CELL = 240, G_THUMB = 200, G_HEAD = 70

interface WorldArea {
  image: string; name: string; province: string; rooms: number
  x: number; y: number          // cell top-left
  s: number; ox: number; oy: number   // thumbnail transform (area px → world)
  area: DaArea
}
interface World { areas: WorldArea[]; byImage: Map<string, WorldArea>; heads: { name: string; y: number }[]; w: number; h: number }

/**
 * Where rooms are drawn: the player's Genie maps when available, else Lich's
 * own tiles laid out on a grid. Either way squares carry Lich room ids.
 */
interface MapSource {
  kind: 'genie' | 'lich'
  /** one area per map, for Global (Genie: ground floor of each map) */
  globalKeys: string[]
  area(key: string): DaArea | null
  /** the area to show for a Lich room; `prefer` keeps the map you're on when the room is on two */
  areaOf(lichId: number, prefer?: string): string
  province(key: string): string
  /** the other floors of this area's map (Genie), ground floor first */
  floors(key: string): string[]
  /** with a Genie source: how many map squares matched a Lich room */
  stats?: { nodes: number; matched: number }
}

function lichSource(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): MapSource {
  const layout = getLayout(lichDb, imageIndex)
  const cache = new Map<string, DaArea>()
  return {
    kind: 'lich',
    globalKeys: [...layout.imageIndex.keys()],
    area(key) {
      if (!key) return null
      let a = cache.get(key)
      if (!a) {
        const rooms = layout.imageIndex.get(key)
        if (!rooms) return null
        a = buildArea(key, rooms, lichDb, layout)
        cache.set(key, a)
      }
      return a
    },
    areaOf: id => layout.areaOf.get(id) ?? '',
    province: key => areaProvince(key, layout.imageIndex.get(key) ?? []),
    floors: key => [key],
  }
}

function genieSource(zones: Map<string, GenieZone>, lichDb: Map<number, LichRoom>): MapSource {
  const match: GenieMatch = matchGenieToLich(zones, lichDb)
  const files = zoneIdByFile(zones)
  const cache = new Map<string, DaArea>()
  // Lich room → every area key it's drawn in (a room can sit on two maps).
  const keysOf = new Map<number, string[]>()
  for (const [lid, nodes] of match.nodesOf) {
    const keys: string[] = []
    for (const { zoneId, nodeId } of nodes) {
      const n = zones.get(zoneId)?.nodes.find(x => x.id === nodeId)
      if (n) keys.push(genieAreaKey(zoneId, n.z))
    }
    keysOf.set(lid, keys)
  }
  const provinceOf = new Map<string, string>()
  return {
    kind: 'genie',
    globalKeys: [...zones.values()].filter(z => z.nodes.length).map(z => genieAreaKey(z.id, genieLevels(z)[0])),
    area(key) {
      let a = cache.get(key)
      if (!a) {
        const k = parseGenieAreaKey(key)
        const zone = k && zones.get(k.zoneId)
        if (!zone) return null
        a = buildGenieArea(zone, k.level, match, lichDb, files)
        cache.set(key, a)
      }
      return a
    },
    areaOf(id, prefer) {
      const keys = keysOf.get(id) ?? []
      if (prefer && keys.includes(prefer)) return prefer
      const pz = prefer ? parseGenieAreaKey(prefer)?.zoneId : undefined
      return keys.find(k => parseGenieAreaKey(k)?.zoneId === pz) ?? keys[0] ?? ''
    },
    province(key) {
      let p = provinceOf.get(key)
      if (!p) {
        const a = this.area(key)
        const rooms = (a?.rooms ?? []).map(r => (r.lich !== null ? lichDb.get(r.lich) : undefined)).filter((r): r is LichRoom => !!r)
        p = areaProvince(a?.name ?? key, rooms)
        provinceOf.set(key, p)
      }
      return p
    },
    floors(key) {
      const k = parseGenieAreaKey(key)
      const zone = k && zones.get(k.zoneId)
      return zone ? genieLevels(zone).map(l => genieAreaKey(zone.id, l)) : [key]
    },
    stats: match.stats,
  }
}

const sourceCache = new WeakMap<Map<number, LichRoom>, { zones: Map<string, GenieZone> | null; src: MapSource }>()
function getSource(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>, zones: Map<string, GenieZone> | undefined): MapSource {
  const z = zones && zones.size ? zones : null
  const hit = sourceCache.get(lichDb)
  if (hit && hit.zones === z) return hit.src
  const src = z ? genieSource(z, lichDb) : lichSource(lichDb, imageIndex)
  sourceCache.set(lichDb, { zones: z, src })
  return src
}

function buildWorld(src: MapSource): World {
  const groups = new Map<string, WorldArea[]>()
  for (const image of src.globalKeys) {
    const area = src.area(image)
    if (!area || area.rooms.length === 0) continue
    const province = src.province(image)
    const bw = Math.max(1, area.bbox.x2 - area.bbox.x1), bh = Math.max(1, area.bbox.y2 - area.bbox.y1)
    // capped so a tiny area (1-3 rooms) isn't blown up to fill its cell
    const sc = Math.min(G_THUMB / bw, G_THUMB / bh, 1.5)
    const wa: WorldArea = { image, name: area.name, province, rooms: area.rooms.length, x: 0, y: 0, s: sc, ox: 0, oy: 0, area }
    if (!groups.has(province)) groups.set(province, [])
    groups.get(province)!.push(wa)
  }
  const areas: WorldArea[] = [], heads: { name: string; y: number }[] = []
  let y = 0
  for (const prov of PROVINCE_ORDER) {
    const list = (groups.get(prov) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    if (!list.length) continue
    heads.push({ name: prov, y: y + 44 })
    y += G_HEAD
    list.forEach((wa, i) => {
      wa.x = (i % G_COLS) * G_CELL
      wa.y = y + Math.floor(i / G_COLS) * G_CELL
      const bw = (wa.area.bbox.x2 - wa.area.bbox.x1) * wa.s, bh = (wa.area.bbox.y2 - wa.area.bbox.y1) * wa.s
      wa.ox = wa.x + (G_CELL - bw) / 2 - wa.area.bbox.x1 * wa.s
      wa.oy = wa.y + 10 + (G_THUMB - bh) / 2 - wa.area.bbox.y1 * wa.s
      areas.push(wa)
    })
    y += Math.ceil(list.length / G_COLS) * G_CELL
  }
  return { areas, byImage: new Map(areas.map(a => [a.image, a])), heads, w: G_COLS * G_CELL, h: y }
}
const worldCache = new WeakMap<MapSource, World>()
/** "Zoluren 1 Crossing" → "Crossing": the province heading already says where. */
function shortAreaName(name: string): string {
  const out = name.replace(/^(zoluren|therengia|ilithi|ilitha|ilithia|forfedhdar|qi|taisidon)\b\s*/i, '')
    .replace(/^[A-Za-z]?-?\d+[a-z]?\b\s*/, '')
  return out || name
}

// The grid layout of Lich's own tiles (the fallback source). Built once per DB.
const layoutCache = new WeakMap<Map<number, LichRoom>, DaLayout>()
function getLayout(lichDb: Map<number, LichRoom>, imageIndex: Map<string, LichRoom[]>): DaLayout {
  let l = layoutCache.get(lichDb)
  if (!l) { l = buildLayout(lichDb, imageIndex); layoutCache.set(lichDb, l) }
  return l
}

const sectionHead: CSSProperties = {
  fontWeight: 'bold', fontSize: '0.91em', textTransform: 'uppercase', letterSpacing: 0.5,
  marginTop: 8, marginBottom: 4,
}
const muted: CSSProperties = { color: 'var(--map-text-muted, #888)' }

export default function DaMapsView({ lichDb, imageIndex, currentRoom, genieZones, character, onSendCommand }: Props) {
  // ── Areas ──────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'local' | 'global'>('local')
  const src = useMemo(() => getSource(lichDb, imageIndex, genieZones), [lichDb, imageIndex, genieZones])
  // The whole world is built the first time Global is opened, then cached.
  const world = useMemo(() => {
    if (mode !== 'global' && !worldCache.has(src)) return null
    let w = worldCache.get(src)
    if (!w) { w = buildWorld(src); worldCache.set(src, w) }
    return w
  }, [mode, src])
  const [hoverArea, setHoverArea] = useState<string | null>(null)

  const [areaImage, setAreaImage] = useState<string>('')
  const hereImage = currentRoom ? src.areaOf(currentRoom.id, areaImage) : ''
  const [followPlayer, setFollowPlayer] = useState(true)
  const area = useMemo(() => src.area(areaImage), [src, areaImage])
  useEffect(() => { if (!areaImage && hereImage) setAreaImage(hereImage) }, [areaImage, hereImage])
  // A different source (Genie maps just loaded) uses different area keys.
  useEffect(() => { setAreaImage(currentRoom ? src.areaOf(currentRoom.id) : '') }, [src]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera ─────────────────────────────────────────────────────────────────
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 })
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number; moved: boolean } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const fitToView = useCallback(() => {
    const svg = svgRef.current
    if (!svg || !area) return
    const W = svg.clientWidth, H = svg.clientHeight
    const bw = Math.max(1, area.bbox.x2 - area.bbox.x1), bh = Math.max(1, area.bbox.y2 - area.bbox.y1)
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((W - 60) / bw, (H - 60) / bh)))
    setTransform({
      scale,
      x: W / 2 - ((area.bbox.x1 + area.bbox.x2) / 2) * scale,
      y: H / 2 - ((area.bbox.y1 + area.bbox.y2) / 2) * scale,
    })
  }, [area])

  const centerOn = useCallback((room: DaRoom, minScale = 0) => {
    const svg = svgRef.current
    if (!svg) return
    setTransform(t => {
      const scale = Math.max(t.scale, minScale)
      return { scale, x: svg.clientWidth / 2 - room.x * scale, y: svg.clientHeight / 2 - room.y * scale }
    })
  }, [])

  // Follow the player across areas; recentre when they move (only while following).
  const hereRoom = area && currentRoom ? area.byLich.get(currentRoom.id) : undefined
  useEffect(() => {
    if (followPlayer && hereImage && hereImage !== areaImage) setAreaImage(hereImage)
  }, [followPlayer, hereImage, areaImage])
  const fittedFor = useRef('')
  useEffect(() => {
    if (mode !== 'local' || !area || fittedFor.current === area.image) return
    fittedFor.current = area.image
    // A new area: fit it, then (if we're in it) centre on the player.
    requestAnimationFrame(() => {
      fitToView()
      if (followPlayer && hereRoom) requestAnimationFrame(() => centerOn(hereRoom))
    })
  }, [area, fitToView, followPlayer, hereRoom, centerOn, mode])
  useEffect(() => {
    if (mode === 'local' && followPlayer && hereRoom && fittedFor.current === area?.image) centerOn(hereRoom)
  }, [hereRoom?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Switching views: Global remembers where you left it; on first open it
  // centres on the area you're in. Local re-fits its area when you come back.
  const globalTfRef = useRef<Transform | null>(null)
  const localTfRef = useRef<Transform | null>(null)
  function switchMode(next: 'local' | 'global') {
    if (next === mode) return
    if (mode === 'global') globalTfRef.current = transform
    else localTfRef.current = transform
    setMode(next)
  }
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    if (mode === 'global' && world) {
      if (globalTfRef.current) { setTransform(globalTfRef.current); return }
      const W = svg.clientWidth || 800, H = svg.clientHeight || 600
      const here = hereImage ? world.byImage.get(hereImage) : undefined
      if (here) {
        const sc = 0.9
        setTransform({ scale: sc, x: W / 2 - (here.x + G_CELL / 2) * sc, y: H / 2 - (here.y + G_CELL / 2) * sc })
      } else {
        const sc = Math.max(MIN_SCALE, (W - 40) / world.w)
        setTransform({ scale: sc, x: (W - world.w * sc) / 2, y: 20 })
      }
    } else if (mode === 'local') {
      if (localTfRef.current && fittedFor.current === area?.image) setTransform(localTfRef.current)
    }
  }, [mode, world]) // eslint-disable-line react-hooks/exhaustive-deps

  /** a Genie map's ground floor, for a boundary marker that names the map */
  function genieGround(zoneId: string): string {
    return src.floors(genieAreaKey(zoneId, 0))[0] ?? genieAreaKey(zoneId, 0)
  }

  function openArea(image: string) {
    setAreaImage(image)
    setFollowPlayer(image === hereImage)
    localTfRef.current = null
    setMode('local')
  }

  // Wheel zoom around the cursor. Native listener so preventDefault works.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.001)
      setTransform(t => {
        const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor))
        const k = scale / t.scale
        return { scale, x: mx - (mx - t.x) * k, y: my - (my - t.y) * k }
      })
      setFollowPlayer(false)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx: transform.x, ty: transform.y, moved: false }
  }
  function onMouseMove(e: React.MouseEvent) {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    if (!d.moved) { d.moved = true; setIsDragging(true); setFollowPlayer(false) }
    const { tx, ty } = d
    setTransform(t => ({ ...t, x: tx + dx, y: ty + dy }))
  }
  function endDrag() {
    // Let the click handler see `moved` first, then clear on the next tick.
    setTimeout(() => { dragRef.current = null }, 0)
    setIsDragging(false)
  }

  // ── Hover / pin / panel ────────────────────────────────────────────────────
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [hoverBuilding, setHoverBuilding] = useState<number | null>(null)
  const [pinnedId, setPinnedId] = useState<number | null>(null)
  const [showPanel, setShowPanel] = useState(true)
  const [tab, setTab] = useState<'legend' | 'room'>('room')
  useEffect(() => { setHoverId(null); setHoverBuilding(null); setPinnedId(null); setHoverArea(null) }, [areaImage, mode])

  // Every room is always drawn; indoor rooms sit inside a dotted building outline.
  const showIndoor = true

  // Observations (mana / forage) — re-read when the capture records something.
  const [obs, setObs] = useState<DaObservations>(() => loadObservations())
  useEffect(() => {
    const h = () => setObs({ ...loadObservations() })
    document.addEventListener(DA_OBS_EVENT, h)
    return () => document.removeEventListener(DA_OBS_EVENT, h)
  }, [])

  // The character's realm: detected guild first, else the panel's own picker.
  const [pickedRealm, setPickedRealm] = useState<Realm | ''>(() => {
    try { return (localStorage.getItem(scopedKey(character, 'damapsRealm')) as Realm | null) ?? '' } catch { return '' }
  })
  const detectedRealm = useMemo(() => {
    try { return guildRealm(localStorage.getItem(scopedKey(character, 'detectedGuild'))) } catch { return null }
  }, [character])
  const myRealm: Realm | null = detectedRealm ?? (pickedRealm || null)

  // ── Drawing ────────────────────────────────────────────────────────────────
  const arcPaths = useMemo(() => {
    if (!area) return null
    const d: Record<DaArcCategory, string[]> = { cardinal: [], climb: [], go: [] }
    for (const arc of area.arcs) {
      const a = area.byId.get(arc.a)!, b = area.byId.get(arc.b)!
      if (!showIndoor && (a.indoor || b.indoor)) {
        // Zoomed out: keep only lines that touch the street, and end them at
        // the building outline's room, so doors still read as connections.
        if (a.indoor && b.indoor) continue
      }
      d[arc.cat].push(`M${a.x},${a.y}L${b.x},${b.y}`)
    }
    return (['cardinal', 'climb', 'go'] as DaArcCategory[]).map(cat => d[cat].length > 0 && (
      <path key={cat} d={d[cat].join('')} stroke={DA_ARC_COLOR[cat]} strokeWidth={1}
        fill="none" opacity={0.75} vectorEffect="non-scaling-stroke" pointerEvents="none" />
    ))
  }, [area, showIndoor])

  const buildingShapes = useMemo(() => {
    if (!area) return null
    return area.buildings.map((b, i) => b.outline && (
      <rect key={`b${i}`} x={b.x1} y={b.y1} width={b.x2 - b.x1} height={b.y2 - b.y1} rx={2}
        fill={showIndoor ? 'none' : 'var(--map-node-fill, #2a2a2a)'}
        fillOpacity={showIndoor ? 0 : 0.85}
        stroke="var(--map-node-stroke, #555)" strokeWidth={1} vectorEffect="non-scaling-stroke"
        strokeDasharray={showIndoor ? '3 2' : undefined}
        style={{ cursor: showIndoor ? undefined : 'pointer' }}
        pointerEvents={showIndoor ? 'none' : 'all'}
        onMouseEnter={() => { if (!dragRef.current?.moved) { setHoverBuilding(i); setHoverId(null) } }}
        onContextMenu={e => {
          e.preventDefault()
          const first = b.rooms.map(id => area!.byId.get(id)?.lich).find(l => l != null)
          if (first != null) onSendCommand(`;go2 ${first}`)
        }}
      />
    ))
  }, [area, showIndoor, onSendCommand])

  const roomRects = useMemo(() => {
    if (!area) return null
    return area.rooms.filter(r => showIndoor || !r.indoor).map(r => {
      // The Genie map maker's colour wins; otherwise the Lich tags' category.
      const fill = r.fill ?? (r.category ? DA_CATEGORIES[r.category].color : undefined)
      const s = r.size
      return (
        <g key={r.id}>
          <rect x={r.x - s / 2} y={r.y - s / 2} width={s} height={s}
            fill={fill ?? 'var(--map-node-fill, #2a2a2a)'}
            stroke={fill ? 'none' : 'var(--map-node-stroke, #555)'} strokeWidth={1} vectorEffect="non-scaling-stroke"
            strokeDasharray={r.lich === null && !r.stubTo ? '1.5 1.5' : undefined}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => { if (!dragRef.current?.moved) { setHoverId(r.id); setHoverBuilding(null) } }}
            onClick={() => {
              if (dragRef.current?.moved) return
              if (r.stubTo) { openArea(genieGround(r.stubTo)); return }
              setPinnedId(p => (p === r.id ? null : r.id))
              setTab('room'); setShowPanel(true)
            }}
            onContextMenu={e => { e.preventDefault(); if (r.lich !== null) onSendCommand(`;go2 ${r.lich}`) }}
          />
          {r.stubTo && (
            <text x={r.x} y={r.y} fontSize={s + 2} fontWeight="bold" fill="var(--map-arc-special, #ffb74d)"
              textAnchor="middle" dominantBaseline="central" pointerEvents="none">↗</text>
          )}
        </g>
      )
    })
  }, [area, showIndoor, onSendCommand, src]) // eslint-disable-line react-hooks/exhaustive-deps

  const labels = useMemo(() => {
    if (!area) return null
    const roomLabels = area.rooms.filter(r => r.label && (showIndoor || !r.indoor)).map(r => (
      <text key={`r${r.id}`} x={r.lx} y={r.ly} fontSize={LABEL_FONT}
        textLength={r.label.length * CHAR_W} lengthAdjust="spacingAndGlyphs" fontStyle="italic"
        fill="var(--map-text-muted, #999)" pointerEvents="none"
        style={{ fontFamily: 'var(--font-mono, monospace)' }}>{r.label}</text>
    ))
    // Genie maps: the place names their makers set down.
    const texts = (area.texts ?? []).map((t, i) => (
      <text key={`t${i}`} x={t.x + 1} y={t.y + 1} fontSize={LABEL_FONT} fontStyle="italic"
        dominantBaseline="text-before-edge" fill="var(--map-text-muted, #999)" pointerEvents="none"
        style={{ fontFamily: 'var(--font-mono, monospace)' }}>{t.text}</text>
    ))
    return [...texts, ...roomLabels, ...area.buildings
      .filter(b => b.name && b.showLabel)
      .map((b, i) => (
        <text key={`l${i}`} x={b.lx} y={b.ly} fontSize={LABEL_FONT}
          textLength={b.name.length * CHAR_W} lengthAdjust="spacingAndGlyphs" fontStyle="italic"
          fill="var(--map-text-muted, #999)" pointerEvents="none"
          style={{ fontFamily: 'var(--font-mono, monospace)' }}>{b.name}</text>
      ))]
  }, [area, showIndoor])

  const highlight = (id: number | null, stroke: string) => {
    if (!area || id === null) return null
    const r = area.byId.get(id)
    if (!r || (!showIndoor && r.indoor)) return null
    const s = r.size + 4
    return <rect x={r.x - s / 2} y={r.y - s / 2} width={s} height={s} fill="none" stroke={stroke}
      strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
  }

  // ── Global view: every area as a thumbnail of all its rooms ──────────────
  const globalLayer = useMemo(() => {
    if (!world) return null
    return (
      <>
        {world.heads.map(h => (
          <text key={h.name} x={0} y={h.y} fontSize={30} fontStyle="italic" fill="var(--map-text, #ccc)"
            pointerEvents="none" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{h.name}</text>
        ))}
        {world.areas.map(wa => {
          const byFill = new Map<string, string[]>()
          for (const r of wa.area.rooms) {
            const fill = r.fill ?? (r.category ? DA_CATEGORIES[r.category].color : 'var(--map-node-stroke, #555)')
            const sz = Math.max(r.size, 2 / wa.s)
            if (!byFill.has(fill)) byFill.set(fill, [])
            byFill.get(fill)!.push(`M${r.x - sz / 2},${r.y - sz / 2}h${sz}v${sz}h${-sz}z`)
          }
          const arcs = wa.area.arcs.map(a => {
            const p = wa.area.byId.get(a.a)!, q = wa.area.byId.get(a.b)!
            return `M${p.x},${p.y}L${q.x},${q.y}`
          }).join('')
          return (
            <g key={wa.image}>
              <rect x={wa.x + 4} y={wa.y + 4} width={G_CELL - 8} height={G_CELL - 8} rx={6}
                fill="var(--map-node-fill, #222)" fillOpacity={0.35}
                stroke="var(--map-border, #444)" strokeWidth={1} vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => { if (!dragRef.current?.moved) setHoverArea(wa.image) }}
                onClick={() => { if (!dragRef.current?.moved) openArea(wa.image) }} />
              <g transform={`translate(${wa.ox} ${wa.oy}) scale(${wa.s})`} pointerEvents="none">
                <path d={arcs} stroke="var(--map-arc-cardinal, #666)" strokeWidth={1} fill="none"
                  vectorEffect="non-scaling-stroke" opacity={0.7} />
                {[...byFill].map(([fill, d]) => <path key={fill} d={d.join('')} fill={fill} />)}
              </g>
              <text x={wa.x + G_CELL / 2} y={wa.y + G_CELL - 12} fontSize={13} textAnchor="middle"
                fill="var(--map-text-muted, #999)" pointerEvents="none"
                style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {(n => n.length > 30 ? n.slice(0, 29) + '…' : n)(shortAreaName(wa.name))}
              </text>
            </g>
          )
        })}
      </>
    )
  }, [world]) // eslint-disable-line react-hooks/exhaustive-deps

  const globalHere = (() => {
    if (!world || !currentRoom || !hereImage) return null
    const wa = world.byImage.get(hereImage)
    const r = wa?.area.byLich.get(currentRoom.id)
    if (!wa || !r) return null
    const cx = wa.ox + r.x * wa.s, cy = wa.oy + r.y * wa.s
    return (
      <g pointerEvents="none">
        <rect x={wa.x + 4} y={wa.y + 4} width={G_CELL - 8} height={G_CELL - 8} rx={6} fill="none"
          stroke="var(--map-current-color, #2fd08a)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <circle cx={cx} cy={cy} r={9} fill="none" stroke="var(--map-current-color, #2fd08a)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <circle cx={cx} cy={cy} r={3} fill="var(--map-current-color, #2fd08a)" />
      </g>
    )
  })()
  const globalHover = (() => {
    if (!world || !hoverArea) return null
    const wa = world.byImage.get(hoverArea)
    if (!wa) return null
    return <rect x={wa.x + 4} y={wa.y + 4} width={G_CELL - 8} height={G_CELL - 8} rx={6} fill="none"
      stroke="var(--map-text, #eee)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
  })()
  const hoveredWorldArea = world && hoverArea ? world.byImage.get(hoverArea) : undefined

  const hereIndicator = hereRoom && (
    <g pointerEvents="none">
      {!showIndoor && hereRoom.indoor && hereRoom.building !== null && (() => {
        const b = area!.buildings[hereRoom.building!]
        return <rect x={b.x1} y={b.y1} width={b.x2 - b.x1} height={b.y2 - b.y1} fill="none"
          stroke="var(--map-current-color, #2fd08a)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      })()}
      <circle cx={hereRoom.x} cy={hereRoom.y} r={14} fill="none" stroke="var(--map-current-color, #2fd08a)"
        strokeWidth={1.5} vectorEffect="non-scaling-stroke">
        <animate attributeName="r" values="8;22;8" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.9;0.15;0.9" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx={hereRoom.x} cy={hereRoom.y} r={6} fill="none" stroke="var(--map-current-color, #2fd08a)"
        strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <circle cx={hereRoom.x} cy={hereRoom.y} r={2} fill="var(--map-current-color, #2fd08a)" />
    </g>
  )

  // ── Side panel content ─────────────────────────────────────────────────────
  const shownId = pinnedId ?? hoverId ?? (hereRoom ? hereRoom.id : null)
  const shownRoom = area && shownId !== null ? area.byId.get(shownId) : undefined
  const shownSource = pinnedId !== null ? 'pinned' : hoverId !== null ? 'hovered' : 'your room'
  const shownBuilding = hoverBuilding !== null && pinnedId === null && area ? area.buildings[hoverBuilding] : undefined

  // Legend: Genie maps use the community's colour meanings; Lich tiles use the
  // categories read from Lich's tags.
  const legendColors = useMemo(() => {
    if (src.kind === 'genie') {
      const used = new Set((area?.rooms ?? []).map(r => r.fill?.toUpperCase()).filter(Boolean))
      return Object.entries(COLOR_LEGEND)
        .filter(([hex]) => mode === 'global' || used.has(hex))
        .map(([hex, c]) => ({ key: hex, color: hex, name: c.name, desc: c.desc }))
    }
    const used = new Set((area?.rooms ?? []).map(r => r.category).filter((c): c is string => !!c))
    return Object.keys(DA_CATEGORIES).filter(k => mode === 'global' || used.has(k))
      .map(k => ({ key: k, color: DA_CATEGORIES[k].color, name: DA_CATEGORIES[k].name, desc: DA_CATEGORIES[k].desc }))
  }, [area, mode, src])
  const presentArcs = useMemo(() => {
    if (!area) return []
    const s = new Set(area.arcs.map(a => a.cat))
    return (['cardinal', 'go', 'climb'] as DaArcCategory[]).filter(c => s.has(c))
  }, [area])

  function roomDetails(r: DaRoom) {
    if (r.stubTo) {
      const to = src.area(genieGround(r.stubTo))
      return (
        <>
          <div style={{ fontWeight: 'bold' }}>{to?.name ?? 'Another map'}</div>
          <div style={{ ...muted, marginTop: 6, fontStyle: 'italic' }}>Click to open that map</div>
        </>
      )
    }
    if (r.lich === null) {
      return (
        <>
          <div style={{ fontWeight: 'bold' }}>{r.title || '(unnamed room)'}</div>
          <div style={{ ...muted, marginTop: 6 }}>
            On the Genie map, but not matched to a Lich room, so it has no details and go2 can't take you there.
          </div>
        </>
      )
    }
    const mana = obs.mana[r.lich] ?? {}
    const found = obs.forage[r.lich] ?? {}
    const foundItems = Object.entries(found).sort((a, b) => b[1].n - a[1].n)
    const lichForage = r.forage.filter(f => !found[f.toLowerCase()])
    return (
      <>
        <div style={{ ...muted, fontSize: '0.91em' }}>{shownSource}</div>
        <div style={{ fontWeight: 'bold', marginTop: 2 }}>{r.title || '(unnamed room)'}</div>
        <div style={{ ...muted, fontSize: '0.91em' }}>
          Lich #{r.lich} · {r.indoor ? 'indoor' : 'outdoor'}{r.location ? ` · ${r.location}` : ''}
        </div>

        <div style={sectionHead}>Mana</div>
        {myRealm === 'Lunar' && (
          <div style={{ ...muted, marginBottom: 4 }}>Lunar mana follows the moons, not the room.</div>
        )}
        {!detectedRealm && (
          <div style={{ marginBottom: 4 }}>
            <span style={muted}>Your realm: </span>
            <select className="map-select" value={pickedRealm} aria-label="Your mana realm"
              onChange={e => {
                const v = e.target.value as Realm | ''
                setPickedRealm(v)
                try { localStorage.setItem(scopedKey(character, 'damapsRealm'), v) } catch { /* ignore */ }
              }}>
              <option value="">—</option>
              {(['Life', 'Holy', 'Elemental', 'Arcane', 'Lunar'] as Realm[]).map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        )}
        {ROOM_REALMS.map(realm => {
          const m = mana[realm]
          const mine = realm === myRealm
          const pct = m && m.rank >= 0 ? ((m.rank + 1) / MANA_WORDS.length) * 100 : 0
          return (
            <div key={realm} title={m ? `${m.text}\n(${new Date(m.at).toLocaleString()})` : 'No PERCEIVE reading recorded here yet'}
              style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                color: mine ? 'var(--map-current-color, #e0a050)' : undefined }}>
              <span style={{ width: 72, flexShrink: 0, fontWeight: mine ? 'bold' : undefined }}>{mine ? '▸ ' : ''}{realm}</span>
              <span style={{ flex: 1, height: 6, background: 'var(--map-btn-bg, #222)', borderRadius: 2, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: 6, width: `${pct}%`,
                  background: mine ? 'var(--map-current-color, #e0a050)' : 'var(--map-text-muted, #777)' }} />
              </span>
              <span style={{ width: 70, textAlign: 'right', ...(m ? {} : muted) }}>{m ? m.word : 'no reading'}</span>
            </div>
          )
        })}

        <div style={sectionHead}>Forage</div>
        {foundItems.length === 0 && lichForage.length === 0 && <div style={muted}>Nothing known yet</div>}
        {foundItems.map(([item, f]) => (
          <div key={item}>· {item} <span style={muted}>(found {f.n}×)</span></div>
        ))}
        {lichForage.map(item => <div key={item}>· {item}</div>)}

        {r.hunting.length > 0 && (
          <>
            <div style={sectionHead}>Hunting</div>
            {r.hunting.map(h => <div key={h}>· {h}</div>)}
          </>
        )}
        {r.services.length > 0 && (
          <>
            <div style={sectionHead}>Here</div>
            <div>{r.services.join(', ')}</div>
          </>
        )}
        <div style={sectionHead}>Exits</div>
        <div style={muted}>{r.exits.filter(e => !e.startsWith(';')).join(', ') || '—'}</div>
        <div style={{ ...muted, marginTop: 8, fontStyle: 'italic' }}>
          Right-click: go2 here · Left-click: pin
        </div>
      </>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const unplaced = currentRoom && !hereImage

  return (
    <div className="map-canvas-wrap" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="map-toolbar" style={{ flexShrink: 0 }}>
        <button className={`map-btn map-btn--sm${mode === 'local' ? ' map-btn--active' : ''}`}
          onClick={() => switchMode('local')} title="Local — the area you're in (or the one you opened from Global)">Local</button>
        <button className={`map-btn map-btn--sm${mode === 'global' ? ' map-btn--active' : ''}`}
          onClick={() => switchMode('global')} title="Global — every area, grouped by province. Click one to open it.">Global</button>
        <span className="map-toolbar-location">
          {mode === 'global'
            ? 'All areas'
            : area ? `${area.name}${hereRoom ? ' · 📍 here' : ''}` : ''}
        </span>
      </div>

      <div className="map-subbar" style={{ flexShrink: 0 }}>
        <button className={`map-btn${followPlayer && hereImage ? ' map-btn--active' : ''}`}
          disabled={!hereImage}
          title={hereImage ? 'Take me to my current room (enables follow)' : 'Your current room has no Da\'Maps position'}
          onClick={() => {
            setFollowPlayer(true)
            if (mode === 'global') { localTfRef.current = null; setMode('local') }
            if (hereImage !== areaImage) setAreaImage(hereImage)
            else if (hereRoom) centerOn(hereRoom, INDOOR_SCALE)
          }}>◆</button>
        <button className="map-btn" title={mode === 'global' ? 'Fit all areas to view' : 'Fit area to view'}
          onClick={() => {
            setFollowPlayer(false)
            if (mode === 'global' && world && svgRef.current) {
              const W = svgRef.current.clientWidth, H = svgRef.current.clientHeight
              const sc = Math.max(MIN_SCALE, Math.min((W - 40) / world.w, (H - 40) / world.h))
              setTransform({ scale: sc, x: (W - world.w * sc) / 2, y: 20 })
            } else fitToView()
          }}>⊡</button>
        <button className={`map-btn${showPanel ? ' map-btn--active' : ''}`} onClick={() => setShowPanel(s => !s)}
          title={showPanel ? 'Hide the side panel' : 'Show the side panel (legend and room details)'}>▤</button>
        {mode === 'local' && area && src.floors(area.image).length > 1 && (
          <span style={{ display: 'inline-flex', gap: 3, marginLeft: 6, alignItems: 'center' }} title="This map has more than one floor">
            <span style={muted}>Floor</span>
            {src.floors(area.image).map(k => {
              const lv = parseGenieAreaKey(k)?.level ?? 0
              return (
                <button key={k} className={`map-btn map-btn--sm${k === area.image ? ' map-btn--active' : ''}`}
                  onClick={() => { setAreaImage(k); setFollowPlayer(k === hereImage) }}>
                  {lv === 0 ? 'Ground' : lv > 0 ? `+${lv}` : lv}
                </button>
              )
            })}
          </span>
        )}
        <span style={{ flex: 1 }} />
      </div>

      {unplaced && (
        <div className="map-hint" style={{ padding: '3px 8px', color: 'var(--map-arc-special, #ffb74d)', flexShrink: 0 }}>
          ⚑ Your room ({lichTitle(currentRoom!)}, Lich #{currentRoom!.id}) {src.kind === 'genie' ? 'isn\'t on your Genie maps' : `has no ${DA_MAPS_NAME} position yet`}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {mode === 'local' && !area && (
          <div className="map-overlay" style={{ pointerEvents: 'none' }}>
            <div className="map-empty">
              <div className="map-empty-icon">🗺</div>
              <div className="map-empty-msg">Waiting for your room</div>
              <div className="map-empty-sub">Move or LOOK in game, or open Global to pick an area.</div>
            </div>
          </div>
        )}
        <svg ref={svgRef}
          style={{ width: '100%', height: '100%', background: 'var(--map-bg, #111)', cursor: isDragging ? 'grabbing' : 'grab' }}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag}
          onMouseLeave={endDrag}  // hover is sticky: the panel keeps the last room while you read it
          onContextMenu={e => e.preventDefault()}>
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
            {mode === 'global' ? (
              <>
                {globalLayer}
                {globalHover}
                {globalHere}
              </>
            ) : (
              <>
                {arcPaths}
                {buildingShapes}
                {labels}
                {roomRects}
                {highlight(pinnedId, 'var(--map-select-color, #e0a050)')}
                {highlight(hoverId, 'var(--map-text, #eee)')}
                {hereIndicator}
              </>
            )}
          </g>
        </svg>

        {showPanel && (mode === 'global' || area) && (
          <div style={{
            position: 'absolute', top: 8, right: 8, bottom: 8, width: PANEL_W, maxWidth: '45%',
            display: 'flex', flexDirection: 'column',
            background: 'var(--map-chrome-bg, rgba(20, 20, 22, 0.95))',
            border: '1px solid var(--map-border, #555)', borderRadius: 4,
            fontSize: PANEL_FONT, color: 'var(--map-text, #ddd)', zIndex: 5,
          }}>
            <div style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', padding: '6px 9px', lineHeight: 1.4 }}>
              {tab === 'legend' && (
                <>
                  {legendColors.length > 0 && <div style={{ ...sectionHead, marginTop: 0 }}>Room colors</div>}
                  {legendColors.map(c => {
                    return (
                      <div key={c.key} style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
                        <span style={{ flexShrink: 0, width: 10, height: 10, background: c.color, alignSelf: 'center',
                          border: '1px solid var(--map-border, #555)' }} />
                        <span><b>{c.name}</b><span style={muted}> — {c.desc}</span></span>
                      </div>
                    )
                  })}
                  {presentArcs.length > 0 && <div style={sectionHead}>Arc types</div>}
                  {presentArcs.map(cat => (
                    <div key={cat} style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
                      <svg width={14} height={10} style={{ flexShrink: 0, alignSelf: 'center' }}>
                        <line x1={1} y1={5} x2={13} y2={5} stroke={DA_ARC_COLOR[cat]} strokeWidth={1.5} />
                      </svg>
                      <span><b>{cat === 'cardinal' ? 'Cardinal' : cat === 'climb' ? 'Climb' : 'Go / Door / Up / Down'}</b>
                        <span style={muted}>{cat === 'cardinal' ? ' — north/south/east/west/etc.' : cat === 'climb' ? ' — ladders, stairs, climb exits' : ' — doors, portals, swim, scripted moves'}</span></span>
                    </div>
                  ))}
                  <div style={sectionHead}>Other</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
                    <svg width={14} height={14} style={{ flexShrink: 0, alignSelf: 'center' }}>
                      <rect x={1} y={1} width={12} height={12} rx={2} fill="none" stroke="var(--map-node-stroke, #555)" strokeDasharray="3 2" />
                    </svg>
                    <span style={muted}>Building (indoor rooms)</span>
                  </div>
                  <div style={{ ...muted, marginTop: 8 }}>Right-click any room to <code>;go2</code> there.</div>
                </>
              )}
              {tab === 'room' && mode === 'global' && (
                hoveredWorldArea ? (
                  <>
                    <div style={{ ...muted, fontSize: '0.91em' }}>hovered area</div>
                    <div style={{ fontWeight: 'bold', marginTop: 2 }}>{hoveredWorldArea.name}</div>
                    <div style={muted}>{hoveredWorldArea.province} · {hoveredWorldArea.rooms} rooms</div>
                    <div style={{ ...muted, marginTop: 8, fontStyle: 'italic' }}>Click to open it in Local</div>
                  </>
                ) : (
                  <div style={muted}>Hover an area to see what it is. Click one to open it.</div>
                )
              )}
              {tab === 'room' && mode === 'local' && (
                shownBuilding ? (
                  <>
                    <div style={{ ...muted, fontSize: '0.91em' }}>hovered building</div>
                    <div style={{ fontWeight: 'bold', marginTop: 2 }}>{shownBuilding.name || 'Building'}</div>
                    <div style={muted}>{shownBuilding.rooms.length} indoor room{shownBuilding.rooms.length === 1 ? '' : 's'} — zoom in to see them.</div>
                    <div style={{ ...muted, marginTop: 8, fontStyle: 'italic' }}>Right-click: go2 to its entrance</div>
                  </>
                ) : shownRoom ? roomDetails(shownRoom) : (
                  <div style={muted}>Hover a room to see its mana and forage.</div>
                )
              )}
            </div>
            <div style={{ display: 'flex', borderTop: '1px solid var(--map-border, #555)', flexShrink: 0 }}>
              {(['legend', 'room'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t}
                  style={{
                    flex: 1, padding: '5px 4px', cursor: 'pointer', fontSize: PANEL_FONT,
                    background: tab === t ? 'var(--map-btn-bg, #222)' : 'transparent',
                    color: tab === t ? 'var(--map-select-color, #e0a050)' : 'var(--map-text-muted, #888)',
                    border: 'none', borderTop: tab === t ? '2px solid var(--map-select-color, #e0a050)' : '2px solid transparent',
                  }}>{t === 'legend' ? 'Map legend' : 'Room'}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: '4px 8px', fontSize: 11, color: 'var(--map-text-muted, #888)',
        borderTop: '1px solid var(--map-border-subtle, #333)' }}>
        {DA_MAPS_NAME}{mode === 'global'
          ? (world ? ` · ${world.areas.length} areas · ${world.areas.reduce((n, a) => n + a.rooms, 0)} rooms` : '')
          : (area ? ` · ${area.name} · ${area.rooms.length} rooms` : '')}
      </div>
    </div>
  )
}
