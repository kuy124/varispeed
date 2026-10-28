(() => {
  const KEY = 'videoSpeed';
  const MAX_RATE = 16; // Chrome clamps playbackRate here; beyond it we fast-seek instead
  let speed = 1;
  let hasShadow = false;

  const timers = new WeakMap(); // video -> fast-seek interval
  const managed = new WeakSet();
  const overlays = new WeakMap(); // video -> { host, bar, time, rate, raf, hideTimer, dragging }
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
  const MONO = 'ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace';
  const CSS = `
    :host { all: initial; }
    .wrap {
      display: flex; align-items: center; gap: 7px; box-sizing: border-box;
      padding: 6px 9px; border-radius: 9px;
      background: rgba(14,15,17,.94); color: #eef0f2;
      border: 1px solid rgba(255,255,255,.13);
      font: 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
      box-shadow: 0 4px 18px rgba(0,0,0,.5);
    }
    button {
      all: unset; cursor: pointer; padding: 5px 6px; border-radius: 4px;
      color: #b3bac2; font: 11px/1 ${MONO}; font-variant-numeric: tabular-nums;
    }
    button:hover { background: rgba(255,255,255,.1); color: #fff; }
    button:focus-visible { outline: 2px solid #ffb020; outline-offset: 1px; }
    input {
      -webkit-appearance: none; appearance: none;
      flex: 1; min-width: 48px; height: 18px; margin: 0;
      cursor: pointer;
      /* the visible rail is a 3px band inside an 18px hit area */
      background: rgba(255,255,255,.22);
      background-size: 100% 3px; background-position: center; background-repeat: no-repeat;
    }
    /* square head, not a round thumb: same playhead language as the popup rail */
    input::-webkit-slider-thumb {
      -webkit-appearance: none; width: 2px; height: 13px; border-radius: 1px;
      background: #ffb020; border: 0; box-shadow: 0 0 0 3px rgba(255,176,32,0);
    }
    input:hover::-webkit-slider-thumb { box-shadow: 0 0 0 3px rgba(255,176,32,.22); }
    input:focus-visible { outline: 2px solid #ffb020; outline-offset: 2px; }
    input:disabled { opacity: .3; cursor: default; }
    .t { font: 11px/1 ${MONO}; font-variant-numeric: tabular-nums; color: #a2a8b0; white-space: nowrap; }
    .t b { font-weight: 400; color: #e8ebee; }
    .r { font: 11px/1 ${MONO}; color: #ffb020; min-width: 24px; text-align: right; }
  `;

  const fmt = (s) => {
    if (!isFinite(s)) return '--:--';
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s % 60);
    const mm = h ? String(m).padStart(2, '0') : m;
    return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
  };

  function buildOverlay(video) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap">
        <button data-d="-10" title="Back 10s">−10</button>
        <button data-d="-5" title="Back 5s">−5</button>
        <input type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">
        <button data-d="5" title="Forward 5s">+5</button>
        <button data-d="10" title="Forward 10s">+10</button>
        <span class="t"></span><span class="r"></span>
      </div>`;

    const ui = {
      host,
      bar: root.querySelector('input'),
      time: root.querySelector('.t'),
      rateLabel: root.querySelector('.r'),
      raf: 0,
      hideTimer: 0,
      dragging: false,
    };

    root.querySelectorAll('[data-d]').forEach((b) => {
      b.addEventListener('click', () => skip(video, Number(b.dataset.d)));
    });
    // Pointer capture keeps the drag alive when the cursor slides off the bar.
    ui.bar.addEventListener('pointerdown', (e) => {
      ui.dragging = true;
      try { ui.bar.setPointerCapture(e.pointerId); } catch (err) {}
    });
    const endDrag = (e) => {
      ui.dragging = false;
      try { ui.bar.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    ui.bar.addEventListener('pointerup', endDrag);
    ui.bar.addEventListener('pointercancel', endDrag);
    ui.bar.addEventListener('input', () => {
      const dur = video.duration;
      if (!isFinite(dur)) return;
      const t = (Number(ui.bar.value) / 1000) * dur;
      seek(video, t);
      ui.time.innerHTML = `<b>${fmt(t)}</b> / ${fmt(dur)}`; // show the target while dragging
    });
    // Keep the bar visible while the pointer is on it, not just on the video.
    host.addEventListener('pointerenter', () => clearTimeout(ui.hideTimer));
    host.addEventListener('pointerleave', () => hide(video));

    overlays.set(video, ui);
    liveHosts.add(host);
    (document.fullscreenElement || document.documentElement).appendChild(host);
    return ui;
  }

  function tick(video, ui) {
    if (!video.isConnected) {
      ui.host.remove();
      liveHosts.delete(ui.host);
      overlays.delete(video);
      return;
    }
    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) return hide(video);

    // Top-centre, not top-left: every player puts its title top-left and its
    // buttons top-right, so the centre strip is the one that stays clear.
    // Capped at 640px so it reads as an instrument, not a site control bar.
    const h = ui.host.offsetHeight || 30;
    const w = Math.min(r.width - 16, 640);
    ui.host.style.left = `${r.left + (r.width - w) / 2}px`;
    ui.host.style.top = `${r.top + 8}px`;
    ui.host.style.width = `${w}px`;
    ui.host.style.display = r.top + 8 + h > r.bottom ? 'none' : 'block';

    if (!ui.dragging && isFinite(video.duration) && video.duration > 0) {
      const p = (video.currentTime / video.duration) * 100;
      ui.bar.value = p * 10;
      // Neutral fill, not amber: amber is the saved rate, this is page state.
      // Matches the panel timeline. backgroundImage, not background: the
      // shorthand would reset the 3px band sizing and fatten the rail.
      ui.bar.style.backgroundImage =
        `linear-gradient(to right, #c6ccd4 ${p}%, rgba(255,255,255,.22) ${p}%)`;
      ui.time.innerHTML = `<b>${fmt(video.currentTime)}</b> / ${fmt(video.duration)}`;
    }
    ui.bar.disabled = !isFinite(video.duration);
    ui.rateLabel.textContent = speed === 1 ? '' : `${speed}×`;
    ui.raf = requestAnimationFrame(() => tick(video, ui));
  }

  function show(video) {
    if (video.closest('.ad-showing')) return;
    const ui = overlays.get(video) || buildOverlay(video);
    clearTimeout(ui.hideTimer);
    ui.host.style.display = 'block';
    cancelAnimationFrame(ui.raf);
    ui.raf = requestAnimationFrame(() => tick(video, ui));
  }

  function hide(video) {
    const ui = overlays.get(video);
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(() => {
      if (ui.dragging) return;
      cancelAnimationFrame(ui.raf);
      ui.raf = 0;
      ui.host.style.display = 'none';
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
    if (managed.has(video)) return;
    managed.add(video);
    // Players (YouTube, SPA frameworks) reset playbackRate when a new source loads.
    video.addEventListener('ratechange', () => applySettings(video));
    video.addEventListener('loadedmetadata', () => applySettings(video));
    video.addEventListener('pointerenter', () => show(video));
    video.addEventListener('pointerleave', () => hide(video));
    applySettings(video);
  }

  function walk(root, fn, pierce) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('video').forEach(fn);
    if (!pierce) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { hasShadow = true; walk(el.shadowRoot, fn, true); }
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
