# plungarr

Unclogs your Sonarr/Radarr download pipeline. plungarr watches the queues and
your SABnzbd downloads, and automatically fixes the stuck states that
otherwise sit there until a human notices: dead usenet posts downloading at
0 B/s forever, completed downloads wedged on "manual import required", junk
releases that can never import. It also reports suspicious library files for
manual inspection. What it can't fix safely, it reports and leaves alone.

Single-file Node 22 service, no dependencies. Talks to everything over the
apps' own HTTP APIs.

## What it does

### Sonarr / Radarr — queue handling (every cycle, default 5 min)

| Situation | Action |
|---|---|
| Completed download blocked on an ignorable technicality ("matched to series/movie **by ID**", "unable to determine if **sample**") | Verify every import candidate maps to the exact series/movie that was grabbed, then **force import**. A mapping mismatch is never imported. |
| "**No files found are eligible** for import" (empty or failed extraction) | Remove + blocklist + search for a replacement |
| Season "pack" that is **one video file** | Remove + blocklist + re-search |
| Download that is **not an upgrade** for the existing file | Remove + blocklist, keep the library file |
| Anything it doesn't recognize | `NOTIFY` log line, left untouched. Never guess. |

### Sonarr / Radarr — periodic reviews

| Sweep | What it catches |
|---|---|
| **Failure review** (6h) | Reads the arrs' history and flags any episode/movie with 3+ failed grabs and no successful import since as a `PROBLEM` log line — your short list of things that need a human to pick a release. Report-only. |
| **Corruption review** (24h) | Reports tracked files with missing MediaInfo, unusually small size, or low estimated bitrate. These are inspection hints, not proof of corruption. Never deletes library files or searches for replacements. |

### SABnzbd — stall watcher (every cycle, optional)

Enabled by setting `SABNZBD_URL` + `SABNZBD_API_KEY`.

| Situation | Action |
|---|---|
| Actively downloading job exceeds **missing-article thresholds** (>12% of the job, or >35% of what's been tried, across two observations) | Remove + blocklist + re-search via the arr that grabbed it. These configurable heuristics do not prove a job is beyond repair. |
| **Head-of-queue stalled** (<5 MB progress in 45 min) | Same — one per cycle, so a wall of dead posts clears itself while live downloads reset their own clock |
| Head wedged in Checking/Verifying/Repairing for hours | `STALL-NOTIFY` only — long par2 repairs are legitimate work, and a true wedge needs a SAB restart, which is deliberately not automated |
| Stalled/dead download no configured arr is tracking | Deleted in SAB directly (`ORPHAN` log line), only after complete ownership checks. Configure every arr sharing this SAB instance. |

## Quick start

Requires Docker with Compose, plus API keys from Sonarr and/or Radarr
(Settings → General → Security). SABnzbd URL + API key are optional and enable
the stalled/dead-download watcher.

```
git clone https://github.com/stove-bison/plungarr.git && cd plungarr
cp .env.example .env    # fill in your URLs and API keys
docker compose up -d --build
```

Watch it work:

```
docker logs -f plungarr
```

One line per action, plus a heartbeat every cycle (fictional examples):

```
2026-01-01T12:00:00Z | sonarr | IMPORTED | Example.Show.S01E02.720p.WEB.h264-GROUP | 1 file(s) sent to ManualImport
2026-01-01T12:00:01Z | sonarr | REMOVED+RESEARCH | Example.Series.S02.720p.WEB-DL | dead_empty
2026-01-01T12:00:02Z | sonarr | PROBLEM | Example Show S01E07 "Example Episode" | 3 failed grab(s) in 48h, none imported since
2026-01-01T12:00:03Z | cycle  | HEARTBEAT | queues processed in 3s | 2 gated, sweep idle
```

Grep for `PROBLEM` to see what needs your attention; everything else is
handled.

## Unraid

A Docker template is included: in the Docker tab choose **Add Container**,
set the template URL to
`https://raw.githubusercontent.com/stove-bison/plungarr/master/templates/plungarr.xml`,
fill in your URLs and API keys, done. The image is published to
`ghcr.io/stove-bison/plungarr:latest` after tests pass on pushes to `master`.

The container runs as uid 1000; if the appdata folder mapped to `/state`
isn't writable by it, plungarr still runs fine — it just keeps its
first-seen/loop-guard state in memory and starts fresh on restart (a
`state save failed` log line tells you this is happening). Stall timers always
start fresh after a restart.

## Configuration

Everything is an environment variable with a sane default — see
[.env.example](.env.example) for the full annotated list. The essentials:

| Variable | Default | |
|---|---|---|
| `SONARR_URL` / `SONARR_API_KEY` | — | At least one arr is required |
| `RADARR_URL` / `RADARR_API_KEY` | — | |
| `SABNZBD_URL` / `SABNZBD_API_KEY` | — | Optional; enables the stall watcher |
| `INTERVAL_SECONDS` | 300 | Cycle length |
| `DRY_RUN` | false | Log intended actions; use fresh memory-only state without reading or writing live state |
| `RUN_ONCE` | false | Run one cycle and finish the periodic reviews before exiting |

## Safety rails

- Import-blocked items are acted on immediately (the arr has already given up
  on them); anything transitional must be seen stuck across two cycles first,
  so an active import is never raced.
- Blocklist loop guard: indexers re-serve the same junk under new GUIDs; after
  2 blocklists of the same release title, plungarr stops re-searching for it.
- Corruption review is always report-only. Missing metadata, unknown age, and
  unusual bitrate can never authorize deleting a library file.
- Stall timers reset on pause, head changes, restart, failed queue reads, and
  gaps longer than two configured cycle intervals (with a minimum of 60 seconds).
- Checking, fetching repair data, verifying, repairing, queued, and propagating
  jobs are excluded from automatic missing-article removals.
- Ownership checks read all arr queue pages. Failed, incomplete, or inconsistent
  snapshots stop the removal; SAB queue observation is also paginated.
- Invalid numeric or boolean configuration stops startup with the setting name.
- Per-item action dedupe (30 min) while the arr catches up.
- `DRY_RUN=true` to watch what it *would* do first.

The older `CORRUPT_MAX_DELETES`, `CORRUPT_LOOP_LIMIT`,
`CORRUPT_MIN_AGE_HOURS`, and `CORRUPT_NO_SEARCH_SERIES_IDS` settings no longer
control actions: library deletion has been removed. Old numeric values are
still validated so malformed configuration does not pass silently.

## Development checks

Run `node --check janitor.mjs` and `node --test` with Node 22. Tests use synthetic
data, mocked APIs, and a local HTTP fixture; they do not contact configured
media services. Pull requests and branch pushes run the tests before an eligible
image publication can proceed.

## License

[MIT](LICENSE)
