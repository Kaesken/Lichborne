// DaMaps Editor — "Get latest maps": bring a map folder up to date with the
// official maps on Lichborne's GitHub (tools/damaps/maps/ on main).
//
// Maps are matched by their link name (`file` inside the map), never by file
// name, because people rename their .damap files. To tell "you changed this
// map" from "this is just an older official copy", it remembers what each
// official map looked like when it was last downloaded (a git blob hash per
// link name, kept in the editor's own settings folder):
//   - not in the folder yet            → added
//   - the same as the official one     → nothing to do
//   - unchanged since the last download (or no record yet and it matches an
//     older official copy we can't know about) → updated in place
//   - changed by you                   → only replaced if you say so
// A file is replaced by writing beside it then renaming, keeping its name.
//
// No Electron imports, so a plain Node harness can drive it with any fetch.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseDamap } from '../../damaps/damapFormat'

export const OFFICIAL_REPO = 'elanthia-online/Lichborne'
export const OFFICIAL_REF = 'main'
export const OFFICIAL_DIR = 'tools/damaps/maps'

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export interface Source { repo: string; ref: string; dir: string }
export const OFFICIAL: Source = { repo: OFFICIAL_REPO, ref: OFFICIAL_REF, dir: OFFICIAL_DIR }

/** Git's id for a file's content, which GitHub's folder listing gives per file. */
export const blobSha = (buf: Buffer) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')

interface Local { path: string; sha: string }
export interface PlanItem { link: string; name: string; remoteName: string; remoteSha: string; local?: Local }
export interface Plan {
  added: PlanItem[]
  updated: PlanItem[]
  /** maps you changed that also have a newer official version */
  changedByYou: PlanItem[]
  same: number
}
export type Record_ = Record<string, string>   // link name (lower case) → official sha last downloaded

const UA = { 'User-Agent': 'DaMaps-Editor', Accept: 'application/vnd.github+json' }

function readLocal(folder: string): Map<string, Local & { name: string }> {
  const out = new Map<string, Local & { name: string }>()
  if (!fs.existsSync(folder)) return out
  for (const f of fs.readdirSync(folder)) {
    if (!f.toLowerCase().endsWith('.damap')) continue
    const p = path.join(folder, f)
    try {
      const buf = fs.readFileSync(p)
      const m = parseDamap(buf.toString('utf8'))
      const key = m.file.toLowerCase()
      if (!out.has(key)) out.set(key, { path: p, sha: blobSha(buf), name: m.name })
    } catch { /* not a readable map: leave it alone */ }
  }
  return out
}

/** Work out what an update would do. Downloads only the maps that differ. */
export async function planUpdate(folder: string, record: Record_, fetchFn: Fetch, src: Source = OFFICIAL):
  Promise<{ plan: Plan; texts: Map<string, string> } | { error: string }> {
  // The list of maps: index.json, which the Da'Maps build writes beside them.
  // It comes from GitHub's file server, which (unlike GitHub's API) doesn't
  // limit how often someone without a login may ask. The API is the fallback.
  const raw = `https://raw.githubusercontent.com/${src.repo}/${src.ref}/${src.dir}`
  let remote: { name: string; sha: string; download_url: string }[]
  const idx = await fetchFn(`${raw}/index.json`, { headers: { 'User-Agent': 'DaMaps-Editor' } })
  if (idx.ok) {
    const j = JSON.parse(await idx.text()) as { maps?: { name: string; sha: string }[] }
    remote = (j.maps ?? []).filter(e => e.name.toLowerCase().endsWith('.damap'))
      .map(e => ({ ...e, download_url: `${raw}/${e.name.split('/').map(encodeURIComponent).join('/')}` }))
  } else {
    const list = await fetchFn(`https://api.github.com/repos/${src.repo}/contents/${src.dir}?ref=${encodeURIComponent(src.ref)}`, { headers: UA })
    if (list.status === 404) return { error: 'There are no official maps on Lichborne\'s GitHub yet. They arrive when the Da\'Maps maps are added to Lichborne.' }
    if (list.status === 403 || list.status === 429) return { error: 'GitHub is limiting how often it can be asked right now. Try again in an hour.' }
    if (!list.ok) return { error: `GitHub answered ${list.status}. Try again later.` }
    const entries = (await list.json()) as { name: string; sha: string; download_url: string; type: string }[]
    remote = entries.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.damap'))
  }
  const local = readLocal(folder)
  const plan: Plan = { added: [], updated: [], changedByYou: [], same: 0 }
  const texts = new Map<string, string>()
  // The link name is inside the file, so a remote map has to be read to place
  // it, unless a local copy already has exactly its content.
  const localBySha = new Map([...local.entries()].map(([k, v]) => [v.sha, k]))
  for (const e of remote) {
    const sameKey = localBySha.get(e.sha)
    if (sameKey) { plan.same++; record[sameKey] = e.sha; continue }
    const r = await fetchFn(e.download_url, { headers: { 'User-Agent': 'DaMaps-Editor' } })
    if (!r.ok) return { error: `Couldn't download ${e.name} (GitHub answered ${r.status}).` }
    const text = await r.text()
    let m
    try { m = parseDamap(text) } catch { continue }      // not a map this editor can read: skip it
    const key = m.file.toLowerCase()
    texts.set(key, text)
    const mine = local.get(key)
    const item: PlanItem = { link: m.file, name: m.name, remoteName: e.name, remoteSha: e.sha, local: mine }
    if (!mine) plan.added.push(item)
    else if (record[key] && mine.sha === record[key]) plan.updated.push(item)
    else plan.changedByYou.push(item)
  }
  return { plan, texts }
}

/** Write the update. `replaceMine` also replaces the maps you changed. Returns the files written. */
export function applyUpdate(folder: string, plan: Plan, texts: Map<string, string>, record: Record_, replaceMine: boolean): string[] {
  fs.mkdirSync(folder, { recursive: true })
  const written: string[] = []
  const write = (item: PlanItem, target: string) => {
    const text = texts.get(item.link.toLowerCase())!
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, target)
    record[item.link.toLowerCase()] = item.remoteSha
    written.push(target)
  }
  for (const item of plan.added) {
    let target = path.join(folder, item.remoteName)
    for (let k = 2; fs.existsSync(target); k++) target = path.join(folder, item.remoteName.replace(/\.damap$/i, `_${k}.damap`))
    write(item, target)
  }
  for (const item of plan.updated) write(item, item.local!.path)
  if (replaceMine) for (const item of plan.changedByYou) write(item, item.local!.path)
  return written
}
