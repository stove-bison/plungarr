// Regression tests: PASS confirms safe behavior at the API boundary.
// All API, clock, and filesystem effects are mocked. No service is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../janitor.mjs', import.meta.url), 'utf8');
const marker = '// ---------- main loop ----------';
assert.ok(source.includes(marker));
const library = source.slice(0, source.indexOf(marker))
  .replace(/^import .*;\r?\n/gm, '');
const sonarr = { name: 'sonarr', kind: 'series', url: 'http://sonarr.invalid', key: 'fixture' };
const radarr = { name: 'radarr', kind: 'movie', url: 'http://radarr.invalid', key: 'fixture' };
const state = () => ({ firstSeen: {}, actioned: {}, blocklistCount: {}, corruptCount: {} });

function harness(env = {}) {
  let now = Date.UTC(2026, 0, 1);
  const calls = [], logs = [], disk = new Map(), posts = [];
  const fixture = {
    post: async (url, headers, body) => { posts.push({ url, headers, body }); },
    api: async (app, method, url, body) => {
      calls.push({ app: app.name, method, url, body });
      if (method !== 'GET') return {};
      if (url.startsWith('/queue/details')) return [];
      if (url.startsWith('/queue')) return { records: [], totalRecords: 0 };
      if (url === '/movie' || url === '/series') return [];
      throw new Error(`Unexpected mock read: ${url}`);
    },
    sab: async params => { calls.push({ sab: params }); return { queue: { slots: [] } }; },
  };
  const context = vm.createContext({
    process: { env: { SONARR_URL: sonarr.url, SONARR_API_KEY: 'fixture',
      SABNZBD_URL: 'http://sab.invalid', SABNZBD_API_KEY: 'fixture', ...env } },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    fs: { readFileSync: p => { if (!disk.has(p)) throw Error('absent'); return disk.get(p); },
      mkdirSync() {}, writeFileSync: (p, text) => disk.set(p, text) },
    path, URL, URLSearchParams, AbortSignal,
    fetch: () => { throw new Error('Real network is forbidden in this harness'); },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    fixture,
  });
  vm.runInContext(library + `
    api = (...args) => fixture.api(...args);
    sabApi = (...args) => fixture.sab(...args);
    notifyPost = (...args) => fixture.post(...args);
    globalThis.subject = { CONFIG, classifyFile, corruptSweepApp, corruptSweep,
      processApp, stallSweep, stallRemove, verifiedImport, saveState, loadState,
      log, notifyFlush, buildPayload, categoryOf };
  `, context);
  return { ...context.subject, calls, logs, disk, fixture, posts,
    advance: minutes => { now += minutes * 60000; }, setNow: ts => { now = ts; } };
}

const file = (id, overrides = {}) => ({ id, size: 1024 ** 3, relativePath: `example-${id}.mkv`,
  dateAdded: '2025-01-01T00:00:00Z', mediaInfo: {}, ...overrides });
const slot = (id = 'job-a', overrides = {}) => ({ nzo_id: id, filename: 'Example.Release',
  mb: '1000', mbleft: '900', mbmissing: '0', status: 'Downloading', ...overrides });
function movies(h, files) {
  const fallback = h.fixture.api;
  h.fixture.api = async (app, method, url, body) => url === '/movie' && method === 'GET'
    ? files.map(f => ({ id: f.id, title: 'Example Movie', hasFile: true, movieFile: f }))
    : fallback(app, method, url, body);
}
function queue(h, getSlots) {
  h.fixture.sab = async params => {
    h.calls.push({ sab: params });
    const slots = getSlots();
    return params.name === 'delete' ? { status: true } : { queue: { paused: false,
      noofslots_total: slots.length, noofslots: slots.length, slots: slots.slice(params.start, params.start + params.limit) } };
  };
}
const deletes = h => h.calls.filter(c => c.method === 'DELETE' || c.sab?.name === 'delete');

test('F1: missing metadata never deletes a full-size old MKV', async () => {
  const h = harness(); movies(h, [file(1)]);
  await h.corruptSweepApp(radarr, state(), { used: 0 });
  assert.equal(deletes(h).length, 0);
  assert.ok(h.logs.some(l => l.includes('CORRUPT-NOTIFY')));
});

test('F1: an unknown file age cannot authorize deletion', async () => {
  const h = harness(); movies(h, [file(1, { dateAdded: undefined })]);
  await h.corruptSweepApp(radarr, state(), { used: 0 });
  assert.equal(deletes(h).length, 0);
});

test('F2: individually pausing a job resets its head timer', async () => {
  const h = harness({ STALL_MINUTES: '5' }), st = state(); let slots = [slot()]; queue(h, () => slots);
  await h.stallSweep(st);
  slots = [slot('job-a', { status: 'Paused' })]; h.advance(1); await h.stallSweep(st);
  h.advance(5); slots = [slot()]; await h.stallSweep(st);
  assert.equal(deletes(h).length, 0);
});

test('F2: time behind another job cannot count toward the head stall timeout', async () => {
  const h = harness({ STALL_MINUTES: '5' }), st = state(); let slots = [slot()]; queue(h, () => slots);
  await h.stallSweep(st);
  slots = [slot('job-b'), slot('job-a', { status: 'Queued' })]; h.advance(1); await h.stallSweep(st);
  h.advance(5); slots = [slot()]; await h.stallSweep(st);
  assert.equal(deletes(h).length, 0);
});

test('F3: missing articles never authorize deleting a Checking job', async () => {
  const h = harness(), st = state(); queue(h, () => [slot('job-a', { status: 'Checking', mbmissing: '200' })]);
  await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
  assert.equal(deletes(h).length, 0);
});

