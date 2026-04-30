/**
 * Lyrics Karaoke plugin — front-end.
 *
 * Two responsibilities, one IIFE:
 *
 *  1. **Setup screen** ("Lyrics Karaoke" in the nav). A wizard that
 *     picks a song, shows what's missing (vocals stem / synced lyrics /
 *     pitch contour), and runs whatever stages are needed to make the
 *     song karaoke-ready. The setup-screen entry points are exposed on
 *     `window.lk*` because screen.html uses inline `onclick=` handlers.
 *
 *  2. **In-player overlay**. When the user opens a sloppak song with
 *     pitch data and toggles "Karaoke" in the player controls, we draw
 *     a horizontal pitch ribbon (one bar per syllable, vertically
 *     positioned by MIDI pitch, with syllable text below and a sweeping
 *     playhead) on a fixed-position canvas above the highway.
 *
 * The merge consumes the previous standalone "Lyrics Sync" plugin —
 * its alignment + save endpoints now live on this plugin. The old
 * lyrics_sync directory remains as a redirect stub for users with
 * bookmarks pointing at it.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ── Per-song state ─────────────────────────────────────────────────
    let currentSong = null;          // {filename, format, ...} from window.slopsmith
    let status = null;               // last /status payload
    let pitchData = null;            // {tokens: [{t, d, w, midi?}, ...]}
    let songPitchRange = null;       // {lo, hi} fixed across the song so bars don't shift vertically as the window scrolls
    let karaokeMode = false;         // user toggle
    let savedShowLyrics = true;      // restore on toggle off
    let generating = false;          // suppress double-clicks during /generate
    let inflightFetch = 0;           // monotonic token; stale fetches drop their result

    // ── DOM refs ───────────────────────────────────────────────────────
    let toggleBtn = null;
    let overlayEl = null;            // wrapper div that hosts the canvas
    let canvas = null;
    let ctx = null;
    let rafHandle = null;
    let resizeObserver = null;

    // ── Constants ──────────────────────────────────────────────────────
    const VISIBLE_SECONDS = 6.0;     // window of upcoming syllables shown
    const PLAYHEAD_FRAC = 0.18;      // playhead x as fraction of canvas width
    const RIBBON_BG = 'rgba(8, 8, 14, 0.78)';
    const BAR_COLOR_DIM = 'rgba(120, 80, 230, 0.55)';
    const BAR_COLOR_FILL = '#e8c040';
    const BAR_COLOR_ACTIVE = '#ffe080';
    const PLAYHEAD_COLOR = 'rgba(255, 255, 255, 0.85)';
    const TEXT_COLOR = '#f4f4ff';
    const TEXT_COLOR_PAST = 'rgba(160,170,200,0.9)';
    const MIN_PITCH_SPAN_SEMITONES = 7;  // never collapse the strip flatter than a 5th
    const RIBBON_HEIGHT_PX = 140;
    const BAR_PAD_PX = 2;
    const BAR_RADIUS = 4;

    // Centralized class strings — every render path picks one of these so
    // the disabled/enabled visual state always matches the .disabled flag.
    // Spelled out as plain `opacity-*` / `cursor-not-allowed` rather than
    // Tailwind's `disabled:` modifier prefix because the modifier only
    // takes effect when the rule is in the class list AND the disabled
    // attribute is set; rebuilding the class string per render is more
    // predictable than relying on conditional Tailwind variants.
    const BTN_CLASS_DISABLED =
        'px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-500 transition ' +
        'opacity-40 cursor-not-allowed';
    const BTN_CLASS_PROMPT =
        'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    const BTN_CLASS_ACTIVE =
        'px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-900/60 rounded-lg text-xs text-yellow-200 transition';

    // ── Utilities ──────────────────────────────────────────────────────

    function safeFetch(url, opts) {
        // Wrap fetch with a uniform error shape so callers don't have to
        // remember "did fetch reject or was it a 4xx?"
        return fetch(url, opts).then(async (r) => {
            const text = await r.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error: text }; }
            return { ok: r.ok, status: r.status, body };
        });
    }

    function syllableText(s) {
        const t = (s && s.w) || '';
        return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
    }

    function isSloppakSong(song) {
        if (!song || !song.filename) return false;
        // The server emits format='sloppak' on song_info; fall back to
        // the filename suffix in case format isn't populated yet (the
        // first song:loaded fires while song_info is still arriving).
        if (song.format === 'sloppak') return true;
        return /\.sloppak(\/)?$/i.test(String(song.filename));
    }

    // ── Status / data fetch ────────────────────────────────────────────

    async function fetchStatus(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;  // a newer song took over
        if (!res.ok) return null;
        status = res.body;
        return status;
    }

    async function fetchPitchData(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/data?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;
        if (!res.ok) return null;
        pitchData = res.body;
        songPitchRange = computeSongPitchRange(pitchData);
        return pitchData;
    }

    // Compute a fixed pitch range for the whole song so a syllable's
    // vertical position stays put as the playhead scrolls. The previous
    // code recomputed lo/hi from the visible window every frame, which
    // made stable bars appear to jump (a bar at the centre of the strip
    // would suddenly snap to the top when a lower-pitched syllable
    // entered the window). We trim 5%/95% percentiles so a single
    // octave-error outlier doesn't squash the rest of the song flat.
    function computeSongPitchRange(data) {
        const tokens = (data && Array.isArray(data.tokens)) ? data.tokens : [];
        const midis = [];
        for (const t of tokens) {
            if (t && typeof t.midi === 'number') midis.push(t.midi);
        }
        if (!midis.length) return { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
        midis.sort((a, b) => a - b);
        const pct = (p) => midis[Math.min(midis.length - 1, Math.max(0, Math.floor(p * (midis.length - 1))))];
        let lo = pct(0.05);
        let hi = pct(0.95);
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    // ── Button wiring ──────────────────────────────────────────────────

    function ensureToggleButton() {
        if (toggleBtn) return;
        const lyricsBtn = document.getElementById('btn-lyrics');
        if (!lyricsBtn || !lyricsBtn.parentNode) return;
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'btn-karaoke';
        toggleBtn.type = 'button';
        // Disabled styling on creation; refreshButtonState() rewrites
        // className on every state transition so the visual stays in
        // sync with the .disabled flag.
        toggleBtn.disabled = true;
        toggleBtn.className = BTN_CLASS_DISABLED;
        toggleBtn.textContent = 'Karaoke';
        toggleBtn.title = 'Karaoke pitch view (sloppak only)';
        toggleBtn.addEventListener('click', onToggleClick);
        lyricsBtn.parentNode.insertBefore(toggleBtn, lyricsBtn.nextSibling);
        // Hidden until song:loaded tells us whether to show it.
        toggleBtn.style.display = 'none';
    }

    function refreshButtonState() {
        if (!toggleBtn) return;
        const sloppak = isSloppakSong(currentSong);
        if (!sloppak) {
            toggleBtn.style.display = 'none';
            return;
        }
        toggleBtn.style.display = '';

        if (generating) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Generating…';
            toggleBtn.title = 'Extracting vocal pitch — this can take a minute.';
            return;
        }

        if (!status) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Checking…';
            return;
        }

        if (!status.has_lyrics) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs synced lyrics. Run Lyrics Sync first.';
            return;
        }

        if (!status.has_vocals) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs an isolated vocals stem. Split stems with Demucs first.';
            return;
        }

        if (!status.has_pitch) {
            toggleBtn.disabled = false;
            toggleBtn.className = BTN_CLASS_PROMPT;
            toggleBtn.textContent = 'Generate Karaoke';
            toggleBtn.title = 'Extract per-syllable pitch from the vocals stem.';
            return;
        }

        // Karaoke ready — toggle between text and karaoke modes.
        toggleBtn.disabled = false;
        toggleBtn.className = karaokeMode ? BTN_CLASS_ACTIVE : BTN_CLASS_PROMPT;
        toggleBtn.textContent = karaokeMode ? 'Karaoke ✓' : 'Karaoke';
        toggleBtn.title = 'Switch between text lyrics and karaoke pitch ribbon.';
    }

    async function onToggleClick() {
        if (!currentSong || !status || generating) return;
        if (!status.has_lyrics || !status.has_vocals) return;

        // Pin the filename at click time. If the user changes songs
        // mid-generation, we don't want to apply the result to a
        // different song's state.
        const clickFilename = currentSong.filename;

        if (!status.has_pitch) {
            // Generate path
            generating = true;
            refreshButtonState();
            try {
                const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: clickFilename }),
                });
                if (currentSong && currentSong.filename !== clickFilename) {
                    // Song changed while we were waiting — let the
                    // caller's resetForNewSong path own state. The new
                    // song's onSongLoaded already kicked off its own
                    // status fetch; we'd just clobber it otherwise.
                    return;
                }
                if (!res.ok) {
                    const msg = (res.body && res.body.error) || `Failed (${res.status})`;
                    alert('Karaoke generation failed: ' + msg);
                } else {
                    // Refresh status, then auto-enable karaoke mode
                    await fetchStatus(clickFilename);
                    if (currentSong && currentSong.filename !== clickFilename) return;
                    if (status && status.has_pitch) {
                        await fetchPitchData(clickFilename);
                        if (currentSong && currentSong.filename !== clickFilename) return;
                        setKaraokeMode(true);
                    }
                }
            } finally {
                generating = false;
                if (currentSong && currentSong.filename === clickFilename) {
                    refreshButtonState();
                }
            }
            return;
        }

        // Toggle path
        if (karaokeMode) {
            setKaraokeMode(false);
        } else {
            if (!pitchData) {
                await fetchPitchData(clickFilename);
                if (currentSong && currentSong.filename !== clickFilename) return;
            }
            setKaraokeMode(!!pitchData);
        }
    }

    function setKaraokeMode(on) {
        if (on === karaokeMode) {
            refreshButtonState();
            return;
        }
        karaokeMode = on;
        if (on) {
            // Stash the current text-lyrics visibility so we can restore
            // it when the user toggles back. Don't blow away their pref.
            if (window.highway && typeof window.highway.getLyricsVisible === 'function') {
                savedShowLyrics = window.highway.getLyricsVisible();
                if (typeof window.highway.setLyricsVisible === 'function') {
                    window.highway.setLyricsVisible(false);
                }
            }
            showOverlay();
        } else {
            hideOverlay();
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
        }
        refreshButtonState();
    }

    // ── Overlay canvas lifecycle ───────────────────────────────────────

    function showOverlay() {
        const player = document.getElementById('player');
        const highway = document.getElementById('highway');
        if (!player || !highway) return;

        if (!overlayEl) {
            overlayEl = document.createElement('div');
            overlayEl.id = 'lyrics-karaoke-overlay';
            overlayEl.style.position = 'absolute';
            overlayEl.style.left = '0';
            overlayEl.style.right = '0';
            overlayEl.style.top = '60px';   // sit just below the HUD row
            overlayEl.style.height = `${RIBBON_HEIGHT_PX}px`;
            overlayEl.style.pointerEvents = 'none';
            overlayEl.style.zIndex = '5';   // above highway, below HUD/controls

            canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            overlayEl.appendChild(canvas);
            player.appendChild(overlayEl);

            ctx = canvas.getContext('2d');
            sizeCanvas();
        } else {
            overlayEl.style.display = '';
        }

        if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(sizeCanvas);
            resizeObserver.observe(overlayEl);
        }
        startRaf();
    }

    function hideOverlay() {
        stopRaf();
        if (overlayEl) overlayEl.style.display = 'none';
    }

    function teardownOverlay() {
        // Full teardown — used on song change so a stale canvas doesn't
        // linger across reloads.
        stopRaf();
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch (_) { /* noop */ }
            resizeObserver = null;
        }
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        canvas = null;
        ctx = null;
    }

    function sizeCanvas() {
        if (!canvas || !overlayEl) return;
        const rect = overlayEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
    }

    // ── Render loop ────────────────────────────────────────────────────

    function startRaf() {
        if (rafHandle) return;
        const tick = () => {
            rafHandle = requestAnimationFrame(tick);
            try { drawFrame(); } catch (e) {
                // Don't kill the rAF loop on a one-off render bug; log and continue.
                console.warn('lyrics_karaoke draw error', e);
            }
        };
        rafHandle = requestAnimationFrame(tick);
    }

    function stopRaf() {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
    }

    function getNow() {
        if (window.highway && typeof window.highway.getTime === 'function') {
            return window.highway.getTime();
        }
        return 0;
    }

    function visibleBars(now) {
        // Use the absolute window [now - playhead-frac * VISIBLE_SECONDS,
        // now + (1-frac) * VISIBLE_SECONDS]. A small overscan on either
        // side keeps bars from popping at the edges.
        if (!pitchData || !Array.isArray(pitchData.tokens)) return [];
        const winLeft = now - PLAYHEAD_FRAC * VISIBLE_SECONDS - 0.5;
        const winRight = now + (1 - PLAYHEAD_FRAC) * VISIBLE_SECONDS + 0.5;
        const out = [];
        for (const tok of pitchData.tokens) {
            if (!tok || typeof tok.t !== 'number') continue;
            const t1 = tok.t + (tok.d || 0);
            if (t1 < winLeft || tok.t > winRight) continue;
            // Tokens without midi still get rendered as text-only so a
            // whole phrase that pYIN couldn't voice (e.g. quiet/whispered
            // sections) doesn't vanish from the chart.
            const hasMidi = typeof tok.midi === 'number';
            out.push({ tok, midi: hasMidi ? tok.midi : null });
        }
        return out;
    }

    function pitchRange(visible) {
        // Auto-fit the strip to the local vocal range, but never collapse
        // tighter than MIN_PITCH_SPAN_SEMITONES so a held single note still
        // sits in the middle of the strip rather than filling it.
        if (!visible.length) return { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
        let lo = Infinity, hi = -Infinity;
        for (const v of visible) {
            if (v.midi < lo) lo = v.midi;
            if (v.midi > hi) hi = v.midi;
        }
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    function drawFrame() {
        if (!canvas || !ctx) return;
        if (!pitchData) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background — soft band so the ribbon reads against any highway.
        ctx.fillStyle = RIBBON_BG;
        roundFillRect(ctx, 4, 4, W - 8, H - 8, 10);

        const now = getNow();
        const pxPerSec = W / VISIBLE_SECONDS;
        const playheadX = W * PLAYHEAD_FRAC;

        // Compute screen-X from absolute time.
        const xFor = (t) => playheadX + (t - now) * pxPerSec;

        const visible = visibleBars(now);
        // Use the song-wide pitch range so a bar's vertical position
        // doesn't shift as new syllables enter/leave the visible window.
        // Fall back to a per-frame range only when the song-wide range
        // hasn't been computed yet (data still loading).
        const { lo, hi } = songPitchRange || pitchRange(visible);

        // Reserve the bottom ~36px for syllable text; the bars live above.
        const dpr = window.devicePixelRatio || 1;
        const TEXT_BAND_CSS = 36;
        const textBandPx = TEXT_BAND_CSS * dpr;
        const barTop = 12 * dpr;
        const barBand = H - textBandPx - barTop - 4 * dpr;
        const barHeight = Math.max(8 * dpr, Math.min(22 * dpr, barBand / 8));

        const yFor = (midi) => {
            const span = Math.max(1, hi - lo);
            const frac = (hi - midi) / span;       // 0 = top, 1 = bottom
            return barTop + frac * Math.max(0, barBand - barHeight);
        };

        ctx.font = `${Math.round(14 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (const { tok, midi } of visible) {
            const x0 = xFor(tok.t);
            const x1 = xFor(tok.t + (tok.d || 0));
            const w = Math.max(2 * dpr, x1 - x0 - 2 * BAR_PAD_PX * dpr);
            const x = x0 + BAR_PAD_PX * dpr;

            const isPast = (tok.t + (tok.d || 0)) <= now;
            const isActive = tok.t <= now && now < tok.t + (tok.d || 0);

            if (midi !== null) {
                const y = yFor(midi);

                // Draw the dim "future" / "past unreached" bar in full.
                ctx.fillStyle = BAR_COLOR_DIM;
                roundFillRect(ctx, x, y, w, barHeight, BAR_RADIUS * dpr);

                // Fill the portion to the left of the playhead in bright color.
                const fillRight = Math.max(x, Math.min(x + w, playheadX));
                const fillW = fillRight - x;
                if (fillW > 0 && (isPast || isActive)) {
                    ctx.fillStyle = isActive ? BAR_COLOR_ACTIVE : BAR_COLOR_FILL;
                    roundFillRect(ctx, x, y, fillW, barHeight, BAR_RADIUS * dpr);
                }
            }

            // Syllable text below the bar, centered on its midpoint.
            // Render even when midi is missing so phrases pYIN couldn't
            // voice still appear in the lyric stream.
            const text = syllableText(tok);
            if (text) {
                ctx.fillStyle = isPast ? TEXT_COLOR_PAST : TEXT_COLOR;
                const cx = (x0 + x1) / 2;
                const ty = barTop + barBand + 4 * dpr;
                ctx.fillText(text, cx, ty);
            }
        }

        // Playhead.
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = Math.max(1, 1.5 * dpr);
        ctx.beginPath();
        ctx.moveTo(playheadX, 6 * dpr);
        ctx.lineTo(playheadX, H - 6 * dpr);
        ctx.stroke();
    }

    function roundFillRect(c, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        c.beginPath();
        c.moveTo(x + rr, y);
        c.lineTo(x + w - rr, y);
        c.quadraticCurveTo(x + w, y, x + w, y + rr);
        c.lineTo(x + w, y + h - rr);
        c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        c.lineTo(x + rr, y + h);
        c.quadraticCurveTo(x, y + h, x, y + h - rr);
        c.lineTo(x, y + rr);
        c.quadraticCurveTo(x, y, x + rr, y);
        c.closePath();
        c.fill();
    }

    // ── Song lifecycle wiring ──────────────────────────────────────────

    function resetForNewSong(song) {
        // If the previous song had karaoke mode on, the highway's
        // showLyrics flag is currently forced to false. Restore the
        // user's saved preference BEFORE we lose track of it — the
        // highway carries showLyrics across songs (it lives in factory
        // closure state and is only reset by toggleLyrics()), so
        // forgetting to restore here would leave text lyrics hidden on
        // the next song that doesn't support karaoke.
        if (karaokeMode) {
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
            karaokeMode = false;
        }
        currentSong = song || null;
        status = null;
        pitchData = null;
        songPitchRange = null;
        // Tear the overlay all the way down so a previous song's bars
        // don't briefly flash for the new song before its data arrives.
        teardownOverlay();
        refreshButtonState();
    }

    async function onSongLoaded(song) {
        resetForNewSong(song);
        ensureToggleButton();
        refreshButtonState();
        if (!isSloppakSong(song)) return;
        await fetchStatus(song.filename);
        // Pre-fetch pitch data so the first toggle is instant.
        if (status && status.has_pitch) {
            await fetchPitchData(song.filename);
        }
        refreshButtonState();
    }

    // ══════════════════════════════════════════════════════════════════
    // SETUP SCREEN — wizard for "Add karaoke to this song"
    // ══════════════════════════════════════════════════════════════════
    //
    // The setup screen DOM is in screen.html. The functions below are
    // exposed on window.lk* because screen.html uses inline onclick=
    // attributes (innerHTML-injected screens can't hydrate via
    // addEventListener at parse time — that's a Slopsmith convention,
    // not a personal preference).

    const setup = {
        selectedFilename: null,
        selectedTitle: '',
        selectedArtist: '',
        // Last alignment result (returned by /align). Held in memory
        // until the build pipeline auto-saves or the user discards.
        alignmentResult: null,
        // Last status fetch for the SETUP screen — kept separate from
        // the player overlay's `status` so a song change in the player
        // doesn't blow away setup state mid-build.
        status: null,
    };

    function setupEl(id) { return document.getElementById(id); }

    async function refreshServerStatus() {
        const el = setupEl('lk-server-status');
        if (!el) return;
        try {
            const res = await safeFetch('/api/plugins/lyrics_karaoke/server-status');
            const ok = res.ok && res.body && res.body.available;
            if (ok) {
                el.innerHTML =
                    '<div class="bg-green-900/20 border border-green-800/30 rounded-xl p-3 text-sm">' +
                    '<span class="text-green-400">Alignment server ready</span>' +
                    '</div>';
            } else {
                const reason = (res.body && res.body.reason) || 'Unknown error';
                el.innerHTML =
                    '<div class="bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 text-sm">' +
                    '<p class="text-yellow-400 font-semibold mb-1">Alignment server unavailable</p>' +
                    '<p class="text-gray-400">' + escHtml(reason) + '</p>' +
                    '<p class="text-gray-500 mt-1">Set <code>demucs_server_url</code> in Stems / Sloppak Converter settings.</p>' +
                    '</div>';
            }
        } catch (_) {
            el.innerHTML =
                '<div class="bg-red-900/20 border border-red-800/30 rounded-xl p-3 text-sm">' +
                '<span class="text-red-400">Failed to check alignment server</span>' +
                '</div>';
        }
    }

    function escHtml(s) {
        // Local minimal HTML escape — keeps the plugin's setup-screen
        // markup safe even if app.js's global esc() helper is missing.
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function lkSearchSongs() {
        const input = setupEl('lk-search');
        const q = (input && input.value || '').trim();
        const container = setupEl('lk-search-results');
        if (!container) return;
        if (!q) {
            container.innerHTML = '';
            return;
        }
        const url = `/api/library?q=${encodeURIComponent(q)}&page=0&size=20&sort=artist&format=sloppak`;
        const res = await safeFetch(url);
        if (!res.ok) {
            container.innerHTML = '<p class="text-gray-500 text-xs py-2">Search failed.</p>';
            return;
        }
        const songs = (res.body && res.body.songs) || [];
        // Karaoke needs split stems (vocals.ogg). The library returns
        // stem_count; >1 means Demucs has run on this song. Songs with
        // only `full.ogg` aren't useful here — surface a hint instead
        // of silently dropping them.
        const withStems = songs.filter((s) => (s.stem_count || 0) > 1);
        const withoutStems = songs.length - withStems.length;
        if (!withStems.length) {
            container.innerHTML =
                '<p class="text-gray-500 text-xs py-2">' +
                'No sloppak songs with split stems matched. ' +
                'Run Demucs split (Stems plugin / Sloppak Converter) on a song first.' +
                (withoutStems > 0 ? ` (${withoutStems} matched without stems.)` : '') +
                '</p>';
            return;
        }
        container.innerHTML = withStems.map((s) => {
            const fn = encodeURIComponent(s.filename);
            const title = escHtml(s.title);
            const artist = escHtml(s.artist);
            // Stash the raw values on data attributes so the click
            // handler can read them without the brittle inline-string
            // escape dance the old lyrics_sync plugin used.
            return (
                '<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer" ' +
                'data-fn="' + fn + '" data-title="' + title + '" data-artist="' + artist + '" ' +
                'onclick="lkSelectFromResult(this)">' +
                '  <div class="flex-1 min-w-0">' +
                '    <span class="text-sm text-white">' + title + '</span> ' +
                '    <span class="text-xs text-gray-500 ml-2">' + artist + '</span>' +
                '  </div>' +
                '  <span class="text-xs text-gray-600">' + (s.stem_count | 0) + ' stems</span>' +
                '</div>'
            );
        }).join('');
    }

    function lkSelectFromResult(div) {
        if (!div) return;
        const fn = decodeURIComponent(div.getAttribute('data-fn') || '');
        const title = div.getAttribute('data-title') || '';
        const artist = div.getAttribute('data-artist') || '';
        lkSelectSong(fn, title, artist);
    }

    async function lkSelectSong(filename, title, artist) {
        setup.selectedFilename = filename;
        setup.selectedTitle = title;
        setup.selectedArtist = artist;
        setup.alignmentResult = null;
        const results = setupEl('lk-search-results');
        if (results) results.innerHTML = '';
        const search = setupEl('lk-search');
        if (search) search.value = '';
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.remove('hidden');
        if (lbl) lbl.textContent = `${title} — ${artist}`;
        await refreshSetupStatus();
    }

    function lkClearSong() {
        setup.selectedFilename = null;
        setup.selectedTitle = '';
        setup.selectedArtist = '';
        setup.alignmentResult = null;
        setup.status = null;
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.add('hidden');
        if (lbl) lbl.textContent = '';
        // Hide all the per-song sections.
        for (const id of ['lk-checklist-section', 'lk-lyrics-section', 'lk-build-section', 'lk-done', 'lk-progress', 'lk-error']) {
            const el = setupEl(id);
            if (el) el.classList.add('hidden');
        }
    }

    async function refreshSetupStatus() {
        if (!setup.selectedFilename) return;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(setup.selectedFilename)}`;
        const res = await safeFetch(url);
        if (!res.ok) return;
        // Pinned to selectedFilename — refreshSetupStatus is called from
        // synchronous flows (selectSong, post-build), so a song-change
        // race would manifest as a stale status. Cheap to guard.
        if (!res.body || res.body.filename !== setup.selectedFilename) return;
        setup.status = res.body;
        renderSetupStatus();
    }

    function renderSetupStatus() {
        const s = setup.status;
        if (!s) return;
        const checklist = setupEl('lk-checklist');
        const checklistSection = setupEl('lk-checklist-section');
        if (checklistSection) checklistSection.classList.remove('hidden');

        // Update the three checklist rows by data-key.
        function setRow(key, mark, klass, detail) {
            if (!checklist) return;
            const row = checklist.querySelector(`li[data-key="${key}"]`);
            if (!row) return;
            const check = row.querySelector('.lk-check');
            const det = row.querySelector('.lk-detail');
            if (check) {
                check.textContent = mark;
                check.className = 'lk-check w-5 ' + klass;
            }
            if (det) det.textContent = detail || '';
        }

        if (s.has_vocals) {
            setRow('vocals', '✓', 'text-green-400', 'stems/vocals.ogg');
        } else {
            setRow('vocals', '✗', 'text-red-400', 'Run Demucs split first');
        }

        if (s.has_lyrics) {
            setRow('lyrics', '✓', 'text-green-400', 'lyrics.json present');
        } else {
            setRow('lyrics', '✗', 'text-yellow-400', 'Paste plain text below');
        }

        if (s.has_pitch) {
            setRow('pitch', '✓', 'text-green-400', `${s.pitch_count} voiced syllables`);
        } else if (!s.has_lyrics) {
            setRow('pitch', '⏸', 'text-gray-500', 'Waiting for synced lyrics');
        } else {
            setRow('pitch', '✗', 'text-yellow-400', 'Will extract on Build');
        }

        // Lyrics input section — show only when synced lyrics are missing
        // AND vocals exist (no point pasting text without a stem to align).
        const lyricsSection = setupEl('lk-lyrics-section');
        if (lyricsSection) {
            if (!s.has_lyrics && s.has_vocals) {
                lyricsSection.classList.remove('hidden');
            } else {
                lyricsSection.classList.add('hidden');
            }
        }

        // Build section — visible if vocals exist and either lyrics need
        // aligning or pitch needs extracting. Hidden when there's
        // genuinely nothing to do (everything ready) — that surface goes
        // to the done state instead.
        const buildSection = setupEl('lk-build-section');
        const doneSection = setupEl('lk-done');
        if (s.has_vocals && (!s.has_lyrics || !s.has_pitch)) {
            if (buildSection) buildSection.classList.remove('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        } else if (s.has_vocals && s.has_lyrics && s.has_pitch) {
            if (buildSection) buildSection.classList.add('hidden');
            renderDoneState(s);
        } else {
            // No vocals — neither section is actionable.
            if (buildSection) buildSection.classList.add('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        }

        updateBuildBtn();
    }

    function renderDoneState(s) {
        const doneSection = setupEl('lk-done');
        const detail = setupEl('lk-done-detail');
        if (doneSection) doneSection.classList.remove('hidden');
        if (detail) {
            detail.textContent =
                `${setup.selectedArtist} — ${setup.selectedTitle} has lyrics + pitch persisted` +
                ` (${s.pitch_count || 0} voiced syllables). Open in the player and toggle Karaoke.`;
        }
        // Only offer the .lrc download if we have a fresh alignment
        // result in memory — re-loading from disk would lose word/line
        // boundaries that the export format expects.
        const exportBtn = setupEl('lk-export-btn');
        if (exportBtn) {
            if (setup.alignmentResult && setup.alignmentResult.length) {
                exportBtn.classList.remove('hidden');
            } else {
                exportBtn.classList.add('hidden');
            }
        }
    }

    function updateBuildBtn() {
        const btn = setupEl('lk-build-btn');
        if (!btn) return;
        const s = setup.status;
        if (!s || !setup.selectedFilename || !s.has_vocals) {
            btn.disabled = true;
            return;
        }
        // If lyrics are missing, we need pasted text to align. If lyrics
        // are present (only pitch missing), we can build with no input.
        if (!s.has_lyrics) {
            const ta = setupEl('lk-lyrics');
            const has = ta && ta.value.trim().length > 0;
            btn.disabled = !has;
            btn.textContent = 'Build Karaoke';
        } else if (!s.has_pitch) {
            btn.disabled = false;
            btn.textContent = 'Extract pitch';
        } else {
            btn.disabled = true;
            btn.textContent = 'Karaoke ready';
        }
    }

    function lkFileUpload(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const ta = setupEl('lk-lyrics');
            if (ta) ta.value = String(reader.result || '');
            lkUpdateLineCount();
            updateBuildBtn();
        };
        reader.readAsText(file);
        input.value = '';
    }

    function lkUpdateLineCount() {
        const ta = setupEl('lk-lyrics');
        const out = setupEl('lk-lyrics-count');
        const text = ta ? ta.value.trim() : '';
        const count = text ? text.split('\n').filter((l) => l.trim()).length : 0;
        if (out) out.textContent = `${count} line${count !== 1 ? 's' : ''}`;
    }

    function setupGranularity() {
        const checked = document.querySelector('input[name="lk-granularity"]:checked');
        return checked ? checked.value : 'syllable';
    }

    function showProgress(label, detail) {
        const p = setupEl('lk-progress');
        const lbl = setupEl('lk-progress-label');
        const det = setupEl('lk-progress-detail');
        if (p) p.classList.remove('hidden');
        if (lbl) lbl.textContent = label || 'Working…';
        if (det) det.textContent = detail || '';
        const err = setupEl('lk-error');
        if (err) err.classList.add('hidden');
    }

    function hideProgress() {
        const p = setupEl('lk-progress');
        if (p) p.classList.add('hidden');
    }

    function showError(msg) {
        hideProgress();
        const err = setupEl('lk-error');
        const det = setupEl('lk-error-detail');
        if (err) err.classList.remove('hidden');
        if (det) det.textContent = msg || 'Unknown error';
    }

    async function lkBuild() {
        if (!setup.selectedFilename || !setup.status) return;
        const filename = setup.selectedFilename;
        const btn = setupEl('lk-build-btn');
        if (btn) btn.disabled = true;

        try {
            // Step 1 — align lyrics if missing.
            if (!setup.status.has_lyrics) {
                const ta = setupEl('lk-lyrics');
                const text = ta ? ta.value.trim() : '';
                if (!text) { showError('Paste lyrics text first.'); return; }
                showProgress('Aligning lyrics with Whisper…', 'This can take a minute on the alignment server.');
                const lang = (setupEl('lk-language') || {}).value || '';
                const granularity = setupGranularity();
                const alignRes = await safeFetch('/api/plugins/lyrics_karaoke/align', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename,
                        lyrics_text: text,
                        language: lang || undefined,
                        granularity,
                    }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!alignRes.ok || !alignRes.body || !Array.isArray(alignRes.body.segments)) {
                    showError((alignRes.body && alignRes.body.error) || `Alignment failed (${alignRes.status})`);
                    return;
                }
                setup.alignmentResult = alignRes.body.segments;

                showProgress('Saving aligned lyrics…');
                const saveRes = await safeFetch('/api/plugins/lyrics_karaoke/save-lyrics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, segments: setup.alignmentResult }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!saveRes.ok) {
                    showError((saveRes.body && saveRes.body.error) || `Save failed (${saveRes.status})`);
                    return;
                }
            }

            // Step 2 — extract pitch (always do this; status flag may be
            // stale after step 1 wrote new lyrics).
            showProgress('Extracting per-syllable pitch with pYIN…', 'Reading the vocals stem; ~30s for a 4-min song.');
            const pitchRes = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename }),
            });
            if (filename !== setup.selectedFilename) return;
            if (!pitchRes.ok) {
                showError((pitchRes.body && pitchRes.body.error) || `Pitch extraction failed (${pitchRes.status})`);
                return;
            }

            // Refresh status and render the done state.
            hideProgress();
            await refreshSetupStatus();
            // Also refresh the player overlay's cached status for this
            // song so the in-player toggle picks up the new pitch data
            // immediately if the user navigates straight to playback.
            if (currentSong && currentSong.filename === filename) {
                await fetchStatus(filename);
                refreshButtonState();
            }
        } catch (e) {
            showError(e && e.message ? e.message : String(e));
        } finally {
            if (btn) btn.disabled = false;
            updateBuildBtn();
        }
    }

    async function lkRedoPitch() {
        if (!setup.selectedFilename) return;
        const filename = setup.selectedFilename;
        showProgress('Re-extracting per-syllable pitch…');
        const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        if (filename !== setup.selectedFilename) return;
        if (!res.ok) {
            showError((res.body && res.body.error) || `Pitch extraction failed (${res.status})`);
            return;
        }
        hideProgress();
        await refreshSetupStatus();
        if (currentSong && currentSong.filename === filename) {
            pitchData = null;  // force the player overlay to refetch on toggle
            await fetchStatus(filename);
            refreshButtonState();
        }
    }

    async function lkExport() {
        if (!setup.alignmentResult || !setup.alignmentResult.length) return;
        const res = await fetch('/api/plugins/lyrics_karaoke/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                segments: setup.alignmentResult,
                title: setup.selectedTitle,
                artist: setup.selectedArtist,
            }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="(.+)"/);
        a.download = match ? match[1] : 'lyrics.lrc';
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function lkOpenInPlayer() {
        if (!setup.selectedFilename) return;
        if (typeof window.playSong === 'function') {
            window.playSong(setup.selectedFilename);
        } else if (typeof window.showScreen === 'function') {
            window.showScreen('player');
        }
    }

    // Bind input listeners after the screen is injected. The setup
    // screen's <textarea> isn't in the DOM at script-load time (it's
    // added when loadPlugins() injects the screen HTML), so attach
    // lazily on first showScreen('plugin-lyrics_karaoke').
    let setupHydrated = false;
    function hydrateSetupScreen() {
        if (setupHydrated) return;
        const ta = setupEl('lk-lyrics');
        if (!ta) return;  // screen not in DOM yet
        ta.addEventListener('input', () => { lkUpdateLineCount(); updateBuildBtn(); });
        setupHydrated = true;
    }

    function onSetupScreenShown() {
        hydrateSetupScreen();
        refreshServerStatus();
        // Don't auto-clear selection — users who drilled into a song
        // and back-buttoned to the screen expect their selection to
        // persist.
        if (setup.selectedFilename) {
            refreshSetupStatus();
        }
    }

    // Expose setup-screen API for inline onclick= handlers.
    window.lkSearchSongs = lkSearchSongs;
    window.lkSelectFromResult = lkSelectFromResult;
    window.lkClearSong = lkClearSong;
    window.lkBuild = lkBuild;
    window.lkRedoPitch = lkRedoPitch;
    window.lkExport = lkExport;
    window.lkOpenInPlayer = lkOpenInPlayer;
    window.lkFileUpload = lkFileUpload;

    // ══════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════

    function init() {
        ensureToggleButton();
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            // window.slopsmith is an EventTarget; .on() forwards to
            // addEventListener, so the handler receives a CustomEvent
            // whose `.detail` is the actual payload (the song info).
            window.slopsmith.on('song:loaded', (e) => onSongLoaded(e && e.detail));
            // Catch-up: plugin scripts load after app.js, so the very
            // first `song:loaded` may have already fired by the time
            // this listener attaches. Read the cached currentSong as a
            // fallback. Subsequent songs go through the listener.
            if (window.slopsmith.currentSong) {
                onSongLoaded(window.slopsmith.currentSong);
            }
        }
        // showScreen wrapper — clean up overlays when leaving the player,
        // and hydrate the setup screen when entering it. Keep the
        // wrapper minimal so we play nice with other plugins that also
        // hook showScreen (load order isn't deterministic).
        const origShowScreen = window.showScreen;
        if (typeof origShowScreen === 'function') {
            window.showScreen = function (name) {
                const ret = origShowScreen.apply(this, arguments);
                if (name !== 'player') {
                    if (karaokeMode) setKaraokeMode(false);
                    teardownOverlay();
                }
                if (name === 'plugin-lyrics_karaoke') {
                    onSetupScreenShown();
                }
                return ret;
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
