// Quality scorecard for generated subtitles. Read-only.
//
//   node tools/subs-audit.mjs                     # all titles, summary
//   node tools/subs-audit.mjs --title Community   # one title
//   node tools/subs-audit.mjs --title Community --episodes   # per-episode rows
//   node tools/subs-audit.mjs --json data/subs-audit.json
//
// Per episode it reports:
//   fallback%  share of cues still using a generic SPEAKER n: label
//   castMiss%  labels that are not in that episode's TMDB cast (should be 0)
//   text%      trigram recall against <file>.en.srt.external-bak when present
//              (a reference, never used for production)
//   short%     cues under 0.8s (fragmentation)
//   tiny%      cues of 3 words or fewer
//   long%      cues over 7s (or more than two 42-character lines)

import fs from 'node:fs';
import path from 'node:path';
import { q } from '../src/db.js';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const titleFilter = (val('--title') || '').toLowerCase();
const showEpisodes = argv.includes('--episodes');
const jsonOut = val('--json');

const TS = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;
const secs = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
const normWords = (s) => s.toLowerCase()
  .replace(/<[^>]*>/g, ' ')
  .replace(/[^a-z0-9' ]+/g, ' ')
  .split(/\s+/).filter(Boolean);

function parseSrt(p) {
  const cues = [];
  let cur = null;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(TS);
    if (m) {
      cur = { start: secs(...m.slice(1, 5)), end: secs(...m.slice(5, 9)), text: [] };
      cues.push(cur);
    } else if (cur && line && !/^\d+$/.test(line)) {
      cur.text.push(line);
    }
  }
  return cues;
}

function trigrams(words) {
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(' '));
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return null;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const castByEpisode = new Map();
const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
const rows = [];

for (const f of files) {
  const title = titleName.get(f.title_id) || '?';
  if (titleFilter && !title.toLowerCase().includes(titleFilter)) continue;
  for (const track of q.subtracksOfFile.all(f.id)) {
    if (track.source === 'external') continue;
    let cues;
    try { cues = parseSrt(track.path); } catch { continue; }
    if (!cues.length) continue;

    const plain = (c) => c.text.join(' ').replace(/^[^:]{1,40}:\s*/, '');
    const words = cues.flatMap((c) => normWords(plain(c)));
    const fallback = cues.filter((c) => /^SPEAKER\s+\d+:/i.test(c.text[0] || '')).length;
    const labels = [...new Set(cues
      .map((c) => (c.text[0] || '').match(/^([^:]{1,40}):/)?.[1])
      .filter(Boolean))];
    const short = cues.filter((c) => c.end - c.start < 0.8).length;
    const tiny = cues.filter((c) => normWords(plain(c)).length <= 3).length;
    const long = cues.filter((c) => c.end - c.start > 7).length;
    const wide = cues.filter((c) =>
      c.text.some((l) => l.length > 42) || c.text.length > 2).length;

    // Labels that cannot appear in this episode's credited cast.
    let castMiss = null;
    if (f.season != null && f.episode != null) {
      const key = `${f.title_id}:${f.season}:${f.episode}`;
      if (!castByEpisode.has(key)) {
        castByEpisode.set(key, new Set(
          q.charactersForEpisode.all(f.title_id, f.season, f.episode)
            .flatMap((c) => [c.display, c.name, ...JSON.parse(c.aliases || '[]')])
            .filter(Boolean).map((s) => s.toLowerCase())
        ));
      }
      const cast = castByEpisode.get(key);
      if (cast.size) {
        const bad = labels.filter((l) =>
          !cast.has(l.toLowerCase()) && !/^SPEAKER \d+$/i.test(l));
        castMiss = bad.length / labels.length;
      }
    }

    let text = null;
    const ref = track.path + '.external-bak';
    if (fs.existsSync(ref)) {
      try {
        const rw = parseSrt(ref).flatMap((c) => normWords(c.text.join(' ')));
        text = overlap(trigrams(words), trigrams(rw));
      } catch { /* ignore */ }
    }

    rows.push({
      title, file: path.basename(f.path), season: f.season, episode: f.episode,
      cues: cues.length, words: words.length, fallbackPct: fallback / cues.length,
      distinctLabels: labels.length, castMissPct: castMiss,
      textRecall: text, shortPct: short / cues.length, tinyPct: tiny / cues.length,
      longPct: long / cues.length, widePct: wide / cues.length
    });
  }
}

const pct = (x) => x == null ? '  —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);
const avg = (arr, k) => {
  const v = arr.map((r) => r[k]).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

if (!rows.length) {
  console.log('No generated tracks matched. Run npm run subs first.');
  process.exit(0);
}

const byTitle = new Map();
for (const r of rows) {
  const t = byTitle.get(r.title) || [];
  t.push(r);
  byTitle.set(r.title, t);
}

console.log(`\n${'title'.padEnd(32)} files  cues   fb%   castMiss  text%  short%  tiny%  long%  wide%`);
for (const [title, list] of [...byTitle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    `${title.slice(0, 32).padEnd(32)} ${String(list.length).padStart(4)} ` +
    `${String(list.reduce((n, r) => n + r.cues, 0)).padStart(6)} ` +
    `${pct(avg(list, 'fallbackPct'))} ${pct(avg(list, 'castMissPct'))}  ` +
    `${pct(avg(list, 'textRecall'))} ${pct(avg(list, 'shortPct'))} ` +
    `${pct(avg(list, 'tinyPct'))} ${pct(avg(list, 'longPct'))} ` +
    `${pct(avg(list, 'widePct'))}`
  );
}

if (showEpisodes) {
  const worst = [...rows].sort((a, b) =>
    (b.fallbackPct + (b.castMissPct || 0)) - (a.fallbackPct + (a.castMissPct || 0)));
  console.log('\nworst episodes:');
  for (const r of worst.slice(0, 15)) {
    const name = `${r.title} ${r.season != null ? `S${r.season}E${r.episode}` : ''}`;
    console.log(`  ${name.slice(0, 40).padEnd(40)} fb ${pct(r.fallbackPct)}  ` +
      `castMiss ${pct(r.castMissPct)}  text ${pct(r.textRecall)}  ` +
      `${r.cues} cues, ${r.distinctLabels} labels`);
  }
}

console.log('\noverall:', JSON.stringify({
  episodes: rows.length,
  cues: rows.reduce((n, r) => n + r.cues, 0),
  fallbackPct: avg(rows, 'fallbackPct'),
  castMissPct: avg(rows, 'castMissPct'),
  textRecall: avg(rows, 'textRecall')
}, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));

if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  console.log(`wrote ${jsonOut}`);
}