test('F4: page-two ownership routes removal through the arr', async () => {
  const h = harness();
  h.fixture.api = async (app, method, url, body) => {
    h.calls.push({ app: app.name, method, url, body });
    if (method !== 'GET') return {};
    const page = new URL(url, sonarr.url).searchParams.get('page') || '1';
    return { totalRecords: 501, records: page === '2'
      ? [{ id: 501, downloadId: 'job-a', title: 'Example.Release' }]
      : Array.from({ length: 500 }, (_, i) => ({ id: i + 1, downloadId: `other-${i}` })) };
  };
  queue(h, () => []);
  await h.stallRemove(state(), 'job-a', 'Example.Release', 'STALLED');
  assert.ok(deletes(h)[0]?.url?.startsWith('/queue/bulk?'));
  assert.equal(JSON.stringify(deletes(h)[0].body), '{"ids":[501]}');
  assert.equal(h.calls.filter(c => c.sab?.name === 'delete').length, 0);
});

test('F5: invalid caps fail startup with the setting name', () => {
  assert.throws(() => harness({ CORRUPT_MAX_DELETES: 'invalid' }), /CORRUPT_MAX_DELETES/);
  assert.throws(() => harness({ STALL_MAX_ACTIONS_PER_CYCLE: 'invalid' }), /STALL_MAX_ACTIONS_PER_CYCLE/);
});

test('F6: dry-run queue actions cannot suppress subsequent live actions', async () => {
  const h = harness({ DRY_RUN: 'true' }), st = state();
  const fallback = h.fixture.api;
  h.fixture.api = (app, method, url, body) => method === 'GET' && url.startsWith('/queue')
    ? { totalRecords: 1, records: [{ id: 1, downloadId: 'job-a', title: 'Example.Release', status: 'completed',
      trackedDownloadState: 'importBlocked', statusMessages: [{ messages: ['No files found are eligible for import'] }] }] }
    : fallback(app, method, url, body);
  await h.processApp(sonarr, st);
  assert.equal(st.actioned['sonarr:job-a'], undefined);
  h.CONFIG.dryRun = false;
  await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 1);
});

test('F6: a dry-run sweep cannot postpone the next live sweep', async () => {
  const h = harness({ DRY_RUN: 'true' }), st = state(); h.CONFIG.apps = [radarr]; movies(h, [file(1)]);
  await h.corruptSweep(st); assert.equal(st.lastCorruptSweep, undefined);
  h.CONFIG.dryRun = false;
  await h.corruptSweep(st);
  assert.equal(deletes(h).length, 0);
  assert.equal(h.logs.filter(l => l.includes('CORRUPT-SWEEP-DONE')).length, 2);
});

test('F1: corruption review cannot delete files even with legacy deletion settings', async () => {
  const h = harness({ CORRUPT_MAX_DELETES: '2' }); movies(h, [file(1), file(2), file(3)]);
  await h.corruptSweepApp(radarr, state(), { used: 0 });
  assert.equal(deletes(h).length, 0);
});

test('control: a fresh file and a full-size readable file are preserved', async () => {
  const h = harness(); movies(h, [file(1, { dateAdded: '2026-01-01T00:00:00Z' }),
    file(2, { mediaInfo: { videoCodec: 'x265' } })]);
  await h.corruptSweepApp(radarr, state(), { used: 0 });
  assert.equal(deletes(h).length, 0);
});

test('control: verified import rejects a different series', async () => {
  const h = harness(); h.fixture.api = async () => [{ series: { id: 2 }, episodes: [{ id: 1 }] }];
  assert.equal(await h.verifiedImport(sonarr, { seriesId: 1, downloadId: 'job-a', title: 'Example.Release' }), false);
});

test('control: global pause clears all SAB progress anchors', async () => {
  const h = harness(), st = state(); st.sabProgress = { 'head:job-a': { dl: 0, ts: 1 } };
  h.fixture.sab = async () => ({ queue: { paused: true, slots: [] } });
  await h.stallSweep(st);
  assert.equal(Object.keys(st.sabProgress).length, 0);
});

test('F5: invalid numeric and boolean settings cannot enable unsafe operation', () => {
  for (const [key, value] of [
    ['INTERVAL_SECONDS', '0'], ['INTERVAL_SECONDS', '2147484'],
    ['MIN_AGE_MINUTES', '-1'], ['STALL_MINUTES', 'Infinity'],
    ['STALL_MIN_PROGRESS_MB', ''], ['STALL_MISSING_FRAC', '1.1'],
    ['STALL_MISSING_TRIED_FRAC', '-0.1'], ['STALL_MAX_ACTIONS_PER_CYCLE', '1.5'],
    ['LOOP_GUARD_LIMIT', 'NaN'], ['FAIL_REVIEW_HOURS', '0'],
    ['FAIL_REVIEW_WINDOW_HOURS', '0'], ['FAIL_REVIEW_FAIL_LIMIT', '1.2'],
    ['CORRUPT_SWEEP_HOURS', '0'], ['CORRUPT_STUB_MB', '-2'],
    ['CORRUPT_MIN_KBPS', 'Infinity'], ['DRY_RUN', 'tru'], ['RUN_ONCE', 'perhaps'],
  ]) assert.throws(() => harness({ [key]: value }), new RegExp(key));
});

