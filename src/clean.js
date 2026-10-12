// Filename / folder-name cleaning and media-type parsing.

export const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg', '.webm']);
export const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub']);

const NOISE_TOKENS = new Set([
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'sd',
  'imax', 'extended', 'remastered', 'uncut', 'unrated', 'hdr', 'hdr10', 'hdr10+', 'dv', 'sdr',
  'web-dl', 'webdl', 'webrip', 'web', 'bluray', 'blu-ray', 'bdrip', 'brrip', 'bd', 'br',
  'hdts', 'hd-ts', 'hdcam', 'telesync', 'ts', 'tc', 'cam', 'screener', 'dvdrip', 'dvdscr',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'vp9', 'av1',
  'aac', 'aac2', 'aac20', 'aac5', 'aac51', 'ac3', 'eac3', 'eac351',
  'dd', 'dd2', 'dd20', 'dd5', 'dd51', 'ddp', 'ddp2', 'ddp20', 'ddp5', 'ddp51', 'ddpa51',
  'dts', 'dtshd', 'dtsma', 'truehd', 'atmos', 'flac', 'opus',
  '51', '71', '20', '61', '10', '10bit', '8bit', 'dual-audio', 'dualaudio', 'multi',
  'fs64', '553mb', 'v3', 'v2', 'v1', 'proper', 'repack', 'linework',
  'lineaudio', 'wa', 'amzn', 'dsnp', 'nf', 'atvp', 'hmax', 'pmtp', 'hulu',
  'yify', 'yts', 'ytsmx', 'ytsam', 'ytslt', 'ytsbz', 'eztv', 'eztvre', 'rarbg', 'tgx',
  'galaxyrg', 'galaxyrg265', 'mixed', 'cakes', 'edith', 'vyndros', 'bone', 'splice', 'joy',
  'kogi', 'exploit', 'flux', 'onehack', 'neonoir', 'hd', 'xclusive', 'other', 'sample',
  'dl',
  'silence', 'nfo', 'poster', 'cover', 'screens'
]);

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
const NOISE_NORM = new Set([...NOISE_TOKENS].map(norm));

const SITE_REGEX = /www\.|yts\.?m?[txs]?\.?\w*|eztv\.\w+|uindex\.org|torrentgalaxy|tgx|xclusive|uindex|onehack/i;

export function titleCase(s) {
  const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'to', 'at', 'for', 'nor', 'but', 'vs', 'v', 'by']);
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      if (/^(?:[IVX]+|MCU|TV|AI|US|UK)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// Strip all release noise from a name, returning a clean human title (keeps bare year).
export function cleanName(raw) {
  let s = String(raw || '');
  s = s.replace(/_/g, ' ');
  s = s.replace(/\[(.*?)\]/g, ' ');                 // [1080p] [BluRay] [YTS.MX]
  s = s.replace(/\(([^)]*)\)/g, (m, inner) => (/\b(?:19|20)\d{2}\b/.test(inner) ? ` ${inner} ` : ' '));
  s = s.replace(/\bline\s+audio\b/gi, ' ');
  s = s.replace(/\bwww\.[a-z0-9.\-]+\.[a-z]{2,6}\b/gi, ' ');
  s = s.replace(/\b(?:torrent\s+)?downloaded\s+from\b.*$/i, ' ');
  s = s.replace(/\b(?:upcoming\s+)?releases?\s+by\b.*$/i, ' ');
  // audio codec + channel pairs while punctuation still intact ("DDP5.1", "AAC 2.0", "DDP5 1")
  s = s.replace(/\b(ddp?|dd\+|aac\d?|ac3|eac3?|dts(?:-?hd)?|truehd|atmos|flac|opus)[\s._]?\d[\s._]?\d\b/gi, ' ');
  s = s.replace(/\b\d[.\s_-]\d\b/g, ' ');        // standalone channel notation 5.1 / 2.0 / 7.1
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/(\w)-(\w)/g, '$1 - $2');
  s = s.replace(/[()]/g, ' ');                      // leftover unmatched parens

  const kept = [];
  for (const t of s.split(/\s+/).filter(Boolean)) {
    const tl = norm(t);
    if (NOISE_NORM.has(tl)) continue;
    if (SITE_REGEX.test(t)) continue;
    if (/^s\d{1,2}$/i.test(t)) continue;            // stray "S01"
    kept.push(t);
  }
  s = kept.join(' ');
  s = s.replace(/[\s\-._]+$/g, '').replace(/^-/, '').trim();
  return s;
}

