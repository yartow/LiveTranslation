# CTT.AY

**Contextual Transcriptions & Translations — Andrew Yong**
Pronounced *"stay"*.

A mobile-first web application for real-time audio transcription and multi-language translation. Designed for one-handed use — start it, put your phone down, read the live translation.

---

## Quick Start

```bash
git clone <this-repo>
cd LiveTranslation
npm install
cp .env.example .env      # no keys needed for free mode (Browser Speech + None)
npm run dev
```

Then open **`http://localhost:PORT`** in Chrome or Edge (the free Browser Speech transcription backend requires one of those) — the terminal running `npm run dev` logs `serving on port XXXX` on startup, so use that number. `PORT` defaults to `5001` (see `.env.example`), but **check your own `.env` file first**: if it already sets a different `PORT` (e.g. `3000`), that value wins and `5001` will not be listening at all. Press Record, allow microphone access, and start talking.

Want Whisper transcription or AI translation instead of the free mode? Add `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to `.env`, or paste them into the in-app Settings (⚙︎) — see [API Providers & Free Mode](#api-providers--free-mode) below. Want to run entirely offline on Apple Silicon with the local `mlx` provider? See [Local MLX Transcription](#local-mlx-transcription-apple-silicon-only) — **do not use Docker for that path**, see the note in [Running Locally — Docker](#running-locally--docker).

---

## What It Does

- **Real-time transcription** — Captures spoken audio via the browser microphone and converts it to text using OpenAI Whisper (paid, high accuracy) or the free Browser Speech API.
- **On-device transcription** — Optional local Whisper via Transformers.js (tiny / small / medium models). Downloads once, runs entirely offline thereafter.
- **Automatic translation** — Translates each transcribed chunk into your chosen language using OpenAI GPT-4o-mini or Claude. Can also run translation-free (transcription only).
- **Live language switching** — Change the target language mid-recording; all accumulated text re-translates on the fly.
- **Speaker detection** — Optionally identifies and labels different speakers.
- **Retroactive correction** — Every 5 sentences, the AI reviews the full accumulated text for grammar and coherence.
- **Export** — Download transcripts as plain text or Markdown.
- **Session history** — Every recording is auto-saved to IndexedDB; browse, export, or delete past sessions.
- **PWA** — Installable on Android (Chrome) and iOS (Share → Add to Home Screen); opens fullscreen with no browser chrome.
- **RTL support** — Right-to-left layout for Arabic and Farsi.
- **Dark/light theme** — Automatic detection with manual toggle.

---

## Browser & Device Compatibility

The app runs entirely in the browser — no app install needed. Compatibility depends on the transcription backend you choose:

| Platform | Whisper (chunk-based) | Browser Speech API |
|---|---|---|
| Desktop Chrome / Edge | ✅ | ✅ |
| Desktop Firefox | ✅ | ❌ not supported |
| Desktop Safari | ✅ | ❌ not supported |
| Android Chrome | ✅ | ✅ |
| **iOS Safari** | ✅ (iOS 14.5+) | ❌ not supported |

**Recommendation for iPhone/iPad:** Use the Whisper backend. The free Browser Speech API is not available on iOS Safari. On any platform, Whisper gives significantly better accuracy.

---

## Microphone & Permissions

The browser will request microphone permission the first time you press Record. Two important constraints:

1. **HTTPS is required in production.** The browser's `getUserMedia` API (and therefore both transcription backends) only works on `https://` or `localhost`. If you deploy to HTTP, microphone access will be silently blocked. Use a TLS-terminating reverse proxy (nginx, Caddy) in front of the app.

2. **User gesture required on iOS.** The microphone can only be activated from a button tap — the app already handles this correctly.

### Bluetooth Microphones

Bluetooth mics work automatically at the OS level. The app requests the system default audio input; if you have a Bluetooth headset connected and selected as the default mic, the browser will use it. No app changes are needed.

