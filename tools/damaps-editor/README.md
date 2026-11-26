# DaMaps Editor

A small Windows program for making and changing Da'Maps maps: rooms, the lines
between them, and place names. It saves `.damap` files. The official maps live
in the Da'Maps repository, [github.com/Kaesken/Da-Maps](https://github.com/Kaesken/Da-Maps)
(`maps/`), which Lichborne downloads.

## Pictures (roads, bridges, roofs)

The editor can paint a picture of each floor for Da'Maps to show under the
rooms, using the Clip Studio brushes in `brushes/`:

- **Surfaces.** A link can be a Road, Dirt path, Bridge (wood or stone) or
  River. Pick one in the toolbar's **as** list before drawing links, or set it
  afterwards: select rooms and choose **Path between them**, or pick it next to
  each neighbour in a room's panel. Linked rooms with the same surface become
  one smooth curve; where roads meet, the straightest pair carries on through.
- **Buildings.** Tick **Building** on a room (or select several and click **Make
  them one building**). Joined rooms with the same building name share one roof
  shaped to all of them, with its ridge running room to room.
- **🖼 Picture** (P) shows it under the rooms as you work.
- **Make picture** (in the map's panel) saves a WebP per floor in an `art`
  folder beside your maps (the repository's `art/` when the map is in `maps/`)
  and records it in the map. The panel says when a picture is older than the
  map. Push the .damap to `maps/` and the picture to `art/` together.

## Using it

1. Open the **DaMaps Editor** shortcut. The program lives in a `Program` folder
   beside your `My Maps` folder (`build.mjs --pack --dir` makes it; the
   single-file portable exe works too but starts slowly, because it unpacks
   itself every time).
2. Open a map from the **My Maps** folder beside the program (**File → Open…**),
   start a new one (**File → New map**), or **File → Import Genie map…**.
3. Edit with the four tools:
   - **Select (V)**: click a room to edit it on the right; drag to move; drag on empty space to select several.
   - **Room (R)**: click to place a room. Shift-click places one and links it to the selected room.
   - **Link (L)**: drag from one room to another for exits both ways (hold Shift for one way).
   - **Label (T)**: click to place a place name.
4. Give every room its title and description exactly as the game shows them.
   That's how Da'Maps finds where you are.
5. **Save**. Maps go to the **My Maps** folder beside the program unless you pick somewhere else.
6. Put the `.damap` file in the Da'Maps repository's `maps/` folder and push.
   Players get it the next time they click **⇩ Update** in Da'Maps; no new
   Lichborne is needed.

**Trying maps before you push them:** start Lichborne with
`LICHBORNE_DAMAPS_DIR` set to your map folder (the DaMaps-start launcher sets it
to `My Maps`). Da'Maps then uses that folder instead of the download, and its
**⇩ Update** button becomes **↺ Reload**: save in the editor, click Reload, and
Lichborne rebuilds from your files. Nothing is downloaded and nothing in the
folder is changed.

Name the `.damap` files however you like. Inside each map, the **Link name**
(e.g. `Map1_Crossing.xml`) is how Da'Maps and other maps' doorways know it, so
leave it as it is on an existing map; a new map gets its own. **Doorway to** on
a room links it to another map by that map's link name.

## Getting the latest maps

**⇩ Latest maps** (or File → Get latest maps…) downloads the official maps from
the Da'Maps repository (`maps/` on `main`) into the map folder. Maps are matched
by link name, so renamed files are fine. A map changed since it was last
downloaded is only replaced if you say so. The list of maps is `maps/index.json`,
which the repository's workflow rewrites on every push; it is read from GitHub's
file server, which doesn't limit people without a GitHub login.

## Sharing it

`--pack --installer` makes `DaMaps-Editor-Setup-<version>.exe` from
[installer.nsi](installer.nsi) (our own NSIS script: electron-builder's NSIS
target needs Wine when built off Windows, makensis doesn't). It installs for the
current user, adds Start menu and optional desktop shortcuts, an uninstaller (in
Settings → Apps and on the Start menu), and the installed editor keeps maps in
`Documents\DaMaps`. It isn't code signed, so Windows warns on first run.

## Updates

New versions are releases on the Da-Maps repository
(github.com/Kaesken/Da-Maps/releases), tagged `editor-v<version>` with
`DaMaps-Editor-Setup-<version>.exe` attached ([editorUpdate.ts](src/editorUpdate.ts)).
To publish one: raise `version` in [package.json](package.json), build the
installer, and make a release with that tag and that file. Lichborne doesn't
read releases, so this never affects players.

The editor checks once a few seconds after it opens (it says nothing unless
there's a newer version) and from Help → Check for updates. **Update now**
downloads the installer, checks its size and SHA-256 against GitHub, closes the
editor (asking about unsaved changes as usual) and runs the installer silently
over the editor's own folder (`/S /UPDATE /D=<folder>`). The installer waits for
the editor to close, then reopens it. Run from source or as the old portable
exe, it only offers the download page.

## Building it

```
node tools/damaps-editor/build.mjs               # build into tools/damaps-editor/dist
npx electron tools/damaps-editor/dist            # run it
node tools/damaps-editor/build.mjs --pack --installer  # an installer to share (release/DaMaps-Editor-Setup-<version>.exe)
node tools/damaps-editor/build.mjs --pack --dir  # the program folder (release/win-unpacked); starts fast
node tools/damaps-editor/build.mjs --pack        # one portable .exe (starts slowly: it unpacks itself each time)
node tools/damaps-editor/build.mjs --pack --zip  # or a zip of the program folder
```

The file format and its checks are in
[`damaps/build/damapFormat.ts`](../../src/renderer/components/panels/damaps/build/damapFormat.ts), shared with the
Da'Maps build, so the editor saves exactly what the build reads.
