// DaMaps Editor — main process: the window, the File/Edit menus, and the file
// dialogs. All editing happens in the window (renderer.ts); this side only
// reads and writes files and asks before closing with unsaved changes.

import { app, BrowserWindow, Menu, dialog, ipcMain, shell, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { decodeMapFile } from '../../damaps/readGenieXml'
import { planUpdate, applyUpdate, type Record_ } from './officialMaps'
import { parseDamap } from '../../damaps/damapFormat'
import { findNewestRelease, fetchUpdateInfo, compareVersions, RELEASES_PAGE, EDITOR_RAW } from './editorUpdate'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'

let win: BrowserWindow | null = null
let dirty = false
let closing = false

const send = (action: string) => win?.webContents.send('menu', action)

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'DaMaps Editor', backgroundColor: '#1b1d22', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, spellcheck: false },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.on('close', e => {
    if (!dirty || closing) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: 'Unsaved changes', message: 'This map has changes you haven\'t saved.', detail: 'Save them before closing?',
    })
    if (choice === 2) return
    if (choice === 1) { closing = true; win!.close(); return }
    win!.webContents.send('menu', 'save-then-close')
  })
  win.on('closed', () => { win = null })
}

function menu() {
  const tpl: Electron.MenuItemConstructorOptions[] = [
    { label: 'File', submenu: [
      { label: 'New map', click: () => send('new') },
      { label: 'Open…', click: () => send('open') },
      { label: 'Import Genie map…', click: () => send('import') },
      { label: 'Get latest maps…', click: () => getLatestMaps() },
      { type: 'separator' },
      { label: 'Save', click: () => send('save') },
      { label: 'Save as…', click: () => send('save-as') },
      { label: 'Show saved maps folder', click: () => shell.openPath(mapsFolder()) },
      { type: 'separator' },
      { label: 'Quit', click: () => win?.close() },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo   (Ctrl+Z)', click: () => send('undo') },
      { label: 'Redo   (Ctrl+Y)', click: () => send('redo') },
      { type: 'separator' },
      { label: 'Select all rooms on this floor   (Ctrl+A)', click: () => send('select-all') },
      { label: 'Delete selected   (Del)', click: () => send('delete') },
    ] },
    { label: 'View', submenu: [
      { label: 'Fit map to window   (F)', click: () => send('fit') },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ] },
    { label: 'Help', submenu: [
      { label: 'How to use the editor', click: () => send('help') },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => checkForUpdate(true) },
      { label: `About DaMaps Editor ${app.getVersion()}`, click: () => dialog.showMessageBox(win!, { type: 'info', message: `DaMaps Editor ${app.getVersion()}`, detail: `Makes and changes maps for Lichborne's Da'Maps.\n\nNew versions: ${RELEASES_PAGE}` }) },
    ] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl))
}

/**
 * Where maps are kept:
 *  - the portable exe: a My Maps folder beside it (it sets PORTABLE_EXECUTABLE_DIR);
 *  - a program folder with a My Maps folder beside it (<DaMaps Editor>\\Program
 *    and <DaMaps Editor>\\My Maps, the hand-installed layout): that folder;
 *  - otherwise (the installer, or run from source): Documents\\DaMaps. An
 *    installed program's own folder is replaced on update, so maps never go there.
 */
