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
- Typography: Avenir Next for primary text, system monospace for technical indicators
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
  - Built-in 5-second timeslice parameter for automatic chunk generation (faster live text appearance)
  - Simple event handlers (ondataavailable, onstop) without manual stop/restart logic
  - Optimized audio settings (echo cancellation, noise suppression, 44.1kHz sample rate)
  - Queue-based sequential processing to prevent chunk loss during API calls
  - Server-side ffmpeg conversion from WebM to MP3 for Whisper API compatibility (handles incomplete chunks)

### Backend Architecture

**Runtime**: Node.js with Express.js server

**API Structure**: RESTful API with single primary endpoint:
- POST `/api/transcribe` - Accepts audio file upload, returns transcribed and translated text

**File Upload Handling**: Multer middleware for multipart form data
- Temporary file storage in `/tmp/uploads/`
- 25MB file size limit
- Automatic cleanup after processing

**Audio Processing Pipeline**:
- Accepts WebM chunks from browser MediaRecorder (incomplete chunks lack proper EBML headers)
- Uses fluent-ffmpeg library to convert WebM to MP3 format (16kHz mono)
- MP3 files are Whisper-compatible and handle incomplete stream chunks gracefully
- Temporary files (both WebM and MP3) are cleaned up immediately after processing

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
1. **Continuous Live Transcription**: Audio is automatically processed every 5 seconds while recording
   - MediaRecorder's built-in timeslice (5000ms) automatically generates chunks for faster live text
   - Simple event-driven architecture with ondataavailable handler
   - Queue-based chunk processing ensures sequential, in-order transcription
   - Server-side ffmpeg conversion from WebM to MP3 handles incomplete chunk headers
   - Transcriptions appear in real-time as they're processed (5s latency)
2. **Source Language Selection**: Users can specify the source language for better transcription accuracy
   - Dropdown selector with all 12 supported languages
   - Passed to Whisper API to improve recognition and reduce processing time
   - Side-by-side with target language selector for clear UX
3. **Speech-to-Text Transcription**: Real-time audio transcription using OpenAI Whisper
4. **Text Correction**: Automatic removal of stutters, filler words, and verbal mistakes using GPT-4o-mini (2-3x faster, 60-80% cheaper than GPT-4o)
5. **Multi-Language Translation**: Support for 15 languages with real-time translation using GPT-4o-mini
   - Includes Dutch and Farsi language support
   - Separate options for Simplified Chinese (zh) and Traditional Chinese (zh-TW)
   - Right-to-left (RTL) text support for Arabic and Farsi
6. **Mobile-Optimized UI**: Responsive design with thumb-reach accessibility
7. **Dark Mode**: System preference detection with manual toggle
8. **Error Handling**: Comprehensive error handling with user-friendly toast notifications
   - Explicit messaging when OpenAI API credits are insufficient
9. **File Management**: Automatic cleanup of temporary audio files (both WebM and MP3) after processing
10. **Session Management**: Prevents starting new recordings while previous chunks are processing
11. **Live Re-translation**: Change target language during recording with automatic re-translation
   - Target language selector enabled during active recording
   - Segment-based caching prevents race conditions when new chunks arrive
   - Monotonic UI updates - translation never regresses to stale snapshots
   - Re-translation queues automatically when processing completes
   - Full transcript rebuilt from cached segments for smooth UX
12. **Speaker Detection**: Optional feature to identify and label different speakers
   - Checkbox toggle to enable/disable speaker detection
   - Uses GPT-4o-mini conversation pattern analysis (not dedicated diarization service)
   - Labels speakers incrementally as "Speaker 1:", "Speaker 2:", etc.
   - Retranslates all existing segments when toggled on/off for consistency
   - Disabled during active recording to prevent mid-session configuration changes

### API Endpoints
- **POST /api/transcribe**: Accepts multipart/form-data with audio file, source language, target language, and speaker detection flag
  - Input: Audio blob (WebM format) + sourceLanguage + targetLanguage (en, es, fr, de, nl, pt, it, zh, zh-TW, ar, fa, hi, ru, ja, ko) + detectSpeakers (boolean)
  - Processing Pipeline:
    1. Rename uploaded file to `.webm` extension
    2. Convert WebM to MP3 (16kHz mono) using fluent-ffmpeg with lenient error flags (-err_detect ignore_err)
    3. Send MP3 to Whisper API with specified source language
    4. Correct transcription with GPT-4o-mini (optionally detecting speakers if flag enabled)
    5. Translate corrected text to target language with GPT-4o-mini
    6. Clean up temporary WebM and MP3 files
  - Output: JSON with correctedText (original) and translatedText
  - Error handling: Returns 400 for missing files, 500 with details for processing/conversion errors

