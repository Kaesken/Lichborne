// DaMaps Editor — the editing window.
//
// Draws one floor of a .damap map as an SVG (8×8 squares centred on their
// position, lines for exits, place names) and edits it with four tools:
// Select/move, Room, Link and Label. The panel on the right edits whatever is
// selected (the map itself when nothing is). Every change goes through
// `change()` so it can be undone, and marks the map unsaved.
//
// The file format and its rules live in tools/damaps/damapFormat.ts, shared
// with the Da'Maps build, so what this saves is exactly what the build reads.

import {
  type DaMapFile, type DaMapRoom, type DaMapExit,
  EXIT_KINDS, emptyDamap, parseDamap, stringifyDamap, checkDamap, zoneToDamap, oppositeExit, directionBetween,
} from '../../damaps/damapFormat'
import { readGenieXml } from '../../damaps/readGenieXml'

interface Api {
  open(): Promise<{ path: string; text: string } | null>
  importGenie(): Promise<{ name: string; text: string } | null>
  save(path: string | null, text: string, suggested: string): Promise<string | null>
  confirm(msg: string, detail: string): Promise<number>
  setDirty(d: boolean): void
  setTitle(t: string): void
  closeNow(): void
  onMenu(fn: (action: string) => void): void
}
const api = (window as unknown as { api: Api }).api

// Room colours the map community uses (same list as Lichborne's map legend).
const COLORS: [string, string][] = [
  ['#FF00FF', 'Transport (portal, ferry…)'], ['#00FF00', 'Interesting room'], ['#FF8000', 'Guildleader'],
  ['#00BF80', 'Auto-healer'], ['#FF0000', 'Shop'], ['#FFFF00', 'Stat training'], ['#0000FF', 'Water (swimming)'],
  ['#000080', 'Underwater (drowning)'], ['#FFBF00', 'Obstacle (roundtime)'], ['#993300', 'Mining'],
  ['#008000', 'Lumberjacking'], ['#C2B280', 'Ranger trailhead'], ['#00FFFF', 'Player housing'],
  ['#A6A3D9', 'Shrine (pilgrim badge)'], ['#400040', 'Depart room'], ['#800080', 'Favor altar'],
]
const HALF = 4          // a square is 8×8 map units
const SVGNS = 'http://www.w3.org/2000/svg'

// ── State ───────────────────────────────────────────────────────────────────

type Tool = 'select' | 'room' | 'link' | 'label'
let map: DaMapFile = emptyDamap()
let filePath: string | null = null
let dirty = false
let tool: Tool = 'select'
let floor = 0
const extraFloors = new Set<number>()
let selRooms = new Set<number>()
let selLabel: number | null = null
let past: string[] = []
let future: string[] = []
const view = { tx: 0, ty: 0, s: 3 }
let byId = new Map<number, DaMapRoom>()

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T
const svg = $<SVGSVGElement>('#canvas')
const gView = $<SVGGElement>('#view')
const gLines = $<SVGGElement>('#layer-lines')
const gRooms = $<SVGGElement>('#layer-rooms')
const gLabels = $<SVGGElement>('#layer-labels')
const gUi = $<SVGGElement>('#layer-ui')
const props = $('#props')
const status = $('#status')

// ── Undo / dirty ────────────────────────────────────────────────────────────

