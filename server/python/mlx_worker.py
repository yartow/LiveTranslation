#!/usr/bin/env python3
"""
mlx_worker.py — long-lived transcription sidecar for mlx-whisper (Apple Silicon).

Protocol: JSON-lines over stdin/stdout.

  in  (per request): {"id": <int>, "path": "<wav path>", "language": "en"|null, "initial_prompt": "..."|null,
                      "opts": {...}|null}   # opts: optional decode overrides, see DEFAULT_OPTS
  out (per request):  {"id": <int>, "text": "...", "diag": {...}}   # diag: per-segment kept/dropped + uncovered spans
                    or {"id": <int>, "error": "..."}
  out (once, after the model is warmed): {"type": "ready"}

stdout carries *only* the lines above — every other message (progress bars,
warnings, tracebacks) must go to stderr, or it corrupts the protocol from the
Node side. See server/lib/mlx-whisper.ts for the caller.
"""

import sys
import os
import json
import traceback
import wave

# Keep noise off stdout before importing anything that might print to it.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# Capture the real stdout for the JSON-lines protocol, then point sys.stdout
# at stderr *before* importing mlx_whisper/numpy/HF — those (and their
# transitive deps) are not guaranteed to respect HF_HUB_DISABLE_PROGRESS_BARS
# for every code path, and a single stray print() anywhere in that dependency
# tree would otherwise desync the Node side's request/response correlation.
# emit() is the only thing that ever writes to _protocol_stdout.
_protocol_stdout = sys.stdout
sys.stdout = sys.stderr

# Override with MLX_MODEL (e.g. "mlx-community/whisper-large-v3-turbo" — faster,
# ~1.6 GB first-run download). Default stays the already-cached large-v3.
MODEL_REPO = os.environ.get("MLX_MODEL") or "mlx-community/whisper-large-v3-mlx"

# Per-segment hallucination filter, applied to Whisper's own segment stats.
# compression_ratio > 2.4 is Whisper's standard signature of a repetition loop
# ("Muziek Muziek Muziek ..."). The no_speech/logprob pair is deliberately an
# AND of two weak signals: no_speech_prob alone is NOT trustworthy (see the
# comment below), but a segment the model itself rates as probably-no-speech
# AND low-confidence is safe to drop.
MAX_COMPRESSION_RATIO = 2.4
NO_SPEECH_PROB_DROP = 0.6
AVG_LOGPROB_DROP = -1.0


# Decode settings a request may override (the eval script A/B-tests these; the
# server leaves them at the defaults). None disables the corresponding check.
DEFAULT_OPTS = {
    # Whisper's own heuristic: skip a suspicious segment next to >= N s of silence.
    # It also discards the REST of the decode window after the skipped segment.
    "hallucination_silence_threshold": 2.0,
    # Whisper skips a whole window when no_speech_prob > this AND avg_logprob < -1.0.
    "no_speech_threshold": NO_SPEECH_PROB_DROP,
    # True = our own post-filter below also drops segments (see keep_segment).
    "segment_filter": True,
}

# A span of audio with no kept segment longer than this is reported as uncovered.
UNCOVERED_GAP_SECS = 2.0


def keep_segment(seg: dict) -> bool:
    if seg.get("compression_ratio", 0.0) > MAX_COMPRESSION_RATIO:
        return False
    if seg.get("no_speech_prob", 0.0) > NO_SPEECH_PROB_DROP and seg.get("avg_logprob", 0.0) < AVG_LOGPROB_DROP:
        return False
    return True


def drop_reason(seg: dict):
    if seg.get("compression_ratio", 0.0) > MAX_COMPRESSION_RATIO:
        return "compression_ratio"
    if seg.get("no_speech_prob", 0.0) > NO_SPEECH_PROB_DROP and seg.get("avg_logprob", 0.0) < AVG_LOGPROB_DROP:
        return "no_speech+logprob"
    return None


def wav_duration(path: str):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return None


def uncovered_spans(kept: list, duration):
    """Stretches of the chunk longer than UNCOVERED_GAP_SECS that no kept segment covers —
    where speech may have been silently lost (also true for genuine pauses; the text
    around them tells which). Needs a known duration for the leading/trailing edges."""
    spans = []
    cursor = 0.0
    for seg in sorted(kept, key=lambda x: x.get("start", 0.0)):
        start, end = seg.get("start", 0.0), seg.get("end", 0.0)
        if start - cursor > UNCOVERED_GAP_SECS:
            spans.append([round(cursor, 2), round(start, 2)])
        cursor = max(cursor, end)
    if duration is not None and duration - cursor > UNCOVERED_GAP_SECS:
        spans.append([round(cursor, 2), round(duration, 2)])
    return spans


