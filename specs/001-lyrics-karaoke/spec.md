# Feature Specification: Lyrics Karaoke

**Feature Branch**: `001-lyrics-karaoke`
**Created**: 2026-05-09 (retrospective)
**Status**: Implemented (v1.4.1)
**Input**: `routes.py`, `screen.html`, `screen.js`.

## User Scenarios & Testing

### User Story 1 — Set up a karaoke-ready sloppak in one workflow (P1)

As a user with a sloppak song that has split stems, I want a single
"Build Karaoke" action that aligns my pasted lyrics text and extracts
per-syllable pitch, so I can sing along with a SingStar-style ribbon.

**Why this priority**: This is the headline feature.

**Independent Test**: Pick a sloppak with a vocals stem, paste lyrics
text, hit Build. Wait for the two-stage pipeline. Open the song in
the player, toggle "Karaoke", confirm a pitch ribbon overlay shows
above the highway with one bar per syllable.

**Acceptance Scenarios**:

1. **Given** a sloppak with `stems[id=vocals]` and a configured demucs
   server, **When** the user submits lyrics, **Then** the plugin runs
   `/align` followed by `/generate-pitch`, persists `lyrics.json` and
   `vocal_pitch.json`, patches `manifest.yaml`, and re-zips the
   sloppak (with a `.bak` of the original).
2. **Given** a song that already has synced lyrics but no pitch,
   **When** the user opens the screen, **Then** only the pitch stage
   needs running; the lyrics-input section is hidden.
3. **Given** a song that already has both, **When** the user opens
   the screen, **Then** "Karaoke ready ✓" is shown with options to
   open in player, re-extract pitch, or download `.lrc`.

---

### User Story 2 — Render the karaoke ribbon over the highway (P1)

As a user playing a karaoke-ready song, I want a horizontal ribbon
above the highway with one bar per upcoming syllable, vertically
positioned by MIDI pitch, with the syllable text below and a sweeping
playhead, so I can sing the right note at the right time.

**Why this priority**: Without the renderer the data is invisible.

**Independent Test**: Toggle "Karaoke" on a karaoke-ready sloppak.
Confirm a fixed-position canvas appears above the highway, with a
~6-second window of upcoming syllables, vertical position by MIDI,
text below each bar, playhead at ~18 % of canvas width.

**Acceptance Scenarios**:

1. **Given** karaoke is enabled, **When** the song plays, **Then**
   bars scroll right-to-left at song speed; the bar under the
   playhead is highlighted (`#ffe080`).
2. **Given** the user toggles karaoke off, **When** the toggle fires,
   **Then** the overlay canvas is removed and the saved
   `showLyrics` state is restored.
3. **Given** the song's pitch range is small (<7 semitones), **When**
   bars are positioned, **Then** the vertical span is clamped to a
   minimum of 7 semitones (a fifth) so bars don't collapse into a
   flat strip.

---

### User Story 3 — Run the two stages independently (P2)

As a user, I want to run alignment and pitch extraction independently
so I can re-run pitch without re-aligning, or align without
generating pitch.

**Why this priority**: Recovery / iteration.

**Independent Test**: From the "Karaoke ready" state, click
"Re-extract pitch". The plugin POSTs `/generate-pitch` only and the
existing `lyrics.json` is untouched.

**Acceptance Scenarios**:

1. **Given** synced lyrics already exist, **When** the user requests
   pitch only, **Then** alignment is skipped and `vocal_pitch.json`
   is regenerated.
2. **Given** the user re-aligns with new text, **When**
   `/save-lyrics` runs, **Then** existing `vocal_pitch.json` is
   invalidated. [NEEDS CLARIFICATION: current code does NOT delete
   `vocal_pitch.json` on re-save — pitch entries keyed by `t` will
   silently mismatch. Confirm whether this is intentional or a bug.]

---

### User Story 4 — Server-first, local-fallback pitch (P2)

As a user with a demucs server that has a CREPE-backed `/pitch`
endpoint, I want pitch extraction to use the server (faster + more
accurate). As a user without that endpoint, I want the plugin to fall
back to local pYIN so I'm not blocked.

**Why this priority**: Quality + degradation.

**Independent Test**: Run pitch with a server that has `/pitch` —
response reports `extractor: "server-crepe"`. Run pitch with a server
that returns 404 on `/pitch` — response reports `extractor:
"local-pyin"` and the result is still valid.

**Acceptance Scenarios**:

1. **Given** the server returns 200 for `/pitch`, **When**
   `/generate-pitch` runs, **Then** server output is used and
   `extractor` is `server-crepe`.
2. **Given** the server returns 404 / 501 / a connection error,
   **When** `/generate-pitch` runs, **Then** local pYIN is used and
   `extractor` is `local-pyin`. The user-facing endpoint MUST NOT
   surface the server failure as an error.

---

### User Story 5 — Export `.lrc` independent of save (P3)

As a user who wants to share synced lyrics outside the sloppak, I
want a download button.

**Acceptance Scenarios**:

1. **Given** alignment segments are present, **When** the user
   clicks Download `.lrc`, **Then** the response is a `.lrc` text
   file with optional `[ti:]` / `[ar:]` headers and a
   `[by:Slopsmith Lyrics Karaoke]` line.

## Functional Requirements

- **FR-001**: `GET /status?filename=` MUST return
  `{is_sloppak, has_vocals, has_lyrics, has_pitch, pitch_count}`.
- **FR-002**: `GET /server-status` MUST probe `<demucs>/health` (5 s).
- **FR-003**: `GET /data?filename=` MUST return a merged
  `{tokens: [{t, d, w, midi?}]}` for the in-player overlay.
- **FR-004**: `POST /align` MUST forward to `<demucs>/align` (300 s).
- **FR-005**: `POST /save-lyrics` MUST persist `lyrics.json`, patch
  manifest, and re-zip zip-form sloppaks (with `.bak`).
- **FR-006**: `POST /generate-pitch` MUST attempt server `/pitch`
  first when configured, fall back to local pYIN, persist
  `vocal_pitch.json`, patch manifest, and re-zip if zip-form. The
  response MUST include `notes_count`, `syllables_total`, and
  `extractor`.
- **FR-007**: `POST /export` MUST return a downloadable LRC.
- **FR-008**: All file writes MUST be atomic (`.tmp` + replace).
- **FR-009**: Per-filename `threading.Lock` MUST serialize concurrent
  `/generate-pitch` calls for the same song.
- **FR-010**: Local pYIN MUST apply two-pass range narrowing,
  per-syllable mode of semitone-rounded pitches, and local-neighbour
  octave-error correction (≥2 neighbours, base distance >12, snap
  improvement ≥6).
- **FR-011**: The frontend MUST inject a "Karaoke" toggle into
  `#player-controls` only when `/data` returns content; toggling
  MUST save / restore the previous `showLyrics` state.

## Out of Scope

- Live mic pitch matching (handled by the karaoke pitch-feedback
  prompt referenced in user memory).
- Translating lyrics.
- Editing per-syllable pitch by hand in-browser.