const snapshot = () => JSON.stringify(map)
function pushUndo(before: string) {
  past.push(before)
  if (past.length > 300) past.shift()
  future = []
  updateButtons()
}
/** Make a change that can be undone. */
function change(fn: () => void, opts: { props?: boolean } = {}) {
  const before = snapshot()
  fn()
  if (snapshot() === before) return
  pushUndo(before)
  markDirty()
  render()
  if (opts.props !== false) renderProps()
}
function markDirty(d = true) {
  dirty = d
  api.setDirty(d)
  updateTitle()
}
function updateTitle() {
  const f = filePath ? filePath.split(/[\\/]/).pop() : 'not saved yet'
  api.setTitle(`${dirty ? '● ' : ''}${map.name || 'Untitled'} (${f}) — DaMaps Editor`)
}
function restore(json: string) {
  map = JSON.parse(json)
  const ids = new Set(map.rooms.map(r => r.id))
  selRooms = new Set([...selRooms].filter(id => ids.has(id)))
  if (selLabel != null && selLabel >= map.labels.length) selLabel = null
  markDirty()
  render(); renderProps()
}
function undo() { const p = past.pop(); if (p == null) return; future.push(snapshot()); restore(p); updateButtons() }
function redo() { const f = future.pop(); if (f == null) return; past.push(snapshot()); restore(f); updateButtons() }
function updateButtons() {
  ($('#undo') as HTMLButtonElement).disabled = !past.length;
  ($('#redo') as HTMLButtonElement).disabled = !future.length
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function toWorld(clientX: number, clientY: number) {
  const r = svg.getBoundingClientRect()
  return { x: (clientX - r.left - view.tx) / view.s, y: (clientY - r.top - view.ty) / view.s }
}
const snapStep = () => Number(($('#snap') as HTMLSelectElement).value) || 0
const snap = (v: number, free = false) => { const s = snapStep(); return free || !s ? Math.round(v) : Math.round(v / s) * s }
function applyView() { gView.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.s})`) }
const nextId = () => map.rooms.reduce((m, r) => Math.max(m, r.id), 0) + 1

function fit() {
  const rooms = map.rooms.filter(r => r.z === floor)
  const labels = map.labels.filter(l => l.z === floor)
  const xs = [...rooms.map(r => r.x), ...labels.map(l => l.x)]
  const ys = [...rooms.map(r => r.y), ...labels.map(l => l.y)]
  const rect = svg.getBoundingClientRect()
  if (!xs.length || !rect.width) { view.s = 3; view.tx = rect.width / 2; view.ty = rect.height / 2; applyView(); return }
  const minX = Math.min(...xs) - 20, maxX = Math.max(...xs) + 20, minY = Math.min(...ys) - 20, maxY = Math.max(...ys) + 20
  view.s = Math.max(0.3, Math.min(8, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))))
  view.tx = rect.width / 2 - ((minX + maxX) / 2) * view.s
  view.ty = rect.height / 2 - ((minY + maxY) / 2) * view.s
  applyView()
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function render() {
  byId = new Map(map.rooms.map(r => [r.id, r]))
  const here = map.rooms.filter(r => r.z === floor)
  // lines: one per pair of rooms; dashed when only one way
  const seen = new Set<string>()
  let lines = ''
  for (const r of here) for (const e of r.exits) {
    if (e.hidden) continue
    const t = byId.get(e.to)
    if (!t || t.z !== floor || t.id === r.id) continue
    const key = r.id < t.id ? `${r.id}-${t.id}` : `${t.id}-${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const back = t.exits.some(x => x.to === r.id && !x.hidden)
    lines += `<line class="ln${back ? '' : ' oneway'}" x1="${r.x}" y1="${r.y}" x2="${t.x}" y2="${t.y}"/>`
  }
  gLines.innerHTML = lines
  let rooms = ''
  for (const r of here) {
    const sel = selRooms.has(r.id)
    const fill = r.color ? ` style="fill:${r.color}"` : ''
    const up = r.exits.some(e => e.exit === 'up' || (byId.get(e.to)?.z ?? floor) > floor)
    const down = r.exits.some(e => e.exit === 'down' || (byId.get(e.to)?.z ?? floor) < floor)
    const tip = `#${r.id} ${r.title || '(no title)'}${r.linksTo ? `\nDoorway to ${r.linksTo}` : ''}`
    rooms += `<g class="rm${sel ? ' sel' : ''}${r.linksTo ? ' door' : ''}" data-room="${r.id}"><title>${esc(tip)}</title>`
      + `<rect x="${r.x - HALF}" y="${r.y - HALF}" width="8" height="8" rx="1"${fill}/>`
      + (up ? `<path class="updown" d="M${r.x - 1.6} ${r.y - 0.4}l1.6 -2.8l1.6 2.8z"/>` : '')
      + (down ? `<path class="updown" d="M${r.x - 1.6} ${r.y + 0.4}l1.6 2.8l1.6 -2.8z"/>` : '')
      + `</g>`
  }
  gRooms.innerHTML = rooms
  let labels = ''
  map.labels.forEach((l, i) => {
    if (l.z !== floor) return
    labels += `<g class="lbl${selLabel === i ? ' sel' : ''}" data-label="${i}"><text x="${l.x}" y="${l.y}" dominant-baseline="hanging" style="pointer-events:all;cursor:move">${esc(l.text || '(empty label)')}</text></g>`
  })
  gLabels.innerHTML = labels
  renderFloors()
  updateStatus()
}

