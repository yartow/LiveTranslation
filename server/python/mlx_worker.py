#!/usr/bin/env python3
"""
mlx_worker.py — long-lived transcription sidecar for mlx-whisper (Apple Silicon).

Protocol: JSON-lines over stdin/stdout.

  in  (per request): {"id": <int>, "path": "<wav path>", "language": "en"|null, "initial_prompt": "..."|null}
  out (per request):  {"id": <int>, "text": "..."}
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

MODEL_REPO = "mlx-community/whisper-large-v3-mlx"

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
            )
            emit({"id": req_id, "text": result.get("text", "").strip()})
        except Exception as e:
            log(f"Request {req_id} failed: {traceback.format_exc()}")
            emit({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log(f"Worker crashed: {traceback.format_exc()}")
        sys.exit(1)