- **POST /api/retranslate**: Re-translates existing transcription text to new target language and/or speaker detection setting
  - Input: JSON with originalText + targetLanguage + detectSpeakers
  - Processing: Translates full text to new language using GPT-4o-mini (with optional speaker detection)
  - Output: JSON with translatedText
  - Used when user changes target language or toggles speaker detection during/after recording

### Component Architecture
- **Header**: App title, theme toggle, sticky positioning
- **LanguageSelector**: Shadcn select component with 15 language options (used for both source and target)
  - Includes Dutch (nl), Farsi (fa), and separate Chinese variants (zh for Simplified, zh-TW for Traditional)
  - Exports getLanguageRTL() helper function to determine text direction
- **RecordButton**: Large circular FAB with recording/processing/idle states
- **RecordingIndicator**: Animated badge showing active recording status
- **TranscriptionDisplay**: Auto-scrolling text areas for original and translated content
  - Supports right-to-left (RTL) text direction for Arabic and Farsi
  - Automatically applies correct text direction based on selected language
- **Home**: Main page orchestrating all components with simplified recording state management
  - MediaRecorder with built-in timeslice (5000ms) for automatic chunking
  - Event handlers: `ondataavailable` for chunk capture, `onstop` for finalization
  - Queue-based chunk processing with `chunkQueueRef` and `isProcessingQueueRef`
  - Sequential API calls via `processNextChunk()` and `enqueueAudioChunk()`
  - Segment-based caching in `transcriptionSegmentsRef` for re-translation support
  - Live re-translation when target language changes (gates on isProcessing and isRetranslating)
  - Monotonic translation updates - rebuilds UI from all segments to prevent regression
  - Race condition handling - tracks segment count and queues re-translation if new chunks arrive
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
  - Accepts MP3 format (16kHz mono) converted from WebM chunks using fluent-ffmpeg
  - Source language parameter improves accuracy and reduces processing time
  - Handles incomplete stream chunks gracefully (MediaRecorder chunks lack proper EBML headers)
- **GPT-4o-mini Chat Completions**: Performs text processing (2-3x faster and 60-80% cheaper than GPT-4o):
  1. Cleans transcription by removing stutters, filler words, and verbal mistakes
  2. Optionally detects and labels different speakers based on conversation patterns ("Speaker 1:", "Speaker 2:", etc.)
  3. Translates corrected text to target language (both initial and re-translation)
- Error correction prompt engineered to preserve sermon content meaning while improving readability
- Speaker detection uses conversation pattern analysis without dedicated diarization service
- Startup validation ensures OPENAI_API_KEY is present before server starts

**Supported Languages**: 15 languages including English, Spanish, French, German, Dutch, Portuguese, Italian, Chinese (Simplified), Chinese (Traditional), Arabic, Farsi, Hindi, Russian, Japanese, Korean

**Audio Processing**:
- **Client**: Browser MediaRecorder produces WebM chunks (5s each)
- **Server**: Converts WebM to MP3 using fluent-ffmpeg before sending to Whisper API
- **Rationale**: MediaRecorder chunks lack proper EBML headers after first chunk; MP3 conversion ensures compatibility

**API Key Management**: Environment variable (`OPENAI_API_KEY`) for authentication

**System Dependencies**:
- fluent-ffmpeg: Node.js library for WebM to MP3 audio conversion (handles incomplete chunk headers)

**Replit-Specific Dependencies**:
- `@replit/vite-plugin-runtime-error-modal`: Development error overlay
- `@replit/vite-plugin-cartographer`: Development tooling integration
- `@replit/vite-plugin-dev-banner`: Development environment indicator

**Build and Development Tools**:
- TypeScript for type safety across client and server
- ESBuild for server bundling in production
- PostCSS with Autoprefixer for CSS processing
- Drizzle Kit for database migrations