function floorName(z: number) { return z === 0 ? 'Ground floor' : z > 0 ? `Up ${z}` : `Down ${-z}` }
function floors() {
  return [...new Set([...map.rooms.map(r => r.z), ...map.labels.map(l => l.z), ...extraFloors, floor])].sort((a, b) => b - a)
}
function renderFloors() {
  const sel = $('#floor') as HTMLSelectElement
  const fl = floors()
  const html = fl.map(z => `<option value="${z}">${floorName(z)} (${map.rooms.filter(r => r.z === z).length})</option>`).join('')
  if (sel.innerHTML !== html) sel.innerHTML = html
  sel.value = String(floor)
}

let pointerWorld = { x: 0, y: 0 }
function updateStatus() {
  const n = map.rooms.filter(r => r.z === floor).length
  const s = selRooms.size ? ` · ${selRooms.size} selected` : ''
  status.textContent = `${n} rooms on this floor · ${map.rooms.length} in all${s} · x ${Math.round(pointerWorld.x)}, y ${Math.round(pointerWorld.y)} · zoom ${Math.round(view.s * 100)}%`
}

// ── Properties panel ────────────────────────────────────────────────────────

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  for (const k of kids) el.append(k)
  return el
}
function field(label: string, control: HTMLElement, title = '') {
  const f = h('label', { class: 'field' }, h('span', title ? { title } : {}, label), control)
  if (title) f.title = title
  return f
}
/** A text box that edits live and makes one undo step per edit. */
function textBox(value: string, set: (v: string) => void, opts: { area?: boolean; rows?: number; placeholder?: string } = {}) {
  const el = opts.area ? h('textarea', { rows: String(opts.rows ?? 3) }) : h('input', { type: 'text' })
  ;(el as HTMLInputElement).value = value
  if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder)
  let before = ''
  el.addEventListener('focus', () => { before = snapshot() })
  el.addEventListener('input', () => { set((el as HTMLInputElement).value); render(); if (!dirty) markDirty() })
  el.addEventListener('change', () => { if (before && snapshot() !== before) { pushUndo(before); markDirty() } before = snapshot() })
  return el
}
function numBox(value: number | undefined, set: (v: number | undefined) => void, opts: { blankOk?: boolean } = {}) {
  const el = h('input', { type: 'number' }) as HTMLInputElement
  el.value = value == null ? '' : String(value)
  el.addEventListener('change', () => {
    const v = el.value.trim() === '' ? undefined : Number(el.value)
    if (v === undefined && !opts.blankOk) { el.value = value == null ? '' : String(value); return }
    if (v !== undefined && !Number.isFinite(v)) return
    change(() => set(v === undefined ? undefined : Math.round(v)))
  })
  return el
}

function renderProps() {
  props.replaceChildren()
  const rooms = [...selRooms].map(id => byId.get(id)).filter(Boolean) as DaMapRoom[]
  if (selLabel != null && map.labels[selLabel]) return renderLabelProps(selLabel)
  if (rooms.length === 1) return renderRoomProps(rooms[0])
  if (rooms.length > 1) return renderManyProps(rooms)
  renderMapProps()
}

function renderMapProps() {
  props.append(h('h2', {}, 'Map'))
  props.append(field('Name', textBox(map.name, v => { map.name = v; updateTitle() }), 'The map\'s name as players will see it'))
  props.append(field('File name', textBox(map.file, v => { map.file = v }), 'Doorways on other maps point at this name. For a map that replaces a Genie map, keep the Genie file name (e.g. Map1_Crossing.xml).'))
  props.append(field('Map id', textBox(map.id, v => { map.id = v }), 'A short id, e.g. 1 for the Crossing. Keep the Genie id when the map came from Genie.'))
  props.append(h('p', { class: 'hint' }, 'A map that keeps a Genie map\'s file name replaces that map in Da\'Maps. A new file name adds a new map.'))
  props.append(h('h2', {}, 'Check'))
  const probs = checkDamap(map)
  if (!map.rooms.length) props.append(h('p', { class: 'hint' }, 'No rooms yet. Pick the Room tool (R) and click to place one.'))
  else if (!probs.length) props.append(h('p', { class: 'ok' }, `✓ ${map.rooms.length} rooms, nothing to fix`))
  for (const p of probs) props.append(h('p', { class: 'warn' }, '⚠ ' + p))
  props.append(h('h2', {}, 'Tips'))
  props.append(h('p', { class: 'hint' }, 'Click a room to edit it. Shift-click with the Room tool to draw a street room by room. Help → How to use the editor has the rest.'))
}