export function extractYear(name) {
  const m = String(name || '').match(/\(?\b((?:19|20)\d{2})\b\)?/g);
  if (!m) return null;
  return parseInt(m[m.length - 1].match(/\d{4}/)[0], 10);
}

const TV_PATTERNS = [
  /[. _\-\[]S(\d{1,2})[\s._-]?E(\d{1,3})[\].\s._-]/i,          // S01E04 / S01.E04 / S01-E04
  /(?:^|[^0-9])S(\d{1,2})E(\d{1,3})(?!\d)/i,                   // looser fallback
  /\b(\d{1,2})x(\d{1,3})\b/i,                                  // 1x04
  /\bseason[. _-]?(\d{1,2})\b.*\bepisode[. _-]?(\d{1,3})\b/i,  // Season 1 Episode 4
];

export function parseEpisodeMarker(name) {
  for (const re of TV_PATTERNS) {
    const m = String(name || '').match(re);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), index: m.index, match: m[0] };
  }
  return null;
}

export function looksLikeSeasonFolder(name) {
  return /(?:^|\W)seasons?[. _-]?\d{1,2}(?:\W|$)/i.test(String(name || ''));
}

export function seasonNumberFromFolder(name) {
  const m = String(name || '').match(/seasons?[. _-]?(\d{1,2})/i);
  return m ? parseInt(m[1], 10) : null;
}

export function looksLikeExtrasFolder(name) {
  return /featurette|extras|specials|bonus|behind.?the.?scene|deleted.?scene/i.test(String(name || ''));
}

export function looksLikeJunkFile(name) {
  if (/\.(txt|nfo|url|jpg|jpeg|png|db|part|!ut|torrent|nzb)$/i.test(name)) return true;
  if (/^(www\.|\[tgx\]|torrent download|new upcoming)/i.test(name)) return true;
  return false;
}

const tokenSet = (s) => new Set(String(s || '').toLowerCase().split(/\s+/).filter(Boolean));

