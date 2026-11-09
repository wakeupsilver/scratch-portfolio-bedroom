#!/usr/bin/env python3
"""Scratch Portfolio Bedroom server: static files plus a small, cached proxy for Scratch's public API.

Why a proxy exists: api.scratch.mit.edu only allows CORS from scratch.mit.edu, and
thumbnails have no CORS headers at all, so a browser app cannot read them directly
(WebGL textures need CORS). Everything upstream is reached through fixed URL templates
filled with validated ids, so callers can never choose which host gets fetched.

Standard library only. Run:  python3 server.py   (HOST / PORT env vars to change binding)
"""
import gzip
import hashlib
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE_DIR = Path(os.environ.get("BLOCKROOM_CACHE", ROOT / ".cache"))
PINNED_DIR = ROOT / "pinned"   # snapshots shipped with the app (see tools/pin.py); these never expire
API = "https://api.scratch.mit.edu"
USER_AGENT = "ScratchPortfolioBedroom/0.1 (fan-made Scratch portfolio visualizer)"
TRUST_PROXY = bool(os.environ.get("TRUST_PROXY"))

PAGE = 40                 # Scratch rejects limit > 40
MAX_PROJECTS = 1200
MAX_FRIENDS = 40
MAX_FAVORITES = 12
SCAN_TOP = 30             # how many projects the on-demand stats scan inspects
SCAN_COMMENT_PAGES = 5    # 5 pages * 40 = counts read "200+" beyond this
MAX_PROJECT_BYTES = 64 * 1024 * 1024
MAX_SCRIPTS = 60
MAX_BLOCKS_PER_SCRIPT = 40
CACHE_LIMIT_BYTES = 400 * 1024 * 1024

TTL_USER = 15 * 60
TTL_SCAN = 60 * 60
TTL_CODE = 6 * 60 * 60
TTL_IMG = 24 * 60 * 60

USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
ID_RE = re.compile(r"^[0-9]{1,12}$")
PROJECT_IMG_SIZES = {"144x108", "216x163", "282x218", "480x360"}
USER_IMG_SIZES = {"32x32", "50x50", "60x60", "90x90"}
IMG_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".json": "application/json",
}


class UpstreamError(Exception):
    def __init__(self, status, message=""):
        super().__init__(message or str(status))
        self.status = status


# ---------------------------------------------------------------- upstream + cache
_upstream_slots = threading.BoundedSemaphore(8)
_key_locks = {}
_key_locks_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=6)


def fetch(url, limit=MAX_PROJECT_BYTES):
    """GET with polite retries. Returns (bytes, content_type)."""
    last = None
    for attempt in range(3):
        try:
            with _upstream_slots:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as r:
                    body = r.read(limit + 1)
                    if len(body) > limit:
                        raise UpstreamError(413, "too large")
                    return body, r.headers.get("Content-Type", "").split(";")[0].strip()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise UpstreamError(e.code)
            last = UpstreamError(e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = UpstreamError(502, str(e))
        time.sleep(0.5 * (2 ** attempt))
    raise last


def fetch_json(path):
    return json.loads(fetch(API + path)[0].decode("utf-8"))


def _path_for(key, base=None):
    h = hashlib.sha256(key.encode()).hexdigest()
    return (base or CACHE_DIR) / h[:2] / h


def cache_get(key, ttl):
    p = _path_for(key)
    try:
        if time.time() - p.stat().st_mtime < ttl:
            return p.read_bytes()
    except OSError:
        pass
    return None


def cache_put(key, data):
    p = _path_for(key)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".%d.tmp" % threading.get_ident())
        tmp.write_bytes(data)
        tmp.replace(p)
    except OSError:
        pass  # a full or read-only disk only costs us the cache


def cached(key, ttl, produce):
    """Disk cache with per-key locking so concurrent visitors share one upstream load."""
    try:
        return _path_for(key, PINNED_DIR).read_bytes()
    except OSError:
        pass
    hit = cache_get(key, ttl)
    if hit is not None:
        return hit
    with _key_locks_guard:
        lock = _key_locks.setdefault(key, threading.Lock())
    with lock:
        hit = cache_get(key, ttl)
        if hit is not None:
            return hit
        try:
            data = produce()
            cache_put(key, data)
            return data
        finally:
            # A waiter still holding the old lock can at worst repeat one upstream load.
            with _key_locks_guard:
                _key_locks.pop(key, None)


def trim_cache():
    """Delete oldest cache files once the cache exceeds its size limit."""
    try:
        files = [(f.stat().st_mtime, f.stat().st_size, f) for f in CACHE_DIR.rglob("*") if f.is_file()]
    except OSError:
        return
    total = sum(s for _, s, _ in files)
    for _, size, f in sorted(files, key=lambda x: x[0]):
        if total <= CACHE_LIMIT_BYTES:
            break
        try:
            f.unlink()
            total -= size
        except OSError:
            pass


