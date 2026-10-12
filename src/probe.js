import { execFile } from 'node:child_process';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 120000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}



// ffprobe prints extradata as a hexdump ("00000000: 0164 0028 ...  .d.(....");
// extract the hex bytes (drop offsets and the ASCII column).
function extradataHex(s) {
  const out = [];
  for (const line of String(s.extradata || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    let body = line.slice(i + 1);
    const j = body.indexOf('  ');
    if (j >= 0) body = body.slice(0, j);
    out.push(body.replace(/[^0-9a-fA-F]/g, ''));
  }
  return out.join('');
}

// MSE codec string for the MediaSource SourceBuffer (fMP4 remux path).
function mseCodecString(s) {
  if (!s || !s.codec_name) return null;
  const c = s.codec_name;
  if (c === 'h264') {
    // avcC extradata bytes 1..3 = profile, compat, level (e.g. 01 64 00 28 -> avc1.640028)
    const hex = extradataHex(s);
    if (hex.length >= 8) return 'avc1.' + hex.slice(2, 8);
    return 'avc1.640028';
  }
  if (c === 'hevc') return 'hvc1.1.6.L153.B0';
  if (c === 'vp9') return 'vp09.00.10.08';
  if (c === 'av1') return 'av01.0.08M.08';
  if (c === 'aac') return 'mp4a.40.2';
  if (c === 'eac3') return 'ec-3';
  if (c === 'ac3') return 'ac-3';
  if (c === 'mp3') return 'mp3';
  if (c === 'opus') return 'opus';
  if (c === 'flac') return 'flac';
  return null;
}

export async function probeVideo(file) {
  const out = await run('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', '-show_data', file
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
    vcodecStr: mseCodecString(v),
    acodecStr: mseCodecString(a),
    subtitles
  };
}

export function ffmpeg(args, timeout = 300000) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout });
}
