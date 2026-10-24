#!/usr/bin/env python3
"""Build Netflix-style subtitles from a human-authored reference .srt.

The reference text is kept verbatim (it is better than ASR); only its timing is
corrected by force-aligning the words to the actual audio. Cues are then
re-flowed to the Netflix rules: 42 characters per line, max two lines, reading
speed ~20 CPS, 0.9-7 s durations, 2-frame gaps, dashes for two-speaker cues.

Usage:
  subs_from_ref.py <video> <reference.srt> --out <standard.srt>
      [--offset seconds] [--sdh-out <sdh.srt> --hf-token ... --characters json
       --context "Community S1E3" --ollama-host ... --naming-model ...]

Reuses transcribe.py's audio extraction, Wav2Vec2 aligner, diarization and
speaker naming so there is one implementation of each.
"""

import argparse
import json
import os
import re
import sys
import textwrap
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe as T  # noqa: E402  (sets up CUDA libs on import)

TS = re.compile(r'^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> '
                r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})')
MAX_LINE = 42
MAX_DUR = 7.0
MIN_DUR = 0.9
MAX_CPS = 20.0
GAP = 2 / 24  # two frames at 24 fps


def secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def parse_srt(path):
    cues, cur = [], None
    for raw in open(path, encoding='utf-8', errors='ignore'):
        line = raw.strip().replace('\ufeff', '')
        m = TS.match(line)
        if m:
            g = m.groups()
            cur = {'start': secs(*g[:4]), 'end': secs(*g[4:]), 'lines': []}
            cues.append(cur)
        elif cur is not None and line and not line.isdigit():
            text = re.sub(r'<[^>]+>', '', line)
            text = text.replace('\u200b', '').strip()
            if text:
                cur['lines'].append(text)
    return [c for c in cues if c['lines'] and c['end'] > c['start']]


def cue_text(cue):
    """Text used for alignment: dashes removed, lines joined."""
    return ' '.join(re.sub(r'^-\s*', '', l) for l in cue['lines']).strip()


# OpenSubtitles-style ad/credit cues are not dialogue and must never reach the
# subtitle track (the E03 reference opens with one).
AD_CUE = re.compile(
    r'(opensubtitles|advertise your product|subscene|addic7ed|'
    r'www\.|https?://|support us and become vip)', re.I)


def clean_reference(cues):
    out = []
    for c in cues:
        text = cue_text(c)
        if not text or AD_CUE.search(text):
            continue
        if len(text) < 2:
            continue
        out.append(c)
    return out


def _words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def _trigrams(text):
    w = _words(text)
    return {tuple(w[i:i + 3]) for i in range(len(w) - 2)}


def _score(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a)


def estimate_offsets(cues, asr_cues):
    """Per-cue offset from reference time to this cut's time.

    Different releases insert recaps/credits or trim scenes, so the shift is
    not constant (S01E04 is -25 s at the start but drifts). Matching each cue's
    text against the ASR transcript gives a local offset; gaps are filled by
    interpolation.
    """
    def strip_label(text):
        return re.sub(r'^[A-Z][^:\n]{0,30}:\s*', '', text)

    asr = [{'start': c['start'],
            'tri': _trigrams(' '.join(strip_label(l) for l in c['lines']))}
           for c in asr_cues]
    raw = []
    for c in cues:
        tri = _trigrams(' '.join(c['lines']))
        best, best_score = None, 0.0
        for a in asr:
            if abs(a['start'] - c['start']) > 150:
                continue
            s = _score(tri, a['tri'])
            if s > best_score:
                best, best_score = a, s
        raw.append((best['start'] - c['start']) if best and best_score >= 0.4 else None)

    # Interpolate missing offsets between the nearest known values.
    known = [i for i, x in enumerate(raw) if x is not None]
    if not known:
        return [0.0] * len(cues)
    out = list(raw)
    for i in range(0, known[0]):
        out[i] = raw[known[0]]
    for i in range(known[-1] + 1, len(out)):
        out[i] = raw[known[-1]]
    for a, b in zip(known, known[1:]):
        if b == a + 1:
            continue
        step = (raw[b] - raw[a]) / (b - a)
        for k in range(a + 1, b):
            out[k] = raw[a] + step * (k - a)
    return [float(x) for x in out]


def apply_offsets(cues, offsets):
    for c, off in zip(cues, offsets):
        c['start'] = max(0.0, c['start'] + off)
        c['end'] = max(c['start'] + 0.2, c['end'] + off)
        c['local_offset'] = off


