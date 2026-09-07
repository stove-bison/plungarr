// plungarr — automatically reviews Sonarr/Radarr download queues and
// processes stuck items the way a careful human would:
//
//   1. VERIFIED IMPORT  — import-blocked/pending items whose only problems are
//      ignorable ("matched by ID", "unable to determine if sample") get their
//      manual-import candidates verified (same series/movie the grab was
//      tracked for, episodes mapped, no other rejections) and force-imported.
//      A mapping mismatch is never imported.
//   2. DEAD RELEASE     — nothing eligible to import, or a "season pack" that
//      is a single video file: remove + blocklist + re-search, with a loop
//      guard (same release title blocklisted LOOP_GUARD_LIMIT times => remove
//      WITHOUT re-search, since indexers keep serving the same junk).
//   3. NOT AN UPGRADE   — the downloaded file doesn't improve on the existing
//      one: remove + blocklist, no re-search (the library file stays).
//   4. ANYTHING ELSE    — logged as NOTIFY and left untouched. Never guess.
//
// Items are only acted on after they've been seen in a previous cycle at least
// MIN_AGE_MINUTES ago, so an import that is actively being processed is never
// raced (a manualimport call during an active import sees files mid-move).
//
// CORRUPTION SWEEP: report files with missing metadata, small size, or low
// estimated bitrate. These are inspection hints, not proof of corruption.
// This sweep never deletes library files or launches replacement searches.
//
// STALL WATCHER (every cycle, needs SABNZBD_URL + SABNZBD_API_KEY): watches the
// SABnzbd queue for posts whose articles are gone from Usenet and sit at the
// head of the queue "downloading" at ~0 B/s, starving everything behind them.
// Two checks:
//
//   DOOMED  ? an actively downloading job exceeds configured missing-article
//             thresholds across multiple observations. These are heuristics;
//             repair/checking/fetching states are always left untouched.
//   STALLED — the HEAD downloading slot made less than STALL_MIN_PROGRESS_MB
//             of progress in STALL_MINUTES (default 5MB / 45min). Only the
//             head is judged: items behind it legitimately receive no
//             bandwidth. One removal per cycle clears a wall of dead jobs one
//             by one while live downloads reset their own clock by progressing.
//
// A head slot wedged in Checking/Verifying/Repairing/Fetching is NOTIFY-only
// (long par2 repairs are legitimate work; a persistent wedge may need a SAB
// restart, which the janitor deliberately does not automate). Skips entirely
// (and forgets progress anchors) while SAB is paused. Downloads not tracked by
// any arr are deleted in SAB directly (ORPHAN) rather than blocklisted.

import fs from 'node:fs';
import path from 'node:path';

const env = (k, d) => (process.env[k] ?? d);
function numberEnv(key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) {
  const raw = env(key, fallback);
  const value = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${key}: expected ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}
function boolEnv(key, fallback) {
  const value = String(env(key, fallback)).trim();
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid ${key}: expected true or false`);
}
function choiceEnv(key, fallback, values) {
  const value = String(env(key, fallback)).trim().toLowerCase();
  if (!values.includes(value)) throw new Error(`Invalid ${key}: expected one of ${values.join(', ')}`);
  return value;
}
const ACTION_VALUES = ['replace', 'discard', 'notify'];
const actionEnv = (key, fallback) => choiceEnv(key, fallback, ACTION_VALUES);
const CADENCE_VALUES = ['immediate', 'daily', 'weekly', 'monthly', 'none'];
const cadenceEnv = (key, fallback) => choiceEnv(key, fallback, CADENCE_VALUES);
const NOTIFY_FORMATS = ['discord', 'slack', 'ntfy', 'gotify', 'apprise', 'json'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function urlEnv(key) {
  const raw = env(key, '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`Invalid ${key}: expected an http(s) URL`);
  return raw;
}
function listEnv(key, fallback, values) {
  const items = String(env(key, fallback)).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const v of items) if (!values.includes(v)) throw new Error(`Invalid ${key}: expected a comma-separated subset of ${values.join(', ')}`);
  return items;
}
function jsonObjectEnv(key) {
  const raw = env(key, '').trim();
  if (!raw) return {};
  let v;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Invalid ${key}: expected a JSON object`);
  return v;
}
const CONFIG = {
  apps: [
    { name: 'sonarr', url: env('SONARR_URL', ''), key: env('SONARR_API_KEY', ''), kind: 'series' },
    { name: 'radarr', url: env('RADARR_URL', ''), key: env('RADARR_API_KEY', ''), kind: 'movie' },
  ].filter(a => a.url && a.key),
  intervalSec: numberEnv('INTERVAL_SECONDS', 300, 1, 2147483),
  minAgeMin: numberEnv('MIN_AGE_MINUTES', 5),
  dryRun: boolEnv('DRY_RUN', false),
  runOnce: boolEnv('RUN_ONCE', false),
  stateFile: env('STATE_FILE', '/state/janitor-state.json'),
  loopGuardLimit: numberEnv('LOOP_GUARD_LIMIT', 2, 0, Number.MAX_SAFE_INTEGER, true),
  // What to do with blocks plungarr recognises but that need a policy choice:
  //   replace = remove + blocklist + search for a different release (loop guard applies)
  //   discard = remove + blocklist, keep the existing library file, no new search
  //   notify  = leave it alone and report it
  actions: {
    archive: actionEnv('ARCHIVE_ACTION', 'replace'),
    dangerous: actionEnv('DANGEROUS_FILE_ACTION', 'replace'),
    sample: actionEnv('SAMPLE_ACTION', 'notify'),
    not_upgrade: actionEnv('NOT_UPGRADE_ACTION', 'discard'),
  },
  sab: {
    url: env('SABNZBD_URL', '').replace(/\/$/, ''),
    key: env('SABNZBD_API_KEY', ''),
    stallMin: numberEnv('STALL_MINUTES', 45, Number.MIN_VALUE),
    minProgressMb: numberEnv('STALL_MIN_PROGRESS_MB', 5, Number.MIN_VALUE),
    missingFrac: numberEnv('STALL_MISSING_FRAC', 0.12, 0, 1),
    missingTriedFrac: numberEnv('STALL_MISSING_TRIED_FRAC', 0.35, 0, 1),
    maxActions: numberEnv('STALL_MAX_ACTIONS_PER_CYCLE', 2, 0, Number.MAX_SAFE_INTEGER, true),
  },
  failReview: {
    enabled: boolEnv('FAIL_REVIEW_ENABLED', true),
    everyHours: numberEnv('FAIL_REVIEW_HOURS', 6, Number.MIN_VALUE),
    windowHours: numberEnv('FAIL_REVIEW_WINDOW_HOURS', 48, Number.MIN_VALUE),
    failLimit: numberEnv('FAIL_REVIEW_FAIL_LIMIT', 3, 1, Number.MAX_SAFE_INTEGER, true),
  },
  notify: {
    url: urlEnv('NOTIFY_URL'),
    format: choiceEnv('NOTIFY_FORMAT', 'json', NOTIFY_FORMATS),
    token: env('NOTIFY_TOKEN', ''),
    extra: jsonObjectEnv('NOTIFY_EXTRA_JSON'),
    hour: numberEnv('NOTIFY_DIGEST_HOUR', 8, 0, 23, true),
    day: WEEKDAYS.indexOf(choiceEnv('NOTIFY_DIGEST_DAY', 'monday', WEEKDAYS)),
    dayOfMonth: numberEnv('NOTIFY_DIGEST_DAY_OF_MONTH', 1, 1, 28, true),
    remindDays: numberEnv('NOTIFY_REMIND_DAYS', 7, 0, Number.MAX_SAFE_INTEGER, true),
    cadence: {
      attention: cadenceEnv('NOTIFY_ATTENTION', 'immediate'),
      errors: cadenceEnv('NOTIFY_ERRORS', 'immediate'),
      actions: cadenceEnv('NOTIFY_ACTIONS', 'daily'),
      problems: cadenceEnv('NOTIFY_PROBLEMS', 'daily'),
      corruption: cadenceEnv('NOTIFY_CORRUPTION', 'weekly'),
      summary: cadenceEnv('NOTIFY_SUMMARY', 'none'),
      heartbeat: cadenceEnv('NOTIFY_HEARTBEAT', 'none'),
    },
  },
  corrupt: {
    enabled: boolEnv('CORRUPT_SWEEP_ENABLED', true),
    sweepHours: numberEnv('CORRUPT_SWEEP_HOURS', 24, Number.MIN_VALUE),
    stubMb: numberEnv('CORRUPT_STUB_MB', 20),
    actExts: env('CORRUPT_ACT_EXTS', '.mkv').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
    minKbps: numberEnv('CORRUPT_MIN_KBPS', 150),
    // Which suspect classes get a CORRUPT-NOTIFY line. The two "can't tell"
    // classes (tiny_readable, scanner_blind) are opt-in because they are
    // mostly legitimate shorts and unscanned containers.
    reportClasses: listEnv('CORRUPT_REPORT_CLASSES', 'unreadable,stub,junk_readable',
      ['unreadable', 'stub', 'junk_readable', 'tiny_readable', 'scanner_blind']),
  },
};
// Accept and validate old numeric settings during upgrades. Corruption review
// is report-only, so these settings can no longer authorize library deletion.
for (const key of ['CORRUPT_MAX_DELETES', 'CORRUPT_LOOP_LIMIT', 'CORRUPT_MIN_AGE_HOURS']) {
  if (process.env[key] !== undefined) numberEnv(key, 0, 0, Number.MAX_SAFE_INTEGER, key !== 'CORRUPT_MIN_AGE_HOURS');
}