function renderLabelProps(i: number) {
  const l = map.labels[i]
  props.append(h('h2', {}, 'Place name'))
  const t = textBox(l.text, v => { l.text = v })
  props.append(field('Text', t))
  props.append(field('X', numBox(l.x, v => { l.x = v! })))
  props.append(field('Y', numBox(l.y, v => { l.y = v! })))
  const del = h('button', { class: 'danger' }, 'Delete place name')
  del.onclick = () => deleteSelection()
  props.append(h('div', { class: 'row' }, del))
  setTimeout(() => { if (!l.text || l.text === 'Place name') { t.focus(); (t as HTMLInputElement).select() } })
}

function colorPicker(current: string | undefined, set: (c: string | undefined) => void) {
  const box = h('div', { class: 'swatches' })
  const none = h('button', { class: `swatch none${current ? '' : ' on'}`, title: 'No colour' })
  none.onclick = () => change(() => set(undefined))
  box.append(none)
  for (const [hex, name] of COLORS) {
    const b = h('button', { class: `swatch${current?.toUpperCase() === hex ? ' on' : ''}`, title: `${name} (${hex})`, style: `background:${hex}` })
    b.onclick = () => change(() => set(hex))
    box.append(b)
  }
  return box
}

function renderManyProps(rooms: DaMapRoom[]) {
  props.append(h('h2', {}, `${rooms.length} rooms selected`))
  props.append(h('p', { class: 'hint' }, 'Drag any of them to move them all. Arrow keys nudge them.'))
  props.append(h('h2', {}, 'Colour for all'))
  props.append(colorPicker(undefined, c => rooms.forEach(r => { if (c) r.color = c; else delete r.color })))
  const fl = h('select') as HTMLSelectElement
  const fls = [...new Set([...floors(), floor + 1, floor - 1])].sort((a, b) => b - a)
  fl.innerHTML = fls.map(z => `<option value="${z}">${floorName(z)}</option>`).join('')
  fl.value = String(floor)
  fl.onchange = () => change(() => rooms.forEach(r => { r.z = Number(fl.value) }))
  props.append(h('h2', {}, 'Floor'))
  props.append(field('Move to', fl))
  const link = h('button', {}, 'Link them in a row')
  link.title = 'Add exits both ways between each room and the next, in the order you selected them'
  link.onclick = () => change(() => { for (let i = 1; i < rooms.length; i++) addLink(rooms[i - 1], rooms[i], false) })
  const del = h('button', { class: 'danger' }, `Delete ${rooms.length} rooms`)
  del.onclick = () => deleteSelection()
  props.append(h('div', { class: 'row' }, link, del))
}

