// build-mana-seed — turn damaps-mana.log files (from the damaps-mana.lic Lich
// script) into Da'Maps' shared mana map, src/renderer/public/damaps-mana-seed.json.
//
//   node tools/damaps/build-mana-seed.mjs <damaps-mana.log> [more logs...]
//
// Keeps one reading per room and realm: the room's own PERCEIVE beats one a
// neighbour reported, then the newest wins. Only the room, realm and strength
// are kept (no character names or game text). Lunar is never included.
// Re-run with every log you have whenever there are new readings: it rebuilds
// the file from the logs given.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORDS = ['faint', 'dim', 'hazy', 'dull', 'muted', 'dusky', 'pale', 'flickering', 'shimmering',
  'pulsating', 'glowing', 'lambent', 'shining', 'luminous', 'radiant', 'fulgent',
  'brilliant', 'flaring', 'glaring', 'blazing', 'blinding']
const REALMS = new Set(['Life', 'Holy', 'Elemental', 'Arcane'])

const logs = process.argv.slice(2)
if (!logs.length) { console.error('usage: node tools/damaps/build-mana-seed.mjs <damaps-mana.log> [more logs...]'); process.exit(1) }

const best = {}   // id → realm → { level (1-21), near, at }
let lines = 0
for (const file of logs) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const c = line.split('\t')
    if (c.length < 8 || !/^\d+$/.test(c[2]) || !REALMS.has(c[4])) continue
    const level = Number(c[6]), outOf = Number(c[7])
    if (!(level >= 1 && outOf >= level)) continue
    const lv = outOf === 21 ? level : Math.max(1, Math.round((level / outOf) * 21))
    const near = c[3] !== 'here', at = c[0]
    const prev = best[c[2]]?.[c[4]]
    if (prev && ((near && !prev.near) || (near === prev.near && prev.at >= at))) continue
    ;(best[c[2]] ??= {})[c[4]] = { lv, near, at }
    lines++
  }
}

const rooms = {}
for (const [id, realms] of Object.entries(best)) {
  rooms[id] = {}
  for (const [realm, r] of Object.entries(realms)) rooms[id][realm] = r.near ? [r.lv, 1] : [r.lv]
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/public/damaps-mana-seed.json')
const made = new Date().toISOString().slice(0, 10)
fs.writeFileSync(out, JSON.stringify({ version: 1, made, words: WORDS, rooms }))
console.log(`shared mana map: ${Object.keys(rooms).length} rooms from ${logs.length} log(s) (${lines} readings used) -> ${out}`)