def build_diag(path: str, segments: list, kept_ids: set) -> dict:
    duration = wav_duration(path)
    kept = [s for s in segments if id(s) in kept_ids]
    return {
        "duration": duration,
        "segments": [
            {
                "start": round(s.get("start", 0.0), 2),
                "end": round(s.get("end", 0.0), 2),
                "text": s.get("text", "").strip(),
                "compression_ratio": round(s.get("compression_ratio", 0.0), 2),
                "avg_logprob": round(s.get("avg_logprob", 0.0), 2),
                "no_speech_prob": round(s.get("no_speech_prob", 0.0), 3),
                "dropped": None if id(s) in kept_ids else drop_reason(s),
            }
            for s in segments
        ],
        "uncovered": uncovered_spans(kept, duration),
    }

# Whisper is known to hallucinate fluent-sounding but entirely invented text
# on silence/background noise (e.g. caption-style artifacts like "[Music]"
# or "Thank you for watching" from its training data). An earlier version of
# this worker tried to catch that here via segment-level no_speech_prob
# filtering — measured against mlx-whisper large-v3 (Dutch), that doesn't
# work: real quiet speech and actual silence produce OVERLAPPING
# no_speech_prob values once an initial_prompt is set (as this app always
# does) — e.g. a real quiet "Amen" scored 0.057 and was transcribed as
# "MUZIEK", while pure silence scored 0.047, LOWER. No threshold can
# separate those. Hallucination filtering now happens content-side, on the
# full transcription text, in server/lib/asr-artifacts.ts — shared by both
# the mlx and OpenAI Whisper engines, which a Python-side probability filter
# could never be anyway.


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    _protocol_stdout.write(json.dumps(obj) + "\n")
    _protocol_stdout.flush()


def main() -> None:
    import numpy as np
    import mlx_whisper

    # Warm the model with a second of silence so the first real request isn't
    # paying for weight load + Metal kernel compilation.
    log(f"Loading {MODEL_REPO}…")
    silence = np.zeros(16_000, dtype=np.float32)
    mlx_whisper.transcribe(silence, path_or_hf_repo=MODEL_REPO, language="en", fp16=True)
    log("Model warm.")
    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"Bad request line, ignoring: {e}")
            continue

        req_id = req.get("id")
        path = req.get("path")
        language = req.get("language") or None
        initial_prompt = req.get("initial_prompt") or None
        opts = {**DEFAULT_OPTS, **(req.get("opts") or {})}

        try:
            if not path or not os.path.exists(path):
                raise FileNotFoundError(f"Audio file not found: {path}")

            result = mlx_whisper.transcribe(
                path,
                path_or_hf_repo=MODEL_REPO,
                language=language,
                fp16=True,
                initial_prompt=initial_prompt,
                # Each chunk is transcribed independently (our own app already
                # supplies cross-chunk continuity via initial_prompt) — disable
                # the library's internal conditioning on its own previous
                # window's text, which is a second, unrelated compounding
                # source of hallucinated repetition.
                condition_on_previous_text=False,
                # Required for hallucination_silence_threshold: when a long
                # silence is detected around a segment, a suspicious segment
                # next to it is skipped instead of kept.
                word_timestamps=opts["hallucination_silence_threshold"] is not None,
                hallucination_silence_threshold=opts["hallucination_silence_threshold"],
                compression_ratio_threshold=MAX_COMPRESSION_RATIO,
                no_speech_threshold=opts["no_speech_threshold"],
            )
            segments = result.get("segments") or []
            diag = None
            if segments:
                kept = [seg for seg in segments if keep_segment(seg)] if opts["segment_filter"] else list(segments)
                dropped = len(segments) - len(kept)
                if dropped:
                    log(f"Request {req_id}: dropped {dropped}/{len(segments)} low-confidence segment(s)")
                text = " ".join(seg.get("text", "").strip() for seg in kept).strip()
                diag = build_diag(path, segments, {id(s) for s in kept})
            else:
                text = result.get("text", "").strip()
            emit({"id": req_id, "text": text, "diag": diag})
        except Exception as e:
            log(f"Request {req_id} failed: {traceback.format_exc()}")
            emit({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log(f"Worker crashed: {traceback.format_exc()}")
        sys.exit(1)