def align(cues, wav):
    """Attach a_start/a_end to every cue from CTC alignment (fallback: none)."""
    segs = [{'text': cue_text(c), 'start': c['start'], 'end': c['end']} for c in cues]
    words = T.align_words(wav, segs)
    if not words:
        return False
    by_seg = {}
    for w in words:
        by_seg.setdefault(w['seg'], []).append(w)
    ok = 0
    for i, cue in enumerate(cues):
        ws = by_seg.get(i) or []
        if ws:
            start, end = min(w['start'] for w in ws), max(w['end'] for w in ws)
            if end - start >= 0.15:
                cue['a_start'], cue['a_end'] = start, end
                ok += 1
    return ok >= max(5, int(len(cues) * 0.5))


def wrap_line(line, width):
    marker = ''
    if line.startswith('- '):
        marker, line = '- ', line[2:]
    body = textwrap.wrap(line, width=width - len(marker),
                         break_long_words=False, break_on_hyphens=False) or ['']
    out = [marker + body[0]]
    out += body[1:]
    return out


def ref_lines(cue):
    """Reference lines re-wrapped to Netflix width, dashes preserved."""
    lines = []
    for line in cue['lines']:
        lines.extend(wrap_line(line, MAX_LINE))
    return lines


def build_standard(cues):
    """Reference cues -> Netflix-shaped cues (no speaker names)."""
    out = []
    for cue in cues:
        start = cue.get('a_start', cue['start'])
        end = cue.get('a_end', cue['end'])
        if end <= start:
            end = start + MIN_DUR
        lines = ref_lines(cue)
        if not lines:
            continue
        # Max two lines per cue; a human cue with more becomes several cues.
        chunks = [lines[i:i + 2] for i in range(0, len(lines), 2)]
        total_chars = max(1, sum(len(l) for l in lines))
        cursor = start
        for n, chunk in enumerate(chunks):
            chars = sum(len(l) for l in chunk)
            if n == len(chunks) - 1:
                chunk_end = end
            else:
                chunk_end = cursor + (end - start) * chars / total_chars
            out.append({'start': cursor, 'end': max(cursor + 0.4, chunk_end),
                        'lines': chunk})
            cursor = chunk_end

    # Merge a sub-second cue into its neighbour when the result still fits two
    # lines. Human references sometimes cut a sentence across cues so tightly
    # that the 0.9 s minimum cannot be met without shifting the next cue.
    merged = []
    for c in out:
        prev = merged[-1] if merged else None
        if (prev and (prev['end'] - prev['start']) < 0.85
                and c['start'] - prev['end'] < 1.0
                and c['end'] - prev['start'] <= MAX_DUR
                and not any(l.startswith('- ') for l in prev['lines'] + c['lines'])):
            text = ' '.join(prev['lines'] + c['lines'])
            lines = wrap_line(text, MAX_LINE)
            if len(lines) <= 2:
                prev['lines'] = lines
                prev['end'] = c['end']
                continue
        merged.append(c)
    out = merged

    # Reading speed and duration, then gaps (never overlap the next cue).
    for i, c in enumerate(out):
        chars = sum(len(l) for l in c['lines'])
        want = min(MAX_DUR, max(MIN_DUR, chars / MAX_CPS))
        if c['end'] - c['start'] < want:
            c['end'] = c['start'] + want
        if c['end'] - c['start'] > MAX_DUR:
            c['end'] = c['start'] + MAX_DUR
        if i + 1 < len(out):
            c['end'] = min(c['end'], out[i + 1]['start'] - GAP)
        if c['end'] <= c['start'] + 0.3:
            c['end'] = c['start'] + 0.3
    # Re-check CPS after gap trimming; a cue that is now too fast is shortened
    # by dropping words is worse than a slightly fast cue, so leave it.
    return [c for c in out if c['lines'] and c['end'] > c['start']]


def srt_ts(seconds):
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def write_srt(cues, path):
    # Atomic: a killed build must never leave a half-written subtitle.
    tmp = path + '.part'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        for n, c in enumerate(cues, 1):
            f.write(f"{n}\n{srt_ts(c['start'])} --> {srt_ts(c['end'])}\n")
            f.write('\n'.join(c['lines']) + '\n\n')
    os.replace(tmp, path)


