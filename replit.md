# SermonScribe - Live Sermon Transcription & Translation App

## Overview

SermonScribe is a mobile-first web application for real-time sermon transcription and multi-language translation. It leverages OpenAI's Whisper for speech-to-text and GPT-4o-mini for text correction and translation. The app prioritizes a distraction-free, readable experience with a focus on one-handed mobile operation for an enhanced spiritual and educational journey.

## User Preferences

Preferred communication style: Simple, everyday language.
Default translation language: Dutch (nl)

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

## Key Features

1. **Continuous Live Transcription** - Audio processed every 5 seconds with book-style formatting
2. **Silence Detection** - Prevents Whisper hallucinations from background noise
3. **Multi-language Translation** - Real-time translation to 15 languages (default: Dutch)
4. **Live Re-translation** - Change target language mid-recording
5. **Retroactive Correction** - Grammar and coherence checks every 5 sentences
6. **Speaker Detection** - Optional speaker identification and labeling
7. **Export Functionality** - Download transcripts as TXT/MD with AI formatting
8. **Collapsible Configuration** - Space-saving UI for language settings
9. **Enhanced Text Visibility** - Minimum 200px height for comfortable reading
10. **Dark/Light Theme** - Automatic theme detection with manual toggle

## Recent Updates (November 12, 2025)

### Silence Detection
- Client-side audio volume analysis using Web Audio API
- Skips chunks with average volume < 0.01
- Prevents "Thanks for watching" hallucinations from fan noise
- Graceful error handling if analysis fails

### Export Features
- Export original text, translation, or both side-by-side
- File formats: plain text (.txt) or Markdown (.md)
- GPT-4o-mini final formatting with proper line breaks and punctuation
- Minor corrections marked with asterisks for transparency
- Local file download with timestamped filenames
- Google Drive export placeholder (ready for connector integration)

### Default Language
- Changed default translation language from Spanish to Dutch (nl)

### Google Drive Integration
- Users can now upload transcripts directly to Google Drive
- Folder selector allows choosing specific Drive folders for upload
- Supports both plain text and Markdown file formats
- Automatic folder loading with root folder fallback

### Cross-Platform Download Support
- Download functionality works on iOS (Safari 13.2+), Android Chrome, and desktop browsers
- Uses setTimeout delay for Safari compatibility
- Proper MIME type handling for txt and md files
- Timestamped filenames for easy organization