function renderRoomProps(r: DaMapRoom) {
  props.append(h('h2', {}, `Room #${r.id}`))
  const title = textBox(r.title, v => { r.title = v }, { placeholder: 'e.g. The Crossing, Hodierna Way' })
  props.append(field('Title', title, 'The room title exactly as the game shows it, without the brackets'))
  props.append(field('Description', textBox(r.descriptions.join('\n'), v => { r.descriptions = v.split('\n').map(s => s.trim()).filter(Boolean) }, { area: true, rows: 5, placeholder: 'The room description, as the game shows it. If the room has more than one (day and night), put each on its own line.' })))
  props.append(h('h2', {}, 'Colour'))
  props.append(colorPicker(r.color, c => { if (c) r.color = c; else delete r.color }))
  props.append(h('h2', {}, 'Position'))
  props.append(field('X', numBox(r.x, v => { r.x = v! })))
  props.append(field('Y', numBox(r.y, v => { r.y = v! })))
  props.append(field('Floor', numBox(r.z, v => { r.z = v! }), '0 is the ground floor, 1 upstairs, -1 below'))
  props.append(h('h2', {}, 'Extra'))
  props.append(field('Other names', textBox((r.aliases ?? []).join('\n'), v => { const a = v.split('\n').map(s => s.trim()).filter(Boolean); if (a.length) r.aliases = a; else delete r.aliases }, { area: true, rows: 2, placeholder: 'One per line (optional)' }), 'Other names people search this room by, e.g. a shop\'s name'))
  props.append(field('Doorway to', textBox(r.linksTo ?? '', v => { const t = v.trim(); if (t) r.linksTo = t; else delete r.linksTo }, { placeholder: 'another map\'s file name' }), 'Makes this square a doorway onto another map, e.g. Map7_NTR.xml'))
  props.append(field('Lich room #', numBox(r.lich, v => { if (v) r.lich = v; else delete r.lich }, { blankOk: true }), 'Only if Da\'Maps matches this room to the wrong Lich room. Leave blank otherwise.'))

  props.append(h('h2', {}, `Exits (${r.exits.length})`))
  const table = h('table', { class: 'exits' })
  table.append(h('tr', {}, h('td', { class: 'way' }, 'Way'), h('td', {}, 'Command'), h('td', { class: 'go-to' }, 'To #'), h('td', { class: 'hid', title: 'Hidden: a real exit that isn\'t drawn as a line' }, '👁'), h('td', { class: 'del' })))
  r.exits.forEach((e, i) => {
    const way = h('select') as HTMLSelectElement
    way.innerHTML = EXIT_KINDS.map(k => `<option>${k}</option>`).join('')
    way.value = e.exit
    way.onchange = () => change(() => { if (e.move === e.exit || !e.move) e.move = way.value === 'go' || way.value === 'climb' ? `${way.value} ` : way.value; e.exit = way.value })
    const move = textBox(e.move, v => { e.move = v })
    const to = numBox(e.to, v => { e.to = v! })
    const t = byId.get(e.to)
    to.title = t ? `#${t.id} ${t.title || '(no title)'}${t.z !== r.z ? ` (${floorName(t.z)})` : ''}` : e.to === 0 ? '0: leads somewhere not on this map' : 'No room with this number on the map'
    if (!t && e.to !== 0) to.style.borderColor = 'var(--danger)'
    const hid = h('input', { type: 'checkbox', title: 'Hidden: a real exit that isn\'t drawn as a line' }) as HTMLInputElement
    hid.checked = !!e.hidden
    hid.onchange = () => change(() => { if (hid.checked) e.hidden = true; else delete e.hidden })
    const del = h('button', { class: 'small danger', title: 'Remove this exit' }, '✕')
    del.onclick = () => change(() => { r.exits.splice(i, 1) })
    table.append(h('tr', {}, h('td', { class: 'way' }, way), h('td', {}, move), h('td', { class: 'go-to' }, to), h('td', { class: 'hid' }, hid), h('td', { class: 'del' }, del)))
  })
  props.append(table)
  const add = h('button', { class: 'small' }, '+ Add exit')
  add.onclick = () => change(() => { r.exits.push({ to: r.id, exit: 'go', move: 'go ' }) })
  props.append(h('p', { class: 'hint' }, 'The Link tool adds exits for you. Use this table for doors and other commands (“go door”, “climb ladder”). To # 0 means the exit leads somewhere not on this map.'))
  const del = h('button', { class: 'danger' }, 'Delete room')
  del.onclick = () => deleteSelection()
  props.append(h('div', { class: 'row' }, add, del))
  if (!r.title) setTimeout(() => title.focus())
}

// ── Edits ───────────────────────────────────────────────────────────────────

