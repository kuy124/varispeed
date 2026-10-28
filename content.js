(() => {
  const KEY = 'videoSpeed';
  const MAX_RATE = 16; // Chrome clamps playbackRate here; beyond it we fast-seek instead
  let speed = 1;
  let hasShadow = false;

  const timers = new WeakMap(); // video -> fast-seek interval
  const managed = new WeakMap();
  const overlays = new WeakMap();
  const liveHosts = new Set();

  const rate = () => Math.min(speed, MAX_RATE);

  function stopBoost(video) {
    const t = timers.get(video);
    if (t) { clearInterval(t); timers.delete(video); }
  }

  // Beyond MAX_RATE we can't raise playbackRate, so we skip forward by
  // (speed - MAX_RATE) seconds of media per second of wall-clock time.
  // ponytail: 100ms timer + seeks, upgrade to requestVideoFrameCallback if drift matters
  function startBoost(video) {
    if (timers.has(video)) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000; // real elapsed time, not an assumed 100ms
      last = now;
      if (!video.isConnected) return stopBoost(video);
      if (video.paused || video.ended || video.seeking || video.readyState < 2) return;
      if (video.closest('.ad-showing')) return; // don't skip ads
      const dur = isFinite(video.duration) ? video.duration : Infinity;
      const next = Math.min(video.currentTime + (speed - MAX_RATE) * dt, dur - 0.05);
      if (next > video.currentTime) {
        try { video.currentTime = next; } catch (e) {}
      }
    }, 100);
    timers.set(video, id);
  }

  // Hand the rate to main.js, which can call the site's own player API.
  // Without this, YouTube's player resets playbackRate to 1 on every load.
  function relay(r) {
    try { window.postMessage({ __vs: 1, rate: r }, '*'); } catch (e) {}
  }

  function applySettings(video) {
    if (!video || video.nodeType !== 1 || !('playbackRate' in video)) return;
    if (video.playbackRate !== rate()) {
      try { video.playbackRate = rate(); } catch (e) {}
    }
    relay(rate());
    if (speed > MAX_RATE) startBoost(video); else stopBoost(video);
  }

  const clampTime = (video, t) => {
    const dur = isFinite(video.duration) ? video.duration : Infinity;
    return Math.max(0, Math.min(t, dur - 0.05));
  };

  function seek(video, t) {
    if (!isFinite(t)) return;
    try { video.currentTime = clampTime(video, t); } catch (e) {}
  }

  const skip = (video, d) => seek(video, video.currentTime + d);

  // ---------- on-video seek UI ----------
  // Lives in a shadow root so no site stylesheet can touch it, and is created
  // lazily on first hover so pages with many videos don't pay for it.
  // Same tokens as the popup: ink ground, one amber signal, mono timecode.
  // Dark because the bar floats on top of video, where light chrome glares.
  // Tachometer direction: ENERGY 2 / RHYTHM 2 / MOTION 1.
  const MONO = 'ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace';
  const LADDER = [
    0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2,
    2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 32, 50, 100,
  ];
  const CSS = `
    :host { all: initial; }
    .wrap {
      box-sizing: border-box; padding: 6px 9px 8px;
      border-radius: 8px;
      background: rgba(12,13,15,.93); color: #eef0f2;
      border: 1px solid rgba(255,255,255,.11);
      box-shadow: 0 6px 22px rgba(0,0,0,.45); /* Separate controls from the moving frame. */
      font: 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
      user-select: none;
    }
    /* A full-width native range keeps pointer and keyboard seeking native. */
    .rail { position: relative; height: 28px; margin: 0 1px; }
    .rail .track, .rail .buf, .rail .played {
      position: absolute; top: 50%; left: 0; height: 3px; border-radius: 2px;
      transform: translateY(-50%); pointer-events: none;
    }
    .track  { right: 0; background: #69717b; }
    .buf    { right: 0; }
    .played { background: #dfe4ea; width: 0; }
    /* White is playback state; amber is the saved speed. */
    .head {
      position: absolute; top: 50%; left: 0; width: 3px; height: 13px;
      border-radius: 1.5px; background: #fff; pointer-events: none;
      transform: translate(-50%,-50%);
      box-shadow: 0 0 0 1px rgba(0,0,0,.6);
    }
    .rail:hover .head { box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 0 4px rgba(255,255,255,.16); }
    .ghost {
      position: absolute; top: 50%; left: 0; width: 1px; height: 9px;
      background: rgba(255,255,255,.8); transform: translate(-50%,-50%);
      pointer-events: none; opacity: 0;
    }
    .rail[data-preview=true] .ghost { opacity: 1; }
    .rail input {
      position: absolute; inset: 0 -9px; width: calc(100% + 18px); height: 28px; margin: 0;
      padding: 0; border: 0;
      -webkit-appearance: none; appearance: none; background: transparent;
      opacity: 0; cursor: ew-resize; touch-action: none;
    }
    .rail input::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 28px; }
    .rail:has(input:focus-visible) { outline: 2px solid #ffb020; outline-offset: 1px; border-radius: 3px; }
    .rail:has(input:disabled) { opacity: .45; }
    /* Equal sides keep the clock centred independently of the speed label. */
    .row {
      display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); align-items: center;
      gap: 8px; margin-top: 2px;
    }
    .row .left { justify-self: start; }
    .row .right { justify-self: end; display: flex; align-items: center; gap: 6px; }
    .grp { display: flex; overflow: hidden; border: 1px solid rgba(255,255,255,.13); border-radius: 5px; }
    .grp button {
      all: unset; box-sizing: border-box; min-height: 28px; cursor: pointer; padding: 6px;
      color: #c2c8d0; font: 11px/1 ${MONO}; font-variant-numeric: tabular-nums;
    }
    .grp button + button { border-left: 1px solid rgba(255,255,255,.13); }
    .grp button:hover { background: rgba(255,255,255,.1); color: #fff; }
    .grp button:focus-visible { outline: 2px solid #ffb020; outline-offset: -2px; }
    .grp button:disabled { opacity: .45; cursor: default; }
    .t {
      min-width: 0; text-align: center; white-space: nowrap;
      font: 11px/1 ${MONO}; font-variant-numeric: tabular-nums; color: #a2a8b0;
    }
    .t b { font-weight: 400; color: #eef0f2; }
    .preview-label { margin-right: 6px; }
    [hidden] { display: none; }
    .r {
      box-sizing: border-box; min-width: 76px; min-height: 30px;
      cursor: pointer; padding: 4px; border-radius: 5px;
      font: 11px/1 ${MONO}; font-variant-numeric: tabular-nums;
      color: #a2a8b0; background: #15171b; border: 1px solid #69717b;
      color-scheme: dark;
    }
    .r:hover { color: #c2c8d0; border-color: #a2a8b0; }
    .r:focus-visible { outline: 2px solid #ffb020; outline-offset: 1px; }
    .r.hot { color: #ffb020; border-color: rgba(255,176,32,.6); background: rgba(255,176,32,.1); }
    .r option { color: #eef0f2; background: #15171b; }
    .notice { margin: 8px 0 0; color: #ffb020; font: 11px/1.4 system-ui,sans-serif; }
    /* Query the actual overlay width, including inside wide pages and iframes. */
    @container (max-width: 440px) {
      .row { grid-template-columns: minmax(0,1fr) auto; }
      .t { grid-column: 1 / -1; grid-row: 1; }
      .row .left { grid-column: 1; grid-row: 2; }
      .row .right { grid-column: 2; grid-row: 2; }
    }
    @container (max-width: 280px) {
      .grp [data-d="-5"], .grp [data-d="5"] { display: none; }
    }
  `;

  const fmt = (s) => {
    if (!isFinite(s)) return '--:--';
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s % 60);
    const mm = h ? String(m).padStart(2, '0') : m;
    return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
  };

  const seekDescription = (time, duration) =>
    `${fmt(time)}.${Math.round(time * 10) % 10} of ${fmt(duration)}`;

  function buildOverlay(video) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;container-type:inline-size;position:fixed;z-index:2147483647;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap" role="group" aria-label="Varispeed video controls">
        <div class="rail">
          <i class="track"></i><i class="buf"></i><i class="played"></i>
          <i class="head"></i><i class="ghost"></i>
          <input type="range" min="0" max="1" step="0.1" value="0" aria-label="Seek">
        </div>
        <div class="row">
          <div class="left grp">
            <button data-d="-10" aria-label="Back 10 seconds">&minus;10s</button>
            <button data-d="-5" aria-label="Back 5 seconds">&minus;5s</button>
          </div>
          <span class="t"><span class="preview-label" hidden>Seek</span><b class="elapsed">--:--</b> / <span class="duration">--:--</span></span>
          <div class="right">
            <div class="grp">
              <button data-d="5" aria-label="Forward 5 seconds">+5s</button>
              <button data-d="10" aria-label="Forward 10 seconds">+10s</button>
            </div>
            <select class="r" aria-label="Playback speed" title="Change playback speed">
              <option value="custom" hidden></option>
              ${LADDER.map((r) => `<option value="${r}">${r}×</option>`).join('')}
            </select>
          </div>
        </div>
        <p class="notice" role="status" hidden></p>
      </div>`;

    const ui = {
      host, root,
      rail: root.querySelector('.rail'),
      bar: root.querySelector('input'),
      elapsed: root.querySelector('.elapsed'),
      duration: root.querySelector('.duration'),
      previewLabel: root.querySelector('.preview-label'),
      buf: root.querySelector('.buf'),
      played: root.querySelector('.played'),
      head: root.querySelector('.head'),
      ghost: root.querySelector('.ghost'),
      rateSelect: root.querySelector('.r'),
      customRate: root.querySelector('[value="custom"]'),
      notice: root.querySelector('.notice'),
      skips: [...root.querySelectorAll('[data-d]')],
      raf: 0,
      hideTimer: 0,
      dragging: false,
      preview: null, // seconds under the cursor, or null
    };

    ui.skips.forEach((b) => {
      b.addEventListener('click', () => skip(video, Number(b.dataset.d)));
    });

    ui.rateSelect.addEventListener('change', async () => {
      const next = Number(ui.rateSelect.value);
      if (!LADDER.includes(next)) return;
      ui.notice.hidden = true;
      try {
        await chrome.storage.local.set({ [KEY]: next });
      } catch (e) {
        ui.notice.textContent = 'Could not save speed. Reload Varispeed and this page.';
        ui.notice.hidden = false;
      }
    });

    // Hovering the rail previews where a click would land: a ghost marker on
    // the rail, and the preview time in the clock. No floating tooltip.
    const ratioAt = (e) => {
      const r = ui.rail.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    ui.rail.addEventListener('pointermove', (e) => {
      const dur = video.duration;
      if (ui.dragging || !isFinite(dur) || dur <= 0) return;
      const p = ratioAt(e);
      ui.preview = p * dur;
      ui.ghost.style.left = `${p * 100}%`;
      ui.rail.dataset.preview = 'true';
    });
    ui.rail.addEventListener('pointerleave', () => {
      if (ui.dragging) return;
      ui.preview = null;
      ui.rail.dataset.preview = 'false';
    });

    // Native range owns the thumb drag; only track whether auto-hide must wait.
    ui.bar.addEventListener('pointerdown', () => {
      ui.dragging = true;
      window.addEventListener('pointerup', endDrag, { capture: true, once: true });
      window.addEventListener('pointercancel', endDrag, { capture: true, once: true });
    });
    const endDrag = () => {
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
      if (!ui.dragging) return;
      ui.dragging = false;
      ui.preview = null;
      ui.rail.dataset.preview = 'false';
      armIdle(video, ui);
    };
    ui.endDrag = endDrag;
    ui.bar.addEventListener('pointerup', endDrag);
    ui.bar.addEventListener('pointercancel', endDrag);
    ui.bar.addEventListener('lostpointercapture', endDrag);
    ui.bar.addEventListener('input', () => {
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      const t = Number(ui.bar.value);
      seek(video, t);
      ui.bar.setAttribute('aria-valuetext', seekDescription(t, dur));
      ui.preview = ui.dragging ? t : null;
      ui.rail.dataset.preview = String(ui.dragging);
      const p = (t / dur) * 100;
      ui.ghost.style.left = `${p}%`;
      ui.played.style.width = `${p}%`;
      ui.head.style.left = `${p}%`;
    });
    host.addEventListener('pointerenter', (e) => show(video, e));
    host.addEventListener('pointermove', (e) => show(video, e));
    host.addEventListener('pointerleave', () => hide(video));
    host.addEventListener('focusin', () => show(video));
    host.addEventListener('focusout', () => armIdle(video, ui));
    // Player shortcuts must not steal keys or clicks from these controls.
    for (const event of ['keyup', 'pointerdown', 'pointerup', 'click']) {
      host.addEventListener(event, (e) => e.stopPropagation());
    }
    host.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        root.activeElement?.blur();
        dismiss(ui);
      }
    });

    overlays.set(video, ui);
    liveHosts.add(host);
    (document.fullscreenElement || document.documentElement).appendChild(host);
    return ui;
  }

  function releaseVideo(video) {
    if (video.isConnected) return;
    managed.get(video)?.abort();
    managed.delete(video);
    stopBoost(video);
    const ui = overlays.get(video);
    if (!ui) return;
    dismiss(ui);
    ui.host.remove();
    liveHosts.delete(ui.host);
    overlays.delete(video);
  }

  function tick(video, ui) {
    if (!video.isConnected) return releaseVideo(video);
    const r = video.getBoundingClientRect();
    const visibleWidth = Math.min(r.right, window.innerWidth) - Math.max(0, r.left);
    if (visibleWidth < 216 || r.height < 90 || r.bottom <= 0 ||
        r.top >= window.innerHeight || video.closest('.ad-showing')) return dismiss(ui);

    // Keep the bar inside the visible video and away from native bottom controls.
    const w = Math.min(visibleWidth - 16, 620);
    ui.host.style.width = `${w}px`;
    ui.host.style.left = `${Math.max(8, Math.min(r.left + (r.width - w) / 2, window.innerWidth - w - 8))}px`;
    const top = Math.max(8, r.top + 8);
    ui.host.style.top = `${top}px`;
    if (top + ui.host.offsetHeight > Math.min(r.bottom, window.innerHeight - 8)) return dismiss(ui);

    const dur = video.duration;
    const known = isFinite(dur) && dur > 0;

    const max = String(known ? dur : 1);
    if (ui.bar.max !== max) ui.bar.max = max;
    if (!ui.dragging) {
      const p = known ? Math.max(0, Math.min(100, (video.currentTime / dur) * 100)) : 0;
      ui.bar.value = known ? video.currentTime : 0;
      ui.played.style.width = `${p}%`;
      ui.head.style.left = `${p}%`;
    }
    const shown = ui.preview ?? video.currentTime;
    ui.elapsed.textContent = fmt(shown);
    ui.duration.textContent = known ? fmt(dur) : dur === Infinity ? 'LIVE' : '--:--';
    ui.previewLabel.hidden = ui.preview === null;
    ui.bar.setAttribute('aria-valuetext', known ? seekDescription(Number(ui.bar.value), dur) : 'Seek unavailable');

    // Paint real ranges, not a solid fill across unbuffered gaps after a seek.
    const stops = ['transparent 0%'];
    try {
      for (let i = 0; known && i < video.buffered.length; i++) {
        const start = Math.max(0, Math.min(100, video.buffered.start(i) / dur * 100));
        const end = Math.max(start, Math.min(100, video.buffered.end(i) / dur * 100));
        stops.push(`transparent ${start}%`, `#a3adb8 ${start}%`, `#a3adb8 ${end}%`, `transparent ${end}%`);
      }
    } catch (e) {}
    stops.push('transparent 100%');
    ui.buf.style.backgroundImage = `linear-gradient(to right, ${stops.join(',')})`;

    ui.bar.disabled = !known;
    ui.skips.forEach((b) => { b.disabled = !known; });
    const preset = LADDER.includes(speed);
    ui.customRate.textContent = `${speed}×`;
    ui.customRate.hidden = preset;
    ui.rateSelect.value = preset ? String(speed) : 'custom';
    ui.rateSelect.classList.toggle('hot', speed !== 1);
    ui.raf = requestAnimationFrame(() => tick(video, ui));
  }

  const IDLE_MS = 2000;
  let keyboardInput = false;
  document.addEventListener('keydown', () => { keyboardInput = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardInput = false; }, true);

  // Range inputs can remain :focus-visible after a mouse click.
  const busy = (ui) => ui.dragging || ui.rateSelect.matches(':open') ||
    (keyboardInput && ui.root.activeElement);

  function dismiss(ui) {
    ui.endDrag();
    ui.root.activeElement?.blur();
    clearTimeout(ui.hideTimer);
    cancelAnimationFrame(ui.raf);
    ui.raf = 0;
    ui.dragging = false;
    ui.preview = null;
    ui.rail.dataset.preview = 'false';
    ui.host.style.display = 'none';
  }

  function show(video, event) {
    if (!video.isConnected) return releaseVideo(video);
    if (video.closest('.ad-showing')) return;
    const ui = overlays.get(video) || buildOverlay(video);
    if (event) {
      // Hiding the bar fires pointerenter underneath it without cursor movement.
      // ponytail: compare CSS pixels; use device-pixel deltas if subpixel motion matters.
      const x = Math.floor(event.clientX), y = Math.floor(event.clientY);
      if (ui.pointerX === x && ui.pointerY === y) {
        if (ui.raf && event.type === 'pointerenter') armIdle(video, ui);
        return;
      }
      ui.pointerX = x;
      ui.pointerY = y;
    }
    if (!ui.raf) {
      ui.host.style.display = 'block';
      ui.raf = requestAnimationFrame(() => tick(video, ui));
    }
    armIdle(video, ui);
  }

  function armIdle(video, ui) {
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(() => {
      if (busy(ui)) return armIdle(video, ui);
      dismiss(ui);
    }, IDLE_MS);
  }

  function hide(video) {
    const ui = overlays.get(video);
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(() => {
      if (busy(ui)) return armIdle(video, ui);
      dismiss(ui);
    }, 350);
  }

  // A fixed-position overlay is not a descendant of the fullscreen element, so
  // it would be invisible in fullscreen. Re-parent the hosts into it.
  document.addEventListener('fullscreenchange', () => {
    const parent = document.fullscreenElement || document.documentElement;
    for (const host of liveHosts) {
      if (host.isConnected && host.parentNode !== parent) parent.appendChild(host);
    }
  });

  // ---------- discovery ----------
  function setup(video) {
    if (!video.isConnected || managed.has(video)) return;
    const controller = new AbortController();
    managed.set(video, controller);
    const options = { signal: controller.signal };
    // Players (YouTube, SPA frameworks) reset playbackRate when a new source loads.
    video.addEventListener('ratechange', () => applySettings(video), options);
    video.addEventListener('loadedmetadata', () => applySettings(video), options);
    // YouTube's chrome can cover the <video> and intercept its pointer events.
    const surface = video.closest('.html5-video-player') || video;
    surface.addEventListener('pointerenter', (e) => show(video, e), options);
    surface.addEventListener('pointermove', (e) => show(video, e), options);
    surface.addEventListener('pointerleave', () => hide(video), options);
    surface.addEventListener('focusin', () => { if (keyboardInput) show(video); }, options);
    applySettings(video);
  }

  function walk(root, fn, pierce) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('video').forEach(fn);
    if (!pierce) return;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.shadowRoot) {
        hasShadow = true;
        if (el.isConnected && !liveHosts.has(el)) obs.observe(el.shadowRoot, { childList: true, subtree: true });
        walk(el.shadowRoot, fn, true);
      }
    }
  }

  const scan = (root) => walk(root, setup, true);
  // Slider drags fire often; skip the shadow-DOM walk on pages that have none.
  const reapplyAll = () => walk(document, applySettings, hasShadow);

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') setup(n);
        else scan(n);
      }
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO') releaseVideo(n);
        else walk(n, releaseVideo, true);
      }
    }
  });

  // The video the user means: visible, biggest, playing, unmuted — in that order.
  // Without the ranking, YouTube's muted hover previews win and get seeked instead.
  function pickVideo() {
    let best = null, bestScore = -Infinity;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 80 || r.height < 45) continue;
      const score = r.width * r.height +
        (v.paused || v.ended ? 0 : 1e6) +
        (v.muted || v.volume === 0 ? 0 : 5e5);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    speed = Number(changes[KEY].newValue) || 1;
    for (const host of liveHosts) host.shadowRoot.querySelector('.notice')?.setAttribute('hidden', '');
    relay(rate()); // the page may not have a <video> mounted yet
    reapplyAll();
  });

  // The popup lives in its own document and cannot touch this <video>, so it
  // asks for state and sends seeks over this channel. A frame with no visible
  // video stays silent, which lets the frame that has one answer instead.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const v = pickVideo();
    if (!v || !msg) return false;
    if (msg.type === 'seek') seek(v, Number(msg.time));
    else if (msg.type === 'seekRel') skip(v, Number(msg.seconds));
    else if (msg.type === 'toggle') { v.paused ? v.play() : v.pause(); }
    else if (msg.type !== 'state') return false;
    reply({
      time: v.currentTime || 0,
      duration: isFinite(v.duration) ? v.duration : 0,
      paused: !!v.paused,
      rate: speed,
    });
  });

  (async () => {
    try {
      const r = await chrome.storage.local.get(KEY);
      speed = Number(r[KEY]) || 1;
    } catch (e) { speed = 1; }
    relay(rate());
    scan(document);
    if (document.documentElement) {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }
  })();
})();