# ---------------------------------------------------------------- user data
def paged(path, cap):
    """Fetch offset/limit pages concurrently until a short page or the cap."""
    first = fetch_json("%s?limit=%d&offset=0" % (path, PAGE))
    out = list(first)
    offset = PAGE
    while len(first) == PAGE and len(out) < cap:
        offsets = [offset + i * PAGE for i in range(5) if offset + i * PAGE < cap]
        pages = list(_pool.map(lambda o: fetch_json("%s?limit=%d&offset=%d" % (path, PAGE, o)), offsets))
        for page in pages:
            out.extend(page)
        offset += PAGE * len(offsets)
        first = pages[-1]
    return out[:cap]


def trim_project(p):
    h = p.get("history") or {}
    s = p.get("stats") or {}
    r = p.get("remix") or {}
    return {
        "id": p["id"],
        "title": p.get("title") or "Untitled",
        "created": h.get("created"),
        "modified": h.get("modified"),
        "shared": h.get("shared"),
        "views": s.get("views", 0),
        "loves": s.get("loves", 0),
        "favorites": s.get("favorites", 0),
        "isRemix": bool(r.get("parent")),
    }


def trim_friend(u):
    return {"id": u["id"], "username": u["username"]}


def load_user(name):
    try:
        u = fetch_json("/users/" + name)
    except UpstreamError as e:
        raise UpstreamError(404, "No such Scratcher") if e.status == 404 else e
    canon = u["username"]
    projects = paged("/users/%s/projects" % canon, MAX_PROJECTS + 1)
    truncated = len(projects) > MAX_PROJECTS

    def optional(path):
        try:
            return fetch_json(path)
        except UpstreamError:
            return []   # a missing friend list should not stop the room from opening

    tail = "?limit=%d&offset=0"
    followers, following, favorites = _pool.map(optional, [
        "/users/%s/followers" % canon + tail % MAX_FRIENDS,
        "/users/%s/following" % canon + tail % MAX_FRIENDS,
        "/users/%s/favorites" % canon + tail % MAX_FAVORITES,
    ])
    # Deliberately omitted: bio, status and country. Many Scratchers are kids, and this
    # app has no need to re-display self-description or location next to their name.
    return json.dumps({
        "profile": {
            "id": u["id"],
            "username": canon,
            "joined": (u.get("history") or {}).get("joined"),
            "scratchteam": bool(u.get("scratchteam")),
        },
        "projects": [trim_project(p) for p in projects[:MAX_PROJECTS]],
        "truncated": truncated,
        "followers": [trim_friend(f) for f in followers],
        "following": [trim_friend(f) for f in following],
        "favorites": [trim_project(p) for p in favorites],
    }).encode()


def get_user(name):
    return cached("user:" + name.lower(), TTL_USER, lambda: load_user(name))


def count_comments(user, pid):
    total = 0
    for page in range(SCAN_COMMENT_PAGES):
        batch = fetch_json("/users/%s/projects/%s/comments?limit=%d&offset=%d" % (user, pid, PAGE, page * PAGE))
        total += len(batch)
        if len(batch) < PAGE:
            return total, False
    return total, True


def load_scan(name):
    """Comment and remix counts are not in the project list, so inspect the top projects."""
    data = json.loads(get_user(name))
    user = data["profile"]["username"]
    top = sorted(data["projects"], key=lambda p: -p["views"])[:SCAN_TOP]

    def inspect(p):
        out = {"id": p["id"], "remixes": 0, "comments": 0, "commentsCapped": False}
        try:
            out["remixes"] = (fetch_json("/projects/%d" % p["id"]).get("stats") or {}).get("remixes", 0)
            out["comments"], out["commentsCapped"] = count_comments(user, p["id"])
        except UpstreamError:
            pass
        return out

    return json.dumps({"scanned": len(top), "total": len(data["projects"]),
                       "results": list(_pool.map(inspect, top))}).encode()


# ---------------------------------------------------------------- project code
CATEGORY_NAMES = {"motion", "looks", "sound", "event", "control", "sensing", "operator", "data", "procedures"}

