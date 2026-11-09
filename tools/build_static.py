#!/usr/bin/env python3
"""Build the static edition: one self-contained page with a fixed set of rooms, no server needed.

Run: python3 tools/build_static.py jay ericr mres griffpatch     Output: dist/index.html, dist/review/

The page holds its data, images and code inline. three.js and the font load from public CDNs.
Sounds are left out because audio can't be looked over before publishing. The yard shows the
other rooms plus each person's followers and following, whose links go to Scratch.
"""
import base64
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

THREE = "https://cdn.jsdelivr.net/npm/three@0.187.0/"
CODE_PROJECTS = 500         # readable projects per room, most viewed first
CAPSULES = 500              # old-format projects per room
CODE_BUDGET = 1200 * 1024   # bytes of code per room
COSTUMES_PER_ROOM = 24
YARD_SIZE = 22              # matches MAX_SHOWN in web/js/outside.js
SKIP_FRIENDS = {"nigg_76er"}   # names that read badly on a floating name tag
MAX_COSTUME_BYTES = 40 * 1024
BIG_THUMBS = 5
PLACEHOLDER_MAX_BYTES = 2400   # Scratch's 60x60 stand-in is 2309 bytes of PNG


def data_uri(ctype, body):
    return "data:%s;base64,%s" % (ctype, base64.b64encode(body).decode())


def image_uri(kind, oid, size):
    try:
        ctype, body = server.get_image(kind, str(oid), size)
    except server.UpstreamError:
        return None
    ctype = ctype.decode()
    # Width lives at byte 16 of a PNG header; 60 wide is the "no image" stand-in.
    if ctype == "image/png" and int.from_bytes(body[16:20], "big") <= 60:
        return None
    return data_uri(ctype, body)


def fetch_costume(md5):
    if not md5 or not md5.endswith((".png", ".svg")):
        return None
    try:
        body, _ = server.fetch("https://assets.scratch.mit.edu/internalapi/asset/%s/get/" % md5, limit=MAX_COSTUME_BYTES)
    except server.UpstreamError:
        return None
    return data_uri("image/svg+xml" if md5.endswith(".svg") else "image/png", body)


def bundle_modules():
    """Join the ES modules into one inline script, each in its own block scope."""
    js = ROOT / "web" / "js"
    order, seen = [], set()

    def visit(name):
        if name in seen:
            return
        seen.add(name)
        for dep in re.findall(r"^import .* from '\./(\w+)\.js';$", (js / (name + ".js")).read_text(), re.M):
            visit(dep)
        order.append(name)

    visit("main")
    out = ["import * as THREE from 'three';",
           "import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';",
           "const __m = {};"]
    for name in order:
        src = (js / (name + ".js")).read_text()
        src = re.sub(r"^import \* as THREE from 'three';\n", "", src, flags=re.M)
        src = re.sub(r"^import \{ RoundedBoxGeometry \} from .*\n", "", src, flags=re.M)
        imports = []

        def take(m):
            imports.append("const { %s } = __m.%s;" % (m.group(1).strip(), m.group(2)))
            return ""

        src = re.sub(r"^import \{([^}]*)\} from '\./(\w+)\.js';\n", take, src, flags=re.M)
        names = re.findall(r"^export (?:async )?(?:function|class|const) (\w+)", src, re.M)
        src = re.sub(r"^export (?=(?:async )?(?:function|class|const) )", "", src, flags=re.M)
        if re.search(r"^(import|export) ", src, re.M):
            raise SystemExit("unhandled import/export in " + name)
        out.append("{\n%s\n%s\n__m.%s = { %s };\n}" % ("\n".join(imports), src, name, ", ".join(names)))
    return "\n".join(out)


