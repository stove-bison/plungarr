// Generates site/docs/settings.html from templates/plungarr.xml and
// .env.example, and copies icon.svg into site/. No dependencies. Run from
// anywhere: paths are resolved relative to this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Unraid template: Name, Target, Default, Description per Config ----
const template = new Map();
// Descriptions may contain ">" (e.g. "Settings > General"), so match to the closing "/>" non-greedily.
for (const m of read('templates/plungarr.xml').matchAll(/<Config\s+(.*?)\/>/g)) {
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
  if (attrs.Type !== 'Variable') continue;
  template.set(attrs.Target, attrs);
}

// ---- .env.example: groups from "# --- title ---" lines, comments become descriptions ----
const groups = [];
let group = { title: 'Connections and cycle', vars: [] };
groups.push(group);
let comment = [];
for (const raw of read('.env.example').split(/\r?\n/)) {
  const line = raw.trim();
  const section = line.match(/^# --- (.+?) ---/);
  if (section) { group = { title: section[1].replace(/\s*\(.*$/, ''), vars: [] }; groups.push(group); comment = []; continue; }
  if (line === '') { comment = []; continue; }
  const kv = line.match(/^(#)?([A-Z][A-Z0-9_]+)=(.*)$/);
  if (kv) {
    const [, commented, key, value] = kv;
    group.vars.push({ key, def: value, optional: !!commented, notes: comment.join(' ') });
    // Commented example blocks share one description; keep it for siblings.
    if (!commented) comment = [];
    continue;
  }
  if (line.startsWith('#')) comment.push(line.replace(/^#\s?/, ''));
}

const sentence = s => s.replace(/\s+/g, ' ').trim();
const rows = [];
for (const g of groups) {
  rows.push(`<h2 id="${esc(g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">${esc(g.title)}</h2>`);
  rows.push('<div class="scroll"><table><thead><tr><th>Setting</th><th>Default</th><th>What it does</th></tr></thead><tbody>');
  for (const v of g.vars) {
    const t = template.get(v.key);
    const def = t?.Default || v.def || (v.optional ? '' : '');
    const desc = t?.Description ? sentence(t.Description) : sentence(v.notes);
    rows.push(`<tr><td><code>${esc(v.key)}</code></td><td>${def ? `<code>${esc(def)}</code>` : '<span class="muted">empty</span>'}</td><td>${esc(desc)}${t?.Name ? ` <span class="muted">Unraid: “${esc(t.Name)}”</span>` : ''}</td></tr>`);
  }
  rows.push('</tbody></table></div>');
}
// Template-only settings (present in the Unraid template but not in .env.example)
const covered = new Set(groups.flatMap(g => g.vars.map(v => v.key)));
const extra = [...template.values()].filter(t => !covered.has(t.Target));
if (extra.length) {
  rows.push('<h2 id="unraid-only">Unraid template only</h2>');
  rows.push('<div class="scroll"><table><thead><tr><th>Setting</th><th>Default</th><th>What it does</th></tr></thead><tbody>');
  for (const t of extra) rows.push(`<tr><td><code>${esc(t.Target)}</code></td><td>${t.Default ? `<code>${esc(t.Default)}</code>` : '<span class="muted">empty</span>'}</td><td>${esc(sentence(t.Description))} <span class="muted">Unraid: “${esc(t.Name)}”</span></td></tr>`);
  rows.push('</tbody></table></div>');
}

const tpl = read('site/docs/settings.template.html');
if (!tpl.includes('<!-- SETTINGS -->')) throw new Error('settings.template.html lacks <!-- SETTINGS --> marker');
fs.writeFileSync(path.join(root, 'site/docs/settings.html'), tpl.replace('<!-- SETTINGS -->', rows.join('\n')));
fs.copyFileSync(path.join(root, 'icon.svg'), path.join(root, 'site/icon.svg'));
console.log(`settings.html: ${groups.reduce((n, g) => n + g.vars.length, 0) + extra.length} settings in ${groups.length + (extra.length ? 1 : 0)} groups`);
