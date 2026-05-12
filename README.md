# CTT.AY

**Contextual Transcriptions & Translations — Andrew Yong**
Pronounced *"stay"*.

A mobile-first web application for real-time audio transcription and multi-language translation. Designed for one-handed use — start it, put your phone down, read the live translation.

---

## What It Does

- **Real-time transcription** — Captures spoken audio via the browser microphone and converts it to text using OpenAI Whisper (paid, high accuracy) or the free Browser Speech API.
- **On-device transcription** — Optional local Whisper via Transformers.js (tiny / small / medium models). Downloads once, runs entirely offline thereafter.
- **Automatic translation** — Translates each transcribed chunk into your chosen language using OpenAI GPT-4o-mini or Claude. Can also run translation-free (transcription only).
- **Live language switching** — Change the target language mid-recording; all accumulated text re-translates on the fly.
- **Speaker detection** — Optionally identifies and labels different speakers.
- **Retroactive correction** — Every 5 sentences, the AI reviews the full accumulated text for grammar and coherence.
- **Export** — Download transcripts as plain text or Markdown, or upload directly to Google Drive.
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

## API Providers & Free Mode

All API keys are entered in the in-app Settings (⚙︎ icon). Keys are stored only in your browser's `sessionStorage` and are never sent to this server's storage — they travel directly to OpenAI or Anthropic with each request.

| Provider | Cost | What it does |
|---|---|---|
| **OpenAI Whisper** | ~$0.006/min | Highest accuracy transcription |
| **Local Whisper** | Free (after model download) | On-device Transformers.js inference |
| **Browser Speech API** | Free | Transcription via the browser — Chrome/Edge only |
| **OpenAI GPT-4o-mini** | ~$0.001/request | Fast translation + grammar correction |
| **Claude** | Free tier available | High-quality translation |
| **None** | Free | Raw transcription only, no translation or correction |

**Fully free mode:** Browser Speech API + None translation. No API keys needed. Works best in Chrome or Edge on a desktop.

---

## Running Locally — npm

Requirements: Node 20+, ffmpeg (`brew install ffmpeg` on Mac).

```bash
# 1. Copy the env template and fill in your keys
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start the dev server (reads .env automatically)
npm run dev
```

Open [http://localhost:5001](http://localhost:5001).

The `.env.example` file documents all available variables. At minimum, set `OPENAI_API_KEY` if you want Whisper transcription, or leave keys empty to use Browser Speech + None for free.

---

## Running Locally — Docker

Requirements: Docker Desktop.

```bash
cp .env.example .env   # fill in your API keys
docker compose up --build
```

Open [http://localhost:5001](http://localhost:5001).

The container runs the production build (Vite client + esbuild server bundle). ffmpeg is included in the image.

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
| File Storage | Google Drive API |
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
- Download locally or save to Google Drive (requires Google Drive connector configured in Replit)
