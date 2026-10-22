#!/usr/bin/env python3
"""Transcribe a video to an .srt file using faster-whisper on CUDA (RTX 3060 12GB).

Falls back through cuda/float16 -> cuda/int8_float16 -> cpu/int8, and through
model sizes, so it always produces subtitles even without a usable GPU.

Usage: transcribe.py <input_video> <output_srt> [--model large-v3-turbo] [--language auto]
                     [--diarize] (speaker-labeled, character-named cues)
"""
import argparse
import difflib
import glob
import json
import os
import re
import site
import subprocess
import sys
import tempfile
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


def diarize(video_path, hf_token):
    """Speaker turns [(start, end, label)] via pyannote, or None on any failure.

    Everything here degrades gracefully: no pyannote, no HF token, missing
    gated-model access, ffmpeg hiccup — any of it just means plain subtitles.
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
    wav = None
    torch = None
    try:
        import torch  # optional: only used to move the pipeline onto the GPU
    except ImportError:
        pass
    try:
        # pyannote reads wav, not mkv/mp4 — extract mono 16 kHz audio first.
        tmpdir = tempfile.mkdtemp(prefix="subs-diarize-")
        wav = os.path.join(tmpdir, "audio.wav")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video_path,
                        "-vn", "-ac", "1", "-ar", "16000", wav],
                       check=True, timeout=1800)
        # pyannote.audio >=4 uses `token=`, older versions `use_auth_token=`
        try:
            pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, token=hf_token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, use_auth_token=hf_token)
        if torch is not None and torch.cuda.is_available():
            pipeline = pipeline.to(torch.device("cuda"))
            print("[transcribe] diarizing on CUDA", file=sys.stderr)
        result = pipeline(wav)
        # pyannote >=4 returns a DiarizeOutput wrapper; its "exclusive" variant
        # (no overlapping turns) is the right one for attributing cues. Older
        # versions return the Annotation directly.
        annotation = getattr(result, 'exclusive_speaker_diarization', None) or result
        turns = sorted((turn.start, turn.end, label)
                       for turn, _, label in annotation.itertracks(yield_label=True))
        print(f"[transcribe] diarized {len(turns)} speaker turns", file=sys.stderr)
        return turns
    except Exception as e:
        print(f"[transcribe] diarization failed ({e}) — plain subtitles instead", file=sys.stderr)
        return None
    finally:
        if wav:
            try:
                os.remove(wav)
                os.rmdir(os.path.dirname(wav))
            except OSError:
                pass


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


def split_by_speaker(seg, turns):
    """One cue per same-speaker run of words inside a Whisper segment."""
    groups = []  # [speaker, tokens, start, end]
    for w in seg.words:
        token = (w.word or "").strip()
        if not token:
            continue
        spk = speaker_for_window(w.start, w.end, turns)
        if groups and groups[-1][0] == spk:
            groups[-1][1].append(token)
            groups[-1][3] = w.end
        else:
            groups.append([spk, [token], w.start, w.end])
    out = []
    for spk, toks, start, end in groups:
        text = " ".join(toks).strip()
        if text:
            out.append({"start": start, "end": end, "speaker": spk, "text": text})
    return out


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


def cast_block(cast):
    """Prompt lines describing the canonical cast (names plus known aliases)."""
    lines = []
    for c in cast:
        aka = [a for a in (c.get("aliases") or [])
               if a and a.lower() != _norm_name(c.get("name"))]
        lines.append(f"- {c['name']}" + (f" (also: {', '.join(aka)})" if aka else ""))
    return "\n".join(lines)


def name_speakers(cues, args, cast=None):
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
    if cast:
        # "null when not on the list" reads as "nothing matches", and models
        # answer all-null, so the default asks for a best guess; SUBS_NAMING_MODE
        # =strict only names speakers the dialogue actually identifies.
        mode = os.environ.get("SUBS_NAMING_MODE", "best")
        if mode == "strict":
            system += (" Name a speaker ONLY when the excerpt identifies them "
                       "(someone says their name, or the scene makes it clear); "
                       "answer null otherwise. Copy names exactly as written.")
        else:
            system += (" Every speaker is almost certainly one of the listed cast "
                       "members: pick the best match for each one, copying the full "
                       "name exactly as written. Answer null only when the excerpt "
                       "gives no clue whatsoever.")
    else:
        system += " Use the name as it would appear in credits, e.g. \"Cassian\"."
    votes = {}
    hint = {}
    CHUNK = 150
    for i in range(0, len(cues), CHUNK):
        chunk = cues[i:i + CHUNK]
        lines = [f"[{srt_ts(c['start'])[:8]}] {c['speaker']}: {c['text'][:160]}" for c in chunk]
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
    for spk, names in votes.items():
        for nm, _count in sorted(names.items(), key=lambda kv: -kv[1]):
            c = match_cast(nm, cast) if cast else {"name": nm, "display": nm}
            if c:
                resolved[spk] = c
                used.add(c["name"])
                break

    # Second chance: speakers the first pass left blank, matched against cast
    # members nobody claimed yet. Cheap, and it rescues episodes whose early
    # dialogue never names anyone.
    all_spk = sorted({c["speaker"] for c in cues if c["speaker"]})
    unassigned = [s for s in all_spk if s not in resolved]
    spare = [c for c in cast if c["name"] not in used]
    if cast and spare and unassigned:
        lines = [f"[{srt_ts(c['start'])[:8]}] {c['speaker']}: {c['text']}" for c in cues[:80]]
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

    out = {spk: (c.get("display") or c["name"]) for spk, c in resolved.items()}
    print(f"[transcribe] named {len(out)}/{len(all_spk)} speaker(s) via {args.naming_model}"
          + (f" (cast {len(cast)})" if cast else ""), file=sys.stderr)
    return out


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
    args = ap.parse_args()
    cast = []
    if args.characters:
        try:
            cast = [c for c in json.loads(args.characters) if isinstance(c, dict) and c.get("name")]
        except json.JSONDecodeError:
            print("[transcribe] --characters is not valid JSON — ignoring cast list",
                  file=sys.stderr)

    model = load_model(args.model)
    lang = None if (args.language or "auto").lower() in ("auto", "") else args.language

    # Word timestamps are only needed to know which speaker said what.
    word_ts = bool(args.diarize)

    # Transcribe in the source language first: Whisper's translate pass
    # produces degenerate timestamps even on English audio (30-second blocks
    # of merged text and 1-second-step junk cues), and most of the library is
    # English anyway. Only when the detected language isn't English do we
    # re-run with task=translate, so foreign content still gets English subs.
    segments, info = model.transcribe(
        args.input,
        language=lang,
        task='transcribe',
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=word_ts,
    )
    print(
        f"[transcribe] detected language={info.language} "
        f"(p={info.language_probability:.2f}) duration={info.duration / 60:.1f}min",
        file=sys.stderr,
    )
    if args.task == 'translate' and info.language != 'en':
        print("[transcribe] non-English audio — re-running with task=translate", file=sys.stderr)
        segments, info = model.transcribe(
            args.input,
            language=info.language,
            task='translate',
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            word_timestamps=word_ts,
        )

    turns = diarize(args.input, args.hf_token) if args.diarize else None

    cues = []
    skipped = 0
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        # Low-confidence filler spanning long stretches.
        if getattr(seg, 'no_speech_prob', 0) > 0.6 and getattr(seg, 'avg_logprob', 0) < -0.8:
            skipped += 1
            continue
        if is_hallucination(text):
            skipped += 1
            continue
        if turns:
            if getattr(seg, 'words', None):
                cues.extend(split_by_speaker(seg, turns))
            else:
                cues.append({"start": seg.start, "end": seg.end,
                             "speaker": speaker_for_window(seg.start, seg.end, turns),
                             "text": text})
        else:
            cues.append({"start": seg.start, "end": seg.end, "speaker": None, "text": text})

    named = 0
    if turns and cues:
        # Free the Whisper model before the LLM naming stage: the 12GB card
        # can't hold both at once and an Ollama OOM shows up as HTTP 500.
        try:
            import gc
            del model
            gc.collect()
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[transcribe] freed whisper model for the naming stage", file=sys.stderr)
        except Exception:
            pass
        names = name_speakers(cues, args, cast)
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
