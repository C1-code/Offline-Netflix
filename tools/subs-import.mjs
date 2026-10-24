// Validate the human-authored subtitles that were parked as *.external-bak.
//
//   node tools/subs-import.mjs --title Community            # dry-run report
//   node tools/subs-import.mjs --title Community --json data/subs-import.json
//
// This is the guard that was missing when external .srt files were banned:
// a reference is only usable if it is the same episode (word overlap with our
// ASR transcript) and its timing can be corrected with a per-file offset.
// Nothing is written except the optional JSON report.

import fs from 'node:fs';
import path from 'node:path';
import { q } from '../src/db.js';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const titleFilter = (val('--title') || '').toLowerCase();
const epFilter = (val('--episodes') || '')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const jsonOut = val('--json');
const minOverlap = +(val('--min-overlap') || 0.45);

const TS = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;
const secs = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
const words = (s) => s.toLowerCase()
  .replace(/<[^>]*>/g, ' ')
  .replace(/[^a-z0-9' ]+/g, ' ')
  .split(/\s+/).filter(Boolean);

function parseSrt(p) {
  const cues = [];
  let cur = null;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim().replace(/^\ufeff/, '');
    const m = line.match(TS);
    if (m) {
      cur = { start: secs(...m.slice(1, 5)), end: secs(...m.slice(5, 9)), text: [] };
      cues.push(cur);
    } else if (cur && line && !/^\d+$/.test(line)) {
      cur.text.push(line);
    }
  }
  return cues
    .map((c) => ({ ...c, text: c.text.join('\n').replace(/<[^>]*>/g, '').trim() }))
    .filter((c) => c.text && c.end > c.start);
}

const trigrams = (text) => {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]);
  return out;
};
const inter = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
const rows = [];

for (const f of files) {
  const title = titleName.get(f.title_id) || '?';
  if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
  const ep = f.season != null && f.episode != null
    ? `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`
    : '';
  if (epFilter.length && !epFilter.includes(ep)) continue;

  const base = f.path.replace(/\.[^.]+$/, '');
  const refPath = base + '.en.srt.external-bak';
  const asrPath = base + '.en.srt';
  if (!fs.existsSync(refPath)) continue;

  const row = { title, episode: ep, file: path.basename(f.path), ref: path.basename(refPath) };
  if (!fs.existsSync(asrPath)) {
    rows.push({ ...row, status: 'no-asr', usable: false });
    continue;
  }
  try {
    const ref = parseSrt(refPath);
    const asr = parseSrt(asrPath);
    if (!ref.length || !asr.length) {
      rows.push({ ...row, status: 'empty', usable: false });
      continue;
    }
    // Same episode? Compare the reference against the whole ASR transcript.
    const asrTri = trigrams(asr.map((c) => c.text).join(' '));
    const refTri = trigrams(ref.map((c) => c.text).join(' '));
    const overlapRef = inter(refTri, asrTri);
    const overlapAsr = inter(asrTri, refTri);

    // Offset: best-overlapping ASR cue within a generous window (different
    // cuts/recaps can be a minute apart).
    const asrByCue = asr.map((c) => ({ c, tri: trigrams(c.text) }));
    const offsets = [];
    for (const c of ref) {
      let best = null, bestScore = 0;
      const cTri = trigrams(c.text);
      for (const a of asrByCue) {
        if (Math.abs(a.c.start - c.start) > 120) continue;
        const s = inter(cTri, a.tri);
        if (s > bestScore) { bestScore = s; best = a.c; }
      }
      if (best && bestScore >= 0.5) offsets.push(best.start - c.start);
    }
    const offset = median(offsets);
    const spread = offsets.length
      ? Math.sqrt(offsets.reduce((n, x) => n + (x - offset) ** 2, 0) / offsets.length)
      : null;
    const matched = offsets.length / ref.length;

    // Whole-file overlap is too forgiving: a different episode still shares
    // ~50% of its trigrams. Check the start, middle and end independently —
    // a wrong-episode reference fails the start even when the rest is generic.
    const duration = Math.max(...ref.map((c) => c.end), ...asr.map((c) => c.end));
    const windows = [];
    for (const frac of [0.03, 0.5, 0.9]) {
      const lo = duration * frac;
      const hi = lo + 120;
      const refWin = ref.filter((c) => c.start >= lo && c.start < hi);
      if (refWin.length < 5) continue;
      let hit = 0;
      for (const c of refWin) {
        const target = c.start + (offset || 0);
        let best = 0;
        const cTri = trigrams(c.text);
        for (const a of asrByCue) {
          if (Math.abs(a.c.start - target) > 4) continue;
          best = Math.max(best, inter(cTri, a.tri));
        }
        if (best >= 0.35) hit++;
      }
      windows.push(hit / refWin.length);
    }
    const goodWindows = windows.filter((w) => w >= 0.35).length;
    const windowCheck = windows.length ? goodWindows >= Math.min(2, windows.length) : false;
    const usable = overlapRef >= minOverlap && offset != null && matched >= 0.5 && windowCheck;
    rows.push({
      ...row, status: usable ? 'ok' : 'rejected', usable,
      refCues: ref.length, asrCues: asr.length,
      overlapRef: +overlapRef.toFixed(3), overlapAsr: +overlapAsr.toFixed(3),
      matched: +matched.toFixed(3), offset: offset == null ? null : +offset.toFixed(2),
      spread: spread == null ? null : +spread.toFixed(2),
      windows: windows.map((w) => +w.toFixed(2)),
      chars: ref.reduce((n, c) => n + c.text.length, 0)
    });
  } catch (e) {
    rows.push({ ...row, status: `error: ${e.message}`, usable: false });
  }
}

const ok = rows.filter((r) => r.usable);
console.log(`\nreferences checked: ${rows.length}  usable: ${ok.length}  rejected: ${rows.length - ok.length}`);
const byTitle = new Map();
for (const r of rows) {
  const t = byTitle.get(r.title) || { total: 0, ok: 0 };
  t.total++;
  if (r.usable) t.ok++;
  byTitle.set(r.title, t);
}
console.log('\ntitle                            refs   usable');
for (const [t, v] of [...byTitle.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${t.slice(0, 32).padEnd(32)} ${String(v.total).padStart(4)} ${String(v.ok).padStart(8)}`);
}
console.log('\nepisode   status    overlap  matched  offset  spread  cues');
const shown = rows.filter((r) => r.status !== 'no-asr').slice(0, 30);
for (const r of shown) {
  console.log(
    `${(r.episode || r.file).slice(0, 9).padEnd(9)} ${String(r.status).padEnd(9)} ` +
    `${r.overlapRef == null ? '  —  ' : (r.overlapRef * 100).toFixed(0).padStart(5) + '%'} ` +
    `${r.matched == null ? '  —  ' : (r.matched * 100).toFixed(0).padStart(6) + '%'} ` +
    `${r.offset == null ? '  —  ' : String(r.offset).padStart(6)} ` +
    `${r.spread == null ? '  —  ' : String(r.spread).padStart(6)} ` +
    `${r.refCues ?? ''}`
  );
}
const rejected = rows.filter((r) => !r.usable && r.status !== 'no-asr');
if (rejected.length) {
  console.log('\nrejected:');
  for (const r of rejected.slice(0, 20)) {
    console.log(`  ${(r.episode || r.file).slice(0, 14)}  ${r.status}  ` +
      `overlap ${r.overlapRef ?? '—'}  matched ${r.matched ?? '—'}`);
  }
}

if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  console.log(`\nwrote ${jsonOut}`);
}