test('F4: an incomplete or changing ownership snapshot cannot delete an orphan', async () => {
  for (const badPage of [
    { totalRecords: 501, records: [] },
    { totalRecords: 500, records: [] },
    { records: [] },
  ]) {
    const h = harness(); let reads = 0;
    h.fixture.api = async () => ++reads === 1
      ? { totalRecords: 501, records: Array.from({ length: 500 }, (_, i) => ({ id: i, downloadId: `other-${i}` })) }
      : badPage;
    queue(h, () => []);
    await assert.rejects(() => h.stallRemove(state(), 'job-a', 'Example.Release', 'STALLED'));
    assert.equal(deletes(h).length, 0);
  }
});

test('F4: an unavailable arr cannot authorize orphan deletion', async () => {
  const h = harness(); h.fixture.api = async () => { throw Error('offline'); }; queue(h, () => []);
  await assert.rejects(() => h.stallRemove(state(), 'job-a', 'Example.Release', 'STALLED'), /offline/);
  assert.equal(deletes(h).length, 0);
});

test('F4: duplicate pages cannot be mistaken for a complete ownership snapshot', async () => {
  const h = harness();
  h.fixture.api = async () => ({ totalRecords: 1000,
    records: Array.from({ length: 500 }, (_, i) => ({ id: i, downloadId: `other-${i}` })) });
  queue(h, () => []);
  await assert.rejects(() => h.stallRemove(state(), 'job-a', 'Example.Release', 'STALLED'));
  assert.equal(deletes(h).length, 0);
});

test('F2: a continuously stalled head is removed once after the observation window', async () => {
  const h = harness(), st = state(); queue(h, () => [slot()]);
  await h.stallSweep(st);
  for (let i = 0; i < 9; i++) { h.advance(5); await h.stallSweep(st); }
  assert.equal(deletes(h).length, 1);
});

test('F2: regular progress keeps the active head alive', async () => {
  const h = harness(), st = state(); let left = 900;
  queue(h, () => [slot('job-a', { mbleft: String(left) })]);
  await h.stallSweep(st);
  for (let i = 0; i < 12; i++) { left -= 6; h.advance(5); await h.stallSweep(st); }
  assert.equal(deletes(h).length, 0);
});

test('F2: a monitoring gap resets stale observations', async () => {
  const h = harness(), st = state(); queue(h, () => [slot()]);
  await h.stallSweep(st); h.advance(60); await h.stallSweep(st);
  assert.equal(deletes(h).length, 0);
});

test('F2: paused missing-article timers must age again after resume', async () => {
  const h = harness(), st = state(); let status = 'Downloading';
  queue(h, () => [slot('job-a', { status, mbmissing: '200' })]);
  await h.stallSweep(st); h.advance(4); status = 'Paused'; await h.stallSweep(st);
  h.advance(4); status = 'Downloading'; await h.stallSweep(st);
  assert.equal(deletes(h).length, 0);
});

test('F3: non-downloading states cannot trigger missing-article removals', async () => {
  for (const status of ['Checking', 'Verifying', 'Repairing', 'Fetching', 'Queued', 'Propagating']) {
    const h = harness(), st = state(); queue(h, () => [slot('job-a', { status, mbmissing: '200' })]);
    await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
    assert.equal(deletes(h).length, 0, status);
  }
});

test('F3: a job eligible for both stall rules is removed only once', async () => {
  const h = harness({ STALL_MINUTES: '5' }), st = state();
  queue(h, () => [slot('job-a', { mbmissing: '200' })]);
  await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
});

test('F4: SAB downloads beyond the first 200 are observed', async () => {
  const h = harness(), st = state();
  queue(h, () => [...Array.from({ length: 200 }, (_, i) => slot('paused-' + i, { status: 'Paused' })),
    slot('job-a', { mbmissing: '200' })]);
  await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
});

test('F2: failed SAB observations invalidate timers', async () => {
  const h = harness(), st = state(); queue(h, () => [slot()]);
  await h.stallSweep(st);
  h.fixture.sab = async () => { throw Error('offline'); };
  await assert.rejects(() => h.stallSweep(st), /offline/);
  assert.equal(Object.keys(st.sabProgress).length, 0);
});

test('F6: dry runs cannot read or overwrite live operational state', () => {
  const h = harness({ DRY_RUN: 'true' });
  const live = JSON.stringify({ ...state(), lastCorruptSweep: 123, actioned: { existing: 456 } });
  h.disk.set(h.CONFIG.stateFile, live);
  const st = h.loadState();
  assert.equal(st.lastCorruptSweep, undefined);
  h.saveState({ ...state(), actioned: { simulated: 789 } });
  assert.equal(h.disk.get(h.CONFIG.stateFile), live);
});

test('F2: a restart discards persisted stall observations', () => {
  const h = harness(); h.disk.set(h.CONFIG.stateFile, JSON.stringify({ ...state(),
    sabProgress: { 'head:job-a': { dl: 100, ts: 1 } }, sabObservedAt: 1 }));
  const st = h.loadState();
  assert.equal(Object.keys(st.sabProgress || {}).length, 0);
});

test('F2: hitting the action cap cannot preserve a recovered jobs missing-article timer', async () => {
  const h = harness({ STALL_MAX_ACTIONS_PER_CYCLE: '1' }), st = state();
  let slots = [slot('job-a', { mbmissing: '200' }), slot('job-b', { mbmissing: '200' })];
  queue(h, () => slots); await h.stallSweep(st);
  h.advance(5); slots[1] = slot('job-b'); await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
  h.advance(1); slots = [slot('job-b', { mbmissing: '200' })]; await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
});

test('F2: malformed byte counters cannot authorize deletion', async () => {
  for (const value of [null, '', ' ', false, [], 'not-a-number']) {
    const h = harness({ STALL_MINUTES: '5' }), st = state();
    queue(h, () => [slot('job-a', { mbleft: value, mbmissing: '200' })]);
    await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
    assert.equal(deletes(h).length, 0, JSON.stringify(value));
  }
});