function addRoom(x: number, y: number): DaMapRoom {
  const r: DaMapRoom = { id: nextId(), x, y, z: floor, title: '', descriptions: [], exits: [] }
  map.rooms.push(r)
  byId.set(r.id, r)
  return r
}
function addLink(a: DaMapRoom, b: DaMapRoom, oneWay: boolean) {
  if (a.id === b.id) return
  const dir = a.z !== b.z ? (b.z > a.z ? 'up' : 'down') : directionBetween(a.x, a.y, b.x, b.y)
  const add = (from: DaMapRoom, to: DaMapRoom, exit: string) => {
    if (from.exits.some(e => e.to === to.id)) return
    const move = exit === 'go' ? 'go ' : exit
    from.exits.push({ to: to.id, exit, move } as DaMapExit)
  }
  add(a, b, dir)
  if (!oneWay) add(b, a, oppositeExit(dir) ?? 'go')
}
function deleteSelection() {
  if (selLabel != null) { const i = selLabel; selLabel = null; change(() => { map.labels.splice(i, 1) }); return }
  if (!selRooms.size) return
  const gone = new Set(selRooms)
  selRooms = new Set()
  change(() => {
    map.rooms = map.rooms.filter(r => !gone.has(r.id))
    for (const r of map.rooms) r.exits = r.exits.filter(e => !gone.has(e.to))
  })
}
function nudge(dx: number, dy: number) {
  if (selLabel != null) { const l = map.labels[selLabel]; change(() => { l.x += dx; l.y += dy }); return }
  if (!selRooms.size) return
  change(() => { for (const id of selRooms) { const r = byId.get(id)!; r.x += dx; r.y += dy } })
}
function select(ids: Iterable<number>, label: number | null = null) {
  selRooms = new Set(ids)
  selLabel = label
  render(); renderProps()
}

// ── Mouse ───────────────────────────────────────────────────────────────────

type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'move'; start: { x: number; y: number }; orig: Map<number, { x: number; y: number }>; before: string; moved: boolean }
  | { kind: 'label'; i: number; start: { x: number; y: number }; orig: { x: number; y: number }; before: string; moved: boolean }
  | { kind: 'box'; start: { x: number; y: number }; add: boolean }
  | { kind: 'link'; from: number }
let drag: Drag | null = null
let spaceDown = false

function hitRoom(t: EventTarget | null): number | null {
  const g = (t as Element | null)?.closest?.('[data-room]')
  return g ? Number(g.getAttribute('data-room')) : null
}
function hitLabel(t: EventTarget | null): number | null {
  const g = (t as Element | null)?.closest?.('[data-label]')
  return g ? Number(g.getAttribute('data-label')) : null
}

svg.addEventListener('contextmenu', e => e.preventDefault())
svg.addEventListener('mousedown', e => {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  const w = toWorld(e.clientX, e.clientY)
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    svg.classList.add('panning')
    e.preventDefault()
    return
  }
  if (e.button !== 0) return
  const room = hitRoom(e.target)
  const label = hitLabel(e.target)

  if (tool === 'link') {
    if (room != null) drag = { kind: 'link', from: room }
    return
  }
  if (tool === 'label' && label == null && room == null) {
    change(() => { map.labels.push({ text: 'Place name', x: snap(w.x, e.altKey), y: snap(w.y, e.altKey), z: floor }) }, { props: false })
    select([], map.labels.length - 1)
    return
  }
  if (tool === 'room' && room == null && label == null) {
    const prev = selRooms.size === 1 ? byId.get([...selRooms][0]) : undefined
    let made: DaMapRoom | null = null
    change(() => {
      made = addRoom(snap(w.x, e.altKey), snap(w.y, e.altKey))
      if (e.shiftKey && prev) addLink(prev, made, false)
    }, { props: false })
    if (made) select([(made as DaMapRoom).id])
    return
  }
  // select tool (and clicks on existing things with the other tools)
  if (label != null) {
    select([], label)
    const l = map.labels[label]
    drag = { kind: 'label', i: label, start: w, orig: { x: l.x, y: l.y }, before: snapshot(), moved: false }
    return
  }
  if (room != null) {
    if (e.shiftKey || e.ctrlKey) {
      const s = new Set(selRooms)
      if (s.has(room)) s.delete(room); else s.add(room)
      select(s)
      if (!s.has(room)) return
    } else if (!selRooms.has(room)) select([room])
    const orig = new Map([...selRooms].map(id => { const r = byId.get(id)!; return [id, { x: r.x, y: r.y }] as const }))
    drag = { kind: 'move', start: w, orig, before: snapshot(), moved: false }
    return
  }
  drag = { kind: 'box', start: w, add: e.shiftKey || e.ctrlKey }
  if (!drag.add && (selRooms.size || selLabel != null)) select([])
})

