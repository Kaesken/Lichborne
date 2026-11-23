# Da'Maps maps

`.damap` files made in the [DaMaps Editor](../../damaps-editor/). The Da'Maps
build (`node tools/damaps/build-damaps.mjs …`) reads every file here:

- a map whose `file` is a Genie map's file name replaces that Genie map;
- any other map is added as a new one.

A room's optional `lich` number overrides the automatic match to a Lich room.
