# Implementation Plan — Lyrics Karaoke

Two-stage backend pipeline plus a single-page setup screen and an
in-player canvas overlay.

## Files

- `plugin.json` — id `lyrics_karaoke`, declares
  `screen.html` / `screen.js` / `routes.py`. Nav label "Lyrics
  Karaoke", screen id `plugin-lyrics_karaoke`.
- `routes.py` (859 lines) — backend.
- `screen.html` (117 lines) — wizard UI.
- `screen.js` (1731 lines) — wizard logic + in-player ribbon.
- `requirements.txt` — install-time deps (`librosa`, `pyyaml`, ...).

## Backend (`routes.py`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/plugins/lyrics_karaoke/status` | GET | Per-song readiness flags. |
| `/api/plugins/lyrics_karaoke/server-status` | GET | Demucs server health. |
| `/api/plugins/lyrics_karaoke/data` | GET | Merged lyrics+pitch for the in-player ribbon. |
| `/api/plugins/lyrics_karaoke/align` | POST | Whisper alignment via demucs server. |
| `/api/plugins/lyrics_karaoke/save-lyrics` | POST | Persist `lyrics.json`, patch manifest, re-zip if zip-form. |
| `/api/plugins/lyrics_karaoke/generate-pitch` | POST (async) | Server CREPE first, fall back to local pYIN; persist `vocal_pitch.json`, patch manifest, re-zip if zip-form. |
| `/api/plugins/lyrics_karaoke/export` | POST | LRC download. |

### Helpers

- `_resolve_sloppak(filename)` →
  `(source_dir, manifest, dlc_path, is_zip)` or None.
- `_manifest_path` / `_read_manifest` / `_write_manifest`.
- `_vocals_rel_path(manifest)` — first stem with `id == "vocals"`.
- `_lyrics_tokens(source_dir, manifest)` — load `lyrics.json` and
  return `[{t, d, w}]`.
- `_read_pitch_file(source_dir, manifest)` — load
  `vocal_pitch.json` (`{version, notes}`).
- `_extract_pitch_per_syllable(vocals_path, lyrics)` — local pYIN
  with three quality heuristics (see clarify.md Q4–Q5).
- `_extract_pitch_via_server(server_url, vocals_path, lyrics)` —
  CREPE on remote demucs server.
- `_persist_lyrics` / `_persist_pitch` — atomic writes + manifest
  patch + optional re-zip.
- `_rezip_sloppak(source_dir, output_path)` — `.bak` + `.tmp` +
  atomic replace.
- `_atomic_write_json(path, payload)`.
- `_format_lrc(segments)`.
- `_job_locks: dict[str, threading.Lock]` with `_job_locks_guard`.

### Setup contract

```python
def setup(app, context):
    _config_dir = context["config_dir"]
    _get_dlc_dir = context["get_dlc_dir"]
    SLOPPAK_CACHE_DIR = context.get("get_sloppak_cache_dir",
                                    lambda: None)()
    if SLOPPAK_CACHE_DIR is None:
        SLOPPAK_CACHE_DIR = STATIC_DIR / "sloppak_cache"
```

## Frontend (`screen.js`)

Single IIFE with two responsibilities:

1. **Setup wizard** — `window.lk*` functions (`lkSearchSongs`,
   `lkBuild`, `lkExport`, `lkClearSong`, `lkRedoPitch`, ...) wired
   to inline `onclick` handlers in `screen.html`.
2. **In-player ribbon** — listens for `song:loaded`, fetches `/data`,
   if it returns content injects a `#btn-karaoke` toggle into
   `#player-controls`, and on toggle creates a fixed-position canvas
   above the highway. Per-frame redraw via RAF; `ResizeObserver`
   tracks highway resize; on toggle off the previous `showLyrics`
   state is restored.

### In-player render constants

```
VISIBLE_SECONDS = 6.0
PLAYHEAD_FRAC   = 0.18
RIBBON_HEIGHT_PX = 140
MIN_PITCH_SPAN_SEMITONES = 7
BAR_PAD_PX = 2
BAR_RADIUS = 4
```

### Pitch range

`songPitchRange = {lo, hi}` is computed once per song so bars do not
shift vertically as the visible window scrolls — a global anchor in
MIDI space, with the 7-semitone floor.

## Integration with Slopsmith Core

- **Sloppak module**: `is_sloppak`, `resolve_source_dir`.
- **Library API**: `/api/library?q=...`.
- **Player events**: `song:loaded`, `song:ready` (for kicking off
  the merged-data fetch).
- **Renderer integration**: a fixed-position overlay div
  containing a canvas, positioned over the highway via
  `getBoundingClientRect()` and observed for resize.

## Out of Scope / Deferred

- Live karaoke pitch matching (separate prompt in user memory).
- Inline alignment editing.
- Per-line lyrics view (no pitch info).
- Tests — none in repo.
