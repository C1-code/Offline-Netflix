// Fill omissions in reference-built subtitle tracks from the audio.
//
//   node tools/subs-gapfill.mjs --title Community --dry-run
//   node tools/subs-gapfill.mjs --title Community
//   node tools/subs-gapfill.mjs --title Community --episodes S01E01,S01E16
//
// Only files whose default track is `English / reference` are processed. Each
// gap >1.5s is transcribed from the audio and the missing lines are inserted;
// existing cues are untouched. If an SDH track exists it gets the same lines,
// unlabeled (no speaker evidence for an inserted line).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import cfg from '../src/config.js';
import { q } from '../src/db.js';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const titleFilter = (val('--title') || '').toLowerCase();
const epFilter = (val('--episodes') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const dryRun = argv.includes('--dry-run');
const limit = +(val('--limit') || 0) || Infinity;

const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
const todo = [];
for (const f of files) {
  const title = titleName.get(f.title_id) || '?';
  if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
  const ep = f.season != null && f.episode != null
    ? `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}` : '';
  if (epFilter.length && !epFilter.includes(ep)) continue;
  const tracks = q.subtracksOfFile.all(f.id);
  const std = tracks.find((t) => t.label === 'English' && t.source === 'reference');
  if (!std || !fs.existsSync(std.path)) continue;
  const sdh = tracks.find((t) => t.label === 'English (SDH)' && fs.existsSync(t.path));
  todo.push({ f, title, ep, std, sdh });
}

console.log(`reference tracks in scope: ${todo.length}`);
if (!todo.length) process.exit(0);

const errorLog = 'data/subs-gapfill-errors.log';
const fail = (file, msg) => {
  try {
    fs.appendFileSync(errorLog,
      `${new Date().toISOString()}\t${file}\t${String(msg).replace(/\s+/g, ' ').slice(0, 1200)}\n`);
  } catch {}
};

let ok = 0, failed = 0;
for (const t of todo) {
  if (ok + failed >= limit) break;
  const args = [
    path.join(cfg.root, 'tools', 'subs_gapfill.py'),
    t.f.path, t.std.path
  ];
  if (t.sdh) args.push('--sdh', t.sdh.path);
  if (dryRun) args.push('--dry-run');

  const t0 = Date.now();
  const r = spawnSync(cfg.venvPython, args, {
    cwd: cfg.root, timeout: 10 * 60 * 1000, encoding: 'utf8', env: { ...process.env }
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status !== 0) {
    failed++;
    const msg = (r.stderr || r.stdout || `exit ${r.status}`).split('\n').filter(Boolean).slice(-3).join(' | ');
    console.log(`FAIL ${t.title} ${t.ep} (${secs}s): ${msg.slice(0, 160)}`);
    fail(t.f.path, msg);
    continue;
  }
  ok++;
  const summary = (r.stderr || '').split('\n').filter((l) => l.includes('[gapfill]')).pop() || '';
  console.log(`${dryRun ? 'dry' : 'ok'} ${t.title} ${t.ep} (${secs}s) ${summary}`);
}

console.log(`\ndone: ${ok} processed, ${failed} failed`);
if (failed) console.log(`failure details: ${errorLog}`);
