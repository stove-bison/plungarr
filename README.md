# plungarr

Unclogs your Sonarr/Radarr download pipeline. plungarr watches the queues and
your SABnzbd downloads, and automatically fixes the stuck states that
otherwise sit there until a human notices: dead usenet posts downloading at
0 B/s forever, completed downloads wedged on "manual import required", junk
releases that can never import. It also reports suspicious library files for
manual inspection. What it can't fix safely, it reports and leaves alone.

Single-file Node 22 service, no dependencies. Talks to everything over the
apps' own HTTP APIs. Any number of Sonarr and Radarr instances can be
configured in one container, which matters if they share a SABnzbd: the
stall watcher only treats a download as an orphan when no configured
instance owns it.

## What it does

### Sonarr / Radarr — queue handling (every cycle, default 5 min)

| Situation | Action |
|---|---|
| Completed download blocked on an ignorable technicality ("matched to series/movie **by ID**", "unable to determine if **sample**") | Verify every import candidate maps to the exact series/movie that was grabbed, then **force import**. A mapping mismatch is never imported. |
| "**No files found are eligible** for import" (empty or failed extraction) | Remove + blocklist + search for a replacement |
| Season "pack" that is **one video file** | Remove + blocklist + search for a replacement |
| Download that is **not an upgrade** for the existing file (reported on the queue item or on its import candidates) | `NOT_UPGRADE_ACTION`, default **discard**: remove + blocklist, keep the library file |
| **Archive** the download client never extracted ("Found archive file, might need to be extracted") | `ARCHIVE_ACTION`, default **replace** |
| **Dangerous or executable file** in the download | `DANGEROUS_FILE_ACTION`, default **replace** |
| File flagged as a **sample** | `SAMPLE_ACTION`, default **notify** (short-form shows trip the sample detector on real episodes) |
| Anything it doesn't recognize | `NOTIFY` log line, left untouched. Never guess. |

The four `*_ACTION` settings take one of three values:

| Value | Effect |
|---|---|
| `replace` | Remove from queue and client, blocklist, search for a different release. The loop guard applies. |
| `discard` | Remove from queue and client, blocklist, keep whatever is already in the library, no new search. |
| `notify` | Leave it alone and report it. The log line names the setting that would auto-clear it. |

Items in these classes always wait one cycle before plungarr acts, even when
the arr reports them as import-blocked, so a client that is still extracting
after "completed" is never raced.

### Sonarr / Radarr — periodic reviews

| Sweep | What it catches |
|---|---|
| **Failure review** (6h) | Reads the arrs' history and flags any episode/movie with 3+ failed grabs and no successful import since as a `PROBLEM` log line — your short list of things that need a human to pick a release. Report-only. |
| **Corruption review** (24h) | Reports tracked files that look wrong: an MKV with no media info, a tiny file with no metadata, or a very low bitrate for its length. Each suspect is reported once, again only if it changes or after `NOTIFY_REMIND_DAYS`. Small-but-readable files and unscanned containers (`.avi`, `.vob`, `.iso`) are opt-in via `CORRUPT_REPORT_CLASSES`. Never deletes library files or searches for replacements. |

### SABnzbd — stall watcher (every cycle, optional)

Enabled by setting `SABNZBD_URL` + `SABNZBD_API_KEY`.

