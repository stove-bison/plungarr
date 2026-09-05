import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const project = fileURLToPath(new URL('..', import.meta.url));
async function runService(overrides = {}) {
  const root = path.resolve(process.env.PLUNGARR_TEST_TMPDIR || path.join(project, '.git', 'test-temp'));
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'plungarr-smoke-'));
  const stateFile = path.join(dir, 'state.json');
  const initial = JSON.stringify({ firstSeen: {}, blocklistCount: {}, actioned: {} });
  fs.writeFileSync(stateFile, initial);
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/v3/queue?')) return res.end(JSON.stringify({ page: 1, totalRecords: 0, records: [] }));
    if (req.url === '/api/v3/series') return res.end(JSON.stringify([{ id: 1, title: 'Example', statistics: { episodeFileCount: 1 } }]));
    if (req.url === '/api/v3/episodefile?seriesId=1') return res.end(JSON.stringify([
      { id: 1, relativePath: 'example.mkv', size: 1024 ** 3, mediaInfo: {}, dateAdded: '2025-01-01T00:00:00Z' },
    ]));
    if (req.url.startsWith('/api/v3/history?')) {
      const page = new URL(req.url, 'http://fixture.invalid').searchParams.get('page');
      return res.end(JSON.stringify({ records: page === '1' ? Array.from({ length: 3 }, () => ({
        episodeId: 7, eventType: 'downloadFailed', date: new Date().toISOString(), sourceTitle: 'Example.Release',
      })) : [] }));
    }
    if (req.url === '/api/v3/episode/7') return res.end(JSON.stringify({
      id: 7, series: { title: 'Example' }, seasonNumber: 1, episodeNumber: 7, title: 'Example Episode',
    }));
    res.statusCode = 500; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP']
      .filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const child = spawn(process.execPath, [path.join(project, 'janitor.mjs')], {
      cwd: project, env: { ...env, SONARR_URL: `http://127.0.0.1:${server.address().port}`,
        SONARR_API_KEY: 'fixture-key', RUN_ONCE: 'true', FAIL_REVIEW_ENABLED: 'false',
        STATE_FILE: stateFile, ...overrides }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    return { code, output, calls, initial, saved: fs.readFileSync(stateFile, 'utf8') };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(dir)) !== root) throw Error('Unexpected cleanup path');
    fs.rmSync(dir, { recursive: true });
  }
}

test('service starts, reports suspect media, and completes one cycle without library writes', async () => {
  const result = await runService();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CORRUPT-NOTIFY/);
  assert.ok(result.calls.length >= 3);
  assert.ok(result.calls.every(c => c.method === 'GET' && c.key === 'fixture-key'));
});

test('dry-run service leaves the live state file unchanged', async () => {
  const result = await runService({ DRY_RUN: 'true' });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.saved, result.initial);
  assert.ok(result.calls.every(c => c.method === 'GET'));
});

test('invalid configuration exits before contacting an arr', async () => {
  const result = await runService({ STALL_MAX_ACTIONS_PER_CYCLE: 'oops' });
  assert.equal(result.code, 1);
  assert.match(result.output, /Invalid STALL_MAX_ACTIONS_PER_CYCLE/);
  assert.equal(result.calls.length, 0);
});

test('RUN_ONCE persists completed review results before exiting', async () => {
  const result = await runService({ FAIL_REVIEW_ENABLED: 'true' });
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.saved).failReported?.['sonarr:7'], 3);
});
