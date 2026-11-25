// DaMaps Editor — main process: the window, the File/Edit menus, and the file
// dialogs. All editing happens in the window (renderer.ts); this side only
// reads and writes files and asks before closing with unsaved changes.

import { app, BrowserWindow, Menu, dialog, ipcMain, shell, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { decodeMapFile } from '../../damaps/readGenieXml'
import { planUpdate, applyUpdate, type Record_ } from './officialMaps'
import { parseDamap } from '../../damaps/damapFormat'

let win: BrowserWindow | null = null
let dirty = false
let closing = false

const send = (action: string) => win?.webContents.send('menu', action)

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'DaMaps Editor', backgroundColor: '#1b1d22',
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
    { label: 'Help', submenu: [ { label: 'How to use the editor', click: () => send('help') } ] },
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
ipcMain.on('dirty', (_e, d: boolean) => { dirty = d })
ipcMain.on('title', (_e, t: string) => win?.setTitle(t))
ipcMain.on('close-now', () => { closing = true; win?.close() })
ipcMain.handle('confirm', (_e, msg: string, detail: string) =>
  dialog.showMessageBoxSync(win!, { type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, message: msg, detail }))

app.whenReady().then(() => { menu(); createWindow() })
app.on('window-all-closed', () => app.quit())
