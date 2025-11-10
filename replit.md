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
- Real-time audio recording using browser MediaRecorder API with optimized audio settings (echo cancellation, noise suppression, 44.1kHz sample rate)

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

### Authentication and Authorization

**Current Implementation**: Basic user schema exists but no active authentication flow

**Future Consideration**: User storage interface (IStorage) provides abstraction for future auth implementation with methods for user creation and retrieval

**Decision**: Authentication deferred to prioritize core transcription/translation functionality

### External Dependencies

**OpenAI API Integration**:
- **Whisper API** (audio.transcriptions.create): Converts recorded audio to English text
- **GPT-5 Chat Completions**: Performs two-step text processing:
  1. Cleans transcription by removing stutters, filler words, and verbal mistakes
  2. Translates corrected text to target language
- Error correction prompt engineered to preserve sermon content meaning while improving readability

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