test('F4: SAB page failures and inconsistent snapshots cannot authorize removals', async () => {
  for (const failure of ['offline', 'count', 'duplicate']) {
    const h = harness(), st = state();
    const slots = Array.from({ length: 200 }, (_, i) => slot('job-' + i, { mbmissing: '200' }));
    h.fixture.sab = async params => {
      if (params.start === 0) return { queue: { slots, noofslots_total: 201 } };
      if (failure === 'offline') throw Error('offline');
      return { queue: { slots: [slots[0]], noofslots_total: failure === 'count' ? 202 : 201 } };
    };
    await assert.rejects(() => h.stallSweep(st));
    assert.equal(deletes(h).length, 0);
  }
});

test('F3: a job entering Checking during ownership lookup cannot be deleted', async () => {
  for (const tracked of [true, false]) {
    const h = harness(), st = state(); let status = 'Downloading';
    queue(h, () => [slot('job-a', { status, mbmissing: '200' })]);
    const fallback = h.fixture.api;
    h.fixture.api = async (app, method, url, body) => {
      if (method === 'GET') {
        status = 'Checking';
        if (url.startsWith('/queue/details')) return [];
        return { totalRecords: tracked ? 1 : 0, records: tracked
          ? [{ id: 1, downloadId: 'job-a', title: 'Example.Release' }] : [] };
      }
      return fallback(app, method, url, body);
    };
    await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
    assert.equal(deletes(h).length, 0);
  }
});

test('F2: progress or head displacement during ownership lookup cancels removal', async () => {
  for (const change of ['progress', 'displaced', 'paused']) {
    const h = harness({ STALL_MINUTES: '5' }), st = state(); let slots = [slot()];
    queue(h, () => slots);
    h.fixture.api = async (app, method, url) => {
      slots = change === 'progress' ? [slot('job-a', { mbleft: '800' })]
        : change === 'paused' ? [slot('job-a', { status: 'Paused' })] : [slot('other'), slot()];
      return url.startsWith('/queue/details') ? [] : { totalRecords: 0, records: [] };
    };
    await h.stallSweep(st); h.advance(6); await h.stallSweep(st);
    assert.equal(deletes(h).length, 0, change);
  }
});

test('F4: an orphan requires a final unpaginated ownership check', async () => {
  const h = harness(), fallback = h.fixture.api;
  h.fixture.api = async (app, method, url, body) => {
    if (url.startsWith('/queue/details')) return [{ id: 99, downloadId: 'job-a', title: 'Example.Release' }];
    return fallback(app, method, url, body);
  };
  queue(h, () => []);
  await h.stallRemove(state(), 'job-a', 'Example.Release', 'STALLED');
  assert.equal(deletes(h).length, 1);
  assert.equal(deletes(h)[0].app, 'sonarr');
  assert.equal(JSON.stringify(deletes(h)[0].body), '{"ids":[99]}');
});

test('F2: head counters are observed even after another job consumes the cap', async () => {
  const h = harness({ STALL_MAX_ACTIONS_PER_CYCLE: '1', STALL_MINUTES: '5' }), st = state();
  let slots = [slot('job-a'), slot('job-b', { mbmissing: '200' })];
  queue(h, () => slots); await h.stallSweep(st);
  h.advance(5); slots[0] = slot('job-a', { mbleft: null }); await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
  h.advance(1); slots = [slot('job-a')]; await h.stallSweep(st);
  assert.equal(deletes(h).length, 1);
});

test('F2: global pause or failure during confirmation invalidates the entire cycle', async () => {
  for (const failure of ['paused', 'offline']) {
    const h = harness(), st = state();
    const slots = [slot('job-a', { mbmissing: '200' }), slot('job-b', { mbmissing: '200' })];
    queue(h, () => slots); await h.stallSweep(st); h.advance(5);
    const fallback = h.fixture.sab; let reads = 0;
    h.fixture.sab = async params => {
      if (params.name !== 'delete' && ++reads === 2) {
        if (failure === 'offline') throw Error('offline');
        return { queue: { paused: true, slots: [] } };
      }
      return fallback(params);
    };
    await assert.rejects(() => h.stallSweep(st));
    assert.equal(deletes(h).length, 0);
    assert.equal(Object.keys(st.sabProgress).length, 0);
  }
});

// ---------- configurable block actions ----------
const queued = (h, records) => { h.fixture.api = async (app, method, url, body) => {
  h.calls.push({ app: app.name, method, url, body });
  if (method !== 'GET') return {};
  if (url.startsWith('/queue')) return { page: 1, totalRecords: records.length, records };
  if (url.startsWith('/manualimport')) return h.candidates || [];
  throw new Error('Unexpected mock read: ' + url);
}; };
const blocked = (id, messages, extra = {}) => ({ id, downloadId: `dl-${id}`, title: `Release.${id}`, status: 'completed',
  trackedDownloadState: 'importBlocked', seriesId: 1, statusMessages: [{ title: `Release.${id}`, messages }], ...extra });
const ARCHIVE = 'Found archive file, might need to be extracted';

test('A1: archive default replaces after the age gate even when importBlocked', async () => {
  const h = harness(), st = state(); queued(h, [blocked(1, [ARCHIVE])]);
  await h.processApp(sonarr, st); assert.equal(deletes(h).length, 0);
  h.advance(6); await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 1);
  assert.match(deletes(h)[0].url, /blocklist=true&skipRedownload=false/);
  assert.ok(h.logs.some(l => l.includes('REMOVED+REPLACE')));
});

