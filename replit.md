# SermonScribe - Live Sermon Transcription & Translation App

## Overview

SermonScribe is a mobile-first web application designed for real-time sermon transcription and translation. The app allows users to record audio during sermons, transcribe speech to text using OpenAI's Whisper model, correct transcription errors, and translate the content into multiple languages. The application prioritizes readability, minimal distraction, and one-handed mobile operation to enhance the spiritual and educational experience.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework**: React with TypeScript using Vite as the build tool

**UI Component Library**: shadcn/ui (Radix UI primitives) with Tailwind CSS for styling

**Design System**: Material Design principles adapted for mobile-first, content-focused usage
- Typography: Roboto for primary text, Roboto Mono for technical indicators
- Spacing: Tailwind utility classes with consistent 2/4/6/8 unit system
- Layout: Full-width mobile container with sticky header and flexible content areas

**State Management**: 
- React hooks (useState, useRef, useEffect) for local component state
- TanStack Query (React Query) for server state management and caching
- No global state management library (Redux/Zustand) - using lightweight local state

**Routing**: Wouter for minimal client-side routing

**Key Design Decisions**:
- Mobile-first responsive design with thumb-reach accessibility
- Dark/light theme support with system preference detection and localStorage persistence
- Continuous audio recording using browser MediaRecorder API with:
  - Built-in 10-second timeslice parameter for automatic chunk generation
  - Simple event handlers (ondataavailable, onstop) without manual stop/restart logic
  - Optimized audio settings (echo cancellation, noise suppression, 44.1kHz sample rate)
  - Queue-based sequential processing to prevent chunk loss during API calls
  - Server-side ffmpeg conversion from WebM to WAV for Whisper API compatibility

### Backend Architecture

**Runtime**: Node.js with Express.js server

**API Structure**: RESTful API with single primary endpoint:
- POST `/api/transcribe` - Accepts audio file upload, returns transcribed and translated text

**File Upload Handling**: Multer middleware for multipart form data
- Temporary file storage in `/tmp/uploads/`
- 25MB file size limit
- Automatic cleanup after processing

**Audio Processing Pipeline**:
- Accepts WebM chunks from browser MediaRecorder
- Uses ffmpeg to convert WebM to WAV format (16kHz mono PCM)
- WAV files are Whisper-compatible and ensure reliable transcription
- Temporary files (both WebM and WAV) are cleaned up immediately after processing

**Key Design Decisions**:
- Express middleware for request logging and JSON parsing with raw body capture
- Development-only Vite integration for HMR (Hot Module Replacement)
- Production build serves static React app from compiled output
- In-memory user storage (MemStorage) - database schema defined but not actively used
- Server-side audio format conversion isolates complexity from frontend

### Data Storage Solutions

**Database ORM**: Drizzle ORM configured for PostgreSQL

**Database Provider**: Neon Database (serverless PostgreSQL)

**Schema Design**:
- `users` table: Basic authentication structure (id, username, password)
- `transcriptions` table: Stores transcription history (id, originalText, translatedText, targetLanguage, timestamp)

**Current State**: Database schema is defined but application currently operates statelessly - transcriptions are not persisted. The storage layer exists as infrastructure for future feature expansion.

**Rationale**: The application prioritizes real-time interaction over historical data retention. Database integration is prepared but not activated to reduce complexity and latency in the initial implementation.

## Implementation Status (Last Updated: November 11, 2025)

### Completed Features ✓
1. **Continuous Live Transcription**: Audio is automatically processed every 10 seconds while recording
   - MediaRecorder's built-in timeslice (10000ms) automatically generates chunks
   - Simple event-driven architecture with ondataavailable handler
   - Queue-based chunk processing ensures sequential, in-order transcription
   - Server-side ffmpeg conversion from WebM to WAV ensures Whisper API compatibility
   - Transcriptions appear in real-time as they're processed
2. **Source Language Selection**: Users can specify the source language for better transcription accuracy
   - Dropdown selector with all 12 supported languages
   - Passed to Whisper API to improve recognition and reduce processing time
   - Side-by-side with target language selector for clear UX
3. **Speech-to-Text Transcription**: Real-time audio transcription using OpenAI Whisper
4. **Text Correction**: Automatic removal of stutters, filler words, and verbal mistakes using GPT-4o
5. **Multi-Language Translation**: Support for 14 languages with real-time translation
   - Includes Dutch language support
   - Separate options for Simplified Chinese (zh) and Traditional Chinese (zh-TW)
