// The site is hand-written HTML plus one generated page. These checks keep it
// honest: every setting the container accepts is documented, and no internal
// link points at a file that does not exist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = path.join(root, 'site');

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory()
    ? htmlFiles(path.join(dir, d.name)) : d.name.endsWith('.html') && !d.name.endsWith('.template.html') ? [path.join(dir, d.name)] : []);
}

test('site: settings page documents every template variable and every .env.example key', () => {
  execFileSync(process.execPath, [path.join(site, 'build.mjs')], { stdio: 'pipe' });
  const page = fs.readFileSync(path.join(site, 'docs', 'settings.html'), 'utf8');
  const targets = [...fs.readFileSync(path.join(root, 'templates', 'plungarr.xml'), 'utf8')
    .matchAll(/<Config\s+.*?Target="([A-Z][A-Z0-9_]+)".*?Type="Variable".*?\/>/g)].map(m => m[1]);
  const envKeys = [...fs.readFileSync(path.join(root, '.env.example'), 'utf8')
    .matchAll(/^#?([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]);
  assert.ok(targets.length > 10 && envKeys.length > 20);
  for (const key of new Set([...targets, ...envKeys])) assert.ok(page.includes(`<code>${key}</code>`), `${key} missing from settings.html`);
});

test('site: every internal link and asset resolves', () => {
  const files = htmlFiles(site);
  assert.ok(files.length >= 6, 'expected at least six pages');
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|data:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      assert.ok(fs.existsSync(resolved), `${path.relative(root, file)} links to missing ${target}`);
    }
    assert.ok(!/<script/i.test(html), `${path.relative(root, file)} must not contain scripts`);
    // Pages make no external requests; the only external URLs are plain links to known hosts.
    const allowed = new Set(['github.com', 'raw.githubusercontent.com', 'ghcr.io', 'ntfy.sh']);
    for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (/\d+\.\d+\.\d+\.\d+|^host$|server-ip/.test(host)) continue; // documentation placeholders like http://SERVER-IP:8989
      assert.ok(allowed.has(host), `${path.relative(root, file)} links to unexpected host ${host}`);
    }
    assert.ok(!/<link[^>]+href="https?:|<img[^>]+src="https?:/i.test(html), `${path.relative(root, file)} loads an external resource`);
  }
});
