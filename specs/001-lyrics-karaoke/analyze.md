# Analysis — Lyrics Karaoke

## Coverage

| Spec area | Implementation | Notes |
|---|---|---|
| FR-001 (`/status`) | `lk_status` | OK. |
| FR-002 (`/server-status`) | `lk_server_status` | OK. |
| FR-003 (`/data`) | `lk_data` | OK; merge-by-`repr(float(t))`. |
| FR-004 (`/align`) | `lk_align` | OK; matches `lyrics_sync` on the wire. |
| FR-005 (`/save-lyrics`) | `lk_save_lyrics` + `_persist_lyrics` | OK; re-zip + `.bak` honoured. |
| FR-006 (`/generate-pitch`, server-first) | `lk_generate_pitch` + `_extract_pitch_via_server` | OK; fallback chain documented. |
| FR-007 (`/export`) | `lk_export` | OK. |
| FR-008 (atomic writes) | `_atomic_write_json`, `_rezip_sloppak` | OK. |
| FR-009 (per-filename lock) | `_job_lock_for` | OK. |
| FR-010 (pYIN heuristics) | `_extract_pitch_per_syllable` | OK; thresholds spelled out as named constants. |
| FR-011 (toggle injection) | `screen.js` injection block | OK. |

## Drift

1. **Re-saving lyrics does not invalidate pitch** (clarify.md Q2 /
   tasks.md T107). The merge in `/data` keys pitch by
   `repr(float(t))`, so any timing shift on re-alignment silently
   loses the pitch overlay. Plausible bug.
2. **`lyrics_sync` plugin still ships independently** — README of
   this plugin claims it superseded `lyrics_sync`, but the standalone
   plugin still exposes its own `/align` / `/save` endpoints and a
   separate nav entry. Users with both installed see two navs.
3. **`screen.js` is large (1731 lines)** — wizard + ribbon renderer
   are co-located. Splitting (or at least sharper section comments)
   would help future plugin authors.

## Gaps

1. No tests at all. The pitch heuristics in
   `_extract_pitch_per_syllable` (two-pass narrowing, octave
   correction with named thresholds) are perfect candidates for
   pytest.
2. No CI in repo.
3. No backend test that asserts the re-zip path actually leaves a
   `.bak`.
4. The `/data` endpoint's float-key merge has no test guarding
   against a pitch entry whose `t` was rounded differently from the
   matching lyrics entry.
5. Live mic pitch matching for the karaoke ribbon is mentioned in
   user memory (`prompt_karaoke_pitch_feedback.md`) but not yet
   implemented in this plugin.

## Recommendations

1. **Fix T107** (invalidate pitch on lyrics re-save) — small change,
   removes a confusing failure mode.
2. **Add a small pytest suite** for the heuristics in
   `_extract_pitch_per_syllable`, using a synthetic vocals stem
   (e.g. a sine-wave that sweeps across a few semitones).
3. **Decide `lyrics_sync` future**: deprecate it in favour of this
   plugin, or fold its zip-aware save into `lyrics_sync`. The status
   quo (two plugins doing the same thing, only one of which re-zips)
   is the bug-prone path.
4. **Split `screen.js`** into wizard + ribbon files via a tiny build
   step, OR add big banner comments separating the two regions and
   move the in-player ribbon into a clearly-labelled section. (The
   plugin loader serves only one script file, so a literal split
   isn't possible without a build step.)
5. **Land karaoke pitch matching** (separate prompt) when ready —
   the data plumbing is already in `/data`.
