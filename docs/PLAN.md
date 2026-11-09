# Scratch Portfolio Bedroom: data inventory, design and roadmap

## What Scratch exposes publicly (checked November 2026, no login needed)

| Data | Where | Notes |
|---|---|---|
| Profile: id, username, joined, status, bio, country, avatar | `api.scratch.mit.edu/users/{name}` | Name lookups are case-insensitive. The app keeps only id, username and joined date |
| Project list: id, title, description, instructions, dates, views, loves, faves, remix parent and root | `/users/{name}/projects?limit=40&offset=n` | `limit` above 40 returns 400. `stats.remixes` is always 0 here |
| Project detail: real remix count, `project_token` | `/projects/{id}` | The token is required to download the project file |
| Project file: sprites, scripts, costumes, sounds, variables | `projects.scratch.mit.edu/{id}?token=` | Three eras: see below |
| Costume and sound files | `assets.scratch.mit.edu/internalapi/asset/{md5ext}/get/` | Allows any origin, so the browser fetches these directly |
| Thumbnails and avatars | `uploads.scratch.mit.edu/get_image/...` | No CORS headers, so they must be proxied to be usable as WebGL textures |
| Followers, following, favorites, curated studios | `/users/{name}/followers` etc. | Paged the same way |
| Comments | `/users/{name}/projects/{id}/comments` | No total count exists: must be counted page by page |
| Remixes | `/projects/{id}/remixes` | |
| Running project | `scratch.mit.edu/projects/{id}/embed` | Can be framed, so the real project runs inside the app |

Not available: private or unshared projects, exact per-edit history, or any rendered video frames.

### Surprises that shaped the design

- **CORS.** The main API only allows `scratch.mit.edu`, so a server-side proxy is required.
- **Three file eras.** `ScratchV01/V02` binary (Scratch 1.x), JSON with Scratch 2 opcodes, and Scratch 3 JSON. For `jay`, the 2007-2012 files are mostly binary.
- **Missing thumbnails.** Scratch returns an identical 60x60 placeholder instead of a 404. 24 of `jay`'s 116 projects have none: 23 of the 39 from 2007, plus the newest. Anything 60px or narrower gets a generated cover.
- **No comment or remix numbers in the list.** "Most comments" and "Most remixes" scan the 30 most-viewed projects on demand, up to 200 comments each, and say so on screen.
- **Do not de-duplicate thumbnails.** Identical thumbnails can be real: `jay`'s "Season's Greetings Visualization" series shares one.

## Design decisions

- **A room, not a dashboard.** Each way of seeing a portfolio is an object you walk up to, so exploring is the interface.
- **Disco ball rather than globe.** A mirror ball is already a sphere of little square tiles, it hangs in a room naturally, and it throws light around.
- **Floor layout.** A GitHub week grid would need around 1,000 columns across 19 years and be nearly empty. Instead every project gets one tile in a snake from door to window, so neighbours are always consecutive and you can walk the timeline. The GitHub-style view lives on as the wall calendar.
- **Towers stay under eye height,** so a skyline never walls off the room.
- **Real frames.** Capturing frames would mean running each project in a VM on the server. Playing the real project in an embed, plus real costumes, gives more for far less.
- **Privacy.** Many Scratchers are children. Bios, status text, location and comment text are never fetched for display or stored, even though they're public. Comments are only counted.
- **Safety.** Upstream URLs are fixed templates filled with validated ids. User-written titles only reach the page through `textContent`.

## Roadmap

1. **Before going public**
   - Read Scratch's terms and community guidelines on third-party use, and ideally ask the Scratch Team. This app shows children's accounts under their usernames.
   - Add a way for someone to remove their room from the app.
   - Hosting: any small Python host works, with `HOST=0.0.0.0` and `TRUST_PROXY=1`. A shared cache (CDN in front of `/img/`) would reduce load on Scratch.
2. **Open the time capsules.** Port a Scratch 1.x parser (such as the open-source `scratch-sb1-converter`) so 2007-2012 projects show their code, costumes, sounds and embedded thumbnails.
3. **Captured frames.** Optional server job that runs a project in the Scratch VM and saves frames for hover previews.
4. **Sharing.** A "postcard" image of your room, and a link to it.
5. **More from the data.** Studios as a bookshelf, remix family trees as a real tree in the yard, room decoration that kids can customize.
