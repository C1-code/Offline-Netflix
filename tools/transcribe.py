#!/usr/bin/env python3
"""Transcribe a video to an .srt file using faster-whisper on CUDA (RTX 3060 12GB).

Falls back through cuda/float16 -> cuda/int8_float16 -> cpu/int8, and through
model sizes, so it always produces subtitles even without a usable GPU.

Usage: transcribe.py <input_video> <output_srt> [--model large-v3-turbo] [--language auto]
                     [--diarize] (speaker-labeled, character-named cues)
"""
import argparse
import atexit
import difflib
import gc
import glob
import json
import os
import re
import shutil
import site
import subprocess
import sys
import tempfile
import textwrap
import urllib.request


def _reexec_with_nvidia_libs():
    """Add pip-installed CUDA/cuDNN libs to LD_LIBRARY_PATH, then re-exec."""
    paths = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "lib")):
            paths.append(d)
    if not paths:
        return
    cur = os.environ.get("LD_LIBRARY_PATH", "")
    needed = [p for p in paths if p not in cur]
    if not needed:
        return
    os.environ["LD_LIBRARY_PATH"] = ":".join(needed + ([cur] if cur else []))
    os.execv(sys.executable, [sys.executable] + sys.argv)


_reexec_with_nvidia_libs()

MODEL_FALLBACKS = ["large-v3-turbo", "large-v3", "medium", "small"]
DEVICE_FALLBACKS = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]


def load_model(preferred):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: tools/setup-whisper.sh", file=sys.stderr)
        sys.exit(2)

    prefs = [preferred] + MODEL_FALLBACKS
    seen = set()
    for model_name in prefs:
        if not model_name or model_name in seen:
            continue
        seen.add(model_name)
        for device, compute in DEVICE_FALLBACKS:
            try:
                model = WhisperModel(model_name, device=device, compute_type=compute)
                print(f"[transcribe] loaded {model_name} on {device} ({compute})", file=sys.stderr)
                return model
            except Exception as e:
                print(f"[transcribe] {model_name}/{device}/{compute} failed: {e}", file=sys.stderr)
    print("[transcribe] could not load any model", file=sys.stderr)
    sys.exit(3)


def is_hallucination(text: str) -> bool:
    """Whisper over music/silence repeats one or two words endlessly — drop those."""
    words = text.split()
    uniq = {w.strip('.,!?;:"\'').lower() for w in words}
    return len(words) >= 4 and len(uniq) <= 2


def fallback_label(speaker: str) -> str:
    """Human-readable stand-in for a speaker the LLM couldn't name: SPEAKER_02 -> SPEAKER 3."""
    m = re.search(r"(\d+)", speaker or "")
    return f"SPEAKER {int(m.group(1)) + 1 if m else 1}"


# ---------- speaker diarization + character naming (Netflix-style cues) ----------

PYANNOTE_MODEL = "pyannote/speaker-diarization-3.1"


def extract_audio(video_path):
    """Mono 16 kHz wav in a temp dir (shared by diarization and alignment).

    One decode instead of one per stage: an episode is read by ffmpeg once, then
    pyannote and the aligner work on the same file. Returns (wav_path, tmpdir).
    """
    tmpdir = tempfile.mkdtemp(prefix="subs-audio-")
    wav = os.path.join(tmpdir, "audio.wav")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video_path,
                    "-vn", "-ac", "1", "-ar", "16000", wav],
                   check=True, timeout=1800)
    return wav, tmpdir


