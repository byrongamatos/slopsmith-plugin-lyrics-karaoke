"""Lyrics Karaoke plugin — end-to-end karaoke setup for sloppak songs.

Two stages, one workflow:

1. **Sync lyrics** — send a sloppak's vocals stem + plain lyric text to a
   Whisper alignment service (the demucs server's ``/align`` endpoint) and
   write the syllable-level result to ``lyrics.json`` inside the sloppak.
2. **Extract pitch** — run ``librosa.pyin`` over the same vocals stem,
   median per syllable, and write ``vocal_pitch.json`` next to it.

Both artifacts are persisted inside the sloppak (manifest is patched, zip
form is re-zipped with a one-time ``.bak``). The frontend can run them
in sequence as a single "Build Karaoke" action, or independently when
one of the two artifacts already exists.

Endpoints
---------

* ``GET  /status?filename=…``     — per-song readiness flags
* ``GET  /server-status``         — alignment server reachable?
* ``GET  /data?filename=…``       — merged ``[{t, d, w, midi?}]`` for the player overlay
* ``POST /align``                 — run Whisper alignment, return segments
* ``POST /save-lyrics``           — persist alignment segments as ``lyrics.json``
* ``POST /generate-pitch``        — extract per-syllable pitch and persist ``vocal_pitch.json``
* ``POST /export``                — download alignment as a standard ``.lrc`` file
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import threading
import zipfile
from pathlib import Path

import yaml
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response


_config_dir: Path | None = None
_get_dlc_dir = None
SLOPPAK_CACHE_DIR: Path | None = None

# Coarse per-filename lock so two simultaneous "Generate" presses on the
# same song serialize instead of racing on the same files.
_job_locks: dict[str, threading.Lock] = {}
_job_locks_guard = threading.Lock()


# ── Demucs / alignment server config ──────────────────────────────────────────

def _get_demucs_server_url() -> str | None:
    """Read the configured alignment server URL from the shared config.json.

    The Stems / Lyrics Sync settings page persists this; the merged plugin
    keeps the same key so existing setups keep working without migration.
    """
    if _config_dir is None:
        return None
    config_file = _config_dir / "config.json"
    if not config_file.exists():
        return None
    try:
        cfg = json.loads(config_file.read_text())
    except Exception:
        return None
    url = cfg.get("demucs_server_url", "")
    if not isinstance(url, str) or not url.strip():
        return None
    return url.rstrip("/")


# ── Manifest helpers ──────────────────────────────────────────────────────────

def _manifest_path(source_dir: Path) -> Path:
    p = source_dir / "manifest.yaml"
    if not p.exists():
        alt = source_dir / "manifest.yml"
        if alt.exists():
            return alt
    return p


def _read_manifest(source_dir: Path) -> dict:
    mp = _manifest_path(source_dir)
    return yaml.safe_load(mp.read_text(encoding="utf-8")) or {}


def _write_manifest(source_dir: Path, manifest: dict) -> None:
    mp = _manifest_path(source_dir)
    mp.write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def _vocals_rel_path(manifest: dict) -> str | None:
    for s in manifest.get("stems", []) or []:
        if not isinstance(s, dict):
            continue
        if str(s.get("id", "")).lower() == "vocals":
            sfile = str(s.get("file", "")).strip()
            if sfile:
                return sfile
    return None


def _lyrics_tokens(source_dir: Path, manifest: dict) -> list[dict]:
    """Return the sloppak's syllable list as ``[{t, d, w}, ...]``.

    Lyrics live in ``lyrics.json`` (path comes from manifest.lyrics). Returns
    an empty list if absent or unparseable — callers gate on ``len(...) > 0``
    so karaoke generation requires synced lyrics.
    """
    rel = manifest.get("lyrics")
    if not rel:
        return []
    p = source_dir / str(rel)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            t = float(item.get("t", 0.0))
            d = float(item.get("d", 0.0))
        except (TypeError, ValueError):
            continue
        w = str(item.get("w", ""))
        if d <= 0:
            continue
        out.append({"t": t, "d": d, "w": w})
    return out


# ── Format / location helpers ─────────────────────────────────────────────────

def _job_lock_for(filename: str) -> threading.Lock:
    with _job_locks_guard:
        lock = _job_locks.get(filename)
        if lock is None:
            lock = threading.Lock()
            _job_locks[filename] = lock
        return lock


def _resolve_sloppak(filename: str):
    """Resolve a sloppak filename to its source dir, manifest, and zip flag.

    Returns ``(source_dir, manifest, dlc_path, is_zip)`` or ``None`` when the
    target is missing or isn't a sloppak.
    """
    import sloppak as sloppak_mod

    if not filename:
        return None
    dlc = _get_dlc_dir() if _get_dlc_dir else None
    if not dlc:
        return None
    dlc_path = (dlc / filename).resolve()
    if not dlc_path.exists():
        return None
    if not sloppak_mod.is_sloppak(dlc_path):
        return None
    source_dir = sloppak_mod.resolve_source_dir(filename, dlc, SLOPPAK_CACHE_DIR)
    manifest = _read_manifest(source_dir)
    return source_dir, manifest, dlc_path, dlc_path.is_file()


def _read_pitch_file(source_dir: Path, manifest: dict) -> dict | None:
    rel = manifest.get("vocal_pitch")
    if not rel:
        return None
    p = source_dir / str(rel)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


# ── Pitch extraction ──────────────────────────────────────────────────────────

def _extract_pitch_per_syllable(vocals_path: Path, lyrics: list[dict]) -> list[dict]:
    """Run pYIN on the vocals stem and return one ``{t, d, midi}`` per
    confidently-voiced syllable. Unvoiced / too-short tokens are dropped."""
    import numpy as np  # noqa: WPS433 — local import keeps cold start cheap
    import librosa

    sr = 22050
    y, sr = librosa.load(str(vocals_path), sr=sr, mono=True)
    if y.size == 0:
        return []

    fmin = librosa.note_to_hz("C2")  # ~65.4 Hz — covers low male vocals
    fmax = librosa.note_to_hz("C6")  # ~1046 Hz — covers high female / falsetto
    hop_length = 256
    frame_length = 2048

    # pyin returns (f0, voiced_flag, voiced_prob). f0 is NaN where unvoiced.
    f0, voiced_flag, _voiced_prob = librosa.pyin(
        y,
        fmin=fmin,
        fmax=fmax,
        sr=sr,
        frame_length=frame_length,
        hop_length=hop_length,
    )

    if f0 is None or len(f0) == 0:
        return []

    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)
    f0 = np.asarray(f0)
    voiced_flag = np.asarray(voiced_flag, dtype=bool)

    out: list[dict] = []
    n_frames = len(times)
    for tok in lyrics:
        t0 = tok["t"]
        t1 = t0 + tok["d"]
        # np.searchsorted is O(log N) — cheap even for thousands of tokens.
        i0 = int(np.searchsorted(times, t0, side="left"))
        i1 = int(np.searchsorted(times, t1, side="right"))
        if i0 >= n_frames or i1 <= i0:
            continue
        seg = f0[i0:i1]
        seg_voiced = voiced_flag[i0:i1]
        seg = seg[seg_voiced]
        # Drop NaNs that may sneak past voiced_flag on edge frames.
        seg = seg[~np.isnan(seg)]
        # Need a minimum of voiced frames to be confident — short hits or
        # purely consonantal syllables shouldn't produce a bar.
        if seg.size < 3:
            continue
        median_hz = float(np.median(seg))
        if median_hz <= 0:
            continue
        midi = int(round(69 + 12 * np.log2(median_hz / 440.0)))
        # Keep `t` and `d` byte-identical to the lyric token so the
        # frontend can match by exact value without a rounding dance.
        out.append({
            "t": t0,
            "d": tok["d"],
            "midi": midi,
        })
    return out


# ── Persistence: write JSON + patch manifest + re-zip ─────────────────────────

def _rezip_sloppak(source_dir: Path, output_path: Path) -> None:
    """Replace the zip-form sloppak with the contents of source_dir.

    Keeps a one-time ``.bak`` of the original next to it so a botched run
    is recoverable. Writes via ``.tmp`` + atomic replace so a crash mid-zip
    doesn't leave a half-written archive.
    """
    if output_path.exists() and output_path.is_file():
        backup = output_path.with_suffix(output_path.suffix + ".bak")
        if not backup.exists():
            shutil.copy2(output_path, backup)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_zip = output_path.with_suffix(output_path.suffix + ".tmp")
    if tmp_zip.exists():
        tmp_zip.unlink()
    with zipfile.ZipFile(str(tmp_zip), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in source_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(source_dir).as_posix())
    tmp_zip.replace(output_path)


def _atomic_write_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _persist_lyrics(
    source_dir: Path,
    manifest: dict,
    segments: list[dict],
    dlc_path: Path,
    is_zip: bool,
) -> int:
    """Convert alignment segments to the sloppak lyrics format and persist.

    Returns the number of lyric entries written.
    """
    lyrics_data = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        try:
            start = float(seg["start"])
            end = float(seg["end"])
        except (KeyError, TypeError, ValueError):
            continue
        d = end - start
        if d <= 0:
            continue
        lyrics_data.append({
            "t": round(start, 3),
            "d": round(d, 3),
            "w": str(seg.get("text", "")),
        })

    _atomic_write_json(source_dir / "lyrics.json", lyrics_data)

    if manifest.get("lyrics") != "lyrics.json":
        manifest["lyrics"] = "lyrics.json"
        _write_manifest(source_dir, manifest)

    if is_zip:
        _rezip_sloppak(source_dir, dlc_path)
    return len(lyrics_data)


def _persist_pitch(
    source_dir: Path,
    manifest: dict,
    notes: list[dict],
    dlc_path: Path,
    is_zip: bool,
) -> None:
    pitch_payload = {"version": 1, "notes": notes}
    _atomic_write_json(source_dir / "vocal_pitch.json", pitch_payload)

    if manifest.get("vocal_pitch") != "vocal_pitch.json":
        manifest["vocal_pitch"] = "vocal_pitch.json"
        _write_manifest(source_dir, manifest)

    if is_zip:
        _rezip_sloppak(source_dir, dlc_path)


# ── LRC formatter (export only) ───────────────────────────────────────────────

def _format_lrc(segments: list[dict]) -> str:
    """Convert alignment segments to the standard LRC line format."""
    lines = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        try:
            t = float(seg["start"])
        except (KeyError, TypeError, ValueError):
            continue
        minutes = int(t // 60)
        seconds = t % 60
        lines.append(f"[{minutes:02d}:{seconds:05.2f}]{seg.get('text', '')}")
    return "\n".join(lines) + "\n"


# ── HTTP routes ───────────────────────────────────────────────────────────────

def setup(app: FastAPI, context: dict):
    global _config_dir, _get_dlc_dir, SLOPPAK_CACHE_DIR

    _config_dir = context["config_dir"]
    _get_dlc_dir = context["get_dlc_dir"]
    get_cache = context.get("get_sloppak_cache_dir", lambda: None)
    SLOPPAK_CACHE_DIR = get_cache()
    if SLOPPAK_CACHE_DIR is None:
        static_dir = Path(os.environ.get("STATIC_DIR", "/app/static"))
        SLOPPAK_CACHE_DIR = static_dir / "sloppak_cache"

    # ── Per-song readiness ────────────────────────────────────────────────

    @app.get("/api/plugins/lyrics_karaoke/status")
    def lk_status(filename: str = ""):
        """Per-song readiness check.

        Returns the flag set the setup screen and the in-player toggle
        both consume. PSARC songs have ``is_sloppak=False`` and the rest
        of the flags are meaningless.
        """
        result = {
            "filename": filename,
            "is_sloppak": False,
            "has_vocals": False,
            "has_lyrics": False,
            "has_pitch": False,
            "pitch_count": 0,
        }
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return result
        source_dir, manifest, _dlc_path, _is_zip = resolved
        result["is_sloppak"] = True
        vocals_rel = _vocals_rel_path(manifest)
        if vocals_rel and (source_dir / vocals_rel).exists():
            result["has_vocals"] = True
        if _lyrics_tokens(source_dir, manifest):
            result["has_lyrics"] = True
        pitch = _read_pitch_file(source_dir, manifest)
        if pitch and isinstance(pitch.get("notes"), list):
            result["has_pitch"] = True
            result["pitch_count"] = len(pitch["notes"])
        return result

    @app.get("/api/plugins/lyrics_karaoke/server-status")
    def lk_server_status():
        """Health-check the configured alignment / demucs server.

        The setup screen polls this once per visit so the user gets a
        clear "alignment server unavailable" banner if their config is
        stale, instead of a cryptic timeout when they hit Build.
        """
        url = _get_demucs_server_url()
        if not url:
            return {"available": False, "reason": "No demucs server configured"}
        try:
            import requests
            resp = requests.get(f"{url}/health", timeout=5)
            if resp.status_code == 200:
                return {"available": True, "server_url": url}
            return {"available": False, "reason": f"Server returned {resp.status_code}"}
        except Exception as e:  # noqa: BLE001 — surface to UI
            return {"available": False, "reason": str(e)}

    # ── Player overlay data ──────────────────────────────────────────────

    @app.get("/api/plugins/lyrics_karaoke/data")
    def lk_data(filename: str = ""):
        """Bundle lyrics + pitch into a single per-syllable list.

        Pre-merged so the renderer doesn't need to match floats across
        a Python/JS rounding boundary. ``midi`` is present only on
        syllables that produced a confidently-voiced pitch.
        """
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 404)
        source_dir, manifest, _dlc_path, _is_zip = resolved
        pitch = _read_pitch_file(source_dir, manifest)
        if not pitch:
            return JSONResponse({"error": "No vocal_pitch.json"}, 404)
        notes = pitch.get("notes") if isinstance(pitch, dict) else None
        if not isinstance(notes, list):
            return JSONResponse({"error": "Malformed vocal_pitch.json"}, 500)

        pitch_by_t: dict[str, int] = {}
        for n in notes:
            if isinstance(n, dict) and "t" in n and "midi" in n:
                pitch_by_t[repr(float(n["t"]))] = int(n["midi"])

        merged = []
        for tok in _lyrics_tokens(source_dir, manifest):
            entry = {"t": tok["t"], "d": tok["d"], "w": tok["w"]}
            mid = pitch_by_t.get(repr(float(tok["t"])))
            if mid is not None:
                entry["midi"] = mid
            merged.append(entry)
        return {"filename": filename, "tokens": merged}

    # ── Stage 1: align lyrics text with Whisper ───────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/align")
    def lk_align(data: dict):
        """Send vocals + plain lyric text to the alignment server.

        Returns ``{segments: [{start, end, text, ...}]}`` on success.
        The caller previews this and then POSTs to ``/save-lyrics`` to
        commit the result to the sloppak.
        """
        filename = (data or {}).get("filename", "")
        lyrics_text = ((data or {}).get("lyrics_text") or "").strip()
        language = (data or {}).get("language", "")
        granularity = (data or {}).get("granularity", "syllable")

        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not lyrics_text:
            return JSONResponse({"error": "lyrics_text required"}, 400)

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, _dlc_path, _is_zip = resolved

        vocals_rel = _vocals_rel_path(manifest)
        if not vocals_rel:
            return JSONResponse(
                {"error": "No vocals stem — split stems with Demucs first."},
                400,
            )
        vocals_path = source_dir / vocals_rel
        if not vocals_path.exists():
            return JSONResponse(
                {"error": f"Vocals stem missing on disk: {vocals_rel}"},
                400,
            )

        server_url = _get_demucs_server_url()
        if not server_url:
            return JSONResponse({"error": "No demucs server configured"}, 400)

        import requests
        try:
            with open(vocals_path, "rb") as f:
                resp = requests.post(
                    f"{server_url}/align",
                    files={"file": (vocals_path.name, f, "audio/ogg")},
                    data={
                        "text": lyrics_text,
                        "language": language,
                        "granularity": granularity,
                    },
                    timeout=300,
                )
        except requests.Timeout:
            return JSONResponse({"error": "Alignment request timed out"}, 504)
        except requests.ConnectionError:
            return JSONResponse({"error": "Cannot connect to alignment server"}, 502)

        if resp.status_code != 200:
            return JSONResponse(
                {"error": f"Alignment server error: {resp.text[:500]}"},
                502,
            )

        result = resp.json()
        if isinstance(result, dict) and "error" in result:
            return JSONResponse(
                {"error": f"Alignment failed: {result['error']}"},
                502,
            )
        return result

    @app.post("/api/plugins/lyrics_karaoke/save-lyrics")
    def lk_save_lyrics(data: dict):
        """Persist alignment segments as the sloppak's ``lyrics.json``."""
        filename = (data or {}).get("filename", "")
        segments = (data or {}).get("segments", []) or []
        if not filename:
            return JSONResponse({"error": "filename required"}, 400)
        if not isinstance(segments, list) or not segments:
            return JSONResponse({"error": "segments required"}, 400)

        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse({"error": "Not a sloppak"}, 400)
        source_dir, manifest, dlc_path, is_zip = resolved

        try:
            count = _persist_lyrics(source_dir, manifest, segments, dlc_path, is_zip)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"Persist failed: {exc}"}, 500)
        return {"ok": True, "lyrics_count": count}

    # ── Stage 2: extract per-syllable pitch ───────────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/generate-pitch")
    async def lk_generate_pitch(data: dict):
        """Run pYIN on the vocals stem and persist ``vocal_pitch.json``.

        Heavy work runs in the default executor; per-filename locking
        serializes accidental double-clicks.
        """
        filename = (data or {}).get("filename", "")
        resolved = _resolve_sloppak(filename)
        if resolved is None:
            return JSONResponse(
                {"error": "Not a sloppak (PSARC songs are not supported)"},
                400,
            )
        source_dir, manifest, dlc_path, is_zip = resolved

        vocals_rel = _vocals_rel_path(manifest)
        if not vocals_rel:
            return JSONResponse(
                {"error": "No vocals stem — split stems with Demucs first."},
                400,
            )
        vocals_path = source_dir / vocals_rel
        if not vocals_path.exists():
            return JSONResponse(
                {"error": f"Vocals stem missing on disk: {vocals_rel}"},
                400,
            )

        lyrics = _lyrics_tokens(source_dir, manifest)
        if not lyrics:
            return JSONResponse(
                {"error": "No synced lyrics — align lyrics first."},
                400,
            )

        # Read the vocals stem from a temp copy so concurrent writes to
        # the unpack cache (re-zip etc.) don't churn the working file.
        tmp_dir = Path(tempfile.mkdtemp(prefix="lk-pitch-"))
        try:
            tmp_vocals = tmp_dir / vocals_path.name
            shutil.copy2(vocals_path, tmp_vocals)

            lock = _job_lock_for(filename)

            def _worker() -> tuple[bool, dict]:
                with lock:
                    try:
                        notes = _extract_pitch_per_syllable(tmp_vocals, lyrics)
                    except Exception as exc:  # noqa: BLE001
                        return False, {"error": f"Pitch extraction failed: {exc}"}
                    if not notes:
                        return False, {
                            "error": (
                                "Pitch extraction produced no voiced syllables — "
                                "the vocals stem may be silent or noise-only."
                            ),
                        }
                    try:
                        _persist_pitch(source_dir, manifest, notes, dlc_path, is_zip)
                    except Exception as exc:  # noqa: BLE001
                        return False, {"error": f"Persist failed: {exc}"}
                    return True, {
                        "ok": True,
                        "notes_count": len(notes),
                        "syllables_total": len(lyrics),
                    }

            ok, payload = await asyncio.get_event_loop().run_in_executor(None, _worker)
            if not ok:
                return JSONResponse(payload, 500)
            return payload
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── Optional export ───────────────────────────────────────────────────

    @app.post("/api/plugins/lyrics_karaoke/export")
    def lk_export(data: dict):
        """Produce a downloadable ``.lrc`` file from alignment segments.

        Independent of save-to-song — useful for sharing the synced
        lyrics outside the sloppak (e.g. submitting to lyric DBs).
        """
        segments = (data or {}).get("segments", []) or []
        if not isinstance(segments, list) or not segments:
            return JSONResponse({"error": "No segments provided"}, 400)

        title = str((data or {}).get("title", "") or "")
        artist = str((data or {}).get("artist", "") or "")

        header_lines = []
        if title:
            header_lines.append(f"[ti:{title}]")
        if artist:
            header_lines.append(f"[ar:{artist}]")
        header_lines.append("[by:Slopsmith Lyrics Karaoke]")
        header = "\n".join(header_lines) + "\n"

        lrc = header + _format_lrc(segments)

        safe_name = f"{artist} - {title}".strip(" -") or "lyrics"
        safe_name = safe_name.replace("/", "_").replace("\\", "_")

        return Response(
            content=lrc,
            media_type="text/plain",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_name}.lrc"',
            },
        )
