// Sermon-mode chunk limits. Kept DOM/React-free so scripts (asr-eval, asr-replay) can
// simulate exactly what the app does without a copy that could drift.

// Sermon-mode chunking. Whisper is trained on up-to-30 s windows and is much
// more accurate (and far less prone to hallucinating) on several seconds of
// context than on the 1-3 s fragments a short pause threshold produces — a
// preacher pauses constantly. So: a VAD cut is only allowed once
// SERMON_MIN_CHUNK_MS of audio is buffered, the pause that triggers it is a
// natural-sentence-gap length, and SERMON_MAX_CHUNK_MS is a hard cap kept well
// under Whisper's 30 s window. Cutting on silence (rather than a fixed
// duration) also means boundaries land between words, which is what makes
// chunkOverlapMs:0 safe here.
//
// 4 s / 15 s (was 6 s / 20 s): text only appears once its chunk is transcribed,
// so chunk length is most of what the operator waits for. `npm run eval:asr`
// (4 clips, 2 runs): 4 s min = 7.6% WER, same as 6 s min, no worse gaps, avg
// chunk 6.6 s vs ~9 s; 3 s min = 8.9% WER and two 8+ word gaps — too short.
export const SERMON_VAD_SILENCE_MS = 700;
export const SERMON_MIN_CHUNK_MS = 4_000;
export const SERMON_MAX_CHUNK_MS = 15_000;