def merge_same_voice(wav, turns, pipeline):
    """Merge diarization clusters that are the same voice.

    pyannote regularly splits one character into two clusters (a quiet scene vs
    a loud one). That breaks naming: the cluster that says "my name's Jeff" is
    small, while the one carrying most of his dialogue gets no anchor and stays
    SPEAKER n. Embedding each cluster and merging near-identical voices fixes
    the split and lets anchors propagate.
    """
    if os.environ.get("SUBS_MERGE_VOICES") == "0" or len({t[2] for t in turns}) < 2:
        return turns
    try:
        import numpy as np
        import torch
        import torchaudio

        waveform, sr = torchaudio.load(wav)
        if sr != 16000:
            waveform = torchaudio.functional.resample(waveform, sr, 16000)
            sr = 16000
        waveform = waveform.mean(dim=0, keepdim=True)

        labels = sorted({t[2] for t in turns})
        embs = {}
        with torch.inference_mode():
            for label in labels:
                segs = [(s, e) for s, e, l in turns if l == label]
                total = sum(e - s for s, e in segs)
                if total < 3.0:
                    continue
                chunks, taken = [], 0.0
                for s, e in segs:
                    dur = min(e - s, 6.0, 30.0 - taken)
                    if dur <= 0.2:
                        continue
                    a = max(0, int(s * sr))
                    b = min(waveform.shape[1], a + int(dur * sr))
                    if b - a > 0:
                        chunks.append(waveform[:, a:b])
                        taken += (b - a) / sr
                    if taken >= 30.0:
                        break
                if not chunks:
                    continue
                # The embedding model expects (batch, channel, samples).
                raw = pipeline._embedding(torch.cat(chunks, dim=1).unsqueeze(0))
                if hasattr(raw, 'detach'):
                    raw = raw.detach().cpu().numpy()
                emb = np.asarray(raw).reshape(-1)
                embs[label] = emb / (np.linalg.norm(emb) or 1.0)
        if len(embs) < 2:
            return turns

        threshold = float(os.environ.get("SUBS_MERGE_SIM", 0.75))
        keys = list(embs)
        if os.environ.get("SUBS_DEBUG_NAMING"):
            pairs = sorted(((float(np.dot(embs[a], embs[b])), a, b)
                            for i, a in enumerate(keys) for b in keys[i + 1:]),
                           reverse=True)[:12]
            print("[transcribe] voice similarities: " +
                  ", ".join(f"{a}/{b}={sim:.2f}" for sim, a, b in pairs), file=sys.stderr)
        parent = {k: k for k in keys}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        merged = []
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                sim = float(np.dot(embs[a], embs[b]))
                if sim >= threshold:
                    ra, rb = find(a), find(b)
                    if ra != rb:
                        parent[rb] = ra
                        merged.append((a, b, round(sim, 3)))
        remap = {k: find(k) for k in keys}
        if not merged:
            return turns
        # Keep the largest cluster's label as the survivor for readability.
        counts = {}
        for _, _, label in turns:
            counts[label] = counts.get(label, 0) + 1
        survivors = {}
        for old, root in remap.items():
            group = [k for k, r in remap.items() if r == root]
            best = max(group, key=lambda k: counts.get(k, 0))
            survivors[old] = best
        out = sorted((s, e, survivors.get(l, l)) for s, e, l in turns)
        print("[transcribe] merged same-voice clusters: " +
              ", ".join(f"{a}->{b} ({sim})" for a, b, sim in merged), file=sys.stderr)
        return out
    except Exception as e:
        print(f"[transcribe] voice-cluster merge skipped ({e})", file=sys.stderr)
        return turns


def diarize(wav, hf_token):
    """Speaker turns [(start, end, label)] via pyannote, or None on any failure.

    Everything here degrades gracefully: no pyannote, no HF token, missing
    gated-model access — any of it just means plain subtitles. Pyannote 4
    exposes an exclusive annotation (overlaps removed) and a full one; the full
    one is the default because sitcom crosstalk otherwise loses the interjection
    that belongs to the second speaker. SUBS_DIARIZE_MODE=exclusive restores the
    old behaviour.
    """
    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print("[transcribe] pyannote.audio not installed — diarization skipped "
              "(re-run tools/setup-whisper.sh)", file=sys.stderr)
        return None
    if not hf_token:
        print("[transcribe] no Hugging Face token — diarization skipped. Accept the "
              f"{PYANNOTE_MODEL} terms on hf.co once (free account), then set "
              "whisperHfToken in config.json (or HF_TOKEN)", file=sys.stderr)
        return None
    torch = None
    try:
        import torch  # optional: only used to move the pipeline onto the GPU
    except ImportError:
        pass
    try:
        # pyannote.audio >=4 uses `token=`, older versions `use_auth_token=`
        try:
            pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, token=hf_token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, use_auth_token=hf_token)
        if torch is not None and torch.cuda.is_available():
            pipeline = pipeline.to(torch.device("cuda"))
            print("[transcribe] diarizing on CUDA", file=sys.stderr)
        result = pipeline(wav)
        full = getattr(result, 'speaker_diarization', None)
        exclusive = getattr(result, 'exclusive_speaker_diarization', None)
        if (os.environ.get("SUBS_DIARIZE_MODE") or "overlap") == "exclusive":
            annotation = exclusive or full or result
        else:
            annotation = full or exclusive or result
        turns = sorted((turn.start, turn.end, label)
                       for turn, _, label in annotation.itertracks(yield_label=True))
        overlaps = sum(1 for i in range(1, len(turns)) if turns[i][0] < turns[i - 1][1] - 1e-6)
        kind = 'exclusive' if exclusive is not None and annotation is exclusive else 'full'
        print(f"[transcribe] diarized {len(turns)} speaker turns "
              f"({overlaps} overlapping, {kind} annotation)", file=sys.stderr)
        turns = merge_same_voice(wav, turns, pipeline)
        print(f"[transcribe] {len({t[2] for t in turns})} distinct voice cluster(s)",
              file=sys.stderr)
        del pipeline
        gc.collect()
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()
        return turns
    except Exception as e:
        print(f"[transcribe] diarization failed ({e}) — plain subtitles instead", file=sys.stderr)
        return None


# ---------- word-level forced alignment (torchaudio Wav2Vec2) ----------

_ALIGNER = None


def load_aligner():
    """Wav2Vec2 CTC aligner, or False when torchaudio / the model is unavailable."""
    global _ALIGNER
    if _ALIGNER is not None:
        return _ALIGNER
    try:
        import torch
        import torchaudio
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print("[transcribe] loading alignment model (wav2vec2 960h)", file=sys.stderr)
        model = bundle.get_model().to(device).eval()
        _ALIGNER = (model, bundle.get_labels(), device)
        print(f"[transcribe] alignment model ready on {device}", file=sys.stderr)
        return _ALIGNER
    except Exception as e:
        print(f"[transcribe] alignment unavailable ({e}) — using Whisper word timestamps",
              file=sys.stderr)
        _ALIGNER = False
        return False


