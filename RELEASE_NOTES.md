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
