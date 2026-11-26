// Build the DaMaps Editor into dist/ (and, with --pack, a Windows program).
//   node tools/damaps-editor/build.mjs          build only
//   node tools/damaps-editor/build.mjs --pack   build + Windows portable exe in tools/damaps-editor/release/
//   node tools/damaps-editor/build.mjs --pack --installer   a Windows installer to share (release/DaMaps-Editor-Setup-<version>.exe)
//   node tools/damaps-editor/build.mjs --pack --dir   the program folder only (release/win-unpacked; starts much faster)
//   npx electron tools/damaps-editor/dist       run it from source
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, 'src'), dist = path.join(here, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })
const common = { bundle: true, logLevel: 'error', minifySyntax: true }
await build({ ...common, entryPoints: [path.join(src, 'main.ts')], outfile: path.join(dist, 'main.js'), platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
await build({ ...common, entryPoints: [path.join(src, 'preload.ts')], outfile: path.join(dist, 'preload.js'), platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
await build({ ...common, entryPoints: [path.join(src, 'renderer.ts')], outfile: path.join(dist, 'renderer.js'), platform: 'browser', format: 'iife', target: 'chrome140' })
for (const f of ['index.html', 'editor.css']) fs.copyFileSync(path.join(src, f), path.join(dist, f))
// the picture brushes (Kaesken's Clip Studio pack), loaded by paint.ts
fs.cpSync(path.join(here, 'brushes'), path.join(dist, 'brushes'), { recursive: true })
// the window icon (the program's own comes from icon/icon.ico, set below)
fs.copyFileSync(path.join(here, 'icon', 'icon.png'), path.join(dist, 'icon.png'))
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, main: 'main.js' }, null, 1))
console.log('built', path.relative(process.cwd(), dist))

// The program's icon. electron-builder only sets it with signAndEditExecutable,
// which needs Windows tools (rcedit), so it's written here with resedit (pure
// JavaScript, already installed by electron-builder): the icon group in
// Electron's exe is replaced by every size in icon/icon.ico.
async function setExeIcon(exePath) {
  const R = await import('resedit')
  const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const res = R.NtExecutableResource.from(exe)
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(here, 'icon', 'icon.ico')))
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries)
  if (!groups.length) throw new Error('no icon group in ' + exePath)
  for (const g of groups) R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map(i => i.data))
  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log('icon set:', path.basename(exePath))
}

if (process.argv.includes('--pack')) {
  const { build: pack, Platform } = await import('electron-builder')
  await pack({
    targets: Platform.WINDOWS.createTarget(process.argv.includes('--zip') ? 'zip' : process.argv.includes('--dir') || process.argv.includes('--installer') ? 'dir' : 'portable', 1 /* x64 */),
    projectDir: dist,
    config: {
      appId: 'com.lichborne.damaps-editor', productName: 'DaMaps Editor',
      electronVersion: JSON.parse(fs.readFileSync(path.join(here, '../../node_modules/electron/package.json'), 'utf8')).version,
      directories: { output: path.join(here, 'release'), app: dist },
      files: ['**/*'], npmRebuild: false, asar: true,
      win: { signAndEditExecutable: false, artifactName: 'DaMaps-Editor-${version}.${ext}' },
      afterPack: ctx => setExeIcon(path.join(ctx.appOutDir, 'DaMaps Editor.exe')),
      portable: { artifactName: 'DaMaps-Editor-${version}.exe' },
    },
  })
}

// The installer: our own NSIS script (installer.nsi) over the program folder.
// electron-builder's NSIS target needs Wine off Windows; makensis doesn't.
// makensis comes from electron-builder's cache (when a build has downloaded it),
// or set MAKENSIS to one (the Publish workflow uses Ubuntu's: /usr/bin/makensis).
if (process.argv.includes('--installer')) {
  const { execFileSync } = await import('node:child_process')
  const os = await import('node:os')
  const src = path.join(here, 'release', 'win-unpacked')
  const find = () => {
    if (process.env.MAKENSIS) return process.env.MAKENSIS
    const caches = [path.join(os.homedir(), '.cache', 'electron-builder'), path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache'), path.join(os.homedir(), 'Library', 'Caches', 'electron-builder')]
    const bin = process.platform === 'win32' ? 'makensis.exe' : path.join(process.platform === 'darwin' ? 'mac' : 'linux', 'makensis')
    for (const c of caches) {
      if (!fs.existsSync(c)) continue
      for (const top of fs.readdirSync(c).filter(d => d.startsWith('nsis-') && !d.startsWith('nsis-resources'))) {
        for (const inner of [top, ...fs.readdirSync(path.join(c, top))]) {
          const p = inner === top ? path.join(c, top, bin) : path.join(c, top, inner, bin)
          if (fs.existsSync(p)) return p
        }
      }
    }
    throw new Error('makensis not found: run a --pack build once, or set MAKENSIS')
  }
  const makensis = find()
  // electron-builder's copy needs NSISDIR pointed at its own folder; a system
  // makensis (MAKENSIS, e.g. Ubuntu's `nsis` package) already knows its own.
  const nsisDir = process.env.MAKENSIS ? undefined : path.dirname(process.platform === 'win32' ? makensis : path.dirname(makensis))
  // the uninstaller deletes exactly the top-level files it installed
  const files = path.join(here, 'release', 'installed-files.nsh')
  const top = fs.readdirSync(src).filter(f => fs.statSync(path.join(src, f)).isFile())
  fs.writeFileSync(files, top.map(f => `  Delete "$INSTDIR\\${f}"`).join('\n') + '\n')
  const out = path.join(here, 'release', `DaMaps-Editor-Setup-${pkg.version}.exe`)
  execFileSync(makensis, ['-V2', `-DSRC=${src}`, `-DOUT=${out}`, `-DVERSION=${pkg.version}`, `-DFILES=${files}`, `-DICON=${path.join(here, 'icon', 'icon.ico')}`, path.join(here, 'installer.nsi')],
    { stdio: 'inherit', env: nsisDir ? { ...process.env, NSISDIR: nsisDir } : process.env })
  console.log('installer:', path.relative(process.cwd(), out))
}
