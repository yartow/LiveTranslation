# WER Benchmark Fixtures

## Audio files

Place audio files in `tests/fixtures/audio/`. Supported formats: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`.

Naming convention: `clip-NN-description.mp3` (e.g. `clip-01-sermon-intro.mp3`).

Each audio file should be 30–120 seconds of clear, continuous speech. Longer clips give more representative WER scores.

## Reference transcripts

For each audio file, create a matching `.txt` file in `tests/fixtures/reference/` with the same stem:

```
tests/fixtures/audio/clip-01-sermon-intro.mp3
tests/fixtures/reference/clip-01-sermon-intro.txt
```

### Reference format

- Verbatim speech — what was actually said, word-for-word
- No punctuation (Whisper often adds its own)
- Lowercase only
- One speaker per line for dialogue clips
- Do NOT include filler words (um, uh) — the model is expected to clean those up

Example:
```
in the beginning god created the heavens and the earth
and the earth was without form and void
```

## Running the benchmark

```sh
# Requires a running server + OPENAI_API_KEY
npm run dev &
npm run test:regression -- --reporter=verbose
```

The benchmark will POST each audio file to `/api/transcribe` with each config combination and compute WER against the reference.

Results are saved to `tests/fixtures/results-TIMESTAMP.json`.

## Estimated cost

- ~$0.006 per minute of audio per transcription call (Whisper pricing)
- 5 configs × audio duration = ~5 calls per fixture
- A 60-second clip: ~$0.03 per fixture
- Keep fixtures short (30–60s) to control cost

## Config matrix tested

| chunkDurationSecs | chunkOverlapMs | useTranscriptContext |
|---|---|---|
| 5  | 0   | false |
| 5  | 500 | false |
| 5  | 500 | true  |
| 10 | 0   | false |
| 10 | 500 | true  |