const IGNORABLE = [
  /matched to (series|movie) by ID/i,
  /Unable to determine if file is a sample/i,
  /One or more episodes expected in this release were not imported/i,
];
const RX_EMPTY = /No files found are eligible for import/i;
const RX_SEASON_BUNDLE = /Single episode file contains all episodes/i;
const RX_NOT_UPGRADE = /do not improve on Existing|Not an? (Custom Format )?upgrade for existing/i;
// Message texts below are identical in Sonarr and Radarr (DownloadedEpisodesImportService /
// DownloadedMovieImportService and the NotSampleSpecification in each).
const RX_ARCHIVE = /Found archive file, might need to be extracted/i;
const RX_DANGEROUS = /Caution: Found (potentially dangerous|executable) file/i;
const RX_SAMPLE = /^\s*Sample\s*$/i; // exact; "Unable to determine if file is a sample" stays ignorable
const ACTION_SETTING = {
  archive: 'ARCHIVE_ACTION', dangerous: 'DANGEROUS_FILE_ACTION',
  sample: 'SAMPLE_ACTION', not_upgrade: 'NOT_UPGRADE_ACTION',
};
const ACTION_REASON = {
  archive: 'archive not extracted', dangerous: 'dangerous or executable file',
  sample: 'flagged as a sample', not_upgrade: 'not an upgrade for the existing file',
};

const log = (app, action, title, detail = '') => {
  console.log(`${new Date().toISOString()} | ${app} | ${action} | ${title}${detail ? ' | ' + detail : ''}`);
  notifyCapture(app, action, title, detail);
};
// Errors go to stderr and into the notifier's "errors" category. Delivery
// failures inside the notifier itself pass capture=false so they cannot loop.
const logError = (app, action, detail, capture = true) => {
  console.error(`${new Date().toISOString()} | ${app} | ${action} | ${detail}`);
  if (capture) notifyCapture(app, action, detail, '');
};

// ---------- state (first-seen ages + blocklist loop guard) ----------
function loadState() {
  if (CONFIG.dryRun) return { firstSeen: {}, blocklistCount: {}, actioned: {} };
  try {
    const st = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    // Downtime is not an observation of an actively stalled download.
    st.sabProgress = {};
    delete st.sabObservedAt;
    return st;
  }
  catch { return { firstSeen: {}, blocklistCount: {}, actioned: {} }; }
}
function saveState(st) {
  if (CONFIG.dryRun) return; // simulation state is memory-only
  try {
    fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(st));
  } catch (e) { logError('state', 'STATE-ERROR', 'state save failed: ' + e.message); }
}
const normTitle = t => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '.');

