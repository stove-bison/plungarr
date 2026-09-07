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

Configure every arr instance that shares the configured SAB instance before
enabling the stall watcher. Missing-article thresholds remain configurable
heuristics. Use `DRY_RUN=true` to inspect intended queue actions first.

## Validation

The regression suite covers destructive action decisions, pagination failures,
state isolation, malformed configuration, and service startup against a local
HTTP fixture. No real media service or library is needed. Run `node --test`
with Node 22. Live integration testing and container vulnerability scanning
remain separate release checks; successful tests do not prove every deployment
or upstream failure mode safe.
