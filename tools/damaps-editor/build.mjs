// Build the DaMaps Editor into dist/ (and, with --pack, a Windows program).
//   node tools/damaps-editor/build.mjs          build only
//   node tools/damaps-editor/build.mjs --pack   build + Windows portable exe in tools/damaps-editor/release/
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
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, main: 'main.js' }, null, 1))
console.log('built', path.relative(process.cwd(), dist))

if (process.argv.includes('--pack')) {
  const { build: pack, Platform } = await import('electron-builder')
  await pack({
    targets: Platform.WINDOWS.createTarget(process.argv.includes('--zip') ? 'zip' : 'portable', 1 /* x64 */),
    projectDir: dist,
    config: {
      appId: 'com.lichborne.damaps-editor', productName: 'DaMaps Editor',
      electronVersion: JSON.parse(fs.readFileSync(path.join(here, '../../node_modules/electron/package.json'), 'utf8')).version,
      directories: { output: path.join(here, 'release'), app: dist },
      files: ['**/*'], npmRebuild: false, asar: true,
      win: { signAndEditExecutable: false, artifactName: 'DaMaps-Editor-${version}.${ext}' },
      portable: { artifactName: 'DaMaps-Editor-${version}.exe' },
    },
  })
}
