# SermonScribe

A mobile-first web application for real-time sermon transcription and multi-language translation. Designed for distraction-free, one-handed mobile use during services.

## What It Does

- **Real-time transcription** — Captures spoken audio and converts it to text with ~300ms latency using AssemblyAI's streaming API.
- **Automatic translation** — Translates transcribed text into your chosen language (default: Dutch) using GPT-4o-mini.
- **Live language switching** — Change the target language mid-recording and all text re-translates on the fly.
- **Speaker detection** — Optionally identifies and labels different speakers.
- **Retroactive correction** — Every 5 sentences, GPT-4o-mini reviews and improves grammar and coherence.
- **Export** — Download transcripts as plain text or Markdown, or upload directly to Google Drive.
- **RTL support** — Right-to-left layout for Arabic and Farsi.
- **Dark/light theme** — Automatic detection with manual toggle.

## Supported Languages

English, Spanish, French, German, Dutch, Portuguese, Italian, Chinese (Simplified), Chinese (Traditional), Arabic, Farsi, Hindi, Russian, Japanese, Korean.

## Getting Started

### Required Environment Variables

| Variable | Description |
|---|---|
| `ASSEMBLYAI_API_KEY` | AssemblyAI API key for real-time transcription |
| `OPENAI_API_KEY` | OpenAI API key for translation and correction |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for session management |

### Running Locally

```bash
npm install
npm run dev
```

The app runs on port 5000 by default. Open `http://localhost:5000` in your browser.

## Architecture

```
Browser (Web Audio API, 16kHz PCM16)
  ↓ WebSocket /ws/transcribe
Express + Node.js backend
  ↓ WebSocket relay
AssemblyAI Real-time API (~300ms latency)
  ↓ transcription result
GPT-4o-mini (correction + translation)
  ↓ 500ms debounce
Browser display
```

### Key Technical Details

- **Audio format**: 16kHz sample rate, PCM16 mono, captured via `ScriptProcessorNode`
- **Silence detection**: Skips audio chunks with average volume below 0.01 to prevent hallucinations from background noise
- **Word boost**: AssemblyAI is configured to boost recognition of religious terms (sermon, scripture, bible, gospel, faith, prayer, amen)
- **Translation debounce**: 500ms window to batch partial transcripts before sending to GPT-4o-mini
- **Retroactive correction**: Full paragraph review every 5 completed sentences

### Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | Node.js, Express |
| Routing | Wouter |
| State | TanStack Query |
| Transcription | AssemblyAI Real-time WebSocket API |
| AI / Translation | OpenAI GPT-4o-mini |
| Database | PostgreSQL via Drizzle ORM (Neon) |
| File Storage | Google Drive API |

## Estimated Cost

- **AssemblyAI**: ~€0.14/hour of transcription
- **OpenAI**: Minimal — GPT-4o-mini is used only for translation and correction, not audio processing

## Export Options

- Plain text (`.txt`) or Markdown (`.md`)
- Export original, translation, or both side-by-side
- Download locally or save to Google Drive (with folder selection)
