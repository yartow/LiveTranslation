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
  - 10-second timeslice for real-time chunk processing
  - Optimized audio settings (echo cancellation, noise suppression, 44.1kHz sample rate)
  - Queue-based sequential processing to prevent chunk loss during API calls

### Backend Architecture

**Runtime**: Node.js with Express.js server

**API Structure**: RESTful API with single primary endpoint:
- POST `/api/transcribe` - Accepts audio file upload, returns transcribed and translated text

**File Upload Handling**: Multer middleware for multipart form data
- Temporary file storage in `/tmp/uploads/`
- 25MB file size limit
- Automatic cleanup after processing

**Key Design Decisions**:
- Express middleware for request logging and JSON parsing with raw body capture
- Development-only Vite integration for HMR (Hot Module Replacement)
- Production build serves static React app from compiled output
- In-memory user storage (MemStorage) - database schema defined but not actively used

### Data Storage Solutions

**Database ORM**: Drizzle ORM configured for PostgreSQL

**Database Provider**: Neon Database (serverless PostgreSQL)

**Schema Design**:
- `users` table: Basic authentication structure (id, username, password)
- `transcriptions` table: Stores transcription history (id, originalText, translatedText, targetLanguage, timestamp)

**Current State**: Database schema is defined but application currently operates statelessly - transcriptions are not persisted. The storage layer exists as infrastructure for future feature expansion.

**Rationale**: The application prioritizes real-time interaction over historical data retention. Database integration is prepared but not activated to reduce complexity and latency in the initial implementation.

## Implementation Status (Last Updated: November 10, 2025)

### Completed Features ✓
1. **Continuous Live Transcription**: Audio is automatically processed every 10 seconds while recording
   - MediaRecorder captures 10-second audio chunks using timeslice
   - Queue-based chunk processing ensures sequential, in-order transcription
   - Prevents chunk dropping during long API calls
   - Transcriptions appear in real-time as they're processed
2. **Speech-to-Text Transcription**: Real-time audio transcription using OpenAI Whisper
3. **Text Correction**: Automatic removal of stutters, filler words, and verbal mistakes using GPT-4o
4. **Multi-Language Translation**: Support for 12 languages with real-time translation
5. **Mobile-Optimized UI**: Responsive design with thumb-reach accessibility
6. **Dark Mode**: System preference detection with manual toggle
7. **Error Handling**: Comprehensive error handling with user-friendly toast notifications
   - Explicit messaging when OpenAI API credits are insufficient
8. **File Management**: Automatic cleanup of temporary audio files after processing
9. **Session Management**: Prevents starting new recordings while previous chunks are processing

### API Endpoints
- **POST /api/transcribe**: Accepts multipart/form-data with audio file and target language
  - Input: Audio blob (WebM format) + target language code (en, es, fr, de, pt, it, zh, ar, hi, ru, ja, ko)
  - Output: JSON with correctedText and translatedText
  - Processing: Whisper transcription → GPT-4o correction → GPT-4o translation
  - Error handling: Returns 400 for missing files, 500 with details for processing errors

### Component Architecture
- **Header**: App title, theme toggle, sticky positioning
- **LanguageSelector**: Shadcn select component with 12 language options
- **RecordButton**: Large circular FAB with recording/processing/idle states
- **RecordingIndicator**: Animated badge showing active recording status
- **TranscriptionDisplay**: Auto-scrolling text areas for original and translated content
- **Home**: Main page orchestrating all components with continuous transcription state management
  - Queue-based chunk processing with `chunkQueueRef` and `isProcessingQueueRef`
  - Sequential API calls via `processNextChunk()` and `enqueueAudioChunk()`
  - Graceful completion waiting for queue to drain before notifying user

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
- **Whisper API** (audio.transcriptions.create): Converts recorded audio to English text
- **GPT-4o Chat Completions**: Performs two-step text processing:
  1. Cleans transcription by removing stutters, filler words, and verbal mistakes
  2. Translates corrected text to target language
- Error correction prompt engineered to preserve sermon content meaning while improving readability
- Startup validation ensures OPENAI_API_KEY is present before server starts

**Supported Languages**: 12 languages including English, Spanish, French, German, Portuguese, Italian, Chinese, Arabic, Hindi, Russian, Japanese, Korean

**Audio Format**: WebM format from browser MediaRecorder, processed server-side

**API Key Management**: Environment variable (`OPENAI_API_KEY`) for authentication

**Replit-Specific Dependencies**:
- `@replit/vite-plugin-runtime-error-modal`: Development error overlay
- `@replit/vite-plugin-cartographer`: Development tooling integration
- `@replit/vite-plugin-dev-banner`: Development environment indicator

**Build and Development Tools**:
- TypeScript for type safety across client and server
- ESBuild for server bundling in production
- PostCSS with Autoprefixer for CSS processing
- Drizzle Kit for database migrations