// Guess an episode's title from the text after the SxxEyy marker.
export function episodeTitleGuess(filename, marker) {
  if (!marker) return null;
  const noExt = String(filename).replace(/\.[^.]+$/, '');
  const after = noExt.slice(marker.index + marker.match.length);
  const beforeNoise = after.split(
    /(?=(?:2160p|1080p|720p|4k|web|web-|webdl|webrip|bluray|br-|bd-|hdts|telesync|cam|x26|x64|h26|hevc|aac|ddp|eac3|\[|yts|eztv|mixed|cakes|edith|vyndros|bone|splice|fs64|remastered|imax|flux))/i
  )[0];
  const t = cleanName(beforeNoise);
  if (!t || /^(?:episode|ep)\s*\d+$/i.test(t) || /^\d+$/.test(t)) return null;
  return titleCase(t);
}

// Show-name resolution: collect every ancestor folder that plausibly names the
// show (season folders count when a show prefix remains, e.g. "Loki - Season 2"),
// then take the SHALLOWEST match so release-style subfolders lose to the real
// show folder ("Star Wars Andor ...FLUX" loses to "Andor").
function resolveShowName(relParts, preTokens) {
  let fallback = null;
  const matches = [];
  for (let i = relParts.length - 1; i >= 0; i--) {
    const part = relParts[i];
    if (looksLikeExtrasFolder(part)) continue;
    const isSeason = looksLikeSeasonFolder(part);
    const rest = isSeason ? part.replace(/(^|[\s._-]*)(?:the\s+)?seasons?[\s._-]*\d{1,2}/i, ' ') : part;
    let cleaned = cleanName(rest);
    if (!cleaned || cleaned.length < 2) {
      if (!fallback && !isSeason) fallback = null;
      continue;
    }
    cleaned = cleaned.replace(/\s+S\d{1,2}$/i, '').trim();
    if (!cleaned) continue;
    if (!fallback) fallback = { name: cleaned, year: extractYear(part) };
    const toks = tokenSet(cleaned);
    for (const t of toks) {
      if (preTokens.has(t) && t.length >= 3) { matches.push({ name: cleaned, year: extractYear(part), i }); break; }
    }
  }
  if (matches.length) {
    matches.sort((a, b) => a.i - b.i);              // shallowest first
    return matches[0];
  }
  return fallback;
}

// Full parse of a video file. relParts = folder names between media root and
// the file (exclusive), in order; filename is the video file's name.
export function parseMediaPath(relParts, filename) {
  if (looksLikeJunkFile(filename)) return { kind: 'junk' };

  const marker = parseEpisodeMarker(filename);
  const inExtras = looksLikeExtrasFolder(relParts.join('/'));
  if (marker && !inExtras) {
    const pre = String(filename).slice(0, marker.index);
    const preTokens = tokenSet(cleanName(pre) + ' ' + cleanName(filename.replace(/\.[^.]+$/, '')));
    const resolved = resolveShowName(relParts, preTokens);
    let showName, showYear;
    if (resolved) {
      showName = resolved.name;
      showYear = resolved.year;
    } else {
      showName = cleanName(pre) || cleanName(String(filename).replace(/\.[^.]+$/, ''));
      showYear = extractYear(filename);
    }
    showName = showName.replace(/\s*S\d{1,2}\s*$/i, '').trim();
    showName = showName.replace(/\s+\(?((?:19|20)\d{2})\)?$/, '').trim();
    // Season: trust the SxxEyy marker; folder only overrides when the marker
    // isn't a special (S00) episode.
    let season = marker.season;
    if (season !== 0) {
      for (let i = relParts.length - 1; i >= 0; i--) {
        const n = seasonNumberFromFolder(relParts[i]);
        if (n != null) { season = n; break; }
      }
    }
    return {
      kind: 'episode',
      showName: titleCase(showName),
      showYear,
      season,
      episode: marker.episode,
      epNameGuess: episodeTitleGuess(filename, marker)
    };
  }

  if (inExtras) return { kind: 'extra' };

  const fileClean = cleanName(filename.replace(/\.[^.]+$/, ''));
  let name, year;
  if (fileClean && fileClean.length >= 2) {
    name = fileClean;
    year = extractYear(filename) ?? extractYear(relParts.join(' '));
  } else {
    name = cleanName(relParts[relParts.length - 1] || 'Unknown');
    year = extractYear(relParts[relParts.length - 1] || '');
  }
  return { kind: 'movie', movieName: titleCase(name) || 'Unknown', year };
}

// Similarity for external-sub matching (0..1)
export function nameSimilarity(a, b) {
  const n = (s) => s.toLowerCase().replace(/[._\-[\]()\s]+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  const A = n(a), B = n(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const at = new Set(A.split(' ')), bt = new Set(B.split(' '));
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  return (2 * inter) / (at.size + bt.size);
}

export function isVideoFile(name) {
  return VIDEO_EXT.has(String(name || '').toLowerCase().match(/\.[^.]+$/)?.[0]);
}

export function isSubFile(name) {
  return SUB_EXT.has(String(name || '').toLowerCase().match(/\.[^.]+$/)?.[0]);
}
