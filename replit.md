# SermonScribe - Live Sermon Transcription & Translation App

## Overview

SermonScribe is a mobile-first web application for real-time sermon transcription and multi-language translation. It leverages OpenAI's Whisper for speech-to-text and GPT-4o-mini for text correction and translation. The app prioritizes a distraction-free, readable experience with a focus on one-handed mobile operation for an enhanced spiritual and educational journey.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript (Vite build tool)
- **UI/UX**: shadcn/ui (Radix UI, Tailwind CSS), Material Design principles (mobile-first, content-focused, thumb-reach accessibility), dark/light theme support.
- **State Management**: React hooks for local state, TanStack Query for server state.
- **Routing**: Wouter for client-side routing.
- **Key Features**: Continuous audio recording using MediaRecorder (restarts every 5s for standalone WebM chunks), queue-based sequential audio processing, real-time transcription display with book-style formatting, live re-translation on target language change, collapsible configuration, retroactive text correction every 5 sentences, optional speaker detection.

### Backend Architecture
- **Runtime**: Node.js with Express.js.
- **API**: RESTful, primarily `POST /api/transcribe` for audio processing.
- **File Handling**: Multer for multipart form data, temporary file storage, automatic cleanup.
- **Audio Processing Pipeline**: Converts WebM to MP3 using FFmpeg, sends to Whisper API, processes text with GPT-4o-mini (correction, translation, speaker detection), cleans up temporary files.
- **Database**: Drizzle ORM for PostgreSQL (Neon Database). Schema defined for `users` and `transcriptions`, but currently operates statelessly, prioritizing real-time functionality over persistence.

### System Design Choices
- **Real-time Processing**: Emphasis on immediate transcription and translation.
- **Error Handling**: Comprehensive client and server-side error handling with user-friendly notifications.
- **Responsiveness**: Mobile-first design ensures optimal experience on small screens.
- **Scalability**: Backend designed to handle audio processing efficiently, with a clear path for future database integration.

## External Dependencies

- **OpenAI API**:
    - **Whisper API**: For speech-to-text transcription (accepts MP3, converted from WebM).
    - **GPT-4o-mini**: For text correction (removing filler words, book-style formatting, retroactive coherence checks), multi-language translation (initial and re-translation), and optional speaker detection.
- **Audio Processing**:
    - **Client-side**: Browser MediaRecorder API for audio capture.
    - **Server-side**: `fluent-ffmpeg` for WebM to MP3 conversion with aggressive error handling.
- **Database**: Neon Database (PostgreSQL) integrated via Drizzle ORM.
- **API Key Management**: `OPENAI_API_KEY` environment variable.
- **Build/Development Tools (Replit-specific)**: `@replit/vite-plugin-runtime-error-modal`, `@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`.
- **Supported Languages**: English, Spanish, French, German, Dutch, Portuguese, Italian, Chinese (Simplified), Chinese (Traditional), Arabic, Farsi, Hindi, Russian, Japanese, Korean.