# Readable text for the common blocks; anything else falls back to a humanized opcode.
TEMPLATES = {
    "motion_movesteps": "move {STEPS} steps", "motion_turnright": "turn right {DEGREES} degrees",
    "motion_turnleft": "turn left {DEGREES} degrees", "motion_goto": "go to {TO}",
    "motion_gotoxy": "go to x: {X} y: {Y}", "motion_glideto": "glide {SECS} secs to {TO}",
    "motion_glidesecstoxy": "glide {SECS} secs to x: {X} y: {Y}",
    "motion_pointindirection": "point in direction {DIRECTION}", "motion_pointtowards": "point towards {TOWARDS}",
    "motion_changexby": "change x by {DX}", "motion_setx": "set x to {X}",
    "motion_changeyby": "change y by {DY}", "motion_sety": "set y to {Y}",
    "motion_ifonedgebounce": "if on edge, bounce", "motion_setrotationstyle": "set rotation style {STYLE}",
    "motion_xposition": "x position", "motion_yposition": "y position", "motion_direction": "direction",
    "looks_sayforsecs": "say {MESSAGE} for {SECS} secs", "looks_say": "say {MESSAGE}",
    "looks_thinkforsecs": "think {MESSAGE} for {SECS} secs", "looks_think": "think {MESSAGE}",
    "looks_switchcostumeto": "switch costume to {COSTUME}", "looks_nextcostume": "next costume",
    "looks_switchbackdropto": "switch backdrop to {BACKDROP}", "looks_nextbackdrop": "next backdrop",
    "looks_changesizeby": "change size by {CHANGE}", "looks_setsizeto": "set size to {SIZE} %",
    "looks_changeeffectby": "change {EFFECT} effect by {CHANGE}", "looks_seteffectto": "set {EFFECT} effect to {VALUE}",
    "looks_cleargraphiceffects": "clear graphic effects", "looks_show": "show", "looks_hide": "hide",
    "looks_gotofrontback": "go to {FRONT_BACK} layer", "looks_goforwardbackwardlayers": "go {FORWARD_BACKWARD} {NUM} layers",
    "looks_costumenumbername": "costume {NUMBER_NAME}", "looks_backdropnumbername": "backdrop {NUMBER_NAME}", "looks_size": "size",
    "sound_playuntildone": "play sound {SOUND_MENU} until done", "sound_play": "start sound {SOUND_MENU}",
    "sound_stopallsounds": "stop all sounds", "sound_changeeffectby": "change {EFFECT} effect by {VALUE}",
    "sound_seteffectto": "set {EFFECT} effect to {VALUE}", "sound_cleareffects": "clear sound effects",
    "sound_changevolumeby": "change volume by {VOLUME}", "sound_setvolumeto": "set volume to {VOLUME} %", "sound_volume": "volume",
    "event_whenflagclicked": "when green flag clicked", "event_whenkeypressed": "when {KEY_OPTION} key pressed",
    "event_whenthisspriteclicked": "when this sprite clicked", "event_whenstageclicked": "when stage clicked",
    "event_whenbackdropswitchesto": "when backdrop switches to {BACKDROP}",
    "event_whengreaterthan": "when {WHENGREATERTHANMENU} > {VALUE}", "event_whenbroadcastreceived": "when I receive {BROADCAST_OPTION}",
    "event_broadcast": "broadcast {BROADCAST_INPUT}", "event_broadcastandwait": "broadcast {BROADCAST_INPUT} and wait",
    "control_wait": "wait {DURATION} seconds", "control_repeat": "repeat {TIMES}", "control_forever": "forever",
    "control_if": "if {CONDITION} then", "control_if_else": "if {CONDITION} then", "control_wait_until": "wait until {CONDITION}",
    "control_repeat_until": "repeat until {CONDITION}", "control_stop": "stop {STOP_OPTION}",
    "control_start_as_clone": "when I start as a clone", "control_create_clone_of": "create clone of {CLONE_OPTION}",
    "control_delete_this_clone": "delete this clone",
    "sensing_touchingobject": "touching {TOUCHINGOBJECTMENU} ?", "sensing_touchingcolor": "touching color {COLOR} ?",
    "sensing_coloristouchingcolor": "color {COLOR} is touching {COLOR2} ?", "sensing_distanceto": "distance to {DISTANCETOMENU}",
    "sensing_askandwait": "ask {QUESTION} and wait", "sensing_answer": "answer", "sensing_keypressed": "key {KEY_OPTION} pressed?",
    "sensing_mousedown": "mouse down?", "sensing_mousex": "mouse x", "sensing_mousey": "mouse y", "sensing_loudness": "loudness",
    "sensing_timer": "timer", "sensing_resettimer": "reset timer", "sensing_of": "{PROPERTY} of {OBJECT}",
    "sensing_current": "current {CURRENTMENU}", "sensing_dayssince2000": "days since 2000", "sensing_username": "username",
    "sensing_setdragmode": "set drag mode {DRAG_MODE}",
    "operator_add": "{NUM1} + {NUM2}", "operator_subtract": "{NUM1} - {NUM2}", "operator_multiply": "{NUM1} * {NUM2}",
    "operator_divide": "{NUM1} / {NUM2}", "operator_random": "pick random {FROM} to {TO}",
    "operator_gt": "{OPERAND1} > {OPERAND2}", "operator_lt": "{OPERAND1} < {OPERAND2}", "operator_equals": "{OPERAND1} = {OPERAND2}",
    "operator_and": "{OPERAND1} and {OPERAND2}", "operator_or": "{OPERAND1} or {OPERAND2}", "operator_not": "not {OPERAND}",
    "operator_join": "join {STRING1} {STRING2}", "operator_letter_of": "letter {LETTER} of {STRING}",
    "operator_length": "length of {STRING}", "operator_contains": "{STRING1} contains {STRING2} ?",
    "operator_mod": "{NUM1} mod {NUM2}", "operator_round": "round {NUM}", "operator_mathop": "{OPERATOR} of {NUM}",
    "data_setvariableto": "set {VARIABLE} to {VALUE}", "data_changevariableby": "change {VARIABLE} by {VALUE}",
    "data_showvariable": "show variable {VARIABLE}", "data_hidevariable": "hide variable {VARIABLE}",
    "data_addtolist": "add {ITEM} to {LIST}", "data_deleteoflist": "delete {INDEX} of {LIST}",
    "data_deletealloflist": "delete all of {LIST}", "data_insertatlist": "insert {ITEM} at {INDEX} of {LIST}",
    "data_replaceitemoflist": "replace item {INDEX} of {LIST} with {ITEM}", "data_itemoflist": "item {INDEX} of {LIST}",
    "data_itemnumoflist": "item # of {ITEM} in {LIST}", "data_lengthoflist": "length of {LIST}",
    "data_listcontainsitem": "{LIST} contains {ITEM} ?",
}
HATS = {"event_whenflagclicked", "event_whenkeypressed", "event_whenthisspriteclicked", "event_whenstageclicked",
        "event_whenbackdropswitchesto", "event_whengreaterthan", "event_whenbroadcastreceived",
        "control_start_as_clone", "procedures_definition"}


