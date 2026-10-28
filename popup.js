const $ = (id) => document.getElementById(id);

// Chrome clamps playbackRate to 1/16..16, so 0.0625 is the true slow floor.
const MIN = 0.0625, MAX = 100;
const clampRate = (s) => Math.min(MAX, Math.max(MIN, Math.round(s * 10000) / 10000));

// A linear 0.0625..100 slider puts 1x at 0.5% of the track, so the whole useful
// range is unreachable. Log scale gives 0.25..16 about 70% of it.
const toSlider = (r) => Math.round((Math.log(r / MIN) / Math.log(MAX / MIN)) * 1000);
const fromSlider = (v) => MIN * (MAX / MIN) ** (v / 1000);

// Speeds people actually ask for. The slider snaps to these so 1x and 2x are
// hit exactly instead of 1.03x. Slow steps double, because at 0.5x a fixed
// 0.25 step is a 50% jump.
const LADDER = [
  0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2,
  2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 32, 50, 100,
];
const snap = (r) => LADDER.find((s) => Math.abs(r - s) < r * 0.05) ?? clampRate(r);
const neighbor = (s, dir) => {
  const i = LADDER.findIndex((v) => v >= s - 1e-9);
  const j = Math.min(LADDER.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
  return LADDER[j];
};

const fmt = (s) => {
  if (!isFinite(s)) return '--:--';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  const mm = h ? String(m).padStart(2, '0') : m;
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
};

// ---------- speed ----------
const slider = $('speed');
const rateVal = $('rateval');
const rateOut = document.querySelector('.rate');
const presets = [...document.querySelectorAll('[data-rate]')];
let rate = 1;

function paintRate() {
  rateVal.textContent = rate;
  // "0.0625" at 34px would shove the trim buttons apart; drop a size for long labels
  rateOut.classList.toggle('long', String(rate).length > 4);
  slider.value = toSlider(rate);
  slider.setAttribute('aria-valuetext', `${rate} times`);
  // Amber up to the needle: reads as a gauge, stays one accent.
  const p = toSlider(rate) / 10;
  slider.style.background = `linear-gradient(to right, rgba(255,176,32,.55) ${p}%, #17191c ${p}%)`;
  presets.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate)));
}

function setSpeed(raw) {
  const s = clampRate(Number(raw));
  if (!isFinite(s)) return;
  rate = s;
  paintRate();
  chrome.storage.local.set({ videoSpeed: s });
}

slider.addEventListener('input', () => setSpeed(snap(fromSlider(Number(slider.value)))));
$('down').addEventListener('click', () => setSpeed(neighbor(rate, -1)));
$('up').addEventListener('click', () => setSpeed(neighbor(rate, 1)));
presets.forEach((b) => b.addEventListener('click', () => setSpeed(b.dataset.rate)));

// Tick marks at the speeds that matter, positioned with the same log map.
// The last one anchors right so its label cannot overflow the panel.
for (const r of [0.25, 1, 4, 16, 100]) {
  const el = document.createElement('span');
  el.textContent = r + '×';
  if (r === 100) {
    el.style.right = '0';
    el.style.transform = 'none';
  } else {
    el.style.left = toSlider(r) / 10 + '%';
  }
  $('ticks').appendChild(el);
}

chrome.storage.local.get('videoSpeed', (r) => {
  rate = clampRate(Number(r.videoSpeed) || 1);
  paintRate();
});

// ---------- page channel ----------
// The popup has its own document, so the page's <video> is only reachable by
// message. Frames without a video stay silent, so the first reply wins.
const send = async (msg) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return null;
  }
};

// ---------- seek deck ----------
let duration = 0;
let position = 0;
let scrubbing = false;

const track = $('track');
const fill = $('fill');
const knob = $('knob');
const hint = $('hint');
const nowEl = $('now');
const durEl = $('dur');
const playEl = $('play');
const statusEl = $('status');

