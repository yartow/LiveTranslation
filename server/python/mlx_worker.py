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

MODEL_REPO = "mlx-community/whisper-large-v3-mlx"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


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