6. **Mobile-Optimized UI**: Responsive design with thumb-reach accessibility
7. **Dark Mode**: System preference detection with manual toggle
8. **Error Handling**: Comprehensive error handling with user-friendly toast notifications
   - Explicit messaging when OpenAI API credits are insufficient
9. **File Management**: Automatic cleanup of temporary audio files (both WebM and WAV) after processing
10. **Session Management**: Prevents starting new recordings while previous chunks are processing

### API Endpoints
- **POST /api/transcribe**: Accepts multipart/form-data with audio file, source language, and target language
  - Input: Audio blob (WebM format) + sourceLanguage + targetLanguage (en, es, fr, de, nl, pt, it, zh, zh-TW, ar, hi, ru, ja, ko)
  - Processing Pipeline:
    1. Rename uploaded file to `.webm` extension
    2. Convert WebM to WAV using fluent-ffmpeg library (16kHz mono PCM) with error tolerance flags
    3. Send WAV to Whisper API with specified source language
    4. Correct transcription with GPT-4o
    5. Translate corrected text to target language with GPT-4o
    6. Clean up temporary WebM and WAV files
  - Output: JSON with correctedText (original) and translatedText
  - Error handling: Returns 400 for missing files, 500 with details for processing/conversion errors

### Component Architecture
- **Header**: App title, theme toggle, sticky positioning
- **LanguageSelector**: Shadcn select component with 14 language options (used for both source and target)
  - Includes Dutch (nl) and separate Chinese variants (zh for Simplified, zh-TW for Traditional)
- **RecordButton**: Large circular FAB with recording/processing/idle states
- **RecordingIndicator**: Animated badge showing active recording status
- **TranscriptionDisplay**: Auto-scrolling text areas for original and translated content
- **Home**: Main page orchestrating all components with simplified recording state management
  - MediaRecorder with built-in timeslice (10000ms) for automatic chunking
  - Event handlers: `ondataavailable` for chunk capture, `onstop` for finalization
  - Queue-based chunk processing with `chunkQueueRef` and `isProcessingQueueRef`
  - Sequential API calls via `processNextChunk()` and `enqueueAudioChunk()`
  - Graceful completion waiting for queue to drain before notifying user
  - No manual stop/restart logic - relies on MediaRecorder's automatic timeslice behavior

### Future Enhancements
- Export transcriptions to PDF/TXT formats
- Save transcription history to database
- Speaker identification for multi-person sermons
- Custom vocabulary for religious terminology
- Offline recording with batch processing

### Authentication and Authorization

**Current Implementation**: Basic user schema exists but no active authentication flow

**Future Consideration**: User storage interface (IStorage) provides abstraction for future auth implementation with methods for user creation and retrieval

**Decision**: Authentication deferred to prioritize core transcription/translation functionality

### External Dependencies

**OpenAI API Integration**:
- **Whisper API** (audio.transcriptions.create): Converts recorded audio to text in specified source language
  - Accepts WAV format (16kHz mono PCM) converted from WebM chunks
  - Source language parameter improves accuracy and reduces processing time
- **GPT-4o Chat Completions**: Performs two-step text processing:
  1. Cleans transcription by removing stutters, filler words, and verbal mistakes
  2. Translates corrected text to target language
- Error correction prompt engineered to preserve sermon content meaning while improving readability
- Startup validation ensures OPENAI_API_KEY is present before server starts

**Supported Languages**: 14 languages including English, Spanish, French, German, Dutch, Portuguese, Italian, Chinese (Simplified), Chinese (Traditional), Arabic, Hindi, Russian, Japanese, Korean

**Audio Processing**:
- **Client**: Browser MediaRecorder produces WebM chunks (10s each)
- **Server**: Uses fluent-ffmpeg library to convert WebM to WAV (16kHz mono PCM) before Whisper processing
  - Includes error detection flags (`-err_detect ignore_err`) to handle malformed WebM chunks from MediaRecorder
  - Security fix: Replaced unsafe shell command execution with fluent-ffmpeg library
- **Rationale**: MediaRecorder timeslice chunks lack proper WebM headers; server-side conversion ensures compatibility

**API Key Management**: Environment variable (`OPENAI_API_KEY`) for authentication

**System Dependencies**:
- **ffmpeg**: Required for audio format conversion (WebM → WAV)

**Replit-Specific Dependencies**:
- `@replit/vite-plugin-runtime-error-modal`: Development error overlay
- `@replit/vite-plugin-cartographer`: Development tooling integration
- `@replit/vite-plugin-dev-banner`: Development environment indicator

**Build and Development Tools**:
- TypeScript for type safety across client and server
- ESBuild for server bundling in production
- PostCSS with Autoprefixer for CSS processing
- Drizzle Kit for database migrations