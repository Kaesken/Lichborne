# DaMaps Editor

A small Windows program for making and changing Da'Maps maps: rooms, the lines
between them, and place names. It saves `.damap` files, which the Da'Maps build
reads from [`tools/damaps/maps/`](../damaps/maps/).

## Using it

1. Open **DaMaps Editor.exe**. It needs no install.
2. Open a map from the **Maps** folder beside the program (**File → Open…**),
   start a new one (**File → New map**), or **File → Import Genie map…**.
3. Edit with the four tools:
   - **Select (V)**: click a room to edit it on the right; drag to move; drag on empty space to select several.
   - **Room (R)**: click to place a room. Shift-click places one and links it to the selected room.
   - **Link (L)**: drag from one room to another for exits both ways (hold Shift for one way).
   - **Label (T)**: click to place a place name.
4. Give every room its title and description exactly as the game shows them.
   That's how Da'Maps finds where you are.
5. **Save**. Maps go to the **Maps** folder beside the program unless you pick somewhere else.
6. Send the `.damap` file to be added. It goes into `tools/damaps/maps/`, and
   the next Da'Maps build picks it up.

A map that keeps a Genie map's file name (e.g. `Map1_Crossing.xml`) replaces
that map in Da'Maps. A new file name adds a new map. **Doorway to** on a room
links it to another map by that map's file name.

## Building it

```
node tools/damaps-editor/build.mjs               # build into tools/damaps-editor/dist
npx electron tools/damaps-editor/dist            # run it
node tools/damaps-editor/build.mjs --pack        # Windows portable .exe in tools/damaps-editor/release
node tools/damaps-editor/build.mjs --pack --zip  # or a zip of the program folder
```

The file format and its checks are in
[`tools/damaps/damapFormat.ts`](../damaps/damapFormat.ts), shared with the
Da'Maps build, so the editor saves exactly what the build reads.