> **Note:** When a Bluetooth headset is active on iOS or macOS, the system switches to HFP (Hands-Free Profile) mode, reducing audio quality to ~8 kHz mono. Whisper handles this cleanly, but if audio quality matters, a wired or USB microphone is better.

---

## Supported Languages

English · Spanish · French · German · Dutch · Portuguese · Italian · Chinese (Simplified) · Chinese (Traditional) · Arabic · Farsi · Hindi · Russian · Japanese · Korean

---

## Sermon Mode (`/`)

The app's default view — a UI purpose-built for translating a live sermon block-by-block with human review, distinct from the streaming-subtitle view (now at `/live`).

- **Segment-based review** — incoming transcript is grouped into ~5–20 second blocks (configurable, "Max. vertraging" in Settings), each cut on a sentence boundary so a block is never split mid-sentence; each segment is independently editable and re-translatable without disturbing the others.
- **Dual-pane layout** — editable source on one side, translation on the other, row-aligned.
- **Keyboard-driven workflow** — hotkeys for re-translating one segment or all pending segments (e.g. Cmd/Ctrl+Shift+Enter).
- **File-based theological glossary (optional)** — a CSV of fixed Dutch→English terms plus a markdown doc of context-dependent disambiguation rules, loaded from files in `data/` (directory configurable via `GLOSSARY_DIR` in `.env`). Configure and reload it from Settings → "Preekmodus — woordenlijst". Segments whose translation appears to be missing an expected glossary term show a non-blocking warning icon — it's a hint for the human reviewer, not a blocker.
- **Scripture quoting (optional)** — detects a spoken Bible reference ("Johannes 3:16") and substitutes the exact English verse text (ESV via API, falling back to the bundled KJV) instead of a model translation when the preacher reads verbatim; a paraphrase is still translated in his own words. Requires a one-time data build — see `scripts/build-bible-data.ts` and `CLAUDE.md`'s "Scripture pipeline". Configure from Settings → "Preekmodus — Schriftcitaten".
- Uses the same OpenAI / Claude / Ollama translation providers as the main app (see below), configured independently per sermon-mode setting.

Open `http://localhost:PORT/` to use it — live/subtitle mode is at `/live`.

---

## Listener Mode (`/listen`)

Lets people in the room who don't speak Dutch follow the English translation live on their own phone, over the same wifi network as the MBP running the app — no app install, no account.

- Open Settings from the sermon-mode toolbar and click **"Luisteraars"** to see the address to hand out (e.g. `http://192.168.178.42:3000`) — it's read live off the machine's current network, so it's correct whether you're at home or at church.
- A listener types that address into their phone's browser. Typing just the bare address (no path) takes them straight to the listener view — you don't need to tell them to add `/listen`.
- The listener screen shows **only the finished English translation**, auto-scrolling as new lines arrive; scrolling up pauses that and shows a "Jump to live" button. A line that gets corrected after it first appears is re-pushed and shown in *italic*.
- **This is not access control.** Anyone on the same wifi who reaches the server can open the listener view. Don't rely on it to keep the transcript private.
- Church guest wifi sometimes isolates devices from each other ("AP/client isolation"), which blocks this entirely and can't be worked around in software — test it on the actual venue's wifi ahead of time. If it's isolated, run a personal hotspot from the MBP instead and have listeners join that.

---

## API Providers & Free Mode

All API keys are entered in the in-app Settings (⚙︎ icon). Keys are stored only in your browser's `sessionStorage` and are never sent to this server's storage — they travel directly to OpenAI or Anthropic with each request.

| Provider | Cost | What it does |
|---|---|---|
| **OpenAI Whisper** | ~$0.006/min | Highest accuracy transcription |
| **MLX Whisper** | Free (Apple Silicon only) | Local Whisper via mlx-whisper sidecar; fastest option on Mac |
| **Local Whisper** | Free (after model download) | On-device Transformers.js inference |
| **Browser Speech API** | Free | Transcription via the browser — Chrome/Edge only |
| **OpenAI GPT-4o-mini** | ~$0.001/request | Fast translation + grammar correction |
| **Claude** | Free tier available | High-quality translation |
| **Ollama (local)** | Free | Translation via a local Ollama model — fully offline |
| **None** | Free | Raw transcription only, no translation or correction |