def humanize(opcode):
    return re.sub(r"[_]+", " ", opcode.split("_", 1)[-1]).strip() or opcode


def category_of(opcode):
    head = opcode.split("_", 1)[0]
    if head == "argument":
        return "procedures"
    return head if head in CATEGORY_NAMES else "extension"


def proc_text(proccode, args):
    parts = re.split(r"(%[sbn])", proccode or "custom block")
    out, i = [], 0
    for part in parts:
        if part in ("%s", "%b", "%n"):
            out.append(args[i] if i < len(args) else "( )")
            i += 1
        else:
            out.append(part)
    return " ".join(p.strip() for p in out if p.strip())


class Sb3Reader:
    def __init__(self, blocks):
        self.blocks = blocks

    def literal(self, value):
        return "(%s)" % str(value)[:40]

    def input_text(self, spec, depth):
        # spec forms: [1, x] shadow only, [2, x] block only, [3, x, shadow] block over shadow.
        if not isinstance(spec, list) or len(spec) < 2:
            return "( )"
        val = spec[1]
        if isinstance(val, str):
            return self.reporter(val, depth + 1)
        if isinstance(val, list) and len(val) >= 2:
            return self.literal(val[1])   # number/string/colour/broadcast/variable/list primitives
        return "( )"

    def reporter(self, block_id, depth):
        b = self.blocks.get(block_id)
        if not isinstance(b, dict) or depth > 6:
            return "( )"
        fields = b.get("fields") or {}
        inputs = b.get("inputs") or {}
        if b.get("shadow") and not inputs and fields:     # dropdown menu shadow
            return "[%s]" % str(next(iter(fields.values()))[0])[:40]
        return "(%s)" % self.text(b, depth)

    def text(self, b, depth=0):
        op = b.get("opcode", "")
        inputs = b.get("inputs") or {}
        fields = b.get("fields") or {}
        mutation = b.get("mutation") or {}
        if op == "procedures_definition":
            proto = self.blocks.get((inputs.get("custom_block") or [None, None])[1]) or {}
            return "define " + proc_text((proto.get("mutation") or {}).get("proccode"), [])
        if op == "procedures_call":
            try:
                ids = json.loads(mutation.get("argumentids") or "[]")
            except ValueError:
                ids = []
            args = [self.input_text(inputs[i], depth) if i in inputs else "( )" for i in ids]
            return proc_text(mutation.get("proccode"), args)
        if op.startswith("argument_reporter"):
            return str((fields.get("VALUE") or ["arg"])[0])

        def fill(m):
            key = m.group(1)
            if key in inputs:
                return self.input_text(inputs[key], depth)
            if key in fields:
                return "[%s]" % str(fields[key][0])[:40]
            return "( )"

        template = TEMPLATES.get(op)
        if template:
            return re.sub(r"\{(\w+)\}", fill, template)
        extras = [self.input_text(v, depth) for k, v in inputs.items() if not k.startswith("SUBSTACK")]
        extras += ["[%s]" % str(v[0])[:40] for v in fields.values() if isinstance(v, list) and v]
        return " ".join([humanize(op)] + extras)

    def walk(self, block_id, depth, out, guard):
        while block_id and block_id not in guard:
            guard.add(block_id)
            b = self.blocks.get(block_id)
            if not isinstance(b, dict):
                return
            op = b.get("opcode", "")
            kind = "hat" if op in HATS else "stack"
            out.append({"c": category_of(op), "t": self.text(b)[:90], "d": depth, "k": kind})
            inputs = b.get("inputs") or {}
            for key in ("SUBSTACK", "SUBSTACK2"):
                if key not in inputs:
                    continue
                if key == "SUBSTACK2":
                    out.append({"c": "control", "t": "else", "d": depth, "k": "stack"})
                sub = inputs[key][1] if len(inputs[key]) > 1 else None
                if isinstance(sub, str):
                    self.walk(sub, depth + 1, out, guard)
            block_id = b.get("next")


