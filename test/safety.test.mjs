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
  const calls = [], logs = [], disk = new Map();
  const fixture = {
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
    path, URLSearchParams, AbortSignal,
    fetch: () => { throw new Error('Real network is forbidden in this harness'); },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    fixture,
  });
  vm.runInContext(library + `
    api = (...args) => fixture.api(...args);
    sabApi = (...args) => fixture.sab(...args);
    globalThis.subject = { CONFIG, classifyFile, corruptSweepApp, corruptSweep,
      processApp, stallSweep, stallRemove, verifiedImport, saveState, loadState };
  `, context);
  return { ...context.subject, calls, logs, disk, fixture,
    advance: minutes => { now += minutes * 60000; } };
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