function mapsFolder() {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  const beside = path.join(path.dirname(process.execPath), '..', 'My Maps')
  const dir = portable ? path.join(portable, 'My Maps')
    : app.isPackaged && fs.existsSync(beside) ? beside
    : path.join(app.getPath('documents'), 'DaMaps')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Get latest maps ─────────────────────────────────────────────────────────

const recordFile = () => path.join(app.getPath('userData'), 'official-maps.json')
function loadRecord(): Record_ {
  try { return JSON.parse(fs.readFileSync(recordFile(), 'utf8')) } catch { return {} }
}
function saveRecord(r: Record_) {
  const tmp = recordFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(r, null, 1))
  fs.renameSync(tmp, recordFile())
}
let updating = false
async function getLatestMaps() {
  if (!win || updating) return
  updating = true
  win.webContents.send('status', 'Checking Lichborne\'s GitHub for the latest maps…')
  try {
    const folder = mapsFolder()
    const record = loadRecord()
    const r = await planUpdate(folder, record, (url, init) => net.fetch(url, init) as never)
    if ('error' in r) { dialog.showMessageBox(win, { type: 'info', message: 'Get latest maps', detail: r.error }); return }
    const { plan, texts } = r
    saveRecord(record)   // remembers maps already up to date
    const names = (xs: { name: string }[]) => xs.map(x => '  • ' + x.name).slice(0, 15).join('\n') + (xs.length > 15 ? `\n  …and ${xs.length - 15} more` : '')
    if (!plan.added.length && !plan.updated.length && !plan.changedByYou.length) {
      dialog.showMessageBox(win, { type: 'info', message: 'Your maps are up to date.', detail: `All ${plan.same} official maps match the ones in ${folder}.` })
      return
    }
    const parts: string[] = []
    if (plan.added.length) parts.push(`New maps (${plan.added.length}):\n${names(plan.added)}`)
    if (plan.updated.length) parts.push(`Updated maps (${plan.updated.length}):\n${names(plan.updated)}`)
    if (plan.changedByYou.length) parts.push(`You've changed these, and they also have a newer official version (${plan.changedByYou.length}):\n${names(plan.changedByYou)}`)
    const buttons = plan.changedByYou.length
      ? ['Update, keep my changed maps', 'Update and replace my changed maps', 'Cancel']
      : ['Update', 'Cancel']
    const choice = (await dialog.showMessageBox(win, {
      type: 'question', message: 'Get latest maps', detail: parts.join('\n\n'), buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true,
    })).response
    if (choice === buttons.length - 1) return
    const written = applyUpdate(folder, plan, texts, record, choice === 1 && plan.changedByYou.length > 0)
    saveRecord(record)
    win.webContents.send('maps-updated', written)
    dialog.showMessageBox(win, { type: 'info', message: `${written.length} map${written.length === 1 ? '' : 's'} updated.`, detail: `In ${folder}` })
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', message: 'Couldn\'t get the latest maps', detail: `${(e as Error).message}\n\nCheck your internet connection and try again.` })
  } finally {
    updating = false
    win?.webContents.send('status', '')
  }
}
ipcMain.on('get-latest', () => { getLatestMaps() })

/** Every map in the map folder: its link names and its name, for "Doorway to". */
ipcMain.handle('map-index', () => {
  const folder = mapsFolder()
  const out: { path: string; name: string; links: string[] }[] = []
  for (const f of fs.readdirSync(folder)) {
    if (!f.toLowerCase().endsWith('.damap')) continue
    try {
      const m = parseDamap(fs.readFileSync(path.join(folder, f), 'utf8'))
      out.push({ path: path.join(folder, f), name: m.name || f.replace(/\.damap$/i, ''), links: [m.file, ...(m.includes ?? [])] })
    } catch { /* not a readable map */ }
  }
  return out
})
ipcMain.handle('open', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Open a map', defaultPath: mapsFolder(), filters: [{ name: 'Da\'Maps map', extensions: ['damap'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') }
})
ipcMain.handle('reopen', (_e, p: string) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } })
ipcMain.handle('import', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Import a Genie map', filters: [{ name: 'Genie map', extensions: ['xml'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return { name: path.basename(r.filePaths[0]), text: decodeMapFile(fs.readFileSync(r.filePaths[0])) }
})
ipcMain.handle('save', async (_e, args: { path: string | null; text: string; suggested: string }) => {
  let p = args.path
  if (!p) {
    const r = await dialog.showSaveDialog(win!, { title: 'Save map', defaultPath: path.join(mapsFolder(), args.suggested), filters: [{ name: 'Da\'Maps map', extensions: ['damap'] }] })
    if (r.canceled || !r.filePath) return null
    p = r.filePath.toLowerCase().endsWith('.damap') ? r.filePath : r.filePath + '.damap'
  }
  // write to a temp file first so a failed save never leaves half a map
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, args.text, 'utf8')
  fs.renameSync(tmp, p)
  return p
})
/**
 * Where a map's pictures go: an `art` folder beside the maps. In the Da'Maps
 * repository layout (maps in `maps/`) that is the repository's `art/`; anywhere
 * else it is `art` inside the map's folder (My Maps\art).
 */
