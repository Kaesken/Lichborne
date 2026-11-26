// DaMaps Editor — finding a newer editor on GitHub.
//
// New versions are published as releases on the Da-Maps repository
// (github.com/Kaesken/Da-Maps), tagged `editor-v<x.y.z>` with the installer
// `DaMaps-Editor-Setup-<x.y.z>.exe` attached. The tag prefix keeps editor
// releases apart from anything else that repository might release later.
// Lichborne doesn't look at releases (it downloads the maps by commit), so a
// release changes nothing for players.
//
// No Electron imports, so a plain Node harness can drive it with any fetch.

export const RELEASES_API = 'https://api.github.com/repos/Kaesken/Da-Maps/releases?per_page=30'
export const RELEASES_PAGE = 'https://github.com/Kaesken/Da-Maps/releases'
export const TAG_PREFIX = 'editor-v'

export interface EditorRelease {
  version: string
  notes: string
  page: string
  asset: { name: string; url: string; size: number; sha256: string | null }
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Compare two x.y.z versions: negative, 0 or positive. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

interface GhAsset { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown; state?: unknown }
interface GhRelease { tag_name?: unknown; draft?: unknown; prerelease?: unknown; body?: unknown; html_url?: unknown; assets?: unknown }

/** The newest published editor release in a GitHub releases list, or null. */
export function newestRelease(list: unknown): EditorRelease | null {
  if (!Array.isArray(list)) return null
  let best: EditorRelease | null = null
  for (const r of list as GhRelease[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !r.tag_name.startsWith(TAG_PREFIX)) continue
    const version = r.tag_name.slice(TAG_PREFIX.length)
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue
    const want = `DaMaps-Editor-Setup-${version}.exe`
    const a = (Array.isArray(r.assets) ? r.assets as GhAsset[] : []).find(x => x?.name === want && (x.state === undefined || x.state === 'uploaded'))
    if (!a || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') continue
    if (!a.browser_download_url.startsWith('https://github.com/')) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    const digest = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(a.digest) ? a.digest.slice(7) : null
    best = {
      version, notes: typeof r.body === 'string' ? r.body.trim() : '',
      page: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : RELEASES_PAGE,
      asset: { name: want, url: a.browser_download_url, size: a.size, sha256: digest },
    }
  }
  return best
}

/** Ask GitHub for the newest editor release. Throws when GitHub can't be reached. */
export async function findNewestRelease(fetchFn: Fetch): Promise<EditorRelease | null> {
  const r = await fetchFn(RELEASES_API, { headers: { 'User-Agent': 'DaMaps-Editor', Accept: 'application/vnd.github+json' } })
  if (r.status === 403 || r.status === 429) throw new Error('GitHub is limiting requests right now. Try again in an hour.')
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`)
  return newestRelease(await r.json())
}