window.addEventListener('mousemove', e => {
  const w = toWorld(e.clientX, e.clientY)
  pointerWorld = w
  if (!drag) { updateStatus(); return }
  if (drag.kind === 'pan') {
    view.tx = drag.tx + e.clientX - drag.sx
    view.ty = drag.ty + e.clientY - drag.sy
    applyView()
  } else if (drag.kind === 'move') {
    const dx = w.x - drag.start.x, dy = w.y - drag.start.y
    if (!drag.moved && Math.hypot(dx, dy) * view.s < 3) return
    drag.moved = true
    // snap the room that was grabbed; the others keep their offsets
    const first = drag.orig.values().next().value!
    const sx = snap(first.x + dx, e.altKey) - first.x, sy = snap(first.y + dy, e.altKey) - first.y
    for (const [id, o] of drag.orig) { const r = byId.get(id); if (r) { r.x = o.x + sx; r.y = o.y + sy } }
    render()
  } else if (drag.kind === 'label') {
    const dx = w.x - drag.start.x, dy = w.y - drag.start.y
    if (!drag.moved && Math.hypot(dx, dy) * view.s < 3) return
    drag.moved = true
    const l = map.labels[drag.i]
    l.x = snap(drag.orig.x + dx, e.altKey); l.y = snap(drag.orig.y + dy, e.altKey)
    render()
  } else if (drag.kind === 'box') {
    const x = Math.min(drag.start.x, w.x), y = Math.min(drag.start.y, w.y)
    gUi.innerHTML = `<rect class="box" x="${x}" y="${y}" width="${Math.abs(w.x - drag.start.x)}" height="${Math.abs(w.y - drag.start.y)}"/>`
  } else if (drag.kind === 'link') {
    const a = byId.get(drag.from)!
    gUi.innerHTML = `<line class="rubber" x1="${a.x}" y1="${a.y}" x2="${w.x}" y2="${w.y}"/>`
  }
  updateStatus()
})

window.addEventListener('mouseup', e => {
  if (!drag) return
  const d = drag
  drag = null
  svg.classList.remove('panning')
  gUi.innerHTML = ''
  const w = toWorld(e.clientX, e.clientY)
  if ((d.kind === 'move' || d.kind === 'label') && d.moved) {
    if (snapshot() !== d.before) { pushUndo(d.before); markDirty() }
    renderProps()
  } else if (d.kind === 'box') {
    const x1 = Math.min(d.start.x, w.x), x2 = Math.max(d.start.x, w.x), y1 = Math.min(d.start.y, w.y), y2 = Math.max(d.start.y, w.y)
    if ((x2 - x1) * view.s < 3 && (y2 - y1) * view.s < 3) return
    const inBox = map.rooms.filter(r => r.z === floor && r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2).map(r => r.id)
    select(d.add ? [...selRooms, ...inBox] : inBox)
  } else if (d.kind === 'link') {
    const target = hitRoom(document.elementFromPoint(e.clientX, e.clientY))
    if (target != null && target !== d.from) {
      const a = byId.get(d.from)!, b = byId.get(target)!
      change(() => addLink(a, b, e.shiftKey), { props: false })
      select([target])
    }
  }
})

svg.addEventListener('wheel', e => {
  e.preventDefault()
  const r = svg.getBoundingClientRect()
  const px = e.clientX - r.left, py = e.clientY - r.top
  const k = Math.pow(1.0015, -e.deltaY)
  const s = Math.max(0.2, Math.min(20, view.s * k))
  view.tx = px - (px - view.tx) * (s / view.s)
  view.ty = py - (py - view.ty) * (s / view.s)
  view.s = s
  applyView(); updateStatus()
}, { passive: false })

// ── Keyboard ────────────────────────────────────────────────────────────────

function setTool(t: Tool) {
  tool = t
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.classList.toggle('on', b.dataset.tool === t)
  svg.className.baseVal = `tool-${t}`
}
const typing = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('input, textarea, select')

window.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return }
  if (typing(e.target)) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return }
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
  if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
  if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); select(map.rooms.filter(r => r.z === floor).map(r => r.id)); return }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openMap(); return }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newMap(); return }
  if (ctrl) return
  const step = (snapStep() || 1) * (e.shiftKey ? 5 : 1)
  switch (e.key) {
    case ' ': spaceDown = true; e.preventDefault(); break
    case 'v': case 'V': setTool('select'); break
    case 'r': case 'R': setTool('room'); break
    case 'l': case 'L': setTool('link'); break
    case 't': case 'T': setTool('label'); break
    case 'f': case 'F': fit(); updateStatus(); break
    case 'Delete': case 'Backspace': deleteSelection(); break
    case 'Escape': select([]); break
    case 'ArrowLeft': e.preventDefault(); nudge(-step, 0); break
    case 'ArrowRight': e.preventDefault(); nudge(step, 0); break
    case 'ArrowUp': e.preventDefault(); nudge(0, -step); break
    case 'ArrowDown': e.preventDefault(); nudge(0, step); break
    case 'PageUp': changeFloor(+1); break
    case 'PageDown': changeFloor(-1); break
  }
})
window.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false })