function artFolder(mapPath: string) {
  const dir = path.dirname(mapPath)
  return path.basename(dir).toLowerCase() === 'maps' ? path.join(dir, '..', 'art') : path.join(dir, 'art')
}
ipcMain.handle('save-art', (_e, args: { mapPath: string; file: string; png: ArrayBuffer }) => {
  if (!/^[^\\/:*?"<>|]+\.(png|webp)$/i.test(args.file)) throw new Error(`not a picture file name: ${args.file}`)
  const dir = artFolder(args.mapPath)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, args.file)
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(args.png))
  fs.renameSync(tmp, p)
  return p
})
ipcMain.handle('show-art', (_e, mapPath: string) => {
  const dir = artFolder(mapPath)
  fs.mkdirSync(dir, { recursive: true })
  return shell.openPath(dir)
})
ipcMain.on('dirty', (_e, d: boolean) => { dirty = d })
ipcMain.on('title', (_e, t: string) => win?.setTitle(t))
ipcMain.on('close-now', () => { closing = true; win?.close() })
ipcMain.handle('confirm', (_e, msg: string, detail: string) =>
  dialog.showMessageBoxSync(win!, { type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, message: msg, detail }))

// ── Updates ──────────────────────────────────────────────────────────────
// Checks the Da-Maps repository (editorUpdate.ts) once at start, quietly, and
// from Help → Check for updates.
//  - Small update (the usual case): when editor/version.json is newer and was
//    built for this same Electron, download editor/app.asar (~400 KB), check
//    its size and SHA-256, then close the editor (asking about unsaved changes
//    as usual). A helper (startHelper, below) waits for it to exit, moves the
//    new file over resources\app.asar and opens the editor again.
//  - Full install (new Electron, or version.json says `full`): download the installer from the newest
//    release and run it silently over this folder (`/S /UPDATE /D=…`), which
//    also reopens the editor.
// Run from source, as the old portable exe, or from a folder it can't write
// to, it only offers the download page.
let updateBusy = false
let pendingSwap: { file: string; asar: string } | null = null
let pendingInstaller: string | null = null

function canSelfInstall(): boolean {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR
}
const resourcesDir = () => process.resourcesPath
const asarPath = () => path.join(resourcesDir(), 'app.asar')
function canSwap(): boolean {
  if (!app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_DIR) return false
  try {
    const probe = path.join(resourcesDir(), '.write-test')
    fs.writeFileSync(probe, ''); fs.rmSync(probe)
    return fs.existsSync(asarPath())
  } catch { return false }
}

async function checkForUpdate(manual: boolean) {
  if (!win || updateBusy || pendingSwap || pendingInstaller) return
  updateBusy = true
  try {
    if (manual) win.webContents.send('status', 'Checking GitHub for a newer DaMaps Editor…')
    const fetchFn = (url: string, init?: { headers?: Record<string, string> }) => net.fetch(url, init) as never
    const info = await fetchUpdateInfo(fetchFn)
    if (!info || compareVersions(info.version, app.getVersion()) <= 0) {
      if (manual) dialog.showMessageBox(win, { type: 'info', message: 'DaMaps Editor is up to date.', detail: `You have version ${app.getVersion()}, the newest there is.` })
      return
    }
    const notes = info.notes ? `\n\nWhat's new:\n${info.notes.length > 900 ? info.notes.slice(0, 900) + '…' : info.notes}` : ''
    const have = `You have version ${app.getVersion()}.`
    const small = info.electron === process.versions.electron && !info.full && canSwap()
    const rel = small ? null : await findNewestRelease(fetchFn).catch(() => null)
    const full = !small && rel && compareVersions(rel.version, app.getVersion()) > 0 && canSelfInstall() ? rel : null
    if (!small && !full) {
      const c = (await dialog.showMessageBox(win, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
        message: `DaMaps Editor ${info.version} is available.`, detail: `${have} This copy can't update itself, so download the new version from GitHub.${notes}` })).response
      if (c === 0) shell.openExternal(rel?.page ?? RELEASES_PAGE)
      return
    }
    const size = small ? info.size : full!.asset.size
    const c = (await dialog.showMessageBox(win, { type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1,
      message: `DaMaps Editor ${info.version} is available.`,
      detail: `${have} Updating downloads it (${size < 1e6 ? `${Math.max(1, Math.round(size / 1e3))} KB` : `${Math.round(size / 1e6)} MB`}), closes the editor and opens the new version. Your maps aren't touched.${notes}` })).response
    if (c !== 0) return
    if (small) {
      const file = asarPath() + '.new'
      await download(`${EDITOR_RAW}/app.asar?v=${info.version}`, file, info.size, info.sha256, info.version)
      pendingSwap = { file, asar: asarPath() }
      startHelper({ asarNew: file, asar: asarPath() })
    } else {
      const dir = path.join(os.tmpdir(), 'DaMaps Editor update')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, full!.asset.name)
      await download(full!.asset.url, file, full!.asset.size, full!.asset.sha256, full!.version)
      pendingInstaller = file
      startHelper({ installer: file, dir: path.dirname(process.execPath) })
    }
    win?.webContents.send('status', `DaMaps Editor ${info.version} is ready. It installs when the editor closes.`)
    win?.close()
  } catch (e) {
    if (manual) dialog.showMessageBox(win!, { type: 'error', message: 'Couldn\'t check for updates', detail: `${(e as Error).message}\n\nCheck your internet connection and try again, or get it from ${RELEASES_PAGE}` })
    else console.warn('update check failed:', e)
  } finally {
    updateBusy = false
    win?.setProgressBar(-1)
    if (!pendingSwap && !pendingInstaller) win?.webContents.send('status', '')
  }
}

