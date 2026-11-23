# DaMaps Editor

A small Windows program for making and changing Da'Maps maps: rooms, the lines
between them, and place names. It saves `.damap` files, which the Da'Maps build
reads from [`tools/damaps/maps/`](../damaps/maps/).

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
6. Send the `.damap` file to be added. It goes into `tools/damaps/maps/`, and
   the next Da'Maps build picks it up.

Name the `.damap` files however you like. Inside each map, the **Link name**
(e.g. `Map1_Crossing.xml`) is how Da'Maps and other maps' doorways know it, so
leave it as it is on an existing map; a new map gets its own. **Doorway to** on
a room links it to another map by that map's link name.

## Getting the latest maps

**⇩ Latest maps** (or File → Get latest maps…) downloads the official maps from
Lichborne's GitHub (`tools/damaps/maps/` on `main`) into the map folder. Maps
are matched by link name, so renamed files are fine. A map changed since it was
last downloaded is only replaced if you say so. The list of maps is
`index.json`, which the Da'Maps build writes; it is read from GitHub's file
server, which doesn't limit people without a GitHub login.

## Sharing it

`--pack --installer` makes `DaMaps-Editor-Setup-<version>.exe` from
[installer.nsi](installer.nsi) (our own NSIS script: electron-builder's NSIS
target needs Wine when built off Windows, makensis doesn't). It installs for the
current user, adds Start menu and optional desktop shortcuts and an uninstaller,
and the installed editor keeps maps in `Documents\DaMaps`. It isn't code
signed, so Windows warns on first run.

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
[`tools/damaps/damapFormat.ts`](../damaps/damapFormat.ts), shared with the
Da'Maps build, so the editor saves exactly what the build reads.