def compact_sb3(data):
    sprites, totals = [], {}
    for t in data.get("targets", []):
        blocks = t.get("blocks") or {}
        reader = Sb3Reader(blocks)
        scripts = []
        for bid, b in blocks.items():
            if isinstance(b, dict):
                cat = category_of(b.get("opcode", ""))
                if not b.get("shadow"):
                    totals[cat] = totals.get(cat, 0) + 1
                if b.get("topLevel") and not b.get("shadow"):
                    rows = []
                    reader.walk(bid, 0, rows, set())
                    if len(rows) > 1 or rows and rows[0]["k"] == "hat":
                        scripts.append(rows)
        sprites.append({
            "name": str(t.get("name", "Sprite"))[:40],
            "isStage": bool(t.get("isStage")),
            "scripts": scripts,
            "costumes": [{"md5": c.get("md5ext") or "%s.%s" % (c.get("assetId"), c.get("dataFormat")),
                          "name": str(c.get("name", ""))[:40]} for c in t.get("costumes", [])],
            "sounds": [{"md5": s.get("md5ext") or "%s.%s" % (s.get("assetId"), s.get("dataFormat")),
                        "name": str(s.get("name", ""))[:40],
                        "adpcm": s.get("format") == "adpcm",
                        "secs": round((s.get("sampleCount") or 0) / (s.get("rate") or 22050), 1)}
                       for s in t.get("sounds", [])],
        })
    return sprites, totals


SB2_CATEGORY = [
    ("motion", ("forward:", "turn", "heading", "gotoX", "gotoSprite", "glide", "changeXpos", "xpos", "changeYpos", "ypos", "bounceOffEdge", "pointTowards")),
    ("looks", ("say", "think", "lookLike", "nextCostume", "show", "hide", "startScene", "nextScene", "changeGraphicEffect", "setGraphicEffect", "filterReset", "changeSizeBy", "setSizeTo", "comeToFront", "goBackByLayers", "costumeIndex", "sceneName", "scale")),
    ("sound", ("playSound", "doPlaySound", "stopAllSounds", "playDrum", "noteOn", "rest", "instrument", "changeVolume", "setVolume", "changeTempo", "setTempo", "volume", "tempo")),
    ("event", ("whenGreenFlag", "whenKey", "whenClicked", "whenScene", "whenSensor", "whenIReceive", "broadcast", "doBroadcast")),
    ("control", ("wait", "doRepeat", "doForever", "doIf", "doWait", "doUntil", "stopScripts", "whenCloned", "createClone", "deleteClone")),
    ("sensing", ("touching", "color", "distance", "doAsk", "answer", "keyPressed", "mouse", "soundLevel", "timer", "timeAndDate", "getAttribute", "getUserName")),
    ("data", ("setVar", "changeVar", "showVariable", "hideVariable", "append:", "deleteLine", "insert:", "setLine", "getLine", "lineCount", "list:", "readVariable", "contentsOfList")),
    ("procedures", ("procDef", "call", "getParam")),
]


def sb2_category(op):
    for cat, prefixes in SB2_CATEGORY:
        if op.startswith(prefixes):
            return cat
    return "operator"