def build_sdh(standard, turns, cast, args):
    """Same cues with speaker IDs only at a change, and only when confident."""
    if not turns:
        return None
    cue_rows = []
    for c in standard:
        text = ' '.join(re.sub(r'^-\s*', '', l) for l in c['lines'])
        cue_rows.append({'start': c['start'], 'end': c['end'],
                         'speaker': T.speaker_for_window(c['start'], c['end'], turns),
                         'text': text, 'multi': sum(1 for l in c['lines'] if l.startswith('- ')) > 1})

    speaker_texts = {}
    for c in cue_rows:
        if c['speaker']:
            speaker_texts[c['speaker']] = (
                speaker_texts.get(c['speaker'], '') + ' ' + c['text']).strip()

    names = {}
    if cast:
        ns = SimpleNamespace(context=args.context or '', ollama_host=args.ollama_host,
                             naming_model=args.naming_model)
        names = T.name_speakers(cue_rows, ns, cast, speaker_texts)
    print(f'[subs_from_ref] SDH speaker names: {json.dumps(names)}', file=sys.stderr)

    out, prev, prev_end = [], None, -99.0
    for cue, row in zip(standard, cue_rows):
        lines = list(cue['lines'])
        label = names.get(row['speaker']) if row['speaker'] else None
        if label and not row['multi'] and (row['speaker'] != prev or cue['start'] - prev_end > 2.0):
            first = f'{label.upper()}: {lines[0]}'
            wrapped = wrap_line(first, MAX_LINE)
            lines = wrapped + lines[1:]
            if len(lines) > 2:
                lines = lines[:2]  # never emit a third line
        out.append({'start': cue['start'], 'end': cue['end'], 'lines': lines})
        prev, prev_end = row['speaker'], cue['end']
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('reference')
    ap.add_argument('--out', required=True)
    ap.add_argument('--offset', type=float, default=0.0,
                    help='global seconds to add to reference times (no --asr)')
    ap.add_argument('--asr', default=None,
                    help='ASR .srt used to estimate a local offset per reference cue')
    ap.add_argument('--no-align', action='store_true')
    ap.add_argument('--sdh-out', default=None)
    ap.add_argument('--hf-token', default=os.environ.get('HF_TOKEN', ''))
    ap.add_argument('--characters', default='')
    ap.add_argument('--context', default='')
    ap.add_argument('--ollama-host', default='http://127.0.0.1:11434')
    ap.add_argument('--naming-model', default=os.environ.get('SUBS_NAMING_MODEL', 'qwen3:4b'))
    args = ap.parse_args()
    cast = []
    if args.characters:
        try:
            cast = [c for c in json.loads(args.characters)
                    if isinstance(c, dict) and c.get('name')]
        except json.JSONDecodeError:
            print('[subs_from_ref] --characters is not valid JSON', file=sys.stderr)

    cues = clean_reference(parse_srt(args.reference))
    if not cues:
        print('[subs_from_ref] reference has no cues', file=sys.stderr)
        sys.exit(2)
    print(f'[subs_from_ref] {len(cues)} dialogue cues after cleaning ads', file=sys.stderr)
    if args.asr and os.path.exists(args.asr):
        offsets = estimate_offsets(cues, parse_srt(args.asr))
        apply_offsets(cues, offsets)
        finite = [o for o in offsets if abs(o) < 150]
        print(f'[subs_from_ref] local offsets: {min(finite):+.2f}..{max(finite):+.2f}s '
              f'(median {sorted(finite)[len(finite)//2]:+.2f}s)', file=sys.stderr)
    else:
        for c in cues:
            c['start'] = max(0.0, c['start'] + args.offset)
            c['end'] = max(c['start'] + 0.2, c['end'] + args.offset)

    wav = tmpdir = None
    need_audio = not args.no_align or bool(args.sdh_out)
    if need_audio:
        try:
            wav, tmpdir = T.extract_audio(args.video)
        except Exception as e:
            print(f'[subs_from_ref] audio extraction failed ({e}) — using reference timings',
                  file=sys.stderr)
    if wav and not args.no_align:
        ok = align(cues, wav)
        print(f'[subs_from_ref] aligned {sum(1 for c in cues if "a_start" in c)}/{len(cues)} cues'
              + ('' if ok else ' (below 50% — falling back per cue)'), file=sys.stderr)

    standard = build_standard(cues)
    if not standard:
        print('[subs_from_ref] no cues produced — leaving the existing track untouched',
              file=sys.stderr)
        sys.exit(3)
    write_srt(standard, args.out)
    print(f'[subs_from_ref] wrote {len(standard)} cues -> {args.out}', file=sys.stderr)

    if args.sdh_out:
        if not wav:
            print('[subs_from_ref] no audio — skipping the SDH track', file=sys.stderr)
        else:
            turns = T.diarize(wav, args.hf_token)
            sdh = build_sdh(standard, turns, cast, args)
            if sdh:
                write_srt(sdh, args.sdh_out)
                labelled = sum(1 for c in sdh
                               if re.match(r"^[A-Z][A-Z .'\-]{1,30}: ", c['lines'][0]))
                print(f'[subs_from_ref] wrote {len(sdh)} SDH cues '
                      f'({labelled} with a speaker ID) -> {args.sdh_out}', file=sys.stderr)
            else:
                print('[subs_from_ref] diarization failed — no SDH track', file=sys.stderr)

    if tmpdir:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    main()