// ---------- api ----------
async function api(app, method, p, body) {
  const r = await fetch(app.url.replace(/\/$/, '') + '/api/v3' + p, {
    method,
    headers: { 'X-Api-Key': app.key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// ---------- classification ----------
function classify(rec) {
  const state = rec.trackedDownloadState;
  if (rec.status !== 'completed' || !/^import(Blocked|Pending|Failed)$/.test(state || '')) return null;
  // An entry's title is usually just the release name — only treat it as the
  // problem text when the entry has no messages. Including release names in
  // the every-ignorable check would incorrectly classify known blocks.
  const msgs = (rec.statusMessages || [])
    .flatMap(m => (m.messages && m.messages.length) ? m.messages : [m.title || ''])
    .filter(Boolean);
  if (!msgs.length) return null; // quietly waiting for the import scanner — not ours
  if (msgs.some(m => RX_EMPTY.test(m))) return 'dead_empty';
  if (msgs.some(m => RX_SEASON_BUNDLE.test(m))) return 'dead_bundle';
  if (msgs.some(m => RX_DANGEROUS.test(m))) return 'dangerous';
  if (msgs.some(m => RX_ARCHIVE.test(m))) return 'archive';
  if (msgs.some(m => RX_NOT_UPGRADE.test(m))) return 'not_upgrade';
  if (msgs.some(m => RX_SAMPLE.test(m))) return 'sample';
  if (msgs.every(m => IGNORABLE.some(rx => rx.test(m)))) return 'verified_import';
  return 'unknown';
}

// ---------- actions ----------
async function removeItems(app, recs, { blocklist, research }) {
  const ids = recs.map(r => r.id);
  if (CONFIG.dryRun) return log(app.name, 'DRY-RUN remove', recs[0].title, `blocklist=${blocklist} research=${research}`);
  await api(app, 'DELETE',
    `/queue/bulk?removeFromClient=true&blocklist=${blocklist}&skipRedownload=${!research}`, { ids });
}

async function verifiedImport(app, rec) {
  const cands = await api(app, 'GET', `/manualimport?downloadId=${rec.downloadId}&filterExistingFiles=true`);
  if (!Array.isArray(cands) || !cands.length) {
    log(app.name, 'NOTIFY', rec.title, 'no manual-import candidates despite importable classification');
    return false;
  }
  // A candidate the arr rejects for a reason plungarr has a policy for
  // (not an upgrade, sample) is skipped here; if nothing else is importable
  // the whole download is handed back to processApp() as that class so the
  // configured *_ACTION applies. Any other rejection is a human's call.
  const files = [], skipped = new Set();
  for (const c of cands) {
    const rej = (c.rejections || []).map(x => x.reason || x)
      .filter(x => !IGNORABLE.some(rx => rx.test(x)));
    if (rej.length) {
      if (rej.every(r => RX_NOT_UPGRADE.test(r))) { skipped.add('not_upgrade'); continue; }
      if (rej.every(r => RX_SAMPLE.test(r))) { skipped.add('sample'); continue; }
      log(app.name, 'NOTIFY', c.relativePath || rec.title, 'unexpected rejection: ' + rej.join('; ')); return false;
    }
    if (app.kind === 'series') {
      if (!c.series || c.series.id !== rec.seriesId || !(c.episodes || []).length) {
        log(app.name, 'NOTIFY', c.relativePath || rec.title,
          `mapping mismatch (candidate series ${c.series && c.series.id} vs tracked ${rec.seriesId})`);
        return false;
      }
      files.push({
        path: c.path, folderName: c.folderName, seriesId: c.series.id,
        episodeIds: c.episodes.map(e => e.id), quality: c.quality, languages: c.languages,
        downloadId: c.downloadId, releaseGroup: c.releaseGroup,
        indexerFlags: c.indexerFlags || 0, releaseType: c.releaseType || 'singleEpisode',
      });
    } else {
      if (!c.movie || c.movie.id !== rec.movieId) {
        log(app.name, 'NOTIFY', c.relativePath || rec.title,
          `mapping mismatch (candidate movie ${c.movie && c.movie.id} vs tracked ${rec.movieId})`);
        return false;
      }
      files.push({
        path: c.path, folderName: c.folderName, movieId: c.movie.id,
        quality: c.quality, languages: c.languages,
        downloadId: c.downloadId, releaseGroup: c.releaseGroup,
        indexerFlags: c.indexerFlags || 0,
      });
    }
  }
  if (!files.length) {
    if (skipped.size === 1) return [...skipped][0];
    log(app.name, 'NOTIFY', rec.title, 'candidates rejected for mixed reasons: ' + [...skipped].join(', '));
    return false;
  }
  if (CONFIG.dryRun) return log(app.name, 'DRY-RUN import', rec.title, `${files.length} file(s)`), true;
  await api(app, 'POST', '/command', { name: 'ManualImport', files, importMode: 'auto' });
  log(app.name, 'IMPORTED', rec.title, `${files.length} file(s) sent to ManualImport`);
  return true;
}

// Apply a policy to one download (all queue records sharing its downloadId).
// `action` is replace | discard | notify; `cls` names the block.
async function applyAction(app, st, gateKey, group, rec, action, cls) {
  const reason = ACTION_REASON[cls] || cls;
  const setting = ACTION_SETTING[cls];
  const dry = CONFIG.dryRun ? 'DRY-RUN ' : '';
  if (action === 'notify') {
    log(app.name, 'NOTIFY', rec.title, `${reason}; left untouched` +
      (setting ? ` (set ${setting}=replace or discard to auto-clear)` : ''));
    return;
  }
  if (action === 'replace') {
    const key = normTitle(rec.title);
    const n = st.blocklistCount[key] || 0;
    const research = n < CONFIG.loopGuardLimit;
    await removeItems(app, group, { blocklist: true, research });
    if (!CONFIG.dryRun) { st.blocklistCount[key] = n + 1; st.actioned[gateKey] = Date.now(); }
    log(app.name, dry + (research ? 'REMOVED+REPLACE' : 'REMOVED (loop guard, no replacement search)'), rec.title, reason);
    return;
  }
  await removeItems(app, group, { blocklist: true, research: false });
  if (!CONFIG.dryRun) st.actioned[gateKey] = Date.now();
  log(app.name, dry + 'REMOVED (discarded, no replacement search)', rec.title, reason);
}

// ---------- one cycle for one app ----------
async function arrQueue(app) {
  const records = [], seen = new Set();
  let total;
  for (let page = 1; page <= 1000; page++) {
    const q = await api(app, 'GET', `/queue?page=${page}&pageSize=500&sortKey=added&sortDirection=ascending&includeUnknownSeriesItems=true&includeUnknownMovieItems=true`);
    if (!q || !Array.isArray(q.records) || !Number.isSafeInteger(q.totalRecords) || q.totalRecords < 0 ||
        (q.page !== undefined && q.page !== page) || (total !== undefined && q.totalRecords !== total)) {
      throw new Error('Incomplete or changing arr queue; no actions taken');
    }
    total = q.totalRecords;
    for (const rec of q.records) {
      if (!Number.isSafeInteger(rec.id) || seen.has(rec.id)) throw new Error('Invalid or duplicate arr queue record; no actions taken');
      seen.add(rec.id);
      records.push(rec);
    }
    if (records.length === total) return records;
    if (!q.records.length || records.length > total) throw new Error('Incomplete arr queue; no actions taken');
  }
  throw new Error('Arr queue pagination limit reached; no actions taken');
}

async function processApp(app, st) {
  const recs = await arrQueue(app);
  const byDownload = new Map();
  for (const r of recs) {
    if (!r.downloadId) continue;
    if (!byDownload.has(r.downloadId)) byDownload.set(r.downloadId, []);
    byDownload.get(r.downloadId).push(r);
  }
  const now = Date.now();
  for (const [downloadId, group] of byDownload) {
    // state keys are app-scoped: a bare downloadId let each app's prune pass
    // delete the OTHER app's gate entries every cycle, so nothing ever aged
    // past the gate.
    const gateKey = `${app.name}:${downloadId}`;
    const rec = group[0];
    const cls = classify(rec);
    if (!cls) { delete st.firstSeen[gateKey]; continue; }

    // ImportBlocked is a settled state — Sonarr already evaluated the import
    // and halted awaiting intervention (TrackedDownloadState enum), so there
    // is nothing to race: act on first sighting. Transitional states
    // (ImportPending/ImportFailed) keep the two-sighting age gate, since the
    // arr's own importer may still pick those up mid-move. Policy classes
    // (archive, dangerous, sample, not_upgrade) always wait one cycle too: a
    // client with an extractor plugin may still be unpacking after "completed".
    if (rec.trackedDownloadState !== 'importBlocked' || cls in ACTION_SETTING) {
      if (!st.firstSeen[gateKey]) { st.firstSeen[gateKey] = now; continue; }
      if (now - st.firstSeen[gateKey] < CONFIG.minAgeMin * 60_000) continue;
    }
    // don't repeat an action for a downloadId the arr hasn't processed yet
    if (st.actioned[gateKey] && now - st.actioned[gateKey] < 30 * 60_000) continue;

    try {
      let effective = cls;
      if (cls === 'verified_import') {
        const result = await verifiedImport(app, rec);
        if (result === true) { if (!CONFIG.dryRun) st.actioned[gateKey] = now; continue; }
        if (result === false) continue;
        effective = result; // every remaining candidate was rejected for one policy reason
      }
      if (effective === 'dead_empty' || effective === 'dead_bundle') {
        await applyAction(app, st, gateKey, group, rec, 'replace', effective);
      } else if (effective in ACTION_SETTING) {
        await applyAction(app, st, gateKey, group, rec, CONFIG.actions[effective], effective);
      } else {
        log(app.name, 'NOTIFY', rec.title,
          'unrecognized block, left untouched: ' +
          (rec.statusMessages || []).flatMap(m => m.messages || []).join('; ').slice(0, 200));
      }
    } catch (e) {
      log(app.name, 'ERROR', rec.title, e.message);
    }
  }
  // prune state entries for downloads no longer queued
  const pfx = app.name + ':';
  for (const m of [st.firstSeen, st.actioned]) {
    for (const k of Object.keys(m)) {
      if (!k.includes(':')) { delete m[k]; continue; } // legacy bare keys
      if (k.startsWith(pfx) && !byDownload.has(k.slice(pfx.length))) delete m[k];
    }
  }
}

// ---------- corruption sweep ----------
const isUnreadable = mi => !mi || !mi.videoCodec;
const fileExt = p => path.extname(p || '').toLowerCase();

const runTimeSeconds = rt => {
  const parts = String(rt || '').split(':').map(Number);
  if (!parts.length || parts.some(isNaN)) return 0;
  return parts.reduce((s, p) => s * 60 + p, 0);
};

function classifyFile(f) {
  const mb = (f.size || 0) / (1024 * 1024);
  const tiny = mb < CONFIG.corrupt.stubMb;
  if (!isUnreadable(f.mediaInfo)) {
    if (!tiny) return null;
    // Readable but tiny. Size alone is not evidence — outtakes, commercials
    // and short specials can legitimately have small files.
    // Low estimated bitrate is suspicious but can be legitimate. Report it
    // for inspection; metadata alone must not authorize deletion.
    const secs = runTimeSeconds(f.mediaInfo.runTime);
    if (secs >= 60 && (f.size * 8 / 1000) / secs < CONFIG.corrupt.minKbps) return 'junk_readable';
    return 'tiny_readable';
  }
  if (tiny) return 'stub'; // suspicious size with absent metadata; report only
  return CONFIG.corrupt.actExts.includes(fileExt(f.relativePath || f.path)) ? 'unreadable' : 'scanner_blind';
}

// What each suspect class looks like and what it usually means, in plain words.
function corruptDetail(cls, f) {
  const mb = Math.round((f.size || 0) / (1024 * 1024));
  const ext = fileExt(f.relativePath || f.path) || 'file';
  switch (cls) {
    case 'unreadable': return `${mb} MB ${ext} with no media info; the scanner normally reads this format. Worth opening by hand.`;
    case 'stub': return `${mb} MB with no media info. Likely an incomplete or placeholder file.`;
    case 'junk_readable': {
      const secs = runTimeSeconds(f.mediaInfo && f.mediaInfo.runTime);
      return `${mb} MB over ${Math.round(secs / 60)} min, about ${Math.round((f.size * 8 / 1000) / secs)} kbps. Very low bitrate for its length.`;
    }
    case 'tiny_readable': return `${mb} MB, metadata readable. Usually a legitimate short or extra.`;
    default: return `${mb} MB ${ext} with no media info; the scanner often skips this format. Cannot tell either way.`;
  }
}

async function corruptSweepApp(app, st = {}) {
  // Metadata and bitrate are hints only. This sweep never mutates a library.
  // Each suspect is reported once (per file id, size and class) and again only
  // if it changes or after NOTIFY_REMIND_DAYS; the arr API is the only thing
  // read, so re-checking costs nothing.
  const seen = st.corruptReported = st.corruptReported || {};
  const now = Date.now(), remindMs = CONFIG.notify.remindDays * 86_400_000;
  const stats = { checked: 0, flagged: 0, fresh: 0, known: 0, suppressed: 0 };
  const live = new Set();
  const report = (f, label) => {
    stats.checked++;
    const cls = classifyFile(f);
    if (!cls) return;
    stats.flagged++;
    if (!CONFIG.corrupt.reportClasses.includes(cls)) { stats.suppressed++; return; }
    const key = `${app.name}:${f.id}`;
    live.add(key);
    const prev = seen[key];
    if (prev && prev.cls === cls && prev.size === f.size &&
        (CONFIG.notify.remindDays === 0 || now - prev.ts < remindMs)) { stats.known++; return; }
    seen[key] = { cls, size: f.size, ts: now };
    stats.fresh++;
    log(app.name, 'CORRUPT-NOTIFY', label, corruptDetail(cls, f) + ' Left untouched.');
  };
  if (app.kind === 'series') {
    for (const s of await api(app, 'GET', '/series')) {
      if (!(s.statistics && s.statistics.episodeFileCount > 0)) continue;
      for (const f of await api(app, 'GET', '/episodefile?seriesId=' + s.id)) {
        report(f, s.title + ': ' + f.relativePath);
      }
    }
  } else {
    for (const m of await api(app, 'GET', '/movie')) {
      if (m.hasFile && m.movieFile) report(m.movieFile, m.title + ': ' + m.movieFile.relativePath);
    }
  }
  const pfx = app.name + ':';
  for (const k of Object.keys(seen)) if (k.startsWith(pfx) && !live.has(k)) delete seen[k];
  return stats;
}

let sweepRunning = false;
async function corruptSweep(st) {
  if (!CONFIG.corrupt.enabled || sweepRunning) return;
  const due = (st[CONFIG.dryRun ? 'lastDryCorruptSweep' : 'lastCorruptSweep'] || 0) + CONFIG.corrupt.sweepHours * 3600_000;
  if (Date.now() < due) return;
  sweepRunning = true;
  try { await corruptSweepInner(st); } finally { sweepRunning = false; }
}
async function corruptSweepInner(st) {
  st[CONFIG.dryRun ? 'lastDryCorruptSweep' : 'lastCorruptSweep'] = Date.now();
  saveState(st); // persist the stamp NOW — a restart mid-sweep must not re-run it at startup
  log('corrupt-sweep', 'START', `walking all tracked files (this can take many minutes on a large library)`);
  for (const app of CONFIG.apps) {
    try {
      const s = await corruptSweepApp(app, st);
      log(app.name, 'CORRUPT-SWEEP-DONE', `${s.checked} file(s) checked`,
        `${s.fresh} new suspect(s), ${s.known} previously reported, ${s.suppressed} in unreported classes; report-only, no files deleted`);
    } catch (e) {
      logError(app.name, 'CORRUPT-SWEEP-ERROR', e.message);
    }
  }
}

// ---------- stall watcher (SABnzbd) ----------
async function sabApi(params) {
  const qs = new URLSearchParams({ output: 'json', apikey: CONFIG.sab.key, ...params });
  const r = await fetch(`${CONFIG.sab.url}/api?${qs}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`SAB ${params.mode} -> HTTP ${r.status}`);
  const result = await r.json();
  if (result?.error || result?.status === false) throw new Error('SAB rejected ' + params.mode + ' request');
  return result;
}

// Remove a SAB download through whichever arr tracks it (blocklist + re-search
// with the usual loop guard); an untracked download is deleted in SAB directly.
async function stallRemove(st, nzoId, slotName, why, confirm = async () => true) {
  for (const app of CONFIG.apps) {
    const matches = r => (r.downloadId || '').toLowerCase() === nzoId.toLowerCase();
    let group = (await arrQueue(app)).filter(matches);
    if (!group.length) {
      // A constant total cannot detect every change between pages. Before
      // declaring an orphan, confirm against the arr's unpaginated endpoint.
      const details = await api(app, 'GET', '/queue/details');
      if (!Array.isArray(details) || details.some(r => !r || !Number.isSafeInteger(r.id))) {
        throw new Error('Invalid ownership confirmation; no removal attempted');
      }
      group = details.filter(matches);
    }
    if (!group.length) continue;
    const key = normTitle(group[0].title);
    const n = st.blocklistCount[key] || 0;
    const research = n < CONFIG.loopGuardLimit;
    if (!await confirm()) return false;
    await removeItems(app, group, { blocklist: true, research });
    if (!CONFIG.dryRun) st.blocklistCount[key] = n + 1;
    log(app.name, (CONFIG.dryRun ? 'DRY-RUN ' : '') + (research ? `${why}-REMOVED+REPLACE` : `${why}-REMOVED (loop guard, no replacement search)`), group[0].title);
    return true;
  }
  if (!await confirm()) return false;
  if (CONFIG.dryRun) { log('sab', `DRY-RUN ${why}-delete orphan`, slotName); return true; }
  const result = await sabApi({ mode: 'queue', name: 'delete', value: nzoId });
  if (result?.status !== true) throw new Error('SAB did not confirm removal');
  log('sab', `${why}-DELETED (ORPHAN, no arr tracks it)`, slotName);
  return true;
}

async function sabQueue() {
  const slots = [], seen = new Set();
  let total;
  for (let start = 0; start < 200000; start += 200) {
    const q = (await sabApi({ mode: 'queue', start, limit: 200 }))?.queue;
    if (!q || !Array.isArray(q.slots)) throw new Error('Invalid SAB queue');
    if (q.paused || q.paused_all) return { ...q, slots: [] };
    const count = q.noofslots_total ?? q.noofslots;
    if (!Number.isSafeInteger(count) || count < 0 || (total !== undefined && count !== total)) {
      throw new Error('Incomplete or changing SAB queue');
    }
    total = count;
    for (const slot of q.slots) {
      if (typeof slot.nzo_id !== 'string' || !slot.nzo_id || seen.has(slot.nzo_id)) {
        throw new Error('Invalid or duplicate SAB queue slot');
      }
      seen.add(slot.nzo_id);
      slots.push(slot);
    }
    if (slots.length === total) return { ...q, slots };
    if (q.slots.length !== 200 || slots.length > total) throw new Error('Incomplete SAB queue');
  }
  throw new Error('SAB queue pagination limit reached');
}

async function stallSweep(st) {
  if (!CONFIG.sab.url || !CONFIG.sab.key) return;
  try { await stallSweepInner(st); }
  catch (e) {
    st.sabProgress = {};
    delete st.sabObservedAt;
    throw e;
  }
}

const byteCounter = value => (typeof value === 'number' ||
  (typeof value === 'string' && value.trim() !== '')) ? Number(value) : NaN;
function missingThresholdExceeded(s) {
  const mb = byteCounter(s.mb), missing = byteCounter(s.mbmissing), left = byteCounter(s.mbleft);
  const tried = Math.max(0, mb - left) + missing;
  return [mb, missing, left].every(Number.isFinite) && left >= 0 && left <= mb &&
    mb >= 50 && missing > 0 && (missing / mb > CONFIG.sab.missingFrac ||
    (tried >= 50 && missing / tried > CONFIG.sab.missingTriedFrac));
}

async function confirmStall(nzoId, why, anchor) {
  let q;
  try {
    q = await sabQueue();
    if (q.paused || q.paused_all) throw new Error('SAB paused during confirmation; cycle cancelled');
  } catch (e) {
    e.stallObservationInvalid = true;
    throw e;
  }
  const s = q.slots.find(s => s.nzo_id === nzoId);
  if (!s || s.status !== 'Downloading') return false;
  if (why === 'DOOMED') return missingThresholdExceeded(s);
  if (q.slots.find(s => s.status !== 'Paused')?.nzo_id !== nzoId) return false;
  const mb = byteCounter(s.mb), left = byteCounter(s.mbleft);
  return Number.isFinite(mb) && Number.isFinite(left) && mb > 0 && left >= 0 && left <= mb &&
    mb - left >= anchor.dl && mb - left - anchor.dl < CONFIG.sab.minProgressMb;
}

async function stallSweepInner(st) {
  const q = await sabQueue();
  const now = Date.now();
  st.sabProgress = st.sabProgress || {};
  // Gaps in observation and paused time must never accrue toward deletion.
  if (st.sabObservedAt && (now < st.sabObservedAt ||
      now - st.sabObservedAt > Math.max(60, 2 * CONFIG.intervalSec) * 1000)) st.sabProgress = {};
  st.sabObservedAt = now;
  if (q.paused || q.paused_all) { st.sabProgress = {}; return; }
  const slots = q.slots;
  const head = slots.find(s => s.status !== 'Paused');
  const eligible = new Set();
  for (const s of slots) if (s.status === 'Downloading') eligible.add('doom:' + s.nzo_id);
  if (head) eligible.add((head.status === 'Downloading' ? 'head:' : 'notice:') + head.nzo_id);
  for (const key of Object.keys(st.sabProgress)) if (!eligible.has(key)) delete st.sabProgress[key];
  let actions = 0;
  const attempted = new Set();

  // Missing-article ratios are configurable heuristics, not proof that PAR2
  // cannot repair a job. Only actively downloading jobs are eligible.
  for (const s of slots) {
    if (s.status !== 'Downloading') continue;
    const doomed = missingThresholdExceeded(s);
    const key = 'doom:' + s.nzo_id;
    if (!doomed) { delete st.sabProgress[key]; continue; }
    if (!st.sabProgress[key]) { st.sabProgress[key] = now; continue; }
    if (now - st.sabProgress[key] < CONFIG.minAgeMin * 60000) continue;
    if (actions >= CONFIG.sab.maxActions) continue; // keep observing/resetting every slot
    attempted.add(s.nzo_id);
    actions++; // reserve the budget even if a request fails after reaching SAB
    try {
      await stallRemove(st, s.nzo_id, s.filename, 'DOOMED', () => confirmStall(s.nzo_id, 'DOOMED'));
    } catch (e) {
      if (e.stallObservationInvalid) throw e;
      log('sab', 'ERROR', s.filename, 'doomed removal: ' + e.message);
    }
    delete st.sabProgress[key];
    delete st.sabProgress['head:' + s.nzo_id];
  }

  if (!head || attempted.has(head.nzo_id)) return;
  if (head.status === 'Downloading') {
    const mb = byteCounter(head.mb), left = byteCounter(head.mbleft);
    const key = 'head:' + head.nzo_id;
    if (!Number.isFinite(mb) || !Number.isFinite(left) || mb <= 0 || left < 0 || left > mb) {
      delete st.sabProgress[key]; return;
    }
    const downloaded = mb - left;
    const a = st.sabProgress[key];
    if (!a || downloaded < a.dl || downloaded - a.dl >= CONFIG.sab.minProgressMb) {
      st.sabProgress[key] = { dl: downloaded, ts: now };
    } else if (now - a.ts >= CONFIG.sab.stallMin * 60000 && actions < CONFIG.sab.maxActions) {
      try { await stallRemove(st, head.nzo_id, head.filename, 'STALLED', () => confirmStall(head.nzo_id, 'STALLED', a)); }
      catch (e) {
        if (e.stallObservationInvalid) throw e;
        log('sab', 'ERROR', head.filename, 'stall removal: ' + e.message);
      }
      delete st.sabProgress[key];
    }
  } else {
    const key = 'notice:' + head.nzo_id;
    const a = st.sabProgress[key];
    if (!a || a.status !== head.status) st.sabProgress[key] = { status: head.status, ts: now };
    else if (now - a.ts >= 2 * CONFIG.sab.stallMin * 60000 && !a.notified) {
      log('sab', 'STALL-NOTIFY', head.filename, 'head remains in ' + head.status + '; left untouched');
      a.notified = true;
    }
  }
}

// ---------- failure review ----------
// Sonarr/Radarr do their own searching (RSS sync etc.); the janitor's job is
// to read their history and SURFACE the targets that keep failing: an episode
// or movie with >= failLimit failed grabs in the window and no import since
// its last failure gets one PROBLEM log line (re-logged only if the count
// grows). Handling stays with a human — never guess.
let failReviewRunning = false;
async function failReview(st) {
  if (!CONFIG.failReview.enabled || failReviewRunning) return;
  if (Date.now() < (st.lastFailReview || 0) + CONFIG.failReview.everyHours * 3600_000) return;
  failReviewRunning = true;
  try {
    st.lastFailReview = Date.now();
    saveState(st);
    await failReviewInner(st);
  } finally { failReviewRunning = false; }
}
async function failReviewInner(st) {
  const cutoff = Date.now() - CONFIG.failReview.windowHours * 3600_000;
  st.failReported = st.failReported || {};
  for (const app of CONFIG.apps) {
    try {
      const events = [];
      for (let page = 1; page <= 6; page++) {
        const h = await api(app, 'GET', `/history?page=${page}&pageSize=500&sortKey=date&sortDirection=descending`);
        const recs = (h && h.records) || [];
        events.push(...recs);
        if (!recs.length || Date.parse(recs[recs.length - 1].date) < cutoff) break;
      }
      const byTarget = new Map();
      for (const e of events) {
        const at = Date.parse(e.date);
        if (!(at >= cutoff)) continue;
        const id = app.kind === 'series' ? e.episodeId : e.movieId;
        if (!id) continue;
        if (!byTarget.has(id)) byTarget.set(id, { fails: 0, lastFailAt: 0, lastFailTitle: '', lastImportAt: 0 });
        const t = byTarget.get(id);
        if (e.eventType === 'downloadFailed') {
          t.fails++;
          if (at > t.lastFailAt) { t.lastFailAt = at; t.lastFailTitle = e.sourceTitle || ''; }
        } else if (e.eventType === 'downloadFolderImported') {
          t.lastImportAt = Math.max(t.lastImportAt, at);
        }
      }
      let problems = 0;
      for (const [id, t] of byTarget) {
        if (t.fails < CONFIG.failReview.failLimit || t.lastImportAt > t.lastFailAt) continue;
        const key = `${app.name}:${id}`;
        if ((st.failReported[key] || 0) >= t.fails) continue; // same count already reported
        st.failReported[key] = t.fails;
        problems++;
        let label = `${app.kind} #${id}`;
        try {
          if (app.kind === 'series') {
            const ep = await api(app, 'GET', `/episode/${id}`);
            let seriesTitle = ep.series && ep.series.title;
            if (!seriesTitle && ep.seriesId) seriesTitle = (await api(app, 'GET', `/series/${ep.seriesId}`)).title;
            label = `${seriesTitle} S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} "${ep.title}"`;
          } else {
            const mv = await api(app, 'GET', `/movie/${id}`);
            label = `${mv.title} (${mv.year})`;
          }
        } catch { /* label fallback is fine */ }
        log(app.name, 'PROBLEM', label,
          `${t.fails} failed grab(s) in ${CONFIG.failReview.windowHours}h, none imported since | last: ${(t.lastFailTitle || '').slice(0, 60)}`);
      }
      log(app.name, 'FAIL-REVIEW-DONE', `${byTarget.size} target(s) had history in window`, `${problems} new/escalated problem(s)`);
    } catch (e) {
      log(app.name, 'ERROR', 'failure review', e.message);
    }
  }
  const keys = Object.keys(st.failReported);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 1000)) delete st.failReported[k];
}

