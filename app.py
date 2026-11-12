#!/usr/bin/env python3
"""Multi-tool web UI for qBittorrent: bulk tracker-URL rewriting,
grouped actions (reannounce, recheck, pause...) and torrent browser.

Stdlib only. Run:  python app.py [--port 8787]
Then open http://127.0.0.1:8787
"""

import argparse
import http.cookiejar
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
HISTORY_FILE = BASE_DIR / "history.jsonl"

# a "real" tracker URL has a scheme; pseudo-trackers look like "** [DHT] **"
URL_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")

MAX_LOG = 3000
CHUNK = 50  # hashes per API call for bulk actions

ACTIONS = {
    "reannounce": "/torrents/reannounce",
    "recheck": "/torrents/recheck",
    "pause": "/torrents/pause",
    "resume": "/torrents/resume",
    "stop": "/torrents/stop",
}

# parameterized actions: action -> {endpoint, params spec}
# spec values: "hashes" = batch param name, "hash" = per-torrent loop, or fixed key
ACTIONS_PARAMS = {
    "delete": {"endpoint": "/torrents/delete", "batch": "hashes", "extra": ["deleteFiles"]},
    "setCategory": {"endpoint": "/torrents/setCategory", "batch": "hashes", "extra": ["category"]},
    "setLocation": {"endpoint": "/torrents/setLocation", "batch": "hashes", "extra": ["location"]},
    "addTrackers": {"endpoint": "/torrents/addTrackers", "per_hash": True, "extra": ["urls"]},
    "removeTrackers": {"endpoint": "/torrents/removeTrackers", "per_hash": True, "extra": ["urls"]},
}

ACTION_LABELS = {
    **{k: k for k in ACTIONS},
    "delete": "Supprimer",
    "setCategory": "Définir catégorie",
    "setLocation": "Changer le dossier",
    "addTrackers": "Ajouter tracker(s)",
    "removeTrackers": "Retirer tracker(s)",
}


class QBClient:
    """Minimal qBittorrent Web API client (session cookie auth)."""

    def __init__(self, host, port, username, password):
        self.base = f"http://{host}:{port}/api/v2"
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        data = urllib.parse.urlencode({"username": username, "password": password}).encode()
        req = urllib.request.Request(self.base + "/auth/login", data=data)
        try:
            with self.opener.open(req, timeout=15) as resp:
                body = resp.read().decode().strip()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise RuntimeError("Login refusé : utilisateur ou mot de passe incorrect.")
            raise RuntimeError(f"qBittorrent a répondu HTTP {e.code} au login.")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Impossible de joindre qBittorrent ({host}:{port}): {e}")
        if body not in ("Ok.", ""):
            raise RuntimeError("Login refusé : utilisateur ou mot de passe incorrect.")
        try:
            with self._open("/app/version") as resp:
                resp.read()
        except Exception:
            raise RuntimeError("Session invalide après login.")

    def _open(self, path, data=None):
        req = urllib.request.Request(self.base + path, data=data)
        return self.opener.open(req, timeout=60)

    def get_json(self, path):
        with self._open(path) as resp:
            return json.loads(resp.read().decode())

    def post(self, path, params):
        data = urllib.parse.urlencode(params).encode()
        try:
            with self._open(path, data=data) as resp:
                return resp.status, resp.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")


# ---------------------------------------------------------------- state

class State:
    lock = threading.Lock()
    qb = None
    qb_info = {}
    torrents = []
    names = {}
    tracker_cache = {}  # hash -> {"trackers": [...], "urls": [...], "n_trackers": int}
    job = {"state": "idle", "kind": None, "done": 0, "total": 0, "log": []}


def job_log(msg):
    with State.lock:
        State.job["log"].append(msg)
        del State.job["log"][:-MAX_LOG]


def set_job(**kw):
    with State.lock:
        State.job.update(kw)


def is_tracker_url(url):
    return bool(URL_RE.match(url or ""))


def tracker_info(trackers):
    urls = [tr.get("url", "") for tr in trackers if is_tracker_url(tr.get("url", ""))]
    return {"n_trackers": len(urls), "urls": urls}