def free_aligner():
    """Release the aligner's VRAM before the LLM naming stage."""
    global _ALIGNER
    if _ALIGNER:
        _ALIGNER = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def align_words(wav_path, segments):
    """Word timings for every segment's text, from CTC forced alignment.

    Whisper's own word timestamps are attention-derived and drift by a few
    hundred milliseconds — enough to hand a short line to the previous speaker
    in fast dialogue. Returned words keep their segment index so the caller can
    fall back per segment.
    """
    al = load_aligner()
    if not al:
        return None
    import torch
    import torchaudio

    model, labels, device = al
    label_id = {c: i for i, c in enumerate(labels)}
    waveform, sr = torchaudio.load(wav_path)
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)
        sr = 16000
    waveform = waveform.mean(dim=0, keepdim=True)

    # The bundle's labels start with '-' (the CTC blank). Hyphens and dashes in
    # the transcript would map to it and forced_align rejects blank targets.
    allowed = {c for c, i in label_id.items() if i != 0}
    seg_words = []
    for seg in segments:
        seg_words.append([
            {'text': token, 'chars': [c for c in token.upper() if c in allowed]}
            for token in seg['text'].split()
        ])

    # Wav2Vec2's transformer attends over its whole input: a 21-minute episode
    # is ~63k frames, quadratic in time and VRAM. Align ~30s windows instead
    # (the same trick WhisperX uses), which also lets a bad window fail alone.
    windows, cur, start = [], [], None
    for si, seg in enumerate(segments):
        if start is None:
            start = seg['start']
        if cur and seg['end'] - start > 30:
            windows.append((start, segments[cur[-1]]['end'], cur))
            cur, start = [], seg['start']
        cur.append(si)
    if cur:
        windows.append((start, segments[cur[-1]]['end'], cur))

    out = []
    failed = 0
    for ws, we, idx in windows:
        pad = 0.3
        a = max(0, int((ws - pad) * sr))
        b = min(waveform.shape[1], int((we + pad) * sr))
        chunk = waveform[:, a:b]
        words = [{'seg': si, **w} for si in idx for w in seg_words[si]]
        tokens = [c for w in words for c in w['chars']]
        times = [None] * len(words)
        bounds = [(segments[w['seg']]['start'], segments[w['seg']]['end']) for w in words]
        spans, log_probs = None, None
        if len(tokens) >= 2:
            try:
                with torch.inference_mode():
                    emissions, _ = model(chunk.to(device))
                    log_probs = torch.log_softmax(emissions, dim=-1)
                    targets = torch.tensor([[label_id[c] for c in tokens]],
                                           dtype=torch.int32, device=device)
                    alignment, scores = torchaudio.functional.forced_align(
                        log_probs, targets, blank=0)
                    spans = torchaudio.functional.merge_tokens(
                        alignment[0], scores[0], blank=0)
                if len(spans) != len(tokens):
                    spans = None
            except Exception as e:
                print(f"[transcribe] alignment window failed ({e})", file=sys.stderr)
                spans = None
        if spans:
            stride = chunk.shape[1] / log_probs.shape[1] / sr
            offset = a / sr
            cursor = 0
            for i, w in enumerate(words):
                n = len(w['chars'])
                if not n:
                    continue
                own = spans[cursor:cursor + n]
                cursor += n
                if own:
                    times[i] = (offset + own[0].start * stride,
                                offset + own[-1].end * stride)
        else:
            failed += 1
        for i, w in enumerate(words):
            if times[i] is None:
                seg = segments[w['seg']]
                mid = (seg['start'] + seg['end']) / 2
                times[i] = (mid, mid)
            # No word may drift outside the Whisper segment that produced it:
            # otherwise the CTC pass can stretch an early word over 15s of
            # music and open a cue that long.
            lo, hi = bounds[i][0] - 0.25, bounds[i][1] + 0.25
            t0, t1 = times[i]
            t0, t1 = max(lo, min(t0, hi)), max(lo, min(t1, hi))
            times[i] = (min(t0, t1), max(t0, t1))
        for w, (t0, t1) in zip(words, times):
            out.append({'seg': w['seg'], 'text': w['text'],
                        'start': max(0.0, t0), 'end': max(0.0, t1)})
    if failed:
        print(f"[transcribe] {failed}/{len(windows)} alignment window(s) fell back "
              "to segment timings", file=sys.stderr)
    return out


def speaker_for_window(ws, we, turns):
    """The diarization turn with the most time overlap for [ws, we]."""
    best, best_ov = None, 0.0
    for ts, te, label in turns:
        ov = min(we, te) - max(ws, ts)
        if ov > best_ov:
            best, best_ov = label, ov
    if best is None and turns:
        mid = (ws + we) / 2
        best = min(turns, key=lambda t: abs((t[0] + t[1]) / 2 - mid))[2]
    return best


def smooth_speakers(words, min_words=2, min_dur=0.30):
    """Reassign blips shorter than min_words/min_dur to the previous speaker.

    Rapid crosstalk produces one-word "turns" ("Awesome", "doing?") that the
    diarizer cannot place reliably; keeping the previous speaker is far less
    jarring than flipping the label for 0.4s.
    """
    i = 0
    while i < len(words):
        j = i
        while j + 1 < len(words) and words[j + 1]['speaker'] == words[i]['speaker']:
            j += 1
        dur = words[j]['end'] - words[i]['start']
        if i > 0 and (j - i + 1) < min_words and dur < min_dur:
            prev = words[i - 1]['speaker']
            for k in range(i, j + 1):
                words[k]['speaker'] = prev
        i = j + 1
    return words