| Situation | Action |
|---|---|
| Actively downloading job exceeds **missing-article thresholds** (>12% of the job, or >35% of what's been tried, across two observations) | Remove + blocklist + search for a replacement via the arr that grabbed it. These configurable heuristics do not prove a job is beyond repair. |
| **Head-of-queue stalled** (<5 MB progress in 45 min) | Same — one per cycle, so a wall of dead posts clears itself while live downloads reset their own clock |
| Head wedged in Checking/Verifying/Repairing for hours | `STALL-NOTIFY` only — long par2 repairs are legitimate work, and a true wedge needs a SAB restart, which is deliberately not automated |
| Stalled/dead download no configured arr is tracking | Deleted in SAB directly (`ORPHAN` log line), only after complete ownership checks. Configure every arr sharing this SAB instance. |

### Notifications (optional)

Off unless `NOTIFY_URL` is set; without it everything still goes to the
container log. With it, plungarr POSTs digests to one receiver:

| `NOTIFY_FORMAT` | Payload | Notes |
|---|---|---|
| `discord` | `{"content"}` | Webhook URL; long digests are split at 2000 characters |
| `slack` | `{"text"}` | Incoming-webhook URL |
| `ntfy` | raw text with a `Title` header | URL is the topic URL; `NOTIFY_TOKEN` becomes a Bearer header; `NOTIFY_EXTRA_JSON` fields become headers (`Priority`, `Tags`) |
| `gotify` | `{"title","message","priority"}` | URL is `https://host/message`; `NOTIFY_TOKEN` is sent as `X-Gotify-Key` |
| `apprise` | `{"title","body","type"}` | Apprise API notify URL with the key in the path; put stateless `urls` in `NOTIFY_EXTRA_JSON` |
| `json` (default) | `{"source","title","text","items":[...]}` | For Home Assistant, n8n, or anything custom; `NOTIFY_TOKEN` becomes a Bearer header |

Each category has its own cadence: `immediate` (batched per cycle, sent at
the end of it), `daily`, `weekly`, `monthly`, or `none`.

| Setting | Carries | Default |
|---|---|---|
| `NOTIFY_ATTENTION` | Items plungarr refuses to touch: unrecognised blocks, sample flags, mapping mismatches, a wedged SABnzbd head | `immediate` |
| `NOTIFY_ERRORS` | API failures, cycle errors, state-save failures | `immediate` |
| `NOTIFY_ACTIONS` | Every import, removal, blocklist, replacement search, stalled and doomed deletion | `daily` |
| `NOTIFY_PROBLEMS` | Failure-review `PROBLEM` lines | `daily` |
| `NOTIFY_CORRUPTION` | Corruption-sweep hints | `weekly` |
| `NOTIFY_SUMMARY` | "What plungarr did" as totals for the period, no per-item lines | `none` |
| `NOTIFY_HEARTBEAT` | "plungarr alive" line, sent even when nothing else happened | `none` |

Digests fire at `NOTIFY_DIGEST_HOUR` (default 8, container local time), on
`NOTIFY_DIGEST_DAY` (default `monday`) for weekly and `NOTIFY_DIGEST_DAY_OF_MONTH`
(default 1) for monthly. Categories sharing a slot are merged into one
message. An attention item is sent once when first seen and again only after
`NOTIFY_REMIND_DAYS` (default 7; 0 disables reminders). Pending items and
sent-times live in the state file, so restarts neither drop nor duplicate a
digest. A startup message is sent once so a bad URL or token shows up
immediately. Delivery failures are logged and retried next cycle; they never
block queue processing. Dry run logs the digest text and never POSTs.

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
2026-01-01T12:00:01Z | sonarr | REMOVED+REPLACE | Example.Series.S02.720p.WEB-DL | dead_empty
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
| `SONARR_2_URL` / `SONARR_2_API_KEY` / `SONARR_2_NAME` | — | Second Sonarr instance (anime, 4K, ...); `_3` to `_9` for more, same for `RADARR_` |
| `SABNZBD_URL` / `SABNZBD_API_KEY` | — | Optional; enables the stall watcher |
| `INTERVAL_SECONDS` | 300 | Cycle length |
| `DRY_RUN` | false | Log intended actions; use fresh memory-only state without reading or writing live state |
| `RUN_ONCE` | false | Run one cycle and finish the periodic reviews before exiting |
| `PUID` / `PGID` | 99 / 100 | User and group the service runs as; `/state` is chowned to them at start |
| `CORRUPT_REPORT_CLASSES` | unreadable,stub,junk_readable | Suspect classes to report; add `tiny_readable` and/or `scanner_blind` for the full list |
| `ARCHIVE_ACTION` | replace | Unextracted archive: `replace`, `discard`, or `notify` |
| `DANGEROUS_FILE_ACTION` | replace | Dangerous or executable file: `replace`, `discard`, or `notify` |
| `SAMPLE_ACTION` | notify | File flagged as a sample: `replace`, `discard`, or `notify` |
| `NOT_UPGRADE_ACTION` | discard | Not an upgrade for the existing file: `replace`, `discard`, or `notify` |
| `NOTIFY_URL` | — | Webhook receiver; empty keeps log-only behaviour |
| `NOTIFY_FORMAT` | json | `discord`, `slack`, `ntfy`, `gotify`, `apprise`, or `json` |
| `NOTIFY_TOKEN` | — | Optional auth token for ntfy, gotify, apprise, json |
| `NOTIFY_EXTRA_JSON` | — | JSON object merged into every payload |
| `NOTIFY_ATTENTION` ... `NOTIFY_HEARTBEAT` | see above | Per-category cadence: `immediate`, `daily`, `weekly`, `monthly`, `none` |
| `NOTIFY_DIGEST_HOUR` / `NOTIFY_DIGEST_DAY` / `NOTIFY_DIGEST_DAY_OF_MONTH` | 8 / monday / 1 | Digest schedule, container local time |
| `NOTIFY_REMIND_DAYS` | 7 | Re-send an unresolved attention item after this many days; 0 disables |

## Safety rails

- Import-blocked items are acted on immediately (the arr has already given up
  on them); anything transitional must be seen stuck across two cycles first,
  so an active import is never raced.
- Blocklist loop guard: indexers re-serve the same junk under new GUIDs; after
  2 blocklists of the same release title, plungarr stops searching for a replacement.
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
