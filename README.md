# qBitTools

**qBittorrent Tools** — a small self-hosted web UI to manage your qBittorrent torrents in bulk — rewrite tracker URLs with custom rules, run grouped actions, and browse your library. Python standard library only, no dependencies.

## Features

- **Torrent browser** — search, category/tag filters, column sorting, pagination, per-torrent tracker details (trackers / files / properties)
- **Tracker URL rewriter** — ordered find/replace rules (literal or regex), live rule playground, dry-run preview, per-torrent rollback history
- **Bulk actions** — reannounce, recheck, pause, resume, stop, delete (optional file deletion), set category, change download folder, add/remove trackers
- **Job log** — every operation runs as a background job with live progress

## Run

Requires Python 3.10+ and qBittorrent with the **Web UI** enabled (Tools → Options → Web UI).

```bash
python app.py --port 8787
```

Then open <http://127.0.0.1:8787> and log in with your qBittorrent Web UI credentials.

## Data and privacy

- Everything runs locally — the app only talks to `http://<host>:<port>/api/v2` on your machine.
- Credentials are entered in the browser and kept in memory only; nothing is written to disk.
- Tracker-rewrite history (`history.jsonl`) is stored locally next to `app.py` and is git-ignored — it contains your tracker URLs and torrent names.
- No telemetry, no external requests.

## Tests

No test suite — manual testing against a live qBittorrent instance.
