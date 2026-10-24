// Build Netflix-style subtitles from validated human references.
//
//   node tools/subs-ref.mjs --title Community --dry-run
//   node tools/subs-ref.mjs --title Community                 # standard track
//   node tools/subs-ref.mjs --title Community --sdh           # + SDH track
//   node tools/subs-ref.mjs --title Community --episodes S01E01,S01E03
//
// Uses data/subs-import.json (tools/subs-import.mjs) to decide which
// references are trustworthy. Rejected references are skipped; their existing
// AI track is left alone until the ASR fallback pass rebuilds them.
//
// Standard track: human text, aligned timings, no speaker names, Netflix cue
// rules. SDH track: same cues, uppercase speaker IDs only at a change and only
// when the naming evidence is strong.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import cfg from '../src/config.js';
import { db, q } from '../src/db.js';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const titleFilter = (val('--title') || '').toLowerCase();
const epFilter = (val('--episodes') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const withSdh = argv.includes('--sdh');
const dryRun = argv.includes('--dry-run');
const limit = +(val('--limit') || 0) || Infinity;
const importPath = val('--import') || 'data/subs-import.json';

if (!fs.existsSync(importPath)) {
  console.error(`missing ${importPath} — run: node tools/subs-import.mjs --title "<show>" --json ${importPath}`);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(importPath, 'utf8'));
const usable = new Map();
for (const r of report) {
  if (!r.usable) continue;
  usable.set(`${r.title}|${r.episode}`, r);
}

const errorLog = 'data/subs-ref-errors.log';
const stamp = () => new Date().toISOString();
const fail = (file, msg) => {
  try { fs.appendFileSync(errorLog, `${stamp()}\t${file}\t${String(msg).replace(/\s+/g, ' ').slice(0, 1200)}\n`); } catch {}
};

const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
const todo = [];
for (const f of files) {
  const title = titleName.get(f.title_id) || '?';
  if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
  if (f.season == null || f.episode == null) continue;
  const ep = `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`;
  if (epFilter.length && !epFilter.includes(ep)) continue;
  const base = f.path.replace(/\.[^.]+$/, '');
  const ref = base + '.en.srt.external-bak';
  if (!fs.existsSync(ref)) continue;
  if (!usable.has(`${title}|${ep}`)) continue;
  todo.push({ f, title, ep, base, ref, meta: usable.get(`${title}|${ep}`) });
}

console.log(`reference episodes in scope: ${todo.length}`);
if (dryRun) {
  for (const t of todo.slice(0, 30)) {
    console.log(`  ${t.title} ${t.ep}  offset ${t.meta.offset >= 0 ? '+' : ''}${t.meta.offset}s  ${t.meta.refCues} cues`);
  }
  process.exit(0);
}

const updateTrack = db.prepare(`UPDATE subtracks SET label=?, source=? WHERE file_id=? AND path=?`);
const setStatus = db.prepare(`UPDATE files SET subtitle_status='done' WHERE id=?`);

function castFor(f) {
  let rows = q.charactersForEpisode.all(f.title_id, f.season, f.episode);
  if (!rows.length) rows = q.charactersForTitle.all(f.title_id);
  return JSON.stringify(rows.map((r) => ({
    name: r.name, display: r.display || r.name,
    aliases: JSON.parse(r.aliases || '[]'), regular: !!r.regular
  })));
}

let ok = 0, failed = 0, skipped = 0;
for (const t of todo) {
  if (ok + failed >= limit) break;
  const { f, base, ref } = t;
  const asr = base + '.en.srt';
  const out = base + '.en.srt';
  const sdhOut = base + '.en.sdh.srt';
  if (!fs.existsSync(asr)) { skipped++; console.log(`skip (no ASR to guide offsets): ${t.ep}`); continue; }

  const context = `${t.title} ${t.ep}` +
    (f.ep_name ? ` — ${f.ep_name}` : '') +
    (f.ep_overview ? `. ${String(f.ep_overview).replace(/\s+/g, ' ').slice(0, 400)}` : '');
  // Use the offset validated by subs-import (start/middle/end windows agree);
  // the per-cue local-offset estimate was too easily fooled by a weak ASR.
  const args = [
    path.join(cfg.root, 'tools', 'subs_from_ref.py'),
    f.path, ref,
    '--offset', String(t.meta.offset || 0),
    '--out', out
  ];
  if (withSdh) {
    args.push('--sdh-out', sdhOut, '--characters', castFor(f),
      '--context', context,
      '--ollama-host', cfg.ollamaHost || 'http://127.0.0.1:11434',
      '--naming-model', cfg.subsNamingModel || 'qwen3:4b',
      '--hf-token', cfg.whisperHfToken || '');
  }

  const t0 = Date.now();
  const r = spawnSync(cfg.venvPython, args, {
    cwd: cfg.root,
    timeout: 15 * 60 * 1000,
    encoding: 'utf8',
    env: { ...process.env }
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status !== 0 || !fs.existsSync(out)) {
    failed++;
    const msg = (r.stderr || r.stdout || `exit ${r.status}`).split('\n').filter(Boolean).slice(-3).join(' | ');
    console.log(`FAIL ${t.title} ${t.ep} (${secs}s): ${msg.slice(0, 160)}`);
    fail(f.path, msg);
    continue;
  }

  updateTrack.run('English', 'reference', f.id, out);
  q.addSubtrack.run({ file_id: f.id, path: out, lang: 'en', label: 'English', source: 'reference', format: 'srt' });
  if (withSdh && fs.existsSync(sdhOut)) {
    updateTrack.run('English (SDH)', 'reference', f.id, sdhOut);
    q.addSubtrack.run({ file_id: f.id, path: sdhOut, lang: 'en', label: 'English (SDH)', source: 'reference', format: 'srt' });
  }
  setStatus.run(f.id);
  ok++;
  console.log(`ok ${t.title} ${t.ep} (${secs}s)` + (withSdh ? ' + SDH' : ''));
}

console.log(`\ndone: ${ok} built, ${failed} failed, ${skipped} skipped`);
if (failed) console.log(`failure details: ${errorLog}`);
