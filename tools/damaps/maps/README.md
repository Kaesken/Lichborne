# Da'Maps maps

Da'Maps' own maps, one `.damap` file per map, made and changed in the
[DaMaps Editor](../../damaps-editor/). They started as the community Genie
maps (converted 2026-11-23) and are now the source: the build reads these and
Lich's map database, and nothing from Genie.

    node tools/damaps/build-damaps.mjs <Lich map-NNNN.json>

writes `src/renderer/public/damaps-world.json`, which ships with Lichborne.
A room's optional `lich` number overrides the automatic match to a Lich room.
