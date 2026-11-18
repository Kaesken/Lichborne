// build-mana-seed — turn damaps-mana.log files (from the damaps-mana.lic Lich
// script) into the mana readings built into Da'Maps, src/renderer/public/damaps-mana-seed.json.
//
//   node tools/damaps/build-mana-seed.mjs <damaps-mana.log> [more logs...] [manual.txt...]
//
// Two kinds of file, mixed freely:
//   - damaps-mana.log from the script (tab-separated, 10 columns)
//   - a hand-written file for rooms Lich hasn't mapped, one reading per line,
//     tab-separated:  <square code> <realm> <word>   e.g.
//         g:1@0#123	Life	blinding
//     The square code is shown (with a Copy button) in Da'Maps' side panel for
//     a room marked "?". A hand reading counts as one taken in the room.
//     Lines starting with # are notes.
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

const SQUARE = /^g:[^#\s]+#-?\d+$/   // a Da'Maps square code
const best = {}   // id or square code → realm → { level (1-21), near, at }
let lines = 0
for (const file of logs) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let c = line.split('\t').map(x => x.trim())
    if (c.length === 1) c = line.split(/\s+/)
    // hand-written: code realm word  ->  the log's columns
    if (c.length === 3 && SQUARE.test(c[0])) {
      const w = WORDS.indexOf(c[2].toLowerCase())
      if (w < 0) { console.warn(`${file}: unknown word "${c[2]}" in: ${line}`); continue }
      const realm = c[1][0].toUpperCase() + c[1].slice(1).toLowerCase()
      c = ['9999-12-31 00:00:00', '', c[0], 'here', realm, c[2].toLowerCase(), String(w + 1), '21']
    }
    if (c.length < 8 || !(/^\d+$/.test(c[2]) || SQUARE.test(c[2])) || !REALMS.has(c[4])) continue
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
console.log(`built-in mana: ${Object.keys(rooms).length} rooms from ${logs.length} log(s) (${lines} readings used) -> ${out}`)