def main(names):
    bundle = {"rooms": {}, "code": {}, "img": {}, "costumes": {}}
    users = {}
    for name in names:
        users[name] = json.loads(server.get_user(name))
    canon = {n: u["profile"]["username"] for n, u in users.items()}
    review = []
    users_by = {canon[n]: u for n, u in users.items()}

    with ThreadPoolExecutor(4) as pool:
        for name, user in users.items():
            for key in ("followers", "following"):
                user[key] = [f for f in user[key] if f["username"] not in SKIP_FRIENDS]
            scan = json.loads(server.cached("scan:" + name.lower(), server.TTL_SCAN, lambda n=name: server.load_scan(n)))
            projects = user["projects"]
            neighbors = [{"id": users[o]["profile"]["id"], "username": canon[o], "neighbor": True} for o in names if o != name]
            bundle["rooms"][canon[name]] = {"user": {**user, "neighbors": neighbors}, "scan": scan}

            before = len(json.dumps(bundle, separators=(",", ":")))
            ids = [p["id"] for p in projects + user["favorites"]]
            # Same order as shapeData: only people who will actually stand in the yard need avatars.
            following = {f["username"] for f in user["following"]}
            followers = {f["username"] for f in user["followers"]}
            yard = [f for f in user["following"] if f["username"] in followers] + [f for f in user["followers"] if f["username"] not in following] + [f for f in user["following"] if f["username"] not in followers]
            yard = yard[:YARD_SIZE]
            for f, uri in zip(yard, pool.map(lambda f: image_uri("u", f["id"], "90x90"), yard)):
                if uri:
                    bundle["img"]["u/%d" % f["id"]] = uri
            for pid, uri in zip(ids, pool.map(lambda i: image_uri("p", i, "144x108"), ids)):
                if uri:
                    bundle["img"]["p/%d" % pid] = uri
            top = [p["id"] for p in sorted(projects, key=lambda p: -p["loves"])[:BIG_THUMBS]]
            for pid, uri in zip(top, pool.map(lambda i: image_uri("p", i, "480x360"), top)):
                if uri:
                    bundle["img"]["P/%d" % pid] = uri
            avatar = image_uri("u", user["profile"]["id"], "90x90")
            if avatar:
                bundle["img"]["u/%d" % user["profile"]["id"]] = avatar

            by_views = sorted(projects, key=lambda p: -p["views"])
            readable = [p for p in by_views if p["created"][:4] >= "2013"][:CODE_PROJECTS]
            capsules = [p for p in by_views if p["created"][:4] < "2013"][:CAPSULES]

            def load(p):
                try:
                    return p, json.loads(server.get_code(str(p["id"])))
                except (server.UpstreamError, ValueError, KeyError):
                    return p, None

            spent = 0
            candidates = []
            for p, code in pool.map(load, readable + capsules):
                if code is None:
                    continue
                for sprite in code["sprites"]:
                    sprite["sounds"] = []
                size = len(json.dumps(code))
                if spent + size > CODE_BUDGET:
                    continue
                spent += size
                candidates.append((p, code))

            wanted = []
            for p, code in sorted(candidates, key=lambda c: -c[0]["loves"]):
                for sprite in code["sprites"]:
                    if not sprite["isStage"]:
                        wanted += [c["md5"] for c in sprite["costumes"][:3]]
            kept = {}
            unique = list(dict.fromkeys(wanted))
            for md5, uri in zip(unique, pool.map(fetch_costume, unique[:COSTUMES_PER_ROOM * 4])):
                if uri and len(kept) < COSTUMES_PER_ROOM:
                    kept[md5] = uri
            bundle["costumes"].update(kept)
            for p, code in candidates:
                for sprite in code["sprites"]:
                    sprite["costumes"] = [c for c in sprite["costumes"] if c["md5"] in kept]
                bundle["code"][str(p["id"])] = code
            review.append((canon[name], projects, candidates, kept))
            sealed = sum(1 for _, c in candidates if c["format"] == "sb1")
            print("%s: %d projects; code for %d (%d old-format) of %d tried, %.0f KB; %d costumes; room adds %.1f MB" % (
                canon[name], len(projects), len(candidates), sealed, len(readable) + len(capsules), spent / 1024, len(kept),
                (len(json.dumps(bundle, separators=(",", ":"))) - before) / 1e6))

    css = (ROOT / "web/css/app.css").read_text()
    css = re.sub(r"@font-face \{.*?\n\}\n", "", css, count=1, flags=re.S)
    html = (ROOT / "web/index.html").read_text()
    html = html.replace(", viewport-fit=cover", "")
    html = re.sub(r'<link rel="preload"[^>]*>\n', "", html)
    html = re.sub(r"<title>.*?</title>", "<title>Scratch Portfolio Bedroom</title>", html)
    html = re.sub(r'<link rel="stylesheet" href="/css/app.css">',
                  lambda m: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@300..700&display=swap">\n<style>%s</style>' % css, html)
    imports = {"three": THREE + "build/three.module.js", "three/addons/": THREE + "examples/jsm/"}
    html = re.sub(r'<script type="importmap">.*?</script>', lambda m: '<script type="importmap">%s</script>' % json.dumps({"imports": imports}), html, flags=re.S)
    payload = json.dumps(bundle, separators=(",", ":")).replace("</", "<\\/")
    js = bundle_modules()
    if "</script" in js:
        raise SystemExit("script terminator inside the bundled code")
    html = html.replace('<script type="module" src="/js/main.js"></script>',
                        '<script type="application/json" id="bundle">%s</script>\n<script type="module">%s</script>' % (payload, js))
    dist = ROOT / "dist"
    (dist / "review").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text(html)
    print("page: %.1f MB (limit 16)" % (len(html.encode()) / 1e6))

    # What a person should look over before this gets published.
    lines = []
    literals = set()
    for name, projects, candidates, kept in review:
        lines.append("== %s titles" % name)
        lines += [p["title"] for p in projects]
        lines += ["FAV: " + p["title"] for p in users_by[name]["favorites"]]
        lines += ["FRIEND: " + f["username"] for f in users_by[name]["followers"] + users_by[name]["following"]]
        for _, code in candidates:
            for sprite in code["sprites"]:
                literals.add(sprite["name"])
                for script in sprite["scripts"]:
                    for row in script["rows"]:
                        literals.update(re.findall(r"[(\[]([^()\[\]]*[A-Za-z]{3}[^()\[\]]*)[)\]]", row["t"]))
    (dist / "review/titles.txt").write_text("\n".join(lines))
    (dist / "review/code_text.txt").write_text("\n".join(sorted(literals, key=str.lower)))
    sheet = ["<!doctype html><body style='margin:0;background:#fff;font:11px sans-serif'>"]
    for name, projects, _, _ in review:
        sheet.append("<h2 style='margin:6px'>%s</h2>" % name)
        sheet += ["<img width=88 height=66 src='%s'>" % bundle["img"]["p/%d" % p["id"]] for p in projects if "p/%d" % p["id"] in bundle["img"]]
        sheet.append("<h3 style='margin:6px'>%s favorites</h3>" % name)
        sheet += ["<img width=88 height=66 src='%s'>" % bundle["img"]["p/%d" % p["id"]] for p in users_by[name]["favorites"] if "p/%d" % p["id"] in bundle["img"]]
    sheet.append("<h2 style='margin:6px'>avatars</h2>")
    sheet += ["<img width=70 src='%s'>" % v for k, v in bundle["img"].items() if k.startswith("u/")]
    sheet.append("<h2 style='margin:6px'>costumes</h2>")
    sheet += ["<img width=88 height=88 style='object-fit:contain;border:1px solid #ccc' src='%s'>" % v for v in bundle["costumes"].values()]
    (dist / "review/sheet.html").write_text("".join(sheet))
    print("review: titles %d lines, code text %d strings %.0f KB" % (len(lines), len(literals), sum(map(len, literals)) / 1024))




if __name__ == "__main__":
    main(sys.argv[1:] or ["jay", "ericr", "mres", "griffpatch"])