function changeFloor(dir: number) {
  const fl = floors()
  const i = fl.indexOf(floor)
  const next = fl[i - dir]
  if (next == null) return
  floor = next
  select([])
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Ask about unsaved changes. True when it's fine to go on. */
async function okToDiscard(): Promise<boolean> {
  if (!dirty) return true
  const c = await api.confirm('This map has changes you haven\'t saved.', 'Save them first?')
  if (c === 2) return false
  if (c === 0) return await save(false)
  return true
}
function load(m: DaMapFile, path: string | null) {
  map = m
  filePath = path
  past = []; future = []
  selRooms = new Set(); selLabel = null
  extraFloors.clear()
  const fl = floors()
  floor = fl.includes(0) || !m.rooms.length ? 0 : m.rooms[0].z
  markDirty(false)
  updateButtons()
  render(); renderProps()
  requestAnimationFrame(() => { fit(); updateStatus() })
}
async function newMap() {
  if (!(await okToDiscard())) return
  load(emptyDamap(), null)
  setTool('room')
}
async function openMap() {
  if (!(await okToDiscard())) return
  const f = await api.open()
  if (!f) return
  try { load(parseDamap(f.text), f.path) }
  catch (err) { alert(`Couldn't open that map:\n\n${(err as Error).message}`) }
}
async function importGenie() {
  if (!(await okToDiscard())) return
  const f = await api.importGenie()
  if (!f) return
  try {
    const m = zoneToDamap(readGenieXml(f.text, f.name))
    if (!m.rooms.length) { alert('That file has no rooms in it. Is it a Genie map?'); return }
    load(m, null)
    markDirty(true)
  } catch (err) { alert(`Couldn't read that Genie map:\n\n${(err as Error).message}`) }
}
async function save(saveAs: boolean): Promise<boolean> {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  const suggested = (map.file || map.name || 'map').replace(/\.xml$/i, '').replace(/[\\/:*?"<>|]+/g, '_') + '.damap'
  try {
    const p = await api.save(saveAs ? null : filePath, stringifyDamap(map), suggested)
    if (!p) return false
    filePath = p
    markDirty(false)
    const probs = checkDamap(map)
    status.textContent = probs.length ? `Saved. Worth a look: ${probs.join('; ')}` : `Saved ${p}`
    renderProps()
    return true
  } catch (err) { alert(`Couldn't save:\n\n${(err as Error).message}`); return false }
}

api.onMenu(async a => {
  switch (a) {
    case 'new': return newMap()
    case 'open': return openMap()
    case 'import': return importGenie()
    case 'save': return save(false)
    case 'save-as': return save(true)
    case 'save-then-close': if (await save(false)) api.closeNow(); return
    case 'undo': return undo()
    case 'redo': return redo()
    case 'select-all': return select(map.rooms.filter(r => r.z === floor).map(r => r.id))
    case 'delete': return deleteSelection()
    case 'fit': fit(); return updateStatus()
    case 'help': $('#help').hidden = false; return
  }
})

// ── Toolbar ─────────────────────────────────────────────────────────────────

for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.onclick = () => setTool(b.dataset.tool as Tool)
;($('#floor') as HTMLSelectElement).onchange = e => { floor = Number((e.target as HTMLSelectElement).value); select([]) }
$('#floor-add').onclick = () => { const top = Math.max(...floors()); extraFloors.add(top + 1); floor = top + 1; select([]) }
$('#fit').onclick = () => { fit(); updateStatus() }
$('#undo').onclick = undo
$('#redo').onclick = redo
$('#save').onclick = () => save(false)
$('#help-close').onclick = () => { $('#help').hidden = true }
new ResizeObserver(() => updateStatus()).observe(svg)

setTool('select')
load(emptyDamap(), null)
setTool('room')
$('#help').hidden = false