test('A2: ARCHIVE_ACTION=notify leaves the item and names the setting', async () => {
  const h = harness({ ARCHIVE_ACTION: 'notify' }), st = state(); queued(h, [blocked(1, [ARCHIVE])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 0);
  assert.ok(h.logs.some(l => l.includes('NOTIFY') && l.includes('ARCHIVE_ACTION')));
});

test('A3: dangerous file default replaces; sample default notifies', async () => {
  const h = harness(), st = state();
  queued(h, [blocked(1, ['Caution: Found executable file']), blocked(2, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 1); assert.equal(JSON.stringify(deletes(h)[0].body), JSON.stringify({ ids: [1] }));
  assert.ok(h.logs.some(l => l.includes('Release.2') && l.includes('SAMPLE_ACTION')));
});

test('A4: loop guard turns replace into a no-search removal after the limit', async () => {
  const h = harness({ LOOP_GUARD_LIMIT: '1' }), st = state(); queued(h, [blocked(1, [ARCHIVE])]);
  st.blocklistCount['release.1'] = 1;
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  assert.match(deletes(h)[0].url, /skipRedownload=true/);
});

test('A5: candidate-level not-an-upgrade routes through NOT_UPGRADE_ACTION', async () => {
  const h = harness(), st = state();
  h.candidates = [{ path: '/x.mkv', series: { id: 1 }, episodes: [{ id: 9 }],
    rejections: [{ reason: 'Not an upgrade for existing episode file(s). Existing quality: WEBDL-720p. New Quality WEBDL-1080p.' }] }];
  queued(h, [blocked(1, ['matched to series by ID'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 1); assert.match(deletes(h)[0].url, /skipRedownload=true/);
  assert.equal(h.calls.filter(c => c.url === '/command').length, 0);
});

test('A6: a mixed candidate set imports the clean file and leaves the rest', async () => {
  const h = harness(), st = state();
  h.candidates = [{ path: '/a.mkv', series: { id: 1 }, episodes: [{ id: 1 }], rejections: [] },
    { path: '/b.mkv', series: { id: 1 }, episodes: [{ id: 2 }], rejections: [{ reason: 'Not an upgrade for existing episode file(s)' }] }];
  queued(h, [blocked(1, ['matched to series by ID'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  const cmd = h.calls.find(c => c.url === '/command');
  assert.equal(cmd.body.files.length, 1); assert.equal(deletes(h).length, 0);
});

test('A7: invalid action values fail startup with the setting name', () => {
  for (const key of ['ARCHIVE_ACTION', 'DANGEROUS_FILE_ACTION', 'SAMPLE_ACTION', 'NOT_UPGRADE_ACTION'])
    assert.throws(() => harness({ [key]: 'research' }), new RegExp(key));
});

test('A8: dry run logs the intended action and sends nothing', async () => {
  const h = harness({ DRY_RUN: 'true' }), st = state(); queued(h, [blocked(1, [ARCHIVE])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  assert.equal(deletes(h).length, 0); assert.ok(h.logs.some(l => l.includes('DRY-RUN')));
});

// ---------- notifications ----------
const notifier = (env = {}) => harness({ NOTIFY_URL: 'http://hook.invalid/x', NOTIFY_FORMAT: 'json', ...env });
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime(); // local time, like the service
function clock(h, ts) { h.setNow(ts); }
const bodyOf = post => JSON.parse(post.body);

test('N1: every format produces its documented body and headers', () => {
  const h = notifier({ NOTIFY_TOKEN: 'tok', NOTIFY_EXTRA_JSON: '{"username":"plungarr"}' });
  const items = [{ category: 'attention', app: 'sonarr', title: 'Release.1', reason: 'x', hint: null }];
  const build = f => h.buildPayload(f, 'T', 'line one', items, { username: 'plungarr' }, 'tok');
  const discord = build('discord'); assert.equal(JSON.parse(discord.bodies[0]).content, 'line one');
  assert.equal(JSON.parse(discord.bodies[0]).username, 'plungarr');
  assert.equal(JSON.parse(build('slack').bodies[0]).text, 'line one');
  const ntfy = build('ntfy'); assert.equal(ntfy.bodies[0], 'line one'); assert.equal(ntfy.headers.Title, 'T');
  assert.equal(ntfy.headers.Authorization, 'Bearer tok');
  const gotify = build('gotify'); const g = JSON.parse(gotify.bodies[0]);
  assert.equal(g.title, 'T'); assert.equal(g.message, 'line one'); assert.equal(typeof g.priority, 'number');
  assert.equal(gotify.headers['X-Gotify-Key'], 'tok');
  const a = JSON.parse(build('apprise').bodies[0]); assert.equal(a.title, 'T'); assert.equal(a.body, 'line one'); assert.equal(a.type, 'info');
  const j = JSON.parse(build('json').bodies[0]); assert.equal(j.source, 'plungarr'); assert.equal(j.items.length, 1); assert.equal(j.title, 'T');
  assert.equal(build('json').headers.Authorization, 'Bearer tok');
});

test('N2: discord splits long text at line boundaries under 2000 characters', () => {
  const h = notifier();
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ` + 'x'.repeat(80)).join('\n');
  const { bodies } = h.buildPayload('discord', 'T', text, [], {}, '');
  assert.ok(bodies.length >= 3);
  for (const b of bodies) { const c = JSON.parse(b).content; assert.ok(c.length <= 2000); assert.ok(!c.startsWith('x')); }
  assert.equal(bodies.map(b => JSON.parse(b).content).join('\n'), text);
});

test('N3: immediate attention lines from one cycle go out as a single POST', async () => {
  const h = notifier(), st = state();
  queued(h, [blocked(1, ['Sample']), blocked(2, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  const j = bodyOf(h.posts[0]); assert.ok(j.text.includes('Release.1') && j.text.includes('Release.2'));
  assert.equal(j.items.filter(i => i.category === 'attention').length, 2);
});

test('N4: an unchanged attention item is not resent until the reminder window passes', async () => {
  const h = notifier({ NOTIFY_REMIND_DAYS: '2' }), st = state();
  queued(h, [blocked(1, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st); await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  h.advance(60); await h.processApp(sonarr, st); await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  h.advance(3 * 24 * 60); await h.processApp(sonarr, st); await h.notifyFlush(st);
  assert.equal(h.posts.length, 2);
  const h0 = notifier({ NOTIFY_REMIND_DAYS: '0' }), st0 = state();
  queued(h0, [blocked(1, ['Sample'])]);
  await h0.processApp(sonarr, st0); h0.advance(6); await h0.processApp(sonarr, st0); await h0.notifyFlush(st0);
  h0.advance(30 * 24 * 60); await h0.processApp(sonarr, st0); await h0.notifyFlush(st0);
  assert.equal(h0.posts.length, 1);
});

test('N5: a daily category waits for the digest hour and sends once', async () => {
  const h = notifier({ NOTIFY_ACTIONS: 'daily', NOTIFY_ATTENTION: 'none' }), st = state();
  clock(h, at(2026, 3, 10, 7)); st.notify = { pending: {}, seen: {}, lastDigest: { daily: at(2026, 3, 9, 8, 1) }, counters: {} };
  h.log('sonarr', 'IMPORTED', 'Release.1', '1 file(s)');
  await h.notifyFlush(st); assert.equal(h.posts.length, 0);
  clock(h, at(2026, 3, 10, 8, 5)); await h.notifyFlush(st); assert.equal(h.posts.length, 1);
  assert.ok(bodyOf(h.posts[0]).text.includes('Release.1'));
  clock(h, at(2026, 3, 10, 8, 10)); h.log('sonarr', 'IMPORTED', 'Release.2', '1 file(s)');
  await h.notifyFlush(st); assert.equal(h.posts.length, 1);
});

test('N6: weekly and monthly slots follow the configured day, and a missed window sends on the next flush', async () => {
  // 2026-03-10 is a Tuesday; NOTIFY_DIGEST_DAY=monday => slot was 2026-03-09 08:00
  const h = notifier({ NOTIFY_PROBLEMS: 'weekly', NOTIFY_CORRUPTION: 'monthly', NOTIFY_ATTENTION: 'none',
    NOTIFY_DIGEST_DAY: 'monday', NOTIFY_DIGEST_DAY_OF_MONTH: '5' }), st = state();
  clock(h, at(2026, 3, 10, 12));
  st.notify = { pending: {}, seen: {}, lastDigest: { weekly: at(2026, 3, 2, 8, 1), monthly: at(2026, 3, 5, 8, 1) }, counters: {} };
  h.log('sonarr', 'PROBLEM', 'Show S01E01', '3 failed grab(s)');
  h.log('radarr', 'CORRUPT-NOTIFY', 'Movie: file.mkv', 'stub');
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  const text = bodyOf(h.posts[0]).text;
  assert.ok(text.includes('Show S01E01')); assert.ok(!text.includes('file.mkv'));
  clock(h, at(2026, 4, 5, 8, 30)); await h.notifyFlush(st);
  assert.equal(h.posts.length, 2); assert.ok(bodyOf(h.posts[1]).text.includes('file.mkv'));
});

test('N7: categories sharing a slot merge into one message with a section each', async () => {
  const h = notifier({ NOTIFY_ACTIONS: 'daily', NOTIFY_PROBLEMS: 'daily', NOTIFY_ATTENTION: 'none' }), st = state();
  clock(h, at(2026, 3, 10, 9)); st.notify = { pending: {}, seen: {}, lastDigest: { daily: at(2026, 3, 9, 8, 1) }, counters: {} };
  h.log('sonarr', 'IMPORTED', 'Release.1', '1 file(s)');
  h.log('sonarr', 'PROBLEM', 'Show S01E01', '3 failed grab(s)');
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  const text = bodyOf(h.posts[0]).text;
  assert.ok(/Actions taken/.test(text) && /Chronic failures/.test(text), text);
});

test('N8: the summary reports period counters and resets them after sending', async () => {
  const h = notifier({ NOTIFY_SUMMARY: 'daily', NOTIFY_ACTIONS: 'none', NOTIFY_ATTENTION: 'none' }), st = state();
  clock(h, at(2026, 3, 10, 7)); st.notify = { pending: {}, seen: {}, lastDigest: { daily: at(2026, 3, 9, 8, 1) }, counters: {} };
  h.log('sonarr', 'IMPORTED', 'Release.1', '1 file(s)'); h.log('sonarr', 'IMPORTED', 'Release.2', '1 file(s)');
  h.log('sonarr', 'REMOVED+REPLACE', 'Release.3', 'archive not extracted');
  await h.notifyFlush(st); assert.equal(h.posts.length, 0);
  clock(h, at(2026, 3, 10, 8, 5)); await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  const text = bodyOf(h.posts[0]).text;
  assert.ok(text.includes('imported: 2') && text.includes('replaced: 1'), text);
  assert.equal(st.notify.counters.imported || 0, 0);
});

test('N9: a failed delivery keeps the items, logs one error, and retries next flush without recursing', async () => {
  const h = notifier(), st = state();
  queued(h, [blocked(1, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  h.fixture.post = async () => { throw new Error('boom'); };
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 0);
  assert.equal(h.logs.filter(l => l.includes('NOTIFY-ERROR')).length, 1);
  h.fixture.post = async (url, headers, body) => { h.posts.push({ url, headers, body }); };
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  const j = bodyOf(h.posts[0]);
  assert.ok(j.text.includes('Release.1')); assert.ok(!j.text.includes('boom'));
});

test('N10: dry run logs the digest and never posts', async () => {
  const h = notifier({ DRY_RUN: 'true' }), st = state();
  queued(h, [blocked(1, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 0);
  assert.ok(h.logs.some(l => l.includes('NOTIFY-DIGEST') && l.includes('dry-run')));
});

test('N11: invalid notification settings fail startup with the setting name', () => {
  for (const [key, value] of [
    ['NOTIFY_FORMAT', 'email'], ['NOTIFY_URL', 'nope'], ['NOTIFY_URL', 'ftp://x'], ['NOTIFY_ATTENTION', 'hourly'],
    ['NOTIFY_ERRORS', 'x'], ['NOTIFY_ACTIONS', 'x'], ['NOTIFY_PROBLEMS', 'x'], ['NOTIFY_CORRUPTION', 'x'],
    ['NOTIFY_SUMMARY', 'x'], ['NOTIFY_HEARTBEAT', 'x'],
    ['NOTIFY_DIGEST_HOUR', '24'], ['NOTIFY_DIGEST_DAY', 'funday'], ['NOTIFY_DIGEST_DAY_OF_MONTH', '31'],
    ['NOTIFY_REMIND_DAYS', '-1'], ['NOTIFY_EXTRA_JSON', '[1]'], ['NOTIFY_EXTRA_JSON', '{bad'],
  ]) assert.throws(() => harness({ [key]: value }), new RegExp(key), `${key}=${value}`);
});

test('N12: without NOTIFY_URL nothing is queued or posted', async () => {
  const h = harness(), st = state();
  queued(h, [blocked(1, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st);
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 0);
  assert.equal(Object.keys((st.notify && st.notify.pending) || {}).length, 0);
});

test('N13: heartbeat sends a digest even when nothing else happened', async () => {
  const h = notifier({ NOTIFY_HEARTBEAT: 'daily', NOTIFY_ATTENTION: 'none' }), st = state();
  clock(h, at(2026, 3, 10, 8, 5)); st.notify = { pending: {}, seen: {}, lastDigest: { daily: at(2026, 3, 9, 8, 1) }, counters: {} };
  await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  assert.ok(/alive/i.test(bodyOf(h.posts[0]).text));
});

test('N14: a repeating error line is sent once until the reminder window passes', async () => {
  const h = notifier({ NOTIFY_REMIND_DAYS: '1', NOTIFY_ATTENTION: 'none' }), st = state();
  for (let i = 0; i < 3; i++) h.log('state', 'STATE-ERROR', 'state save failed: EACCES', '');
  await h.notifyFlush(st); assert.equal(h.posts.length, 1);
  h.log('state', 'STATE-ERROR', 'state save failed: EACCES', '');
  await h.notifyFlush(st); assert.equal(h.posts.length, 1);
  h.advance(25 * 60); h.log('state', 'STATE-ERROR', 'state save failed: EACCES', '');
  await h.notifyFlush(st); assert.equal(h.posts.length, 2);
});

// ---------- corruption sweep reporting ----------
test('C1: only the actionable classes are reported by default', async () => {
  const h = harness(), st = state();
  movies(h, [file(1), file(2, { size: 5 * 1024 ** 2, mediaInfo: { videoCodec: 'x264', runTime: '00:00:30' } })]);
  const stats = await h.corruptSweepApp(radarr, st);
  assert.equal(stats.fresh, 1); assert.equal(stats.suppressed, 1);
  assert.ok(h.logs.some(l => l.includes('example-1.mkv') && l.includes('no media info')));
  assert.ok(!h.logs.some(l => l.includes('example-2.mkv')));
});

test('C2: CORRUPT_REPORT_CLASSES opts the quiet classes in, and rejects unknown names', async () => {
  const h = harness({ CORRUPT_REPORT_CLASSES: 'tiny_readable' }), st = state();
  movies(h, [file(1), file(2, { size: 5 * 1024 ** 2, mediaInfo: { videoCodec: 'x264', runTime: '00:00:30' } })]);
  await h.corruptSweepApp(radarr, st);
  assert.ok(h.logs.some(l => l.includes('example-2.mkv') && l.includes('legitimate short')));
  assert.ok(!h.logs.some(l => l.includes('example-1.mkv')));
  assert.throws(() => harness({ CORRUPT_REPORT_CLASSES: 'unreadable,bogus' }), /CORRUPT_REPORT_CLASSES/);
});

test('C3: a suspect is reported once, again when it changes, and again after the reminder window', async () => {
  const h = harness({ NOTIFY_REMIND_DAYS: '3' }), st = state();
  let files = [file(1)]; movies(h, files);
  let s1 = await h.corruptSweepApp(radarr, st); assert.equal(s1.fresh, 1);
  let s2 = await h.corruptSweepApp(radarr, st); assert.equal(s2.fresh, 0); assert.equal(s2.known, 1);
  assert.equal(h.logs.filter(l => l.includes('CORRUPT-NOTIFY')).length, 1);
  movies(h, [file(1, { size: 2 * 1024 ** 3 })]);
  let s3 = await h.corruptSweepApp(radarr, st); assert.equal(s3.fresh, 1);
  h.advance(4 * 24 * 60);
  let s4 = await h.corruptSweepApp(radarr, st); assert.equal(s4.fresh, 1);
  const h0 = harness({ NOTIFY_REMIND_DAYS: '0' }), st0 = state(); movies(h0, [file(1)]);
  await h0.corruptSweepApp(radarr, st0); h0.advance(365 * 24 * 60);
  assert.equal((await h0.corruptSweepApp(radarr, st0)).fresh, 0);
});

test('C4: reported entries for files no longer in the library are forgotten', async () => {
  const h = harness(), st = state();
  movies(h, [file(1)]); await h.corruptSweepApp(radarr, st);
  assert.ok(st.corruptReported['radarr:1']);
  movies(h, []); await h.corruptSweepApp(radarr, st);
  assert.equal(st.corruptReported['radarr:1'], undefined);
});

test('N15: the heartbeat reports the SABnzbd stall watcher state', async () => {
  const h = notifier({ NOTIFY_HEARTBEAT: 'daily', NOTIFY_ATTENTION: 'none' }), st = state();
  clock(h, at(2026, 3, 10, 8, 5)); st.notify = { pending: {}, seen: {}, lastDigest: { daily: at(2026, 3, 9, 8, 1) }, counters: {} };
  await h.notifyFlush(st);
  assert.match(bodyOf(h.posts[0]).text, /SABnzbd stall watcher on/);
});

test('N16: attention lines seen before NOTIFY_URL or a cadence was set are still sent once enabled', async () => {
  // Cycles ran with no receiver configured; the same state file is then used with one.
  const off = harness(), st = state();
  queued(off, [blocked(1, ['Sample'])]);
  await off.processApp(sonarr, st); off.advance(6); await off.processApp(sonarr, st); await off.notifyFlush(st);
  assert.equal(Object.keys(st.notify.seen).length, 0);
  const on = notifier(); queued(on, [blocked(1, ['Sample'])]);
  on.advance(12); await on.processApp(sonarr, st); await on.notifyFlush(st);
  assert.equal(on.posts.length, 1); assert.ok(bodyOf(on.posts[0]).text.includes('Release.1'));
  // Same again for a category that was 'none' and is later switched on.
  const none = notifier({ NOTIFY_ATTENTION: 'none' }), st2 = state(); queued(none, [blocked(1, ['Sample'])]);
  await none.processApp(sonarr, st2); none.advance(6); await none.processApp(sonarr, st2); await none.notifyFlush(st2);
  assert.equal(none.posts.length, 0);
  const later = notifier(); queued(later, [blocked(1, ['Sample'])]);
  later.advance(12); await later.processApp(sonarr, st2); await later.notifyFlush(st2);
  assert.equal(later.posts.length, 1);
});

test('N17: a state file from the pre-v2 notifier has its seen list cleared once, and sends log NOTIFY-SENT', async () => {
  const h = notifier(), st = state();
  st.notify = { pending: {}, seen: { 'attention|sonarr|Release.1|flagged as a sample; left untouched (set SAMPLE_ACTION=replace or discard to auto-clear)': Date.now() }, lastDigest: {}, counters: {} };
  queued(h, [blocked(1, ['Sample'])]);
  await h.processApp(sonarr, st); h.advance(6); await h.processApp(sonarr, st); await h.notifyFlush(st);
  assert.equal(h.posts.length, 1);
  assert.equal(st.notify.v, 2);
  assert.ok(h.logs.some(l => l.includes('NOTIFY-SENT') && l.includes('attention')));
  await h.processApp(sonarr, st); await h.notifyFlush(st);
  assert.equal(h.posts.length, 1, 'v2 seen list is kept after migration');
});

// ---------- multiple arr instances ----------
test('M1: numbered instances become separate apps with distinct default names', () => {
  const h = harness({ SONARR_2_URL: 'http://anime.invalid', SONARR_2_API_KEY: 'k2',
    RADARR_URL: 'http://radarr.invalid', RADARR_API_KEY: 'k3', RADARR_3_URL: 'http://r3.invalid', RADARR_3_API_KEY: 'k4' });
  assert.equal(h.CONFIG.apps.map(a => `${a.name}:${a.kind}`).join(','), 'sonarr:series,sonarr-2:series,radarr:movie,radarr-3:movie');
});

test('M2: *_NAME labels an instance and duplicates or half-configured instances fail startup', () => {
  const h = harness({ SONARR_2_URL: 'http://anime.invalid', SONARR_2_API_KEY: 'k2', SONARR_2_NAME: 'Anime' });
  assert.equal(h.CONFIG.apps[1].name, 'anime');
  assert.throws(() => harness({ SONARR_2_URL: 'http://anime.invalid', SONARR_2_API_KEY: 'k2', SONARR_2_NAME: 'sonarr' }), /used twice/);
  assert.throws(() => harness({ SONARR_2_URL: 'http://anime.invalid' }), /SONARR_2_URL\/SONARR_2_API_KEY/);
  assert.throws(() => harness({ SONARR_2_URL: 'http://anime.invalid', SONARR_2_API_KEY: 'k2', SONARR_2_NAME: 'a:b' }), /SONARR_2_NAME/);
});

test('M3: two instances keep separate age gates and actions for the same downloadId', async () => {
  const h = harness({ SONARR_2_URL: 'http://anime.invalid', SONARR_2_API_KEY: 'k2' }), st = state();
  const [main, anime] = h.CONFIG.apps;
  queued(h, [blocked(1, [ARCHIVE])]);
  await h.processApp(main, st); await h.processApp(anime, st);
  h.advance(6); await h.processApp(main, st); await h.processApp(anime, st);
  assert.equal(deletes(h).length, 2);
  assert.deepEqual(deletes(h).map(d => d.app), ['sonarr', 'sonarr-2']);
});