// ---------- notifications ----------
// Every log line is classified into a category. Lines land in an in-memory
// buffer; notifyFlush() (end of each cycle) moves them into the state file,
// applies attention de-duplication, and sends whatever is due for its
// cadence: immediate lines go now, daily/weekly/monthly lines wait for their
// slot. Delivery failures keep the items queued for the next cycle.
const CATEGORY_ORDER = ['attention', 'errors', 'actions', 'problems', 'corruption', 'summary', 'heartbeat'];
const CATEGORY_LABEL = { attention: 'Needs attention', errors: 'Errors', actions: 'Actions taken',
  problems: 'Chronic failures', corruption: 'Suspect library files', summary: 'Summary', heartbeat: 'Heartbeat' };
const notifyBuffer = [];

function categoryOf(action) {
  if (action.startsWith('DRY-RUN')) return null;
  if (action === 'NOTIFY' || action === 'STALL-NOTIFY') return 'attention';
  if (/ERROR$/.test(action)) return 'errors';
  if (action === 'PROBLEM') return 'problems';
  if (action === 'CORRUPT-NOTIFY') return 'corruption';
  if (action === 'IMPORTED' || /^REMOVED|-REMOVED|-DELETED/.test(action)) return 'actions';
  return null;
}

function counterOf(action) {
  if (action === 'IMPORTED') return 'imported';
  if (action.includes('ORPHAN')) return 'orphaned';
  if (action.startsWith('STALLED-')) return 'stalled';
  if (action.startsWith('DOOMED-')) return 'doomed';
  if (action.includes('loop guard')) return 'loopGuard';
  if (action.includes('+REPLACE')) return 'replaced';
  if (action.includes('discarded')) return 'discarded';
  if (/ERROR$/.test(action)) return 'errors';
  return null;
}

