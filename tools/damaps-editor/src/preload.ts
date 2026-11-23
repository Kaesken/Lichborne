// DaMaps Editor — the small bridge between the window and the main process.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  open: () => ipcRenderer.invoke('open'),
  importGenie: () => ipcRenderer.invoke('import'),
  save: (path: string | null, text: string, suggested: string) => ipcRenderer.invoke('save', { path, text, suggested }),
  confirm: (msg: string, detail: string) => ipcRenderer.invoke('confirm', msg, detail),
  setDirty: (d: boolean) => ipcRenderer.send('dirty', d),
  setTitle: (t: string) => ipcRenderer.send('title', t),
  closeNow: () => ipcRenderer.send('close-now'),
  onMenu: (fn: (action: string) => void) => ipcRenderer.on('menu', (_e, a: string) => fn(a)),
})