# Scratch 2 names its blocks differently. Same wording as Scratch 3, filled by position.
SB2_TEXT = {
    "whenGreenFlag": "when green flag clicked", "whenClicked": "when this sprite clicked", "whenKeyPressed": "when {0} key pressed",
    "whenIReceive": "when I receive {0}", "whenSceneStarts": "when backdrop switches to {0}", "whenCloned": "when I start as a clone",
    "whenSensorGreaterThan": "when {0} > {1}", "broadcast:": "broadcast {0}", "doBroadcastAndWait": "broadcast {0} and wait",
    "forward:": "move {0} steps", "turnRight:": "turn right {0} degrees", "turnLeft:": "turn left {0} degrees",
    "heading:": "point in direction {0}", "pointTowards:": "point towards {0}", "gotoX:y:": "go to x: {0} y: {1}",
    "gotoSpriteOrMouse:": "go to {0}", "glideSecs:toX:y:elapsed:from:": "glide {0} secs to x: {1} y: {2}",
    "changeXposBy:": "change x by {0}", "xpos:": "set x to {0}", "changeYposBy:": "change y by {0}", "ypos:": "set y to {0}",
    "bounceOffEdge": "if on edge, bounce", "setRotationStyle": "set rotation style {0}", "xpos": "x position", "ypos": "y position", "heading": "direction",
    "say:duration:elapsed:from:": "say {0} for {1} secs", "say:": "say {0}", "think:duration:elapsed:from:": "think {0} for {1} secs", "think:": "think {0}",
    "show": "show", "hide": "hide", "lookLike:": "switch costume to {0}", "nextCostume": "next costume",
    "startScene": "switch backdrop to {0}", "nextScene": "next backdrop", "startSceneAndWait": "switch backdrop to {0} and wait",
    "changeGraphicEffect:by:": "change {0} effect by {1}", "setGraphicEffect:to:": "set {0} effect to {1}", "filterReset": "clear graphic effects",
    "changeSizeBy:": "change size by {0}", "setSizeTo:": "set size to {0} %", "comeToFront": "go to front layer", "goBackByLayers:": "go back {0} layers",
    "costumeIndex": "costume number", "sceneName": "backdrop name", "scale": "size",
    "playSound:": "start sound {0}", "doPlaySoundAndWait": "play sound {0} until done", "stopAllSounds": "stop all sounds",
    "playDrum": "play drum {0} for {1} beats", "rest:elapsed:from:": "rest for {0} beats", "noteOn:duration:elapsed:from:": "play note {0} for {1} beats",
    "instrument:": "set instrument to {0}", "changeVolumeBy:": "change volume by {0}", "setVolumeTo:": "set volume to {0} %", "volume": "volume",
    "changeTempoBy:": "change tempo by {0}", "setTempoTo:": "set tempo to {0}", "tempo": "tempo",
    "wait:elapsed:from:": "wait {0} seconds", "doRepeat": "repeat {0}", "doForever": "forever", "doIf": "if {0} then", "doIfElse": "if {0} then",
    "doWaitUntil": "wait until {0}", "doUntil": "repeat until {0}", "stopScripts": "stop {0}", "createCloneOf": "create clone of {0}", "deleteClone": "delete this clone",
    "touching:": "touching {0} ?", "touchingColor:": "touching color {0} ?", "color:sees:": "color {0} is touching {1} ?", "distanceTo:": "distance to {0}",
    "doAsk": "ask {0} and wait", "answer": "answer", "keyPressed:": "key {0} pressed?", "mousePressed": "mouse down?", "mouseX": "mouse x", "mouseY": "mouse y",
    "soundLevel": "loudness", "timer": "timer", "timerReset": "reset timer", "getAttribute:of:": "{0} of {1}", "timeAndDate": "current {0}", "timestamp": "days since 2000", "getUserName": "username",
    "+": "{0} + {1}", "-": "{0} - {1}", "*": "{0} * {1}", "/": "{0} / {1}", "randomFrom:to:": "pick random {0} to {1}", "<": "{0} < {1}", ">": "{0} > {1}", "=": "{0} = {1}",
    "&": "{0} and {1}", "|": "{0} or {1}", "not": "not {0}", "concatenate:with:": "join {0} {1}", "letter:of:": "letter {0} of {1}", "stringLength:": "length of {0}",
    "%": "{0} mod {1}", "rounded": "round {0}", "computeFunction:of:": "{0} of {1}",
    "readVariable": "{0}", "setVar:to:": "set {0} to {1}", "changeVar:by:": "change {0} by {1}", "showVariable:": "show variable {0}", "hideVariable:": "hide variable {0}",
    "contentsOfList:": "{0}", "append:toList:": "add {0} to {1}", "deleteLine:ofList:": "delete {0} of {1}", "insert:at:ofList:": "insert {0} at {1} of {2}",
    "setLine:ofList:to:": "replace item {0} of {1} with {2}", "getLine:ofList:": "item {0} of {1}", "lineCountOfList:": "length of {0}", "list:contains:": "{0} contains {1} ?",
    "procDef": "define {0}", "getParam": "{0}",
}