**Fully free mode:** Browser Speech API + None translation. No API keys needed. Works best in Chrome or Edge on a desktop.

### Ollama setup

1. Install [Ollama](https://ollama.com) and pull your model:
   ```bash
   ollama pull qwen2.5:14b
   ```
2. Start Ollama (it runs as a background service on `http://localhost:11434`).
3. In CTT.AY Settings, set **Translation provider → Ollama (local)**, enter the base URL (`http://localhost:11434`) and model name (`qwen2.5:14b`).

Any model available in Ollama that supports the chat/JSON completion API works — `qwen2.5:7b`, `llama3.1:8b`, `mistral:7b`, etc. Smaller models are faster but less accurate for Dutch theological content.

---

## Running Locally — npm

Requirements: Node 20+, ffmpeg (`brew install ffmpeg` on Mac).

```bash
# 1. Copy the env template and fill in your keys
cp .env.example .env

# 2. Install dependencies
npm install

# 3a. Dev mode — API keys auto-fill in the browser from your .env
npm run dev

# 3b. Production mode — keys must be entered in the in-app Settings panel
npm run build && npm run start
```

Open `http://localhost:PORT` — default `5001`, but **check your `.env`** for a `PORT=` line that overrides it (the server logs `serving on port XXXX` on startup either way).

### Dev mode vs production mode

| | Dev (`npm run dev`) | Production (`npm run build && npm start`) |
|---|---|---|
| API keys | Auto-filled from `.env` — no need to type them in the browser | Must be entered in the Settings panel each session |
| Build | Vite HMR — live reload on file changes | Optimised static bundle |
| Port | 5001 (default) or `$PORT` | 5001 (default) or `$PORT` — same default, no dev/prod split |

In dev mode, the server exposes a `/api/dev-config` endpoint that returns `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from your `.env`. The browser reads these on startup and pre-fills the Settings fields. This endpoint returns **403 in production** — keys are never exposed in deployed builds.

---

## Running Locally — Docker

Requirements: Docker Desktop.

```bash
cp .env.example .env   # fill in your API keys
docker compose up --build
```

Open [http://localhost:5001](http://localhost:5001).

Unlike `npm run dev`, this port is **fixed at `5001`** even if your `.env` sets a different `PORT` — `docker-compose.yml` hardcodes `PORT: "5001"` in its `environment:` block, which takes precedence over whatever `.env` provides.

The container runs the production build (Vite client + esbuild server bundle). ffmpeg is included in the image.

> **⚠️ The `mlx` (local LLM / on-device Whisper) transcription provider does not work in Docker.** The Docker image (`Dockerfile`) is based on `node:20-alpine`, a Linux container — `mlx-whisper` depends on Apple's MLX framework, which only runs on Apple Silicon macOS, not Linux, and not inside a container even when Docker Desktop is hosted on an Apple Silicon Mac (the container's own kernel/CPU access is Linux/x86-virtualized, not native macOS). If you select `mlx` as the transcription provider while running via Docker, transcription requests will fail. Use `npm run dev` / `npm start` directly on macOS instead if you want the `mlx` provider — see [Local MLX Transcription](#local-mlx-transcription-apple-silicon-only). The other three transcription backends (`whisper` via OpenAI, `browser`, `transformers`) all work fine in Docker.

---

## Local MLX Transcription (Apple Silicon only)

The `mlx` transcription provider runs `whisper-large-v3-mlx` fully on-device via a Python sidecar process (`server/python/mlx_worker.py`), using Apple's MLX framework. It is free, requires no API key, and stays fast because the model is kept loaded in memory between audio chunks.

Requirements:
- **macOS on Apple Silicon (M1/M2/M3/M4).** Not available on Intel Macs, Linux, Windows, or in Docker (see the warning above).
- A Python interpreter with `mlx-whisper` installed, pointed to via the `MLX_PYTHON` env var (see `.env.example`). Plain `python3` on PATH is often not the right interpreter if you installed `mlx-whisper` into a conda/venv environment.
- Run the app directly on the host with `npm run dev` or `npm run build && npm start` — not through `docker compose`.

---

## Simulating Mobile Latency in Development

On a local dev machine the audio chunk upload is instant (localhost). On a real phone over 4G, the same upload adds 500–1500 ms of lag on top of the normal API round-trip. To get a realistic feel during development, set `SIMULATE_LATENCY_MS` in your `.env`:

```bash
# .env
SIMULATE_LATENCY_MS=1500
```

This injects a 1.5 s delay at two points:
- **Before every `/api/` HTTP response** — simulates mobile network latency on translation calls.
- **After audio conversion in each WebSocket chunk** — simulates the time a phone takes to upload the audio blob over a real connection.

The server logs `Latency simulation enabled: +1500ms` as a reminder when this is active. Set back to `0` (or remove the line) to disable.

---

## Architecture

```
Browser
  ├── MediaRecorder  ──5 s chunks──►  WebSocket /ws/transcribe (max 10 MB)
  │     (Whisper path)                  ↓ ffmpeg (webm → mp3)
  │                                     ↓ OpenAI Whisper (transcription)
  │                                     ↓ GPT-4o-mini / Claude (correct + translate)
  │                                     ↓ ordered delivery back to browser
  │
  ├── Transformers.js  ──on-device──►  Local Whisper (tiny / small / medium)
  │     (Local Whisper path)            ↓ text sent to POST /api/translate
  │
  └── SpeechRecognition API  ──final text──►  POST /api/translate
        (Browser path, Chrome/Edge)            ↓ GPT-4o-mini / Claude
                                               ↓ JSON response to browser
```

### Key Technical Details

- **Chunk pipeline**: Each 5 s audio chunk is processed concurrently (ffmpeg → Whisper → LLM). Results are buffered and delivered strictly in recording order, even if a later chunk finishes faster.
- **Audio format**: `audio/webm;codecs=opus` preferred; falls back to `audio/mp4` on iOS Safari.
- **Raw preview**: Whisper's raw transcript is shown immediately as a grey preview while the correction/translation is still running.
- **Retroactive correction**: Every 5 completed sentences the full accumulated text is sent back to the LLM for a coherence and grammar pass.
- **Local Whisper**: Transformers.js models are downloaded once and cached by the browser; model sizes are ~40 MB (tiny), ~244 MB (small), ~769 MB (medium).
- **Session history**: Every recording is auto-saved to IndexedDB; sessions expire after 30 days.

---

## Running Tests

```bash
# Unit + integration tests (fast, no API calls)
npm test

# Regression tests — run explicitly when needed
npm run test:regression
```

The regression suite tests specific bugs that have been fixed (chunk ordering, validation, provider fallback). Run it before merging changes that touch the server pipeline.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | Node.js 20+, Express |
| Routing | Wouter |
| State | TanStack Query |
| Transcription | OpenAI Whisper (chunk-based WS) · Transformers.js (local) · Browser SpeechRecognition |
| Translation | OpenAI GPT-4o-mini · Claude (Anthropic) |
| Audio processing | ffmpeg via fluent-ffmpeg |
| Database | PostgreSQL via Drizzle ORM (Neon) |
| Offline / PWA | IndexedDB (session history) · Web App Manifest |
| Testing | Vitest + Supertest |

---

## Estimated Cost

With Whisper + GPT-4o-mini (both OpenAI):

- **Whisper**: ~$0.006 per minute of audio
- **GPT-4o-mini**: ~$0.001 per transcription chunk (very cheap)
- **Total**: roughly $0.01–0.02 per 1-hour session

Claude pricing is similar. Local Whisper + None translation is completely free.

## Export Options

- Plain text (`.txt`) or Markdown (`.md`)
- Export original transcription, translation, or both side-by-side
- Optional AI formatting pass before export
- Downloads locally to your device
