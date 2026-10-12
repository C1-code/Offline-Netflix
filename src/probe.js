import { execFile } from 'node:child_process';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 120000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

export async function probeVideo(file) {
  const out = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', file
  ]);
  const j = JSON.parse(out);
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg') || {};
  const a = j.streams?.find((s) => s.codec_type === 'audio') || {};
  const subtitles = (j.streams || [])
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      lang: s.tags?.language || null,
      title: s.tags?.title || null
    }));
  return {
    duration: parseFloat(j.format?.duration) || null,
    width: v.width || null,
    height: v.height || null,
    vcodec: v.codec_name || null,
    acodec: a.codec_name || null,
    subtitles
  };
}

export function ffmpeg(args, timeout = 300000) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout });
}