def sb2_text(op, args, depth=0):
    if op == "call" and args:
        return proc_text(str(args[0]), [sb2_expr(a, depth + 1) for a in args[1:]])
    if op == "procDef" and args:
        return "define " + proc_text(str(args[0]), [])
    if op == "getParam" and args:
        return str(args[0])[:40]
    parts = [sb2_expr(a, depth + 1) for a in args if not _is_stack(a)]
    template = SB2_TEXT.get(op)
    if template:
        return re.sub(r"\{(\d)\}", lambda m: parts[int(m.group(1))] if int(m.group(1)) < len(parts) else "( )", template)
    return " ".join([re.sub(r"[:]", " ", op).strip()] + parts)


def sb2_expr(v, depth=0):
    if isinstance(v, list) and v and isinstance(v[0], str) and depth < 6:
        return "(%s)" % sb2_text(v[0], v[1:], depth)
    if isinstance(v, list):
        return "( )"
    return "(%s)" % str(v)[:40]


def _is_stack(v):
    return isinstance(v, list) and (not v or isinstance(v[0], list))


def sb2_rows(stack, depth, out, totals):
    for block in stack if isinstance(stack, list) else []:
        if not isinstance(block, list) or not block or not isinstance(block[0], str):
            continue
        op = block[0]
        cat = sb2_category(op)
        totals[cat] = totals.get(cat, 0) + 1
        out.append({"c": cat, "t": sb2_text(op, block[1:])[:90], "d": depth, "k": "hat" if op.startswith(("when", "procDef")) else "stack"})
        stacks = [arg for arg in block[1:] if _is_stack(arg)]
        for i, arg in enumerate(stacks):
            if i:
                out.append({"c": "control", "t": "else", "d": depth, "k": "stack"})
            sb2_rows(arg, depth + 1, out, totals)


def compact_sb2(data):
    sprites, totals = [], {}
    targets = [data] + [c for c in data.get("children", []) if "objName" in c]
    for t in targets:
        scripts = []
        for s in t.get("scripts", []):
            if isinstance(s, list) and len(s) == 3:
                rows = []
                sb2_rows(s[2], 0, rows, totals)
                if rows:
                    scripts.append(rows)
        sprites.append({
            "name": str(t.get("objName", "Stage"))[:40],
            "isStage": t is data,
            "scripts": scripts,
            "costumes": [{"md5": c.get("baseLayerMD5"), "name": str(c.get("costumeName", ""))[:40]}
                         for c in t.get("costumes", []) if c.get("baseLayerMD5")],
            "sounds": [{"md5": s.get("md5"), "name": str(s.get("soundName", ""))[:40],
                        "adpcm": s.get("format") == "adpcm",
                        "secs": round((s.get("sampleCount") or 0) / (s.get("rate") or 22050), 1)}
                       for s in t.get("sounds", []) if s.get("md5")],
        })
    return sprites, totals


def compact_project(raw):
    """Turn a project file into a small drawing-friendly summary, whatever its era."""
    if raw.startswith(b"ScratchV"):   # Scratch 1.x binary; no code readable without a Squeak parser
        return {"format": "sb1", "sprites": [], "blockTotals": {}, "blockCount": 0, "scriptCount": 0}
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info = z.getinfo("project.json")
            if info.file_size > MAX_PROJECT_BYTES:
                raise UpstreamError(413, "too large")
            raw = z.read(info)
    data = json.loads(raw.decode("utf-8"))
    if "targets" in data:
        fmt, (sprites, totals) = "sb3", compact_sb3(data)
    else:
        fmt, (sprites, totals) = "sb2", compact_sb2(data)

    # Keep the file small: longest scripts first, across the whole project.
    script_count = sum(len(s["scripts"]) for s in sprites)
    kept = sorted(((len(rows), si, ri) for si, s in enumerate(sprites) for ri, rows in enumerate(s["scripts"])), reverse=True)
    keep = {(si, ri) for _, si, ri in kept[:MAX_SCRIPTS]}
    for si, s in enumerate(sprites):
        s["scripts"] = [{"rows": rows[:MAX_BLOCKS_PER_SCRIPT], "more": max(0, len(rows) - MAX_BLOCKS_PER_SCRIPT)}
                        for ri, rows in enumerate(s["scripts"]) if (si, ri) in keep]
        s["costumes"] = s["costumes"][:30]
        s["sounds"] = s["sounds"][:20]
    return {"format": fmt, "sprites": sprites, "blockTotals": totals,
            "blockCount": sum(totals.values()), "scriptCount": script_count}


def load_code(pid):
    meta = fetch_json("/projects/" + pid)
    token = meta.get("project_token")
    raw = fetch("https://projects.scratch.mit.edu/%s?token=%s" % (pid, token))[0]
    return json.dumps(compact_project(raw)).encode()


