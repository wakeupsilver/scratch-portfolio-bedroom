#!/usr/bin/env python3
"""Store one Scratcher's room in pinned/ so it opens instantly and never depends on Scratch being up.

Run: python3 tools/pin.py jay     Run it again whenever you want to refresh the snapshot.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

BIG_THUMBS = 8   # the poster's largest tiles plus the top of the leaderboard


def store(key, data):
    path = server._path_for(key, server.PINNED_DIR)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def main(name):
    user = server.get_user(name)
    data = json.loads(user)
    canon = data["profile"]["username"].lower()
    store("user:" + canon, user)
    store("scan:" + canon, server.load_scan(canon))
    projects = data["projects"]
    favorites = data["favorites"]
    friends = data["followers"] + data["following"]

    def image(kind, oid, size):
        try:
            ctype, body = server.get_image(kind, str(oid), size)
            store("img:%s:%s:%s" % (kind, oid, size), ctype + b"\n" + body)
        except server.UpstreamError as e:
            print("skipped image", kind, oid, size, e.status)

    def code(p):
        try:
            store("code:%d" % p["id"], server.get_code(str(p["id"])))
        except (server.UpstreamError, ValueError, KeyError) as e:
            print("skipped code", p["id"], e)

    loved = sorted(projects, key=lambda p: -p["loves"])[:BIG_THUMBS]
    jobs = [("p", p["id"], "144x108") for p in projects + favorites]
    jobs += [("p", p["id"], "216x163") for p in projects + favorites]
    jobs += [("p", p["id"], "480x360") for p in loved]
    jobs += [("u", data["profile"]["id"], "90x90")] + [("u", f["id"], "90x90") for f in friends]
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda j: image(*j), jobs))
        list(pool.map(code, projects))
    total = sum(f.stat().st_size for f in server.PINNED_DIR.rglob("*") if f.is_file())
    print("pinned %s: %d projects, %.1f MB in %s" % (canon, len(projects), total / 1e6, server.PINNED_DIR))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "jay")