SENT_END = re.compile(r'[.!?…]["\')\]]*$')


def _cue_lines(text, width=42):
    text = re.sub(r'\s+([,.;:!?%])', r'\1', ' '.join(text.split()))
    return textwrap.wrap(text, width=width, break_long_words=False,
                         break_on_hyphens=False) or [text]


def _finish_cue(speaker, words, lines=None):
    start, end = words[0]['start'], words[-1]['end']
    if end <= start:
        end = start + 0.2
    text = '\n'.join(lines) if lines else \
        '\n'.join(_cue_lines(' '.join(w['text'] for w in words)))
    # A cue can start mid-sentence after a speaker change; subtitles read
    # better when every cue starts with a capital.
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return {'start': start, 'end': end, 'speaker': speaker, 'text': text}


def build_cues(words, max_chars=84, max_dur=7.0):
    """Group words into speaker runs, then into readable 1–2 line cues.

    Splits at speaker changes, sentence ends, 84 characters or 7 seconds —
    whichever comes first. This replaces the old word-by-word splitter that
    produced 0.4s cues like "Shirley: What are you" / "Jeff: doing?".
    """
    groups = []
    for w in words:
        token = (w.get('text') or '').strip()
        if not token:
            continue
        w = {**w, 'text': token}
        if groups and groups[-1]['speaker'] == w.get('speaker'):
            groups[-1]['words'].append(w)
        else:
            groups.append({'speaker': w.get('speaker'), 'words': [w]})

    cues = []
    for group in groups:
        chunk = []

        def flush():
            nonlocal chunk
            if chunk:
                cues.append({'speaker': group['speaker'], 'words': chunk})
                chunk = []

        for w in group['words']:
            if chunk:
                trial = ' '.join(x['text'] for x in chunk + [w])
                if len(trial) > max_chars or (w['end'] - chunk[0]['start']) > max_dur:
                    flush()
            chunk.append(w)
            text = ' '.join(x['text'] for x in chunk)
            if SENT_END.search(w['text']) and len(text) >= 25:
                flush()
        flush()

    out = []
    for cue in cues:
        ws = cue['words']
        lines = _cue_lines(' '.join(w['text'] for w in ws))
        if len(lines) > 2:
            # Very long unpunctuated speech: split in half at a word boundary.
            mid = len(ws) // 2
            for part in (ws[:mid], ws[mid:]):
                if part:
                    out.append(_finish_cue(cue['speaker'], part))
        else:
            out.append(_finish_cue(cue['speaker'], ws, lines))
    return [c for c in out if c['text']]


# ---------- LLM speaker naming via local Ollama ----------

def ollama_name_chunk(host, model, system, user_prompt, timeout=900):
    # num_ctx matters a lot: this model's default is 131072, which allocates a
    # huge KV cache and spills the MoE to CPU (minutes per call). A small
    # window keeps generation fast and fits the whole cast + one chunk easily.
    options = {
        "temperature": 0,
        "num_ctx": int(os.environ.get("SUBS_NAMING_CTX", 8192)),
        "num_predict": int(os.environ.get("SUBS_NAMING_PREDICT", 700)),
    }
    body = json.dumps({
        # think=false is essential on thinking-capable models (gemma4 here):
        # otherwise the hidden reasoning consumes the whole num_predict budget
        # and the visible answer comes back as "{}".
        "model": model, "stream": False, "format": "json", "think": False,
        "options": options,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user_prompt}],
    }).encode()
    req = urllib.request.Request(host.rstrip("/") + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    content = (data.get("message") or {}).get("content") or "{}"
    if os.environ.get("SUBS_DEBUG_NAMING"):
        print(f"[transcribe] prompt {len(user_prompt)} chars -> "
              f"prompt_eval={data.get('prompt_eval_count')} tokens, "
              f"eval={data.get('eval_count')} tokens, "
              f"done_reason={data.get('done_reason')}, "
              f"reply {len(content)} chars", file=sys.stderr)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            return {}
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}
    return parsed if isinstance(parsed, dict) else {}


