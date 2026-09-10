# Multiple Sonarr and Radarr instances

- `SONARR_2_URL` / `SONARR_2_API_KEY` (and `_3` to `_9`, same for `RADARR_`)
  add further instances to one container. Optional `_NAME` labels each one
  in logs, digests, and state. Duplicate names or a URL without a key stop
  startup naming the setting.
- Configure every instance that shares a SABnzbd: the stall watcher only
  deletes a download as an orphan when no configured instance owns it.

# Corruption review reporting

- Suspects are reported once per file, and again only if the file changes
  or after `NOTIFY_REMIND_DAYS`. Entries for files that leave the library
  are forgotten automatically.
- `CORRUPT_REPORT_CLASSES` (default `unreadable,stub,junk_readable`) selects
  which classes are reported. `tiny_readable` and `scanner_blind` are opt-in
  because they are mostly legitimate shorts and unscanned containers.
- Each report now says what was seen and what it usually means, in plain
  words, with the file size.
- The sweep summary reports files checked, new suspects, previously reported,
  and suppressed counts.

# Container user and state directory

- The image now starts as root only to chown `/state` to `PUID:PGID`
  (default 99:100, Unraid's nobody:users) and then drops privileges via
  su-exec. Bind-mounted state folders created by Docker or Unraid are
  writable without manual intervention. Set `PUID`/`PGID` to match your
  host convention.

# Notifications

- Optional webhook delivery: set `NOTIFY_URL` and pick `NOTIFY_FORMAT`
  (`discord`, `slack`, `ntfy`, `gotify`, `apprise`, or generic `json`).
  `NOTIFY_TOKEN` and `NOTIFY_EXTRA_JSON` cover receiver-specific auth and
  fields. Empty `NOTIFY_URL` keeps the previous log-only behaviour.
- Seven categories each take `immediate`, `daily`, `weekly`, `monthly`, or
  `none`: attention and errors default to immediate, actions and problems to
  daily, corruption to weekly, summary and heartbeat to none.
- Digest schedule via `NOTIFY_DIGEST_HOUR`, `NOTIFY_DIGEST_DAY`, and
  `NOTIFY_DIGEST_DAY_OF_MONTH` in container local time. Unresolved attention
  items are re-sent after `NOTIFY_REMIND_DAYS`.
- Pending items and sent-times persist in the state file. Delivery failures
  are retried next cycle and never block queue processing. Dry run logs the
  digest text and never POSTs. A startup message validates the receiver.
- Invalid notification settings stop startup naming the setting.

# Orphaned downloads

- A completed or failed download that no configured Sonarr/Radarr grabbed
  is now handled. This happens when a series or movie is deleted while its
  episodes are still downloading, or when an NZB is added to the client by
  hand: the arr lists it as an unknown item, nothing will ever import it,
  and it sits in the queue and on disk indefinitely.
- `ORPHAN_ACTION` (default `delete`) removes it from the arr queue and the
  download client, with no blocklist and no search. `notify` only reports
  it. Set `notify` if you add NZBs by hand and import them yourself.
- Orphans wait for the normal age gate, and are never touched while another
  configured instance owns the same download, using the same paginated and
  unpaginated ownership checks as the stall watcher. If a sibling instance
  cannot be read, the orphan is left alone that cycle.
- Log line: `REMOVED (ORPHAN, no configured arr grabbed it)`, counted as
  `orphaned` in digests.
- Sonarr and Radarr only read the most recent 60 entries of the download
  client's history. A large backlog of orphans hides older ones; plungarr
  clears them a batch at a time as the arr exposes them.

# Folder-name mismatches (Sonarr)

- Sonarr refuses to import a file whose parsed episode numbers disagree with
  the release folder name ("Episode 7x20 was unexpected considering the ...
  folder name"). In practice this is usually a parser quirk, such as
  `1x8_720.mkv` reading as episode 7x20, and Sonarr's manual-import view
  still maps the file to the right episode.
- `FOLDER_MISMATCH_ACTION` (default `import`) imports with Sonarr's own
  mapping, but only when every file maps to episodes the download was
  grabbed for and together they cover exactly those episodes. A file that
  maps outside the grab, or a set that does not cover it, is reported and
  left for a human. `replace`, `discard`, and `notify` behave as for the
  other block actions.
- The import also requires the mismatch to look like a parser quirk: the
  unexpected episodes Sonarr names are in another season, or there are
  more than five of them. A few unexpected episodes in the same season is
  what a genuinely mislabelled file looks like (a release folder that
  parsed as one episode holding a double episode), and that case is
  reported instead of imported.

# Nothing left to import

- A download blocked on a technicality ("matched by ID", "unable to
  determine if sample") whose folder is gone or holds no video is now
  handled like Sonarr's own "No files found are eligible" case: removed,
  blocklisted, and searched again. One whose files are all already in the
  library goes through `NOT_UPGRADE_ACTION`. Previously both were reported
  every cycle and never cleared.
- A single-episode download that would replace a library file spanning more
  episodes ("Episode file on disk contains more episodes than this file
  contains") is now treated as not an upgrade, so `NOT_UPGRADE_ACTION`
  applies. Importing it would delete the other episodes' only copy.

# Configurable block actions

- Four new settings decide what plungarr does with blocks it recognises but
  that need a policy choice: `ARCHIVE_ACTION` (default `replace`),
  `DANGEROUS_FILE_ACTION` (default `replace`), `SAMPLE_ACTION` (default
  `notify`), and `NOT_UPGRADE_ACTION` (default `discard`). Each takes
  `replace`, `discard`, or `notify`; any other value stops startup naming the
  setting.
- Not-an-upgrade rejections reported only on the manual-import candidates,
  not on the queue item, are now handled. Previously they were logged as an
  unexpected rejection and left in the queue indefinitely.
- Items in these classes always wait one cycle before plungarr acts, even when
  the arr reports them as import-blocked.
- The `REMOVED+RESEARCH` log label is now `REMOVED+REPLACE`; the loop-guard
  label reads `no replacement search`. Behaviour is unchanged.

# Safety changes

- Library corruption review is report-only. Missing metadata, small files,
  unusual bitrate, and unknown file age never authorize deletion.
- Stall timers use continuous observations. Pause, displacement from the head,
  restart, invalid counters, failed reads, and monitoring gaps reset eligibility.
- Repair/checking/fetching states are protected. A fresh SAB check immediately
  before removal cancels actions when status, head position, or progress changes.
- Action caps limit removal attempts without skipping observations of other jobs.
- Complete arr and SAB queue reads detect incomplete and inconsistent pages.
  Potential orphans receive an additional unpaginated arr ownership check.
- Invalid numeric and boolean settings fail startup with the setting name.
- Dry runs use fresh memory-only state and never read or overwrite live state.
- One-shot runs await periodic reviews and persist their completed results.
- Tests run on branch pushes and pull requests; image publication requires a
  passing test job. Action commits and the base image are pinned, with weekly
  dependency update proposals configured.
- Configuration examples and logs use generic placeholders and fictional data.
  Docker build contexts exclude environment files, state, tests, and Git history.

## Upgrade notes

The corruption sweep no longer deletes library files or searches for replacements.
Remove obsolete corruption deletion/loop/age/pinned-series settings from your
configuration; the supported settings are documented in `.env.example`.

Two new settings default to acting: `ORPHAN_ACTION=delete` removes completed
or failed downloads that no configured arr grabbed, and
`FOLDER_MISMATCH_ACTION=import` imports Sonarr folder-name mismatches with
Sonarr's own mapping. Set either to `notify` to keep the previous behaviour
of reporting only.

Configure every arr instance that shares the configured SAB instance before
enabling the stall watcher or leaving `ORPHAN_ACTION=delete` on: a download
one instance does not know about may belong to another. Missing-article thresholds remain configurable
heuristics. Use `DRY_RUN=true` to inspect intended queue actions first.

## Validation

The regression suite covers destructive action decisions, pagination failures,
state isolation, malformed configuration, and service startup against a local
HTTP fixture. No real media service or library is needed. Run `node --test`
with Node 22. Live integration testing and container vulnerability scanning
remain separate release checks; successful tests do not prove every deployment
or upstream failure mode safe.