def torrent_public(t):
    h = t["hash"]
    info = State.tracker_cache.get(h)
    return {
        "hash": h,
        "name": t.get("name", ""),
        "size": t.get("total_size", 0),
        "category": t.get("category", ""),
        "tags": t.get("tags", "") or "",
        "progress": round(t.get("progress", 0) * 100, 1),
        "state": t.get("state", ""),
        "scanned": info is not None,
        "n_trackers": info["n_trackers"] if info else 0,
    }


def get_trackers(h):
    cached = State.tracker_cache.get(h)
    if cached:
        return cached["trackers"]
    return State.qb.get_json(f"/torrents/trackers?hash={h}")


# ---------------------------------------------------------------- rules

def validate_rules(rules):
    """Return (clean_rules, error)."""
    clean = []
    for i, r in enumerate(rules or []):
        find = (r.get("find") or "").strip()
        if not find:
            continue
        replace = r.get("replace") or ""
        is_regex = bool(r.get("regex"))
        if is_regex:
            try:
                re.compile(find)
            except re.error as e:
                return None, f"Règle #{i + 1} : regex invalide ({e})"
        clean.append({"find": find, "replace": replace, "regex": is_regex})
    if not clean:
        return None, "Aucune règle valide (le champ 'chercher' est vide)."
    return clean, None


def apply_rules(url, rules):
    new = url
    for r in rules:
        if r["regex"]:
            new = re.sub(r["find"], r["replace"], new)
        else:
            new = new.replace(r["find"], r["replace"])
    return new


def compute_edits(h, rules):
    """Return list of (old_url, new_url) for one torrent."""
    edits = []
    for tr in get_trackers(h):
        old = tr.get("url", "")
        if not is_tracker_url(old):
            continue
        new = apply_rules(old, rules)
        if new != old:
            edits.append((old, new))
    return edits


# ---------------------------------------------------------------- jobs

def run_scan():
    set_job(state="running", kind="scan", done=0, total=len(State.torrents), log=[])
    job_log(f"Scan de {len(State.torrents)} torrents…")
    for i, t in enumerate(State.torrents, 1):
        h = t["hash"]
        try:
            trackers = State.qb.get_json(f"/torrents/trackers?hash={h}")
            info = tracker_info(trackers)
            State.tracker_cache[h] = {"trackers": trackers, **info}
        except Exception as e:
            job_log(f"ERREUR trackers {h[:8]}… : {e}")
        if i % 25 == 0 or i == len(State.torrents):
            set_job(done=i)
    n = sum(1 for v in State.tracker_cache.values() if v["n_trackers"])
    job_log(f"Scan terminé : {n} torrent(s) avec trackers sur {len(State.torrents)}.")
    set_job(state="done")


def edit_one(h, old_url, new_url):
    """Replace one tracker URL in place. Returns a status string."""
    status, _ = State.qb.post("/torrents/editTracker", {"hash": h, "url": old_url, "newUrl": new_url})
    if status in (200, 204):
        return "ok"
    if status == 409:
        try:
            fresh = State.qb.get_json(f"/torrents/trackers?hash={h}")
            urls = {tr.get("url", "") for tr in fresh}
        except Exception:
            urls = set()
        if new_url in urls:
            return "deja"
        if old_url not in urls:
            return "introuvable"
    if status in (404, 405, 501, 409):
        State.qb.post("/torrents/removeTrackers", {"hash": h, "urls": old_url})
        s2, _ = State.qb.post("/torrents/addTrackers", {"hash": h, "urls": new_url})
        return "ok(fallback)" if s2 == 200 else f"ERREUR addTrackers {s2}"
    return f"ERREUR editTracker {status}"