/** Download to `file`, checking the size and (when known) SHA-256; nothing is left behind on failure. */
async function download(url: string, file: string, size: number, sha256: string | null, version: string) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'DaMaps-Editor', 'Cache-Control': 'no-cache' } })
  if (!res.ok || !res.body) throw new Error(`The download failed (GitHub answered ${res.status}).`)
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(file)
  let got = 0, shown = -1, ok = false
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length
      if (got > size) throw new Error('The download is bigger than GitHub says it should be.')
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
      const pct = Math.floor(got * 100 / size)
      if (pct !== shown) { shown = pct; win?.setProgressBar(got / size); win?.webContents.send('status', `Downloading DaMaps Editor ${version}… ${pct}%`) }
    }
    if (got !== size) throw new Error('The download was cut short.')
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('The download didn\'t match the one on GitHub, so it wasn\'t installed.')
    ok = true
  } finally {
    await new Promise<void>(r => out.end(() => r()))
    if (!ok) fs.rmSync(file, { force: true })
  }
}

// The helper that finishes an update. It runs as a second, windowless copy of
// this same program in plain Node mode (ELECTRON_RUN_AS_NODE), from a script in
// the temp folder (not app.asar, which it has to replace). It's started as soon
// as the download is ready, before the editor closes, and waits for the editor
// (by process id) to exit; then it either moves app.asar.new over app.asar and
// opens the editor again, or runs the installer silently over this folder, which
// reopens it. It writes what it did to "DaMaps Editor update\update.log" in the
// temp folder. (1.3.0 and 1.3.1 used a hidden PowerShell started at quit, which
// never ran on Kaesken's PC.)
const HELPER = String.raw`
process.noAsar = true
const fs = require('fs'), path = require('path'), { spawn } = require('child_process')
const a = JSON.parse(process.argv[process.argv.length - 1])
const log = m => { try { fs.appendFileSync(a.log, new Date().toISOString() + ' ' + m + '\n') } catch {} }
const alive = p => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  log('waiting for the editor (pid ' + a.pid + ') to close')
  const until = Date.now() + 12 * 3600e3
  while (alive(a.pid) && Date.now() < until) await sleep(500)
  if (alive(a.pid)) { log('gave up waiting'); return }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  if (a.installer) {
    log('running the installer: ' + a.installer)
    spawn(a.installer, ['/S', '/UPDATE', '/D=' + a.dir], { argv0: '"' + a.installer + '"', detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env }).unref()
    return
  }
  let moved = false
  for (let i = 0; i < 80 && !moved; i++) {
    try { fs.renameSync(a.asarNew, a.asar); moved = true } catch (e) { if (i === 79) log('could not replace app.asar: ' + e.message); await sleep(250) }
  }
  log(moved ? 'updated app.asar' : 'left the old version in place')
  spawn(a.exe, [], { detached: true, stdio: 'ignore', env }).unref()
  log('reopened the editor')
})().catch(e => log('failed: ' + (e && e.stack || e)))
`

function startHelper(job: { asarNew?: string; asar?: string; installer?: string; dir?: string }) {
  const tmp = path.join(os.tmpdir(), 'DaMaps Editor update')
  fs.mkdirSync(tmp, { recursive: true })
  const script = path.join(tmp, 'update-helper.js')
  fs.writeFileSync(script, HELPER)
  const args = { ...job, pid: process.pid, exe: process.execPath, log: path.join(tmp, 'update.log') }
  spawn(process.execPath, [script, JSON.stringify(args)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true,
  }).unref()
}

app.whenReady().then(() => {
  // a swap that never happened (the editor was killed before closing)
  if (app.isPackaged) fs.rmSync(asarPath() + '.new', { force: true })
  menu(); createWindow(); setTimeout(() => checkForUpdate(false), 4000)
})
app.on('window-all-closed', () => app.quit())