function notifyCapture(app, action, title, detail) {
  const category = categoryOf(String(action));
  if (!category) return;
  notifyBuffer.push({ ts: Date.now(), category, app, action, title: String(title), detail: String(detail || '') });
}

// Most recent scheduled instant at or before `now` for a periodic cadence
// (container local time). A cadence is due when its last digest predates it.
function lastSlot(cadence, now) {
  const d = new Date(now);
  d.setHours(CONFIG.notify.hour, 0, 0, 0);
  if (cadence === 'daily') {
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
  } else if (cadence === 'weekly') {
    d.setDate(d.getDate() - ((d.getDay() - CONFIG.notify.day + 7) % 7));
    if (d.getTime() > now) d.setDate(d.getDate() - 7);
  } else {
    d.setDate(CONFIG.notify.dayOfMonth);
    if (d.getTime() > now) d.setMonth(d.getMonth() - 1);
  }
  return d.getTime();
}

function chunkText(text, max) {
  if (!max || text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (let line of text.split('\n')) {
    while (line.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(line.slice(0, max)); line = line.slice(max); }
    if (cur && cur.length + 1 + line.length > max) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

function buildPayload(format, title, text, items, extra, token) {
  const json = { 'Content-Type': 'application/json' };
  const bearer = h => (token ? { ...h, Authorization: 'Bearer ' + token } : h);
  switch (format) {
    case 'discord':
      return { headers: json, bodies: chunkText(text, 2000).map(t => JSON.stringify({ content: t, ...extra })) };
    case 'slack':
      return { headers: json, bodies: [JSON.stringify({ text, ...extra })] };
    case 'ntfy': // raw body to the topic URL; extra JSON becomes headers (Priority, Tags, ...)
      return { headers: bearer({ 'Content-Type': 'text/plain; charset=utf-8', Title: title, ...extra }), bodies: [text] };
    case 'gotify':
      return { headers: token ? { ...json, 'X-Gotify-Key': token } : json,
        bodies: [JSON.stringify({ title, message: text, priority: 5, ...extra })] };
    case 'apprise':
      return { headers: bearer(json), bodies: [JSON.stringify({ title, body: text, type: 'info', ...extra })] };
    default:
      return { headers: bearer(json), bodies: [JSON.stringify({ source: 'plungarr', title, text, items, ...extra })] };
  }
}

async function notifyPost(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`notify POST -> HTTP ${r.status}`);
}

async function notifySend(title, text, items) {
  const { headers, bodies } = buildPayload(CONFIG.notify.format, title, text, items, CONFIG.notify.extra, CONFIG.notify.token);
  if (CONFIG.dryRun) { log('notify', 'NOTIFY-DIGEST (dry-run)', title, text.replace(/\s+/g, ' ').slice(0, 300)); return; }
  for (const body of bodies) await notifyPost(CONFIG.notify.url, headers, body);
}

const itemLine = ev => `- [${ev.app}] ${ev.action === 'NOTIFY' || ev.action === 'PROBLEM' || ev.action === 'CORRUPT-NOTIFY' ? '' : ev.action + ' '}${ev.title}${ev.detail ? ' — ' + ev.detail : ''}`;
const itemJson = ev => ({ category: ev.category, app: ev.app, action: ev.action, title: ev.title, reason: ev.detail || null,
  hint: (ev.detail.match(/set ([A-Z_]+_ACTION)=/) || [])[1] || null, at: new Date(ev.ts).toISOString() });

function notifyInit(st) {
  const n = st.notify = st.notify || {};
  n.pending = n.pending || {}; n.seen = n.seen || {}; n.lastDigest = n.lastDigest || {}; n.counters = n.counters || {};
  return n;
}

async function notifyFlush(st) {
  const n = notifyInit(st);
  const now = Date.now();
  const remindMs = CONFIG.notify.remindDays * 86_400_000;
  // No receiver configured: drop the buffer without recording anything, so
  // enabling NOTIFY_URL later sends everything that is still outstanding.
  if (!CONFIG.notify.url) { notifyBuffer.length = 0; n.pending = {}; return; }
  const openNow = new Set();
  for (const ev of notifyBuffer.splice(0)) {
    const c = counterOf(ev.action);
    if (c) n.counters[c] = (n.counters[c] || 0) + 1;
    if (ev.category === 'attention') openNow.add(`${ev.app}|${ev.title}|${ev.detail}`.slice(0, 400));
    if (CONFIG.notify.cadence[ev.category] === 'none') continue;
    // Attention items and errors repeat every cycle while unresolved; send
    // each distinct line once, then again only after the reminder window.
    // "Seen" is recorded only when the line is actually queued, so a category
    // switched from none to a cadence later still sends what is outstanding.
    if (ev.category === 'attention' || ev.category === 'errors') {
      const key = `${ev.category}|${ev.app}|${ev.title}|${ev.detail}`.slice(0, 400);
      const last = n.seen[key];
      if (last === undefined && ev.category === 'attention') n.counters.attentionOpened = (n.counters.attentionOpened || 0) + 1;
      if (last !== undefined && (CONFIG.notify.remindDays === 0 || now - last < remindMs)) continue;
      n.seen[key] = now;
    }
    (n.pending[ev.category] = n.pending[ev.category] || []).push(ev);
  }
  if (openNow.size) n.openAttention = openNow.size;
  const keep = Math.max(CONFIG.notify.remindDays * 2, 60) * 86_400_000;
  for (const [k, ts] of Object.entries(n.seen)) if (now - ts > keep) delete n.seen[k];

  const due = new Set(['immediate']);
  for (const c of ['daily', 'weekly', 'monthly']) if ((n.lastDigest[c] || 0) < lastSlot(c, now)) due.add(c);
  const sections = [], items = [], sentCats = [];
  let attention = 0, actions = 0, summarySent = false;
  for (const cat of CATEGORY_ORDER) {
    const cadence = CONFIG.notify.cadence[cat];
    if (cadence === 'none' || !due.has(cadence)) continue;
    if (cat === 'summary') {
      const c = n.counters;
      const since = n.lastDigest[cadence] || n.counters.since || now;
      sections.push(`## ${CATEGORY_LABEL[cat]} (since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')})\n` +
        `imported: ${c.imported || 0}, replaced: ${c.replaced || 0}, discarded: ${c.discarded || 0}, ` +
        `stalled removed: ${c.stalled || 0}, doomed removed: ${c.doomed || 0}, orphans deleted: ${c.orphaned || 0}, ` +
        `loop-guard stops: ${c.loopGuard || 0}, attention items opened: ${c.attentionOpened || 0}, ` +
        `still open: ${n.openAttention || 0}, errors: ${c.errors || 0}`);
      summarySent = true;
    } else if (cat === 'heartbeat') {
      sections.push(`## ${CATEGORY_LABEL[cat]}\nplungarr alive: apps ${CONFIG.apps.map(a => a.name).join(', ')}, ` +
        `SABnzbd stall watcher ${CONFIG.sab.url && CONFIG.sab.key ? 'on' : 'off'}, ` +
        `${Object.keys(st.firstSeen || {}).length} item(s) gated, ${n.openAttention || 0} need attention`);
    } else if (n.pending[cat] && n.pending[cat].length) {
      const list = n.pending[cat];
      sections.push(`## ${CATEGORY_LABEL[cat]} (${list.length})\n` + list.map(itemLine).join('\n'));
      items.push(...list.map(itemJson));
      sentCats.push(cat);
      if (cat === 'attention') attention += list.length; else if (cat === 'actions') actions += list.length;
    }
  }
  const periodicDue = [...due].filter(c => c !== 'immediate');
  if (!sections.length) { for (const c of periodicDue) n.lastDigest[c] = now; return; }
  const parts = [];
  if (attention) parts.push(`${attention} need attention`);
  if (actions) parts.push(`${actions} action(s)`);
  const title = 'plungarr: ' + (parts.length ? parts.join(', ') : 'digest');
  try {
    await notifySend(title, sections.join('\n\n'), items);
  } catch (e) {
    logError('notify', 'NOTIFY-ERROR', `delivery failed, will retry next cycle: ${e.message}`, false);
    return;
  }
  for (const cat of sentCats) delete n.pending[cat];
  for (const c of periodicDue) n.lastDigest[c] = now;
  if (summarySent) n.counters = { since: now };
}

async function notifyStartup() {
  if (!CONFIG.notify.url) return;
  const cad = CONFIG.notify.cadence;
  const sab = CONFIG.sab.url && CONFIG.sab.key ? 'on' : 'off (set SABNZBD_URL + SABNZBD_API_KEY)';
  const text = `plungarr online. apps: ${CONFIG.apps.map(a => a.name).join(', ')}; SABnzbd stall watcher: ${sab}; dryRun=${CONFIG.dryRun}; ` +
    `format=${CONFIG.notify.format}; cadence: ` + CATEGORY_ORDER.map(c => `${c}=${cad[c]}`).join(', ') +
    `; digest at ${String(CONFIG.notify.hour).padStart(2, '0')}:00 local, weekly ${WEEKDAYS[CONFIG.notify.day]}, monthly day ${CONFIG.notify.dayOfMonth}`;
  try { await notifySend('plungarr online', text, []); log('notify', 'NOTIFY-STARTUP', 'startup message sent'); }
  catch (e) { logError('notify', 'NOTIFY-ERROR', `startup message failed: ${e.message}`, false); }
}

// ---------- main loop ----------
// In-memory state is the source of truth; the file is best-effort persistence
// across restarts (an unwritable /state only costs cross-restart memory).
const state = loadState();
let cycleRunning = false;
async function cycle() {
  if (cycleRunning) return; // a long corrupt sweep must not stack concurrent cycles
  cycleRunning = true;
  try { await cycleInner(); } finally { cycleRunning = false; }
}
async function cycleInner() {
  const t0 = Date.now();
  for (const app of CONFIG.apps) {
    try { await processApp(app, state); }
    catch (e) { logError(app.name, 'CYCLE-ERROR', e.message); }
  }
  log('cycle', 'HEARTBEAT', `queues processed in ${Math.round((Date.now() - t0) / 1000)}s`,
    `${Object.keys(state.firstSeen).length} gated, sweep ${sweepRunning ? 'running' : 'idle'}`);
  try { await stallSweep(state); }
  catch (e) { logError('stall-sweep', 'CYCLE-ERROR', e.message); }
  // Normal service cycles continue during reviews; one-shot execution waits
  // for completion. Persist review results after the asynchronous work too.
  const reviews = [
    corruptSweep(state).catch(e => logError('corrupt-sweep', 'CYCLE-ERROR', e.message)).finally(() => saveState(state)),
    failReview(state).catch(e => logError('fail-review', 'CYCLE-ERROR', e.message)).finally(() => saveState(state)),
  ];
  if (CONFIG.runOnce) await Promise.all(reviews);
  try { await notifyFlush(state); }
  catch (e) { logError('notify', 'NOTIFY-ERROR', e.message, false); }
  saveState(state);
}

if (!CONFIG.apps.length) {
  console.error('No apps configured — set SONARR_URL/SONARR_API_KEY and/or RADARR_URL/RADARR_API_KEY.');
  process.exit(1);
}
console.log(`plungarr starting: apps=[${CONFIG.apps.map(a => a.name).join(', ')}] interval=${CONFIG.intervalSec}s minAge=${CONFIG.minAgeMin}m dryRun=${CONFIG.dryRun} corruptSweep=${CONFIG.corrupt.enabled ? `every ${CONFIG.corrupt.sweepHours}h (report-only)` : 'off'} failReview=${CONFIG.failReview.enabled ? `every ${CONFIG.failReview.everyHours}h (>=${CONFIG.failReview.failLimit} fails/${CONFIG.failReview.windowHours}h)` : 'off'} stallWatch=${CONFIG.sab.url && CONFIG.sab.key ? `on (head <${CONFIG.sab.minProgressMb}MB/${CONFIG.sab.stallMin}min, doomed >${Math.round(CONFIG.sab.missingFrac * 100)}% missing, ${CONFIG.sab.maxActions}/cycle)` : 'off (set SABNZBD_URL + SABNZBD_API_KEY)'}`);
await notifyStartup();
await cycle();
if (!CONFIG.runOnce) setInterval(cycle, CONFIG.intervalSec * 1000);
