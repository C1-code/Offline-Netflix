#!/usr/bin/env python3
"""Transcribe a video to an .srt file using faster-whisper on CUDA (RTX 3060 12GB).

Falls back through cuda/float16 -> cuda/int8_float16 -> cpu/int8, and through
model sizes, so it always produces subtitles even without a usable GPU.

Usage: transcribe.py <input_video> <output_srt> [--model large-v3-turbo] [--language auto]
"""
import argparse
import glob
import os
import site
import sys


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
    args = ap.parse_args()

    model = load_model(args.model)
    lang = None if (args.language or "auto").lower() in ("auto", "") else args.language

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
        )

    with open(args.output, "w", encoding="utf-8", newline="\n") as f:
        count = 0
        skipped = 0
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            # Hallucination guards: whisper over music/silence tends to emit
            # one or two words repeated over and over ("HABLAMOS HABLAMOS...")
            # or low-confidence filler spanning long stretches. Drop those.
            words = text.split()
            uniq = {w.strip('.,!?;:"\'').lower() for w in words}
            if len(words) >= 4 and len(uniq) <= 2:
                skipped += 1
                continue
            if getattr(seg, 'no_speech_prob', 0) > 0.6 and getattr(seg, 'avg_logprob', 0) < -0.8:
                skipped += 1
                continue
            f.write(f"{count + 1}\n{srt_ts(seg.start)} --> {srt_ts(seg.end)}\n{text}\n\n")
            count += 1
            if count % 200 == 0:
                print(f"[transcribe] {count} segments", file=sys.stderr)
    print(f"[transcribe] wrote {count} segments ({skipped} hallucinations skipped) -> {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
