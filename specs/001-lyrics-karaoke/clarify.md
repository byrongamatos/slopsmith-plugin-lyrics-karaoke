# Clarifications — Lyrics Karaoke

## Q1. Why two stages instead of one combined endpoint?

**A.** Alignment and pitch can fail independently and have very
different cost profiles (alignment ≤ a minute via Whisper; pitch can
be several minutes on CPU pYIN for a long song). Splitting them lets
the UI show stage-level progress, lets users skip alignment when it
already exists, and lets re-extracting pitch happen without
re-uploading the lyrics text.

## Q2. Does `/save-lyrics` invalidate existing pitch?

**A.** Today, no. Re-saving lyrics keeps `vocal_pitch.json` intact,
and the merge in `/data` keys pitch by `repr(float(t))`. If the new
alignment shifts timings, pitch entries silently fail to match. This
is a plausible bug — if the user re-aligns with corrected lyrics,
they almost certainly want the old pitch invalidated. Treating as
[NEEDS CLARIFICATION]. Possible fix: delete `vocal_pitch.json` (and
unset `manifest.vocal_pitch`) at the end of `_persist_lyrics`.

## Q3. Why does `/data` key pitch by `repr(float(t))`?

**A.** Because `lyrics.json` and `vocal_pitch.json` are written
independently and merging them by float-equality risks rounding-edge
mismatches. `repr(float(t))` round-trips both sides through the same
representation. Brittle if either side is regenerated with different
rounding (see Q2).

## Q4. Why does the local pYIN path do a two-pass narrow search?

**A.** Documented in `_extract_pitch_per_syllable`: pYIN's
octave-error rate drops dramatically when the search range is
narrowed to ~one octave around the singer's actual median. The first
pass uses C2-C6 (covers low male to high female / falsetto), then
the second pass narrows to ±12 semitones around the median midi.
Confidence threshold ≥0.5 with ≥32 voiced frames before narrowing —
fewer voiced frames mean we can't trust the median, so we keep the
wide-range result.

## Q5. Why local-neighbour octave correction instead of song-wide
median?

**A.** Comparing to the song-wide median caused every chorus high
note to fold down an octave. Real pYIN octave errors are localised
(a single quiet syllable jumps off its neighbours, while genuine
high notes are flanked by other high notes). The local-neighbour
correction snaps only when the candidate is meaningfully closer
(≥6-semitone improvement) and the original is more than an octave
from the local median.

## Q6. Why is the in-player canvas a fixed-position overlay rather
than drawn into the highway via `addDrawHook`?

**A.** The karaoke ribbon is a self-contained surface with its own
RAF loop and font/text rendering. Putting it on its own canvas above
the highway lets us style it independently (z-index, padding,
backdrop) without polluting the highway draw call.

## Q7. What is the 7-semitone (`MIN_PITCH_SPAN_SEMITONES`) floor for?

**A.** Songs with a narrow vocal range (e.g. spoken-word, monotone
melodies) would otherwise produce a strip where every bar sits at
roughly the same y. Clamping the visible span to a fifth keeps the
ribbon visibly varied and gives bars room to breathe.

## Q8. Why `requirements.txt` instead of `pyproject.toml`?

**A.** The plugin's Python dependencies (`librosa`, `pyyaml`,
`requests`, `numpy`) are install-time requirements for the plugin
inside the Slopsmith image. The plugin loader does not run a build
step; `requirements.txt` is consumed by the host Slopsmith install
process or by ad-hoc `pip install -r`. Not a wheel, not a package.
