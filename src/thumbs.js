import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { q } from './db.js';
import { ffmpeg } from './probe.js';

// One thumbnail per file: a frame ~10% in, scaled to a 360px-wide card image.
export async function ensureThumb(fileRow) {
  if (fileRow.thumb && fs.existsSync(fileRow.thumb)) return fileRow.thumb;
  if (!fs.existsSync(fileRow.path)) return null;
  const out = path.join(cfg.thumbsDir, `${fileRow.id}.jpg`);
  if (fs.existsSync(out)) {
    q.setThumb.run({ thumb: out, id: fileRow.id });
    return out;
  }
  const dur = fileRow.duration || 0;
  const at = dur > 60 ? Math.min(dur * 0.1, 600) : Math.max(dur * 0.15, 1);
  try {
    await ffmpeg([
      '-ss', String(at), '-i', fileRow.path,
      '-frames:v', '1', '-vf', "scale=640:-2,format=yuv420p",
      '-q:v', '2', out
    ], 120000);
  } catch (e) {
    return null;
  }
  if (fs.existsSync(out)) {
    q.setThumb.run({ thumb: out, id: fileRow.id });
    return out;
  }
  return null;
}

export async function generateAllThumbs() {
  const files = q.allFiles.all().filter((f) => !f.hidden);
  let made = 0;
  for (const f of files) {
    if (f.thumb && fs.existsSync(f.thumb)) continue;
    const t = await ensureThumb(f);
    if (t) made++;
    process.stdout.write(`\rthumbnails: ${made} generated  (${files.indexOf(f) + 1}/${files.length})`);
  }
  console.log('');
  return made;
}
