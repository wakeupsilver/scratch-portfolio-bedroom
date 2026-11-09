# Scratch Portfolio Bedroom

Type any Scratch username and walk into a 3D room built from that person's public projects.

Fan-made, not affiliated with Scratch or MIT. Project images, sounds and code belong to their creators.

## Run it

```
python3 server.py
```

Then open http://127.0.0.1:8642, or go straight to a room at http://127.0.0.1:8642/u/jay

Python 3.8+ with no packages to install. `three.js` and the Fredoka font are vendored in `web/vendor` and `web/fonts`.

Environment variables: `HOST`, `PORT`, `BLOCKROOM_CACHE` (cache folder), `TRUST_PROXY=1` (read the visitor's address from `X-Forwarded-For` when behind a hosting proxy), `BLOCKROOM_LOG=1` (request logging).

## In the room

| Thing | What it shows | What you can do |
|---|---|---|
| Floor | One tile per project, oldest by the door, snaking to newest by the window. Colour = year, gem = most loved, ring = remix | Walk on it to play notes, hover for the thumbnail, click to open |
| Disco ball | Every tile is a project thumbnail | Hover to pop a tile out, click to open. It lowers as you approach |
| Poster | Mosaic where the most-loved project is biggest | Hover, click |
| Calendar | Months by years, GitHub-style | Click a month to list its projects |
| Control panel | Top 5 by views, loves, faves, comments, remixes or newest | Push a button: the screen ranks them and the floor rises into a skyline |
| Window | Followers and following as characters in the yard. Sky follows the visitor's clock | Click a friend to visit their room |
| Computer | Enters Code Land: real scripts drawn as blocks on curved walls in 3D | Fly around, click a script to zoom, see the block-type breakdown |
| Bed | Enters a dream: thumbnails morph across the sky, real costumes drift by, real project sounds echo over a soft pad | Drag to look, click anything floating |
| Shelf | Their favorited projects | Hover, click |
| Project sheet | Large thumbnail, stats, costumes | Play the real project in place, jump to its code |

Controls: WASD or arrows to walk, Shift to run, drag to look, wheel to step, click anything. Touch devices get a stick. "All projects" is a searchable text list, which is also the fallback when WebGL isn't available.

## Layout

```
server.py            static files + cached proxy for Scratch's public API, block-text rendering
web/js/main.js       app flow and travel between worlds
web/js/engine.js     renderer, camera rig, input, picking
web/js/atlas.js      one texture holding every thumbnail
web/js/room.js       shell, furniture, stations
web/js/floor.js  disco.js  wallart.js  outside.js    the room's stations
web/js/codeland.js   inside the computer
web/js/dream.js      in the bed
web/js/audio.js      synth effects and the dream mix
web/js/ui.js         hover card, project sheet, lists, HUD
docs/PLAN.md         what Scratch exposes, design decisions, roadmap
```

## Shared edition

`python3 tools/build_static.py jay ericr mres griffpatch`, then `node tools/rasterize.mjs dist/index.html` (public sharing on claude.ai rejects SVG images). Output: `dist/index.html`, one self-contained page.

## Tests

```
python3 tests/test_server.py                 # offline: parsing, validation, privacy, rate limit
npm i playwright-core                        # needs Node 18+ and an installed Chrome
OUT=/tmp node tests/e2e.mjs jay              # server must be running; uses live Scratch data
```