function paintTime(t) {
  position = Math.max(0, t);
  const p = duration > 0 ? Math.min(1, position / duration) : 0;
  fill.style.width = p * 100 + '%';
  knob.style.left = p * 100 + '%';
  nowEl.textContent = fmt(position);
  track.setAttribute('aria-valuemax', String(Math.round(duration)));
  track.setAttribute('aria-valuenow', String(Math.round(position)));
  track.setAttribute('aria-valuetext', `${fmt(position)} of ${fmt(duration)}`);
}

function render(state) {
  if (!state) {
    document.body.dataset.state = 'idle';
    duration = 0;
    paintTime(0);
    durEl.textContent = '--:--';
    statusEl.hidden = false;
    statusEl.textContent = 'No video on this page.';
    return;
  }
  document.body.dataset.state = 'ready';
  duration = state.duration || 0;
  durEl.textContent = fmt(duration);
  playEl.dataset.playing = String(!state.paused);
  playEl.setAttribute('aria-label', state.paused ? 'Play' : 'Pause');
  if (!scrubbing) paintTime(state.time || 0);
  statusEl.hidden = true;
}

let alive = true;
async function poll() {
  if (!alive) return;
  render(await send({ type: 'state' }));
  setTimeout(poll, 250);
}

// ---------- timeline drag ----------
// One seek per frame while dragging. A raw pointermove burst sends 60
// messages a second at the page, and a <video> can only honour one per frame.
let queued = null, scheduled = false;
function scrubTo(e) {
  const r = track.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration;
  paintTime(t); // instant feedback; the page catches up on the next frame
  queued = t;   // latest position wins, so a fast drag never lags behind
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    send({ type: 'seek', time: queued });
  });
}

track.addEventListener('pointerdown', (e) => {
  if (!duration) return;
  scrubbing = true;
  try { track.setPointerCapture(e.pointerId); } catch (err) {}
  scrubTo(e);
});
// While scrubbing the clock already shows the target, so the floating preview
// would just sit on top of the knob.
track.addEventListener('pointermove', (e) => {
  const r = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (duration && !scrubbing) {
    hint.style.left = ratio * 100 + '%';
    hint.textContent = fmt(ratio * duration);
  }
  if (scrubbing) scrubTo(e);
});
const endScrub = (e) => {
  scrubbing = false;
  try { track.releasePointerCapture(e.pointerId); } catch (err) {}
};
track.addEventListener('pointerup', endScrub);
track.addEventListener('pointercancel', endScrub);
track.addEventListener('keydown', (e) => {
  const d = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
  if (!d) return;
  e.preventDefault();
  send({ type: 'seekRel', seconds: d });
});

document.querySelectorAll('[data-d]').forEach((b) => {
  b.addEventListener('click', () => send({ type: 'seekRel', seconds: Number(b.dataset.d) }));
});
playEl.addEventListener('click', () => send({ type: 'toggle' }));

// ---------- hh:mm:ss jump ----------
// Minutes and seconds over 59 are fine (90mm means 1h30m), so the fields carry
// no max: people type what they mean instead of converting in their head.
const fields = ['h', 'm', 's'].map($);
const MULT = [3600, 60, 1];

function goTo() {
  const parts = fields.map((el) => Math.max(0, Math.floor(Number(el.value) || 0)));
  if (parts.every((n) => n === 0)) return; // nothing entered yet
  const t = parts.reduce((acc, n, i) => acc + n * MULT[i], 0);
  paintTime(t);
  send({ type: 'seek', time: t });
}

$('go').addEventListener('click', goTo);
fields.forEach((el, i) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goTo();
    // Right arrow at the end of a field hops to the next one, like a timecode editor
    else if (e.key === 'ArrowRight' && i < fields.length - 1 && el.selectionStart === el.value.length) {
      fields[i + 1].focus();
    }
  });
});

poll();
window.addEventListener('unload', () => { alive = false; });
