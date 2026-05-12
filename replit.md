# CTT.AY - Contextual Transcriptions & Translations

## Overview

CTT.AY (pronounced "stay") is a mobile-first web application for real-time audio transcription and multi-language translation. Short for **Contextual Transcriptions and Translations, Andrew Yong**. It uses a chunk-based Whisper pipeline for transcription and GPT-4o-mini or Claude for translation. The app prioritizes a distraction-free, readable experience with a focus on one-handed mobile operation.

## User Preferences

Preferred communication style: Simple, everyday language.
Default translation language: Dutch (nl)

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript (Vite build tool)
- **UI/UX**: shadcn/ui (Radix UI, Tailwind CSS), Material Design principles (mobile-first, content-focused, thumb-reach accessibility), dark/light theme support.
- **State Management**: React hooks for local state, TanStack Query for server state.
- **Routing**: Wouter for client-side routing.
- **Audio Streaming**: WebSocket-based real-time audio streaming using Web Audio API at 16kHz sample rate, PCM16 format.
- **Key Features**: Chunk-based transcription, partial transcript display, live re-translation on target language change, collapsible configuration, retroactive text correction, provider selection, user-supplied API keys.

### Backend Architecture
- **Runtime**: Node.js with Express.js.
- **API**: RESTful endpoints for retranslation, retroactive correction, export formatting, and Google Drive integration.
- **WebSocket**: `/ws/transcribe` endpoint for chunk-based audio (max 10 MB payload).
- **Streaming Pipeline**: Browser audio → WebSocket chunks → Whisper API → Transcription → GPT-4o-mini or Claude (correction, translation) → Browser.
- **Database**: Drizzle ORM for PostgreSQL (Neon Database).

### System Design Choices
- **Real-time Processing**: Emphasis on immediate transcription and translation.
- **Error Handling**: Comprehensive client and server-side error handling with user-friendly notifications.
- **Responsiveness**: Mobile-first design ensures optimal experience on small screens.
- **Provider Flexibility**: Users can choose transcription/translation providers and supply their own API keys at runtime.

## External Dependencies

- **OpenAI API**:
    - **Whisper**: Chunk-based transcription.
    - **GPT-4o-mini**: Text correction, multi-language translation, export formatting.
- **Anthropic API**: Claude as an optional translation provider.
- **Audio Processing**:
    - **Client-side**: Web Audio API for real-time audio capture at 16kHz, PCM16 format.
    - **Server-side**: Chunk-based WebSocket handler with 10 MB payload limit.
- **Database**: Neon Database (PostgreSQL) via Drizzle ORM.
- **API Key Management**: `OPENAI_API_KEY` environment variable (required); `ANTHROPIC_API_KEY` optional.
- **Build/Development Tools (Replit-specific)**: `@replit/vite-plugin-runtime-error-modal`, `@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`.
- **Supported Languages**: English, Spanish, French, German, Dutch, Portuguese, Italian, Chinese (Simplified), Chinese (Traditional), Arabic, Farsi, Hindi, Russian, Japanese, Korean.

## Key Features

1. **Chunk-based Transcription** — Audio sent in segments to Whisper; silence detection prevents hallucinations from background noise
2. **Local Whisper (Transformers.js)** — On-device inference with tiny/small/medium models; no API key required after initial download
3. **Multi-language Translation** — Real-time translation to 15 languages (default: Dutch)
4. **Live Re-translation** — Change target language mid-recording
5. **Provider Selection** — Choose transcription and translation provider in Settings; supply your own API keys
6. **Retroactive Correction** — Grammar and coherence checks every 5 sentences
7. **Export** — Download transcripts as TXT/MD with AI formatting; upload to Google Drive
8. **Session History** — IndexedDB-backed session log with export and delete per session
9. **PWA / Add to Home Screen** — Installable on Android and iOS, opens fullscreen
10. **Dark/Light Theme** — Automatic detection with manual toggle