def run_rewrite(rules, hashes, dry_run):
    set_job(state="running", kind="rewrite", done=0, total=len(hashes), log=[])
    tag = "[DRY-RUN] " if dry_run else ""
    job_log(f"{tag}Réécriture d'URL sur {len(hashes)} torrent(s), {len(rules)} règle(s)…")

    changes, n_err, touched = [], 0, set()
    for i, h in enumerate(hashes, 1):
        name = State.names.get(h, h)
        try:
            edits = compute_edits(h, rules)
        except Exception as e:
            job_log(f"ERREUR {name[:60]} : {e}")
            n_err += 1
            edits = []
        existing = set()
        if edits and not dry_run:
            try:
                existing = {tr.get("url", "") for tr in get_trackers(h)}
            except Exception:
                existing = set()
        for old, new in edits:
            if new in existing:
                st = "deja"
            elif dry_run:
                st = "dry-run"
            else:
                st = edit_one(h, old, new)
            job_log(f"{st.upper():>14}  {name[:50]}\n{'':>14}  {old}\n{'':>14}  -> {new}")
            if st.startswith("ERREUR"):
                n_err += 1
            elif not dry_run and st in ("ok", "ok(fallback)"):
                changes.append({"hash": h, "name": name, "old_url": old, "new_url": new})
                touched.add(h)
        if i % 10 == 0 or i == len(hashes):
            set_job(done=i)

    # invalidate cache for modified torrents so previews stay accurate
    for h in touched:
        State.tracker_cache.pop(h, None)

    if changes:
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "kind": "rewrite",
            "rules": rules,
            "n": len(changes),
            "changes": changes,
        }
        with open(HISTORY_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        job_log(f"Historique enregistré ({len(changes)} changement(s)) — rollback possible.")

    job_log(f"Terminé : {len(hashes)} torrent(s) traité(s), {n_err} erreur(s).")
    set_job(state="done")


def run_action(action, hashes, params=None):
    params = params or {}
    set_job(state="running", kind=f"action:{action}", done=0, total=len(hashes), log=[])
    job_log(f"Action '{ACTION_LABELS.get(action, action)}' sur {len(hashes)} torrent(s)…")
    n_err = 0
    uniq = sorted(set(hashes))

    if action in ACTIONS_PARAMS:
        spec = ACTIONS_PARAMS[action]
        endpoint = spec["endpoint"]
        urls = [u.strip() for u in (params.get("urls") or "").splitlines() if u.strip()]
        if action in ("addTrackers", "removeTrackers"):
            if not urls:
                job_log("ERREUR : aucune URL de tracker fournie.")
                set_job(state="done")
                return
        if spec.get("per_hash"):
            # one call per torrent; urls joined per endpoint convention
            sep = "\n" if action == "addTrackers" else "|"
            for i, h in enumerate(uniq):
                status, _ = State.qb.post(endpoint, {"hash": h, "urls": sep.join(urls)})
                if status != 200:
                    n_err += 1
                    job_log(f"ERREUR {h[:8]}… : HTTP {status}")
                if (i + 1) % 20 == 0 or i + 1 == len(uniq):
                    set_job(done=i + 1)
                    job_log(f"{i + 1}/{len(uniq)} torrents")
        else:
            extra = {k: params.get(k, "") for k in spec["extra"]}
            for j in range(0, len(uniq), CHUNK):
                batch = {spec["batch"]: "|".join(uniq[j:j + CHUNK]), **extra}
                status, _ = State.qb.post(endpoint, batch)
                if status == 200:
                    job_log(f"OK  lot {j // CHUNK + 1} ({len(uniq[j:j + CHUNK])} torrents)")
                else:
                    n_err += 1
                    job_log(f"ERREUR lot {j // CHUNK + 1} : HTTP {status}")
                set_job(done=min(j + CHUNK, len(uniq)))
    else:
        endpoint = ACTIONS[action]
        for j in range(0, len(uniq), CHUNK):
            batch = "|".join(uniq[j:j + CHUNK])
            status, _ = State.qb.post(endpoint, {"hashes": batch})
            if status == 200:
                job_log(f"OK  lot {j // CHUNK + 1} ({len(uniq[j:j + CHUNK])} torrents)")
            else:
                n_err += 1
                job_log(f"ERREUR lot {j // CHUNK + 1} : HTTP {status}")
            set_job(done=min(j + CHUNK, len(uniq)))

    job_log(f"Terminé : {len(uniq)} torrent(s), {n_err} erreur(s).")
    set_job(state="done")


def run_rollback(index):
    runs = load_history()
    if index < 0 or index >= len(runs):
        job_log("Rollback impossible : index invalide.")
        set_job(state="done")
        return
    run = runs[index]
    changes = run["changes"]
    set_job(state="running", kind="rollback", done=0, total=len(changes), log=[])
    job_log(f"Rollback du run #{index} ({run['ts']}) — {len(changes)} tracker(s).")
    n_err, touched = 0, set()
    for i, c in enumerate(changes, 1):
        try:
            st = edit_one(c["hash"], c["new_url"], c["old_url"])
        except Exception as e:
            st = f"ERREUR {e}"
        job_log(f"{st.upper():>14}  {c['name'][:50]}\n{'':>14}  {c['new_url']}\n{'':>14}  -> {c['old_url']}")
        if st.startswith("ERREUR"):
            n_err += 1
        elif st in ("ok", "ok(fallback)"):
            touched.add(c["hash"])
        if i % 20 == 0 or i == len(changes):
            set_job(done=i)
    for h in touched:
        State.tracker_cache.pop(h, None)
    job_log(f"Rollback terminé : {len(changes)} tracker(s), {n_err} erreur(s).")
    set_job(state="done")


def load_history():
    if not HISTORY_FILE.exists():
        return []
    runs = []
    for line in HISTORY_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                runs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return runs


# ---------------------------------------------------------------- http

def send_json(handler, obj, status=200):
    body = json.dumps(obj, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_body(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    if not length:
        return {}
    try:
        return json.loads(handler.rfile.read(length).decode())
    except json.JSONDecodeError:
        return {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])

        if path == "/api/torrents":
            return send_json(self, [torrent_public(t) for t in State.torrents])

        if path == "/api/trackers":
            h = query.get("hash", [""])[0]
            cached = State.tracker_cache.get(h)
            if cached:
                return send_json(self, cached["trackers"])
            if State.qb:
                try:
                    return send_json(self, State.qb.get_json(f"/torrents/trackers?hash={h}"))
                except Exception as e:
                    return send_json(self, {"error": str(e)}, 502)
            return send_json(self, {"error": "not connected"}, 401)

        if path == "/api/job":
            with State.lock:
                return send_json(self, State.job)

        if path == "/api/status":
            return send_json(self, {
                "connected": State.qb is not None,
                "info": State.qb_info,
                "n_torrents": len(State.torrents),
                "n_scanned": len(State.tracker_cache),
                "actions": sorted(ACTIONS),
            })

        if path == "/api/history":
            runs = load_history()
            summary = [
                {
                    "idx": i,
                    "ts": r.get("ts"),
                    "kind": r.get("kind", "rewrite"),
                    "n": r.get("n", len(r.get("changes", []))),
                    "rules": r.get("rules"),
                }
                for i, r in enumerate(runs)
            ]
            return send_json(self, summary[::-1])

        return send_json(self, {"error": "not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = read_body(self)

        if path == "/api/connect":
            try:
                port = int(body.get("port") or 8080)
                qb = QBClient(
                    body.get("host") or "127.0.0.1",
                    port,
                    body.get("username") or "user",
                    body.get("password") or "",
                )
                State.qb = qb
                State.qb_info = {
                    "host": body.get("host") or "127.0.0.1",
                    "port": port,
                    "username": body.get("username") or "user",
                }
                State.torrents = qb.get_json("/torrents/info")
                State.names = {t["hash"]: t.get("name", t["hash"]) for t in State.torrents}
                State.tracker_cache = {}
                return send_json(self, {"ok": True, "n_torrents": len(State.torrents)})
            except Exception as e:
                State.qb = None
                return send_json(self, {"ok": False, "error": str(e)}, 502)

        if path == "/api/disconnect":
            State.qb = None
            State.torrents = []
            State.names = {}
            State.tracker_cache = {}
            return send_json(self, {"ok": True})

        if path == "/api/scan":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            if State.job.get("state") == "running":
                return send_json(self, {"error": "un job est déjà en cours"}, 409)
            threading.Thread(target=run_scan, daemon=True).start()
            return send_json(self, {"ok": True})

        if path == "/api/preview":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            rules, err = validate_rules(body.get("rules"))
            if err:
                return send_json(self, {"error": err}, 400)
            hashes = body.get("hashes") or []
            results, errors = [], 0
            for h in hashes:
                try:
                    for old, new in compute_edits(h, rules):
                        results.append({"hash": h, "name": State.names.get(h, h), "old": old, "new": new})
                except Exception:
                    errors += 1
            return send_json(self, {"changes": results, "errors": errors})

        if path == "/api/rewrite":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            if State.job.get("state") == "running":
                return send_json(self, {"error": "un job est déjà en cours"}, 409)
            rules, err = validate_rules(body.get("rules"))
            if err:
                return send_json(self, {"error": err}, 400)
            hashes = body.get("hashes") or []
            if not hashes:
                return send_json(self, {"error": "aucun torrent sélectionné"}, 400)
            threading.Thread(
                target=run_rewrite,
                args=(rules, hashes, bool(body.get("dry_run"))),
                daemon=True,
            ).start()
            return send_json(self, {"ok": True})

        if path == "/api/test-rule":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            url = (body.get("url") or "").strip()
            rules, err = validate_rules(body.get("rules"))
            if err:
                return send_json(self, {"error": err}, 400)
            if not url:
                return send_json(self, {"error": "URL d'exemple requise"}, 400)
            return send_json(self, {"result": apply_rules(url, rules)})

        if path == "/api/torrent-detail":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            h = (body.get("hash") or "").strip()
            if not h:
                return send_json(self, {"error": "hash requis"}, 400)
            try:
                return send_json(self, {
                    "properties": State.qb.get_json(f"/torrents/properties?hash={h}"),
                    "files": State.qb.get_json(f"/torrents/files?hash={h}"),
                    "trackers": State.qb.get_json(f"/torrents/trackers?hash={h}"),
                })
            except Exception as e:
                return send_json(self, {"error": str(e)}, 502)

        if path == "/api/action":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            if State.job.get("state") == "running":
                return send_json(self, {"error": "un job est déjà en cours"}, 409)
            action = body.get("action")
            hashes = body.get("hashes") or []
            params = body.get("params") or {}
            known = action in ACTIONS or action in ACTIONS_PARAMS
            if not known:
                return send_json(self, {"error": "action inconnue"}, 400)
            if not hashes:
                return send_json(self, {"error": "aucun torrent sélectionné"}, 400)
            if action in ACTIONS_PARAMS:
                spec = ACTIONS_PARAMS[action]
                for k in spec["extra"]:
                    if k == "urls":
                        if not [u for u in (params.get("urls") or "").splitlines() if u.strip()]:
                            return send_json(self, {"error": "au moins une URL de tracker requise"}, 400)
                    elif not (params.get(k) or "").strip():
                        return send_json(self, {"error": f"paramètre '{k}' requis"}, 400)
            threading.Thread(
                target=run_action, args=(action, hashes, params), daemon=True
            ).start()
            return send_json(self, {"ok": True})

        if path == "/api/rollback":
            if not State.qb:
                return send_json(self, {"error": "not connected"}, 401)
            if State.job.get("state") == "running":
                return send_json(self, {"error": "un job est déjà en cours"}, 409)
            idx = body.get("index")
            if idx is None:
                return send_json(self, {"error": "index requis"}, 400)
            threading.Thread(target=run_rollback, args=(int(idx),), daemon=True).start()
            return send_json(self, {"ok": True})

        return send_json(self, {"error": "not found"}, 404)

    def _static(self, name):
        target = (STATIC_DIR / name).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            return send_json(self, {"error": "not found"}, 404)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1", help="address to bind this UI on")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"UI: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
