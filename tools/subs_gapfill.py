#!/usr/bin/env python3
"""Fill gaps in a reference-built subtitle track from the audio.

Human subtitles condense scenes: quick exchanges and ad-libs are often left
out, so the track goes silent while people are talking. This scans the gaps
between existing cues, transcribes only that audio with Whisper (tuned VAD and
thresholds), and inserts the missing lines using the same Netflix cue rules.
Existing cues are never modified.

Usage:
  subs_gapfill.py <video> <standard.srt> [--sdh <sdh.srt>] [--dry-run]
"""

import argparse
import os
import re
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe as T  # noqa: E402  (sets CUDA libs, provides hallucination guard)

TS = re.compile(r'^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> '
                r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})')
MAX_LINE = 42
MAX_DUR = 7.0
MIN_DUR = 0.9
MAX_CPS = 20.0
GAP = 2 / 24


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
            cur['lines'].append(re.sub(r'<[^>]+>', '', line).strip())
    return [c for c in cues if c['lines'] and c['end'] > c['start']]


def srt_ts(seconds):
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def write_srt(cues, path):
    tmp = path + '.part'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        for n, c in enumerate(cues, 1):
            f.write(f"{n}\n{srt_ts(c['start'])} --> {srt_ts(c['end'])}\n")
            f.write('\n'.join(c['lines']) + '\n\n')
    os.replace(tmp, path)


def wrap(text):
    return textwrap.wrap(text, width=MAX_LINE, break_long_words=False,
                         break_on_hyphens=False) or [text]


def cue_from_words(start, end, text, gap_start, gap_end):
    text = re.sub(r'\s+', ' ', text).strip()
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    lines = wrap(text)
    if len(lines) > 2:
        lines = lines[:2]
    start = max(gap_start, start)
    end = min(gap_end, max(start + 0.3, end))
    want = min(MAX_DUR, max(MIN_DUR, len(' '.join(lines)) / MAX_CPS))
    if end - start < want:
        end = min(gap_end, start + want)
    if end - start > MAX_DUR:
        end = start + MAX_DUR
    return {'start': start, 'end': end, 'lines': lines}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('srt')
    ap.add_argument('--sdh', default=None)
    ap.add_argument('--model', default=os.environ.get('SUBS_WHISPER_MODEL', 'large-v3-turbo'))
    ap.add_argument('--min-gap', type=float, default=2.0)
    ap.add_argument('--min-words', type=int, default=3)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    cues = parse_srt(args.srt)
    if len(cues) < 2:
        print('[gapfill] not enough cues', file=sys.stderr)
        sys.exit(2)

    gaps = [(a['end'], b['start']) for a, b in zip(cues, cues[1:])
            if b['start'] - a['end'] >= args.min_gap]
    if not gaps:
        print('[gapfill] no gaps to fill', file=sys.stderr)
        return

    wav, tmpdir = T.extract_audio(args.video)
    try:
        import shutil
        import torchaudio
        from faster_whisper import WhisperModel

        waveform, sr = torchaudio.load(wav)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
        audio = waveform.mean(dim=0).numpy().astype('float32')

        model = WhisperModel(args.model, device='cuda', compute_type='float16')
        vad = {'threshold': 0.2, 'min_silence_duration_ms': 250, 'speech_pad_ms': 600}
        added, speech_gaps = [], 0
        for gs, ge in gaps:
            a = max(0, int((gs - 0.15) * 16000))
            b = min(len(audio), int((ge + 0.15) * 16000))
            if b - a < 1600:
                continue
            segs, _ = model.transcribe(
                audio[a:b], language='en', task='transcribe',
                vad_filter=True, vad_parameters=vad,
                no_speech_threshold=0.9, log_prob_threshold=-2.0,
                condition_on_previous_text=False)
            base = a / 16000
            got = 0
            for s in segs:
                text = (s.text or '').strip()
                if not text or T.is_hallucination(text):
                    continue
                if getattr(s, 'no_speech_prob', 0) > 0.8 and getattr(s, 'avg_logprob', 0) < -1.0:
                    continue
                if re.fullmatch(r'[\[\(].*[\]\)]', text):
                    continue
                if s.end - s.start < 0.5:
                    continue
                words = re.findall(r"[a-z0-9']+", text.lower())
                filler = {'okay', 'ok', 'thank', 'thanks', 'you', 'so', 'and', 'oh',
                          'um', 'uh', 'yes', 'no', 'hey', 'huh', 'what', 'right',
                          'sure', 'well', 'like', 'the', 'a', 'i'}
                if len(words) < args.min_words or all(w in filler for w in words):
                    continue
                added.append(cue_from_words(base + s.start, base + s.end, text, gs, ge))
                got += 1
            if got:
                speech_gaps += 1
        print(f'[gapfill] {len(gaps)} gap(s), {speech_gaps} with speech, '
              f'{len(added)} cue(s) added', file=sys.stderr)
        if args.dry_run:
            for c in added[:25]:
                print(f"  {srt_ts(c['start'])}  {' '.join(c['lines'])[:100]}", file=sys.stderr)
            return

        merged = sorted(cues + added, key=lambda c: c['start'])
        # Never let an inserted cue overlap an existing one.
        for i, c in enumerate(merged[:-1]):
            if c['end'] > merged[i + 1]['start'] - GAP:
                c['end'] = max(c['start'] + 0.2, merged[i + 1]['start'] - GAP)
        write_srt(merged, args.srt)
        print(f'[gapfill] wrote {len(merged)} cues -> {args.srt}', file=sys.stderr)

        if args.sdh and os.path.exists(args.sdh):
            sdh = parse_srt(args.sdh)
            merged_sdh = sorted(sdh + [dict(c, lines=list(c['lines'])) for c in added],
                                key=lambda c: c['start'])
            for i, c in enumerate(merged_sdh[:-1]):
                if c['end'] > merged_sdh[i + 1]['start'] - GAP:
                    c['end'] = max(c['start'] + 0.2, merged_sdh[i + 1]['start'] - GAP)
            write_srt(merged_sdh, args.sdh)
            print(f'[gapfill] wrote {len(merged_sdh)} SDH cues -> {args.sdh}', file=sys.stderr)
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    main()
