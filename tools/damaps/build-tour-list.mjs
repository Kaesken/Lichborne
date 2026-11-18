// build-tour-list — list every Lich room drawn on each Da'Maps map, for the
// damaps-mana.lic Lich script's tour mode, so a tour covers exactly what
// Da'Maps shows.
//
//   node tools/damaps/build-tour-list.mjs [out file]
//
// Reads src/renderer/public/damaps-world.json and writes damaps-maps.txt
// (default: tools/damaps/damaps-maps.txt). One line per map, all floors
// together, tab-separated:  <map name> <Lich IDs, comma-separated>
// Put the file in Lich's scripts/custom folder, next to damaps-mana.lic.
// Re-run whenever damaps-world.json is rebuilt.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const world = JSON.parse(fs.readFileSync(path.join(here, '../../src/renderer/public/damaps-world.json'), 'utf8'))
const out = process.argv[2] ?? path.join(here, 'damaps-maps.txt')
const maps = new Map()   // ground-floor key -> { name, ids }
for (const a of world.areas) {
  const ground = a.floors[0]
  if (!maps.has(ground)) maps.set(ground, { name: world.areas.find(x => x.key === ground)?.name ?? a.name, ids: new Set() })
  for (const r of a.rooms) if (r[1] && !r[5]) maps.get(ground).ids.add(r[1])
}
const lines = ['# Da\'Maps maps and the Lich rooms drawn on them, for damaps-mana.lic tours.',
  `# Made ${new Date().toISOString().slice(0, 10)} from damaps-world.json. One line per map: name<TAB>Lich IDs`]
let n = 0
for (const { name, ids } of [...maps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ids.size) continue
  lines.push(`${name}\t${[...ids].sort((x, y) => x - y).join(',')}`)
  n += ids.size
}
fs.writeFileSync(out, lines.join('\n') + '\n')
console.log(`${lines.length - 2} maps, ${n} rooms -> ${out}`)