def ollama_unload(host, model, timeout=10):
    """Evict the naming model from VRAM (Ollama `keep_alive: 0`).

    Ollama keeps a model resident for five minutes after the last request. On a
    12 GB card that model cannot coexist with Whisper plus pyannote, so the next
    file of a library pass would load into an occupied GPU (and either fall back
    to CPU or fail outright). Calling this before transcription and again after
    naming keeps a long pass on the GPU. Best effort: an unreachable Ollama or a
    model that is not loaded is not an error.
    """
    if not model:
        return
    body = json.dumps({"model": model, "keep_alive": 0}).encode()
    req = urllib.request.Request(host.rstrip("/") + "/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
        print(f"[transcribe] unloaded {model} from VRAM", file=sys.stderr)
    except Exception as e:
        print(f"[transcribe] could not unload {model} ({e})", file=sys.stderr)


def _norm_name(s):
    """Lowercase, drop punctuation, collapse spaces — for alias matching."""
    return re.sub(r"[^a-z0-9 ]+", " ", str(s).lower()).strip()


def match_cast(raw, cast):
    """Find the cast entry a model-supplied name refers to, or None.

    Tries exact canonical/alias matches, then token containment ("Kendall" vs
    "Kendall Roy"), then a fuzzy ratio — so "Ken" and "Kendall" both land on
    Kendall Roy, while an invented name ("Linus Moss") matches nothing.
    """
    n = _norm_name(raw)
    if not n or not cast:
        return None
    variants = []
    for c in cast:
        for v in [c.get("name")] + list(c.get("aliases") or []):
            nv = _norm_name(v)
            if nv:
                variants.append((nv, c))
    for nv, c in variants:
        if n == nv:
            return c
    ntok = set(n.split())
    # Same leading name but garbled rest ("Greg Egg" for "Greg Hirsch"): accept
    # when that first token identifies exactly one cast member.
    if len(ntok) > 1:
        first = n.split()[0]
        leads = {id(c): c for nv, c in variants if nv.split() and nv.split()[0] == first}
        if len(leads) == 1:
            return next(iter(leads.values()))
    for nv, c in variants:
        ctok = set(nv.split())
        if ctok and (ntok <= ctok or ctok <= ntok):
            return c
    best_ratio, best = 0.0, None
    for nv, c in variants:
        r = difflib.SequenceMatcher(None, n, nv).ratio()
        if r > best_ratio:
            best_ratio, best = r, c
    return best if best_ratio >= 0.85 else None


def match_cast_strict(raw, cast):
    """Exact name/alias, or a token subset ("Whitman" vs "Professor Whitman").

    No fuzzy ratio here: introductions must not snap "new" or "sure" onto a
    character with a vaguely similar spelling.
    """
    n = _norm_name(raw)
    if not n or not cast:
        return None
    ntok = set(n.split())
    for c in cast:
        for v in [c.get("name"), c.get("display")] + list(c.get("aliases") or []):
            nv = _norm_name(v)
            if not nv:
                continue
            if n == nv or ntok <= set(nv.split()):
                return c
    return None


def cast_block(cast):
    """Prompt lines describing the canonical cast (names plus known aliases)."""
    lines = []
    for c in cast:
        aka = [a for a in (c.get("aliases") or [])
               if a and a.lower() != _norm_name(c.get("name"))]
        lines.append(f"- {c['name']}" + (f" (also: {', '.join(aka)})" if aka else ""))
    return "\n".join(lines)


_NAME = r"([A-Z][a-zA-Z'’\-]{1,30}(?:\s+[A-Z][a-zA-Z'’\-]{1,30}){0,3})"
# First-person introductions only. "His name is Pierce." must not anchor the
# person saying it to Pierce — that is exactly the false positive that turned
# Professor Whitman's monologue into Pierce.
SELF_ID = re.compile(r"\b(?:my\s+name(?:'s| is)|i'?m|this is|it'?s)\s+" + _NAME)
# "name's Jeff" at the very start of a speaker's text (cue splitting can eat
# the leading "My").
SELF_ID_START = re.compile(r"^name(?:'s| is)\s+" + _NAME)


def self_id_anchors(speaker_texts, cast):
    """Speakers who introduce themselves, e.g. "my name's Jeff" -> SPEAKER_02: Jeff.

    Run on each speaker's *whole* transcript, not on cues: cue splitting had
    separated "My" from "name's Jeff", so the only certain assignment in the
    episode was being missed. These anchors override every model guess.
    """
    if not cast:
        return {}
    found = {}
    for spk, text in (speaker_texts or {}).items():
        text = text.replace('\n', ' ').strip()
        for m in list(SELF_ID.finditer(text)) + list(SELF_ID_START.finditer(text)):
            hit = match_cast_strict(m.group(1), cast)
            if hit:
                votes = found.setdefault(spk, {})
                votes[hit['name']] = votes.get(hit['name'], 0) + 1
    return {spk: max(v, key=v.get) for spk, v in found.items()}


def name_speakers(cues, args, cast=None, speaker_texts=None):
    """Map diarization labels (SPEAKER_00...) to character names.

    The transcript is chunked so an episode of any length fits the model's
    context; names found in earlier chunks are passed along as hints so the
    mapping stays consistent. Only dialogue text is sent, nothing else.

    When a canonical cast list is available (title_characters, see
    tools/characters.mjs) the model must choose from it, answers are snapped to
    the closest cast entry, and invented names are dropped.
    """
    if not cues:
        return {}
    cast = cast or []
    system = (
        "You are labeling the transcript of one TV episode. Speakers are "
        "anonymized as SPEAKER_00, SPEAKER_01, ... Identify which character each "
        "speaker is, using how characters address each other by name and the "
        "situation. Reply with ONLY a JSON object mapping every speaker id to a "
        "character name (or null when you cannot tell). Never invent speaker ids."
    )
    # SUBS_NAMING_MODE:
    #   guarded (default) — name regulars and anyone the scene identifies;
    #     leave background performers (students, patrons, guards) null;
    #   strict  — only when the dialogue itself identifies the speaker;
    #   best    — old behaviour: force the closest cast match on everyone,
    #     which is what produced "Buzz Hickey" in a season-1 episode.
    mode = os.environ.get("SUBS_NAMING_MODE", "guarded")
    if cast:
        if mode == "strict":
            system += (" Name a speaker ONLY when the excerpt identifies them "
                       "(someone says their name, or the scene makes it clear); "
                       "answer null otherwise. Copy names exactly as written.")
        elif mode == "guarded":
            system += (" The listed cast are the characters credited in THIS "
                       "episode, but not every voice is one of them: background "
                       "students, patrons and staff are not in the list. Name a "
                       "speaker when the scene makes it clear; answer null for "
                       "unidentified background performers rather than guessing. "
                       "Copy names exactly as written.")
        else:
            system += (" Every speaker is almost certainly one of the listed cast "
                       "members: pick the best match for each one, copying the full "
                       "name exactly as written. Answer null only when the excerpt "
                       "gives no clue whatsoever.")
    else:
        system += " Use the name as it would appear in credits, e.g. \"Cassian\"."
    if speaker_texts is None:
        speaker_texts = {}
        for c in cues:
            if c.get('speaker'):
                speaker_texts[c['speaker']] = (
                    speaker_texts.get(c['speaker'], '') + ' ' +
                    c['text'].replace('\n', ' ')).strip()

    # Self-identification wins over any amount of model guessing.
    anchors = self_id_anchors(speaker_texts, cast)
    if anchors:
        print(f"[transcribe] self-identification anchors: {json.dumps(anchors)}",
              file=sys.stderr)
    votes = {}
    hint = dict(anchors)
    CHUNK = 150
    for i in range(0, len(cues), CHUNK):
        chunk = cues[i:i + CHUNK]
        lines = [f"[{srt_ts(c['start'])[:8]}] {c['speaker']}: "
                 f"{c['text'].replace(chr(10), ' ')[:160]}" for c in chunk]
        user = f"Show: {args.context or 'Unknown'}\n\nTranscript excerpt:\n" + "\n".join(lines)
        if cast:
            user += "\n\nCast (use exactly these full names):\n" + cast_block(cast)
            user += ('\n\nExample answer shape: {"SPEAKER_00": "Cassian Andor", '
                     '"SPEAKER_01": "Luthen Rael"}')
        user += "\n\nJSON mapping of every SPEAKER id above to a character name or null:"
        if hint:
            user += "\n\nAlready identified in earlier excerpts (keep consistent): " + json.dumps(hint)
        try:
            answer = ollama_name_chunk(args.ollama_host, args.naming_model, system, user)
            if os.environ.get("SUBS_DEBUG_NAMING"):
                print(f"[transcribe] raw model answer ({len(answer)} key(s)): "
                      f"{json.dumps(answer)[:600]}", file=sys.stderr)
            for spk, nm in answer.items():
                # Models drift between "SPEAKER_9", "SPEAKER 9" and "speaker-9";
                # normalize or the vote is silently lost.
                spk = re.sub(r"\s*[- ]\s*", "_", str(spk).strip()).upper()
                if isinstance(nm, str) and nm.strip():
                    nm = nm.strip()
                    votes.setdefault(spk, {})
                    votes[spk][nm] = votes[spk].get(nm, 0) + 1
                    hint[spk] = nm
        except Exception as e:
            print(f"[transcribe] LLM naming failed ({e}) — generic labels kept", file=sys.stderr)
            break
    # Resolve each speaker to a cast entry: most-voted name that actually
    # matches someone in the list. Without a list, keep the model's answer.
    resolved = {}
    used = set()
    unstable = 0
    for spk, names in votes.items():
        ranked = sorted(names.items(), key=lambda kv: -kv[1])
        # A single mention of a name across chunks is a guess, not a vote.
        if len(ranked) > 1 and ranked[0][1] < 2:
            unstable += 1
            continue
        for nm, _count in ranked:
            c = match_cast(nm, cast) if cast else {"name": nm, "display": nm}
            if c:
                resolved[spk] = c
                used.add(c["name"])
                break
    if unstable:
        print(f"[transcribe] ignored {unstable} unstable speaker mapping(s) "
              "(no name got more than one vote)", file=sys.stderr)

    for spk, nm in anchors.items():
        c = match_cast(nm, cast) if cast else {"name": nm, "display": nm}
        if c:
            resolved[spk] = c
            used.add(c["name"])

    # Second chance: speakers the first pass left blank, matched against cast
    # members nobody claimed yet. Cheap, and it rescues episodes whose early
    # dialogue never names anyone.
    all_spk = sorted({c["speaker"] for c in cues if c["speaker"]})
    unassigned = [s for s in all_spk if s not in resolved]
    spare = [c for c in cast if c["name"] not in used]
    if cast and spare and unassigned:
        lines = [f"[{srt_ts(c['start'])[:8]}] {c['speaker']}: "
                 f"{c['text'].replace(chr(10), ' ')}" for c in cues[:80]]
        user = (f"Show: {args.context or 'Unknown'}\n\n"
                "Unassigned speakers: " + ", ".join(unassigned) + "\n\n"
                "Cast members not yet matched to anyone:\n" + cast_block(spare) + "\n\n"
                "Transcript excerpt:\n" + "\n".join(lines) +
                "\n\nJSON mapping of any of the unassigned speakers above to one of "
                "those cast members (null if unsure):")
        try:
            extra = ollama_name_chunk(args.ollama_host, args.naming_model, system, user)
            if os.environ.get("SUBS_DEBUG_NAMING"):
                print(f"[transcribe] second chance answer: {json.dumps(extra)[:400]}",
                      file=sys.stderr)
            for spk, nm in extra.items():
                spk = re.sub(r"\s*[- ]\s*", "_", str(spk).strip()).upper()
                if spk in resolved or not isinstance(nm, str) or not nm.strip():
                    continue
                c = match_cast(nm.strip(), spare)
                if c and c["name"] not in used:
                    resolved[spk] = c
                    used.add(c["name"])
        except Exception as e:
            print(f"[transcribe] second-chance naming failed ({e})", file=sys.stderr)

    # Guarded: a proposed name must be supported by the episode itself. Without
    # that rule the model confidently labels Jeff's lines "Chang" because the
    # scene mentions Professor Whitman. Anchors are exempt (the character said
    # their own name). SUBS_NAMING_EVIDENCE=guests relaxes this so regulars are
    # accepted without the name being spoken (more names, more guesses).
    dropped = 0
    if cast and mode == "guarded":
        dialogue = ' ' + ' '.join(_norm_name(t) for t in speaker_texts.values()) + ' '
        require_all = (os.environ.get("SUBS_NAMING_EVIDENCE") or "all") != "guests"
        kept = {}
        for spk, c in resolved.items():
            if spk in anchors:
                kept[spk] = c
                continue
            if c.get('regular') and not require_all:
                kept[spk] = c
                continue
            variants = [c.get('name'), c.get('display')] + list(c.get('aliases') or [])
            norm = {_norm_name(v) for v in variants if v}
            if any(n and f' {n} ' in dialogue for n in norm):
                kept[spk] = c
            else:
                dropped += 1
                if os.environ.get("SUBS_DEBUG_NAMING"):
                    print(f"[transcribe] dropped {c.get('display') or c.get('name')} "
                          f"for {spk}: never named in this episode", file=sys.stderr)
        resolved = kept

    out = {spk: (c.get("display") or c["name"]) for spk, c in resolved.items()}
    print(f"[transcribe] named {len(out)}/{len(all_spk)} speaker(s) via {args.naming_model}"
          + (f" (cast {len(cast)}, mode {mode})" if cast else "")
          + (f", {dropped} guest guess(es) dropped" if dropped else ""), file=sys.stderr)
    return out


def segment_word_times(seg):
    """(token, start, end) for a segment when forced alignment is unavailable.

    Uses Whisper's word timestamps when they exist, otherwise spreads the
    segment's duration over its words by length (good enough to keep a cue in
    the right place when alignment could not run at all).
    """
    tokens = seg['text'].split()
    if not tokens:
        return
    if seg.get('words'):
        for token, start, end in seg['words']:
            token = (token or '').strip()
            if token:
                yield token, start, end
        return
    weights = [max(1, len(t)) for t in tokens]
    total = sum(weights)
    duration = max(0.2, seg['end'] - seg['start'])
    t = seg['start']
    for token, weight in zip(tokens, weights):
        step = duration * weight / total
        yield token, t, t + step
        t += step


def srt_ts(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    ap.add_argument("--diarize", action="store_true",
                    help="split cues by speaker (pyannote) and prefix character "
                         "names (e.g. 'DEDRA: ...') via a local Ollama model")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""))
    ap.add_argument("--ollama-host", default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
    ap.add_argument("--naming-model", default=os.environ.get("SUBS_NAMING_MODEL", "qwen3:4b"))
    ap.add_argument("--context", default="", help="show/episode hint for speaker naming")
    ap.add_argument("--characters", default="",
                    help="JSON array of canonical cast entries "
                         "[{\"name\":..., \"display\":..., \"aliases\":[...]}]; "
                         "constrains naming to these people (see tools/characters.mjs)")
    ap.add_argument("--no-align", action="store_true",
                    help="skip wav2vec2 forced alignment (fall back to Whisper word timestamps)")
    args = ap.parse_args()
    cast = []
    if args.characters:
        try:
            cast = [c for c in json.loads(args.characters) if isinstance(c, dict) and c.get("name")]
        except json.JSONDecodeError:
            print("[transcribe] --characters is not valid JSON — ignoring cast list",
                  file=sys.stderr)

    # A previous file's naming call can still hold the LLM in VRAM (Ollama's
    # default keep-alive). Clear it before Whisper claims the GPU.
    if args.diarize:
        ollama_unload(args.ollama_host, args.naming_model)

    wav = tmpdir = None
    if args.diarize:
        try:
            wav, tmpdir = extract_audio(args.input)
            atexit.register(shutil.rmtree, tmpdir, ignore_errors=True)
        except Exception as e:
            print(f"[transcribe] audio extraction failed ({e}) — "
                  "no diarization/alignment for this file", file=sys.stderr)

    # Alignment replaces Whisper's attention-derived word timings, so ask for
    # them only when it is not available.
    align_ok = bool(wav) and not args.no_align and bool(load_aligner())
    model = load_model(args.model)
    lang = None if (args.language or "auto").lower() in ("auto", "") else args.language

    vad = {
        "threshold": float(os.environ.get("SUBS_VAD_THRESHOLD", 0.2)),
        "min_silence_duration_ms": 250,
        "speech_pad_ms": 600,
    }
    # These thresholds matter: with faster-whisper's defaults (no_speech 0.6,
    # log_prob -1.0) whole lines of quiet / filtered dialogue (a phone call,
    # whispered asides) are discarded before we ever see them. 0.9 / -2.0 keeps
    # them, and the hallucination guard below still drops repeated junk.
    decode = dict(
        language=lang,
        task='transcribe',
        vad_filter=True,
        vad_parameters=vad,
        no_speech_threshold=0.9,
        log_prob_threshold=-2.0,
        condition_on_previous_text=True,
        word_timestamps=bool(args.diarize and not align_ok),
    )

    # Transcribe in the source language first: Whisper's translate pass
    # produces degenerate timestamps even on English audio (30-second blocks
    # of merged text and 1-second-step junk cues), and most of the library is
    # English anyway. Only when the detected language isn't English do we
    # re-run with task=translate, so foreign content still gets English subs.
    segments, info = model.transcribe(args.input, **decode)
    print(
        f"[transcribe] detected language={info.language} "
        f"(p={info.language_probability:.2f}) duration={info.duration / 60:.1f}min",
        file=sys.stderr,
    )
    if args.task == 'translate' and info.language != 'en':
        print("[transcribe] non-English audio — re-running with task=translate", file=sys.stderr)
        decode.update(language=info.language, task='translate')
        segments, info = model.transcribe(args.input, **decode)

    turns = diarize(wav, args.hf_token) if wav else None

    kept, skipped = [], 0
    for seg in segments:
        text = re.sub(r'\s+', ' ', (seg.text or '')).strip()
        if not text:
            continue
        # Low-confidence filler spanning long stretches.
        if getattr(seg, 'no_speech_prob', 0) > 0.8 and getattr(seg, 'avg_logprob', 0) < -1.0:
            skipped += 1
            continue
        if is_hallucination(text):
            skipped += 1
            continue
        # A one-word "line" stretched over a long stretch of music is Whisper
        # padding silence, not dialogue (it produced a 14s "My" cue).
        if len(text.split()) <= 2 and (seg.end - seg.start) > 5:
            skipped += 1
            continue
        kept.append({
            'text': text, 'start': seg.start, 'end': seg.end,
            'words': [(w.word, w.start, w.end) for w in (getattr(seg, 'words', None) or [])]
        })

    words = align_words(wav, kept) if (align_ok and kept) else None
    if words is not None:
        print(f"[transcribe] aligned {len(words)} word(s)", file=sys.stderr)
    else:
        words = []
        for si, seg in enumerate(kept):
            for token, start, end in segment_word_times(seg):
                words.append({'seg': si, 'text': token, 'start': start, 'end': end})

    if turns:
        for w in words:
            w['speaker'] = speaker_for_window(w['start'], w['end'], turns)
        smooth_speakers(words)
    else:
        for w in words:
            w['speaker'] = None
    cues = build_cues(words)

    named = 0
    if turns and cues:
        # Free Whisper + the aligner before the LLM naming stage: the 12GB card
        # can't hold all three, and an Ollama OOM shows up as HTTP 500.
        try:
            free_aligner()
            del model
            gc.collect()
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[transcribe] freed whisper + aligner for the naming stage", file=sys.stderr)
        except Exception:
            pass
        names = {}
        speaker_texts = {}
        for w in words:
            if w['speaker']:
                speaker_texts[w['speaker']] = (
                    speaker_texts.get(w['speaker'], '') + ' ' + w['text']).strip()
        if os.environ.get("SUBS_DEBUG_NAMING"):
            for spk in sorted(speaker_texts):
                print(f"[transcribe] {spk} ({len(speaker_texts[spk].split())} words): "
                      f"{speaker_texts[spk][:110]}", file=sys.stderr)
        try:
            names = name_speakers(cues, args, cast, speaker_texts)
        finally:
            # Hand the GPU back for the next file in the pass, even when naming
            # threw: a resident 12B model is what turns one failure into a
            # cascade of out-of-memory failures for every file after it.
            ollama_unload(args.ollama_host, args.naming_model)
        named = len(names)
        for c in cues:
            if c["speaker"] is not None:
                nm = names.get(c["speaker"])
                c["prefix"] = (nm or fallback_label(c["speaker"])) + ": "

    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        count = 0
        for c in cues:
            text = c["text"].strip()
            if not text:
                continue
            if c.get("prefix"):
                text = c["prefix"] + text
            f.write(f"{count + 1}\n{srt_ts(c['start'])} --> {srt_ts(c['end'])}\n{text}\n\n")
            count += 1
            if count % 200 == 0:
                print(f"[transcribe] {count} segments", file=sys.stderr)
    print(f"[transcribe] wrote {count} segments ({skipped} hallucinations skipped) -> {args.output}", file=sys.stderr)
    # stdout stays machine-readable for the Node side (track label); progress is on stderr.
    print(f"named_speakers={named}")


if __name__ == "__main__":
    main()
