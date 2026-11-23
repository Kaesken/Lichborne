// DaMaps Editor — main process: the window, the File/Edit menus, and the file
// dialogs. All editing happens in the window (renderer.ts); this side only
// reads and writes files and asks before closing with unsaved changes.

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

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

/** Where maps are saved by default: Documents\DaMaps */
function mapsFolder() {
  const dir = path.join(app.getPath('documents'), 'DaMaps')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

ipcMain.handle('open', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Open a map', defaultPath: mapsFolder(), filters: [{ name: 'Da\'Maps map', extensions: ['damap'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') }
})
ipcMain.handle('import', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Import a Genie map', filters: [{ name: 'Genie map', extensions: ['xml'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return null
  return { name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8') }
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
