# Listening back to a recorded service

When you record with `npm run dev:record`, every recording is saved in its own folder under
`data/asr-debug/` as many short `.wav` pieces, one per audio chunk sent to Whisper. These steps
join the pieces into one recording you can listen to, and convert it to a smaller `.m4a`.

## What you need

- A session recorded with **`npm run dev:record`**. Plain `npm run dev` saves no audio.
- **ffmpeg**, only for the `.m4a` step: `brew install ffmpeg`. Check with `which ffmpeg`.

## 1. Find your session folder

Each recording gets a folder named after the time it started (UTC), followed by a short id:

```bash
ls data/asr-debug
# 2026-11-03T09-34-05-859Z-mw0hqql8   <- recorded 3 Nov 2026, 09:34 UTC (10:34 Dutch time)
```

The newest recording is listed last. Folders starting with `replay-` were made by
`scripts/asr-replay.ts` and are not real services.

## 2. Join the pieces and convert

Run these commands from the project folder (`LiveTranslation/`). Put your folder name in the
first line, and the other two lines use it:

```bash
S="data/asr-debug/2026-11-03T09-34-05-859Z-mw0hqql8"

# Join all pieces into full.wav (also writes timeline.txt and prints it)
npx tsx scripts/asr-session-audio.ts "$S"

# Convert full.wav to a much smaller full.m4a
ffmpeg -i "$S/full.wav" -c:a aac -b:a 64k "$S/full.m4a"
```

These are **separate commands**: run them one after the other, not pasted together on one line.
Keep the quotes around the paths.

## What you get

All three files are written into the session folder itself:

| File | What it is |
|------|------------|
| `full.wav` | The whole recording as one file, 16 kHz mono. Large: about 110 MB per hour. |
| `full.m4a` | The same audio compressed, about a quarter of the size. Opens in QuickTime or Music, and is easy to share. |
| `timeline.txt` | What happened to every stretch of audio (see below). |

Once you have the `.m4a` you can delete `full.wav`: the first command recreates it whenever you
need it.

## Reading `timeline.txt`

Every line is a time range in `full.wav`/`full.m4a` (minutes:seconds from the start of the
recording) and what happened to it:

```
[00:20.0-00:29.2] CHUNK #3     9.2s  cut=vad 2.0w/s uncovered=6.98-9.22s  "Ik heb hem ingeplukt. ..."
[01:20.6-01:24.7] DISCARDED   4.1s  gate longest voiced run 180ms ...  (browser gate: "no sustained speech")
```

- **CHUNK**: sent to Whisper. `w/s` is the number of words per second it returned. A low value
  on a stretch where someone was clearly speaking means words were lost. `uncovered=` lists
  seconds within the chunk that no transcribed text covers.
- **DISCARDED**: the browser decided there was no speech and never sent this stretch to Whisper.
- **GAP**: no audio was recorded at all for that stretch.

At the bottom there is a per-minute table of the machine's load (CPU, memory, battery,
throttling), which helps explain a slow or missed stretch.

## Listening to one fragment

To check a single moment, for example a timestamp from `edits.md` or `timeline.txt`, cut it out:

```bash
ffmpeg -ss 01:20 -to 01:35 -i "$S/full.wav" -c:a aac -b:a 64k "$S/fragment.m4a"
```

## Troubleshooting

- **`usage: npx tsx scripts/asr-session-audio.ts <session folder>`**: the folder name is missing
  or misspelled. Check it with `ls data/asr-debug`.
- **`no audio found in …`**: the folder has no `.wav` files, for example because the recording
  was started with `npm run dev` instead of `npm run dev:record`, or was stopped immediately.
- **`command not found: ffmpeg`**: install it with `brew install ffmpeg`.
- **ffmpeg asks `File … already exists. Overwrite? [y/N]`**: answer `y`, or add `-y` after
  `ffmpeg` to always overwrite.
