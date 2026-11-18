// Da'Maps — one Genie map floor turned into a Da'Maps area.
//
// Positions, lines, colours and place names come from the Genie map exactly as
// its makers drew them. Each square is backed by the Lich room it matched
// (genieMatch.ts), which supplies indoor/outdoor, forage, hunting, services and
// the id for `;go2`. Squares with no Lich match are still drawn, so the map is
// whole, but can't be travelled to by clicking.
//
// Area keys are `g:<zoneId>@<level>`; Genie maps can have several floors.

import type { GenieZone, LichRoom } from '../mapTypes'
import { lichTitle } from '../mapTypes'
import {
  type DaArea, type DaArc, type DaBuilding, type DaRoom,
  classifyMove, splitTags, isIndoor, buildingName, placeLabelsAndOutlines,
} from './daMapsData'
import { isStub, nodeKey, type GenieMatch } from './genieMatch'

export const GENIE_ROOM_SIZE = 8

export const genieAreaKey = (zoneId: string, level: number) => `g:${zoneId}@${level}`
export function parseGenieAreaKey(key: string): { zoneId: string; level: number } | null {
  const m = /^g:(.*)@(-?\d+)$/.exec(key)
  return m ? { zoneId: m[1], level: Number(m[2]) } : null
}

/** the floors a Genie map has, ground floor first */
export function genieLevels(zone: GenieZone): number[] {
  const s = new Set(zone.nodes.map(n => n.z))
  return [...s].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b))
}

/** Genie map file name → its zone id, for boundary markers ("Map7_NE_Gate.xml"). */
export function zoneIdByFile(zones: Map<string, GenieZone>): Map<string, string> {
  const m = new Map<string, string>()
  for (const z of zones.values()) m.set(z.sourceFile.toLowerCase(), z.id)
  return m
}

export function buildGenieArea(
  zone: GenieZone, level: number, match: GenieMatch,
  lichDb: Map<number, LichRoom>, fileToZone: Map<string, string>,
): DaArea {
  const rooms: DaRoom[] = []
  const byId = new Map<number, DaRoom>()      // keyed by Genie node id (unique in a zone)
  const byLich = new Map<number, DaRoom>()

  for (const n of zone.nodes) {
    if (n.z !== level) continue
    const lid = match.lichOf.get(nodeKey(zone.id, n.id)) ?? null
    const r = lid !== null ? lichDb.get(lid) : undefined
    const tags = splitTags(r?.tags)
    const exits = r ? Object.values(r.wayto ?? {}).filter((m): m is string => typeof m === 'string') : n.arcs.map(a => a.move)
    let stubTo: string | undefined
    if (isStub(n)) {
      const file = (n.note!.match(/[^|]*\.xml/i)?.[0] ?? '').trim().toLowerCase()
      stubTo = fileToZone.get(file)
    }
    const room: DaRoom = {
      id: n.id,
      lich: stubTo ? null : lid,
      fill: n.color && n.color.toUpperCase() !== '#FFFFFF' ? n.color : undefined,
      stubTo,
      x: n.x, y: n.y, size: GENIE_ROOM_SIZE,
      lx: 0, ly: 0,
      title: r ? lichTitle(r) : n.name.replace(/^\[+|\]+$/g, ''),
      indoor: r ? isIndoor(r) : false,
      category: tags.category,
      forage: tags.forage, hunting: tags.hunting, services: tags.services,
      exits,
      crossTo: stubTo ? [stubTo] : [],
      label: '',
      building: null,
      location: r?.location ?? '',
    }
    rooms.push(room)
    byId.set(room.id, room)
    if (room.lich !== null && !byLich.has(room.lich)) byLich.set(room.lich, room)
  }

  // Lines, as the map's makers drew them (hidden arcs stay hidden).
  const seen = new Set<string>()
  const arcs: DaArc[] = []
  for (const n of zone.nodes) {
    if (n.z !== level) continue
    for (const a of n.arcs) {
      if (a.hidden || !byId.has(a.destination) || a.destination === n.id) continue
      const k = n.id < a.destination ? `${n.id}-${a.destination}` : `${a.destination}-${n.id}`
      if (seen.has(k)) continue
      seen.add(k)
      arcs.push({ a: n.id, b: a.destination, cat: classifyMove(a.move) })
    }
  }

  // Buildings: indoor rooms joined on the map that share a name.
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let p = x
    while ((parent.get(p) ?? p) !== p) p = parent.get(p)!
    parent.set(x, p)
    return p
  }
  for (const r of rooms) if (r.indoor) parent.set(r.id, r.id)
  for (const a of arcs) {
    const p = byId.get(a.a)!, q = byId.get(a.b)!
    if (!p.indoor || !q.indoor || buildingName(p.title) !== buildingName(q.title)) continue
    const ra = find(p.id), rb = find(q.id)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map<number, DaRoom[]>()
  for (const r of rooms) {
    if (!r.indoor) continue
    const g = find(r.id)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(r)
  }
  const buildings: DaBuilding[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const pad = 3
    const b: DaBuilding = {
      name: buildingName(members[0].title), outline: true, lx: 0, ly: 0, showLabel: false,
      rooms: members.map(m => m.id),
      x1: Math.min(...members.map(m => m.x - m.size / 2)) - pad,
      y1: Math.min(...members.map(m => m.y - m.size / 2)) - pad,
      x2: Math.max(...members.map(m => m.x + m.size / 2)) + pad,
      y2: Math.max(...members.map(m => m.y + m.size / 2)) + pad,
    }
    const idx = buildings.push(b) - 1
    for (const m of members) m.building = idx
  }
  // Outlines only where they wrap nothing else; Genie's own place names are
  // the labels, so none are added.
  placeLabelsAndOutlines(rooms, buildings, arcs, byId, { labels: false })

  const texts = zone.labels.filter(l => l.z === level && l.text).map(l => ({ text: l.text, x: l.x, y: l.y }))
  const xs = rooms.map(r => r.x).concat(texts.map(t => t.x)), ys = rooms.map(r => r.y).concat(texts.map(t => t.y))
  const bbox = rooms.length
    ? { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
    : { x1: 0, y1: 0, x2: 100, y2: 100 }

  const levels = genieLevels(zone)
  const name = zone.name + (levels.length > 1 ? (level === 0 ? '' : ` (floor ${level > 0 ? '+' : ''}${level})`) : '')
  return { image: genieAreaKey(zone.id, level), name, rooms, byId, byLich, arcs, buildings, bbox, texts }
}