def get_code(pid):
    return cached("code:" + pid, TTL_CODE, lambda: load_code(pid))


# ---------------------------------------------------------------- images
def get_image(kind, oid, size):
    folder = "project" if kind == "p" else "user"
    url = "https://uploads.scratch.mit.edu/get_image/%s/%s_%s.png" % (folder, oid, size)

    def produce():
        body, ctype = fetch(url, limit=8 * 1024 * 1024)
        if ctype not in IMG_TYPES:
            raise UpstreamError(415, "unexpected image type")
        return ctype.encode() + b"\n" + body

    return cached("img:%s:%s:%s" % (kind, oid, size), TTL_IMG, produce).split(b"\n", 1)


# ---------------------------------------------------------------- rate limit
class RateLimiter:
    """Per-client token bucket on /api/*, so one visitor cannot exhaust Scratch's goodwill."""

    def __init__(self, per_minute=240):
        self.rate = per_minute / 60.0
        self.burst = float(per_minute)
        self.state = {}
        self.lock = threading.Lock()

    def allow(self, client):
        now = time.time()
        with self.lock:
            if len(self.state) > 10000:
                self.state.clear()
            tokens, last = self.state.get(client, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < 1:
                self.state[client] = (tokens, now)
                return False
            self.state[client] = (tokens - 1, now)
            return True


limiter = RateLimiter()


# ---------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "ScratchPortfolioBedroom"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("BLOCKROOM_LOG"):
            super().log_message(fmt, *args)

    def send_bytes(self, body, ctype, status=200, max_age=0):
        if "gzip" in self.headers.get("Accept-Encoding", "") and ctype.split(";")[0] in ("application/json", "text/javascript", "text/css", "text/html"):
            body = gzip.compress(body, 5)
            gz = True
        else:
            gz = False
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer-when-downgrade")
        self.send_header("Cache-Control", "public, max-age=%d" % max_age if max_age else "no-cache")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def send_err(self, status, message):
        self.send_bytes(json.dumps({"error": message}).encode(), "application/json", status)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path.startswith("/api/"):
                client = self.client_address[0]
                if TRUST_PROXY:   # behind a hosting proxy every visitor shares one socket address
                    client = self.headers.get("X-Forwarded-For", client).split(",")[-1].strip()
                if not limiter.allow(client):
                    return self.send_err(429, "Too many requests. Try again in a minute.")
                return self.route_api(path.split("/")[2:])
            if path.startswith("/img/"):
                return self.route_img(path.split("/")[2:])
            return self.route_static(path)
        except UpstreamError as e:
            status = e.status if e.status in (404, 429) else 502
            self.send_err(status, str(e) if status == 404 else "Scratch didn't answer. Try again soon.")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, KeyError, zipfile.BadZipFile) as e:
            self.send_err(502, "Couldn't read that data (%s)." % type(e).__name__)

    def route_api(self, parts):
        if len(parts) == 2:
            kind, arg = parts
            if kind == "user" and USERNAME_RE.match(arg):
                return self.send_bytes(get_user(arg), "application/json", max_age=60)
            if kind == "scan" and USERNAME_RE.match(arg):
                body = cached("scan:" + arg.lower(), TTL_SCAN, lambda: load_scan(arg))
                return self.send_bytes(body, "application/json", max_age=60)
            if kind == "code" and ID_RE.match(arg):
                return self.send_bytes(get_code(arg), "application/json", max_age=600)
        self.send_err(400, "Bad request")

    def route_img(self, parts):
        if len(parts) == 3 and parts[0] in ("p", "u") and ID_RE.match(parts[1]):
            allowed = PROJECT_IMG_SIZES if parts[0] == "p" else USER_IMG_SIZES
            if parts[2] in allowed:
                ctype, body = get_image(parts[0], parts[1], parts[2])
                return self.send_bytes(body, ctype.decode(), max_age=86400)
        self.send_err(400, "Bad request")

    def route_static(self, path):
        if path == "/" or (path.startswith("/u/") and USERNAME_RE.match(path[3:])):
            path = "/index.html"
        target = (WEB / path.lstrip("/")).resolve()
        if WEB.resolve() not in target.parents or not target.is_file() or target.suffix not in STATIC_TYPES:
            return self.send_err(404, "Not found")
        vendor = "/vendor/" in path or "/fonts/" in path
        self.send_bytes(target.read_bytes(), STATIC_TYPES[target.suffix], max_age=86400 if vendor else 0)


def cache_janitor():
    while True:
        trim_cache()
        time.sleep(3600)


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8642"))
    threading.Thread(target=cache_janitor, daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("Scratch Portfolio Bedroom is open at http://%s:%d" % (host, port), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
