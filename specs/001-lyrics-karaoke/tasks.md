# Tasks — Lyrics Karaoke

## US1 — One-button karaoke setup (P1)

- [DONE] T101 `/status` per-song readiness.
- [DONE] T102 `/align` forwarding to demucs server.
- [DONE] T103 `/save-lyrics` with manifest patch.
- [DONE] T104 `/generate-pitch` with executor + per-filename lock.
- [DONE] T105 Wizard UI (`screen.html` + `screen.js`).
- [DONE] T106 Re-zip zip-form sloppaks with `.bak`.
- [OPEN] T107 [P] Invalidate `vocal_pitch.json` when re-saving
  lyrics (clarify.md Q2). Currently silently mismatches.

## US2 — In-player ribbon (P1)

- [DONE] T201 `/data` merged lyrics+pitch endpoint.
- [DONE] T202 Toggle button injection into `#player-controls`.
- [DONE] T203 Fixed-position overlay canvas, 6 s window, 18 %
  playhead.
- [DONE] T204 RAF redraw + ResizeObserver.
- [DONE] T205 Per-song pitch range with 7-semitone floor.
- [DONE] T206 Save / restore `showLyrics` state on toggle.

## US3 — Independent stages (P2)

- [DONE] T301 Lyrics-input section hidden when synced lyrics
  already exist.
- [DONE] T302 "Re-extract pitch" button on the Done state.
- [DONE] T303 `/generate-pitch` requires synced lyrics — returns
  400 with "align lyrics first" if absent.

## US4 — Server-first pitch (P2)

- [DONE] T401 Try `/pitch` first when server URL is configured.
- [DONE] T402 Catch `NotImplementedError` (404 / 501) and any
  transport exception; fall back to local pYIN.
- [DONE] T403 Surface `extractor: "server-crepe"|"local-pyin"` in
  the response.

## US5 — `.lrc` export (P3)

- [DONE] T501 `/export` produces standard LRC.

## Cross-cutting

- [DONE] T601 Atomic file writes (`.tmp` + replace).
- [DONE] T602 `.bak` retention on first re-zip only.
- [DONE] T603 Per-filename `threading.Lock` on `/generate-pitch`.
- [OPEN] T604 [P] Tests — no test harness in repo. Pitch heuristics
  (two-pass narrowing, octave correction) are unit-test-shaped and
  would benefit.
- [OPEN] T605 [P] `lyrics_sync` deprecation: this plugin's
  `routes.py` already absorbed `/align` and `/save`-equivalents.
  The standalone `lyrics_sync` plugin should be redirected here.
- [OPEN] T606 [P] Live karaoke pitch matching — separate prompt
  exists; not yet shipped here.
