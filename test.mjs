// Run: node test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

// ---------- fake page ----------
const mk = (w, h, extra = {}) => ({
  nodeType: 1, tagName: 'VIDEO', isConnected: true, playbackRate: 1,
  currentTime: 0, duration: 1000, paused: false, ended: false, seeking: false,
  readyState: 4, muted: false, volume: 1,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, bottom: h }),
  _l: {},
  addEventListener(t, fn) { (this._l[t] ||= []).push(fn); },
  fire(t) { (this._l[t] || []).forEach((fn) => fn()); },
  closest: () => null,
  ...extra,
});

const video = mk(800, 450);
const preview = mk(320, 180, { muted: true }); // YouTube-style hover preview
const tiny = mk(1, 1, { paused: true });

const posted = [];
let onChanged, onMessage;
globalThis.window = { postMessage: (m) => posted.push(m), addEventListener() {} };
globalThis.chrome = {
  storage: {
    local: { get: async () => ({ videoSpeed: 100 }), set() {} },
    onChanged: { addListener(fn) { onChanged = fn; } },
  },
  runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
};
globalThis.MutationObserver = class { observe() {} };
globalThis.document = {
  documentElement: {},
  addEventListener() {},
  querySelectorAll: (s) => (s === 'video' ? [video, preview, tiny] : []),
};

// ---------- content script ----------
new Function(read('content.js'))();
await sleep(20);

assert.equal(video.playbackRate, 16, 'playbackRate clamps at 16');
assert.equal(posted.at(-1).rate, 16, 'rate is relayed to the MAIN-world bridge');

video.playbackRate = 1;
video.fire('ratechange');
assert.equal(video.playbackRate, 16, 'speed restored after site resets it');

await sleep(300);
assert.ok(video.currentTime > 10, `boost fast-forwards (got ${video.currentTime.toFixed(1)})`);

video.paused = true;
preview.paused = true;
const t0 = video.currentTime;
const p0 = preview.currentTime;
let state;
onMessage({ type: 'seekRel', seconds: 10 }, {}, (s) => { state = s; });
assert.ok(Math.abs(video.currentTime - (t0 + 10)) < 0.01, 'seek hits the playing video only');
assert.equal(preview.currentTime, p0, 'muted hover previews are not seeked');
assert.equal(tiny.currentTime, 0, 'tiny videos are ignored');
assert.equal(state.duration, 1000, 'the reply carries real state for the popup');

onMessage({ type: 'seek', time: 42 }, {}, () => {});
assert.equal(video.currentTime, 42, 'absolute seek from the popup timeline');

onChanged({ videoSpeed: { newValue: 2 } }, 'local');
assert.equal(video.playbackRate, 2, 'speed change applies live');
assert.equal(posted.at(-1).rate, 2, 'live change is relayed too');

// ---------- popup ----------
// Enough of a DOM for popup.js: elements record text, style and attributes.
const el = (id) => ({
  id, value: '', textContent: '', style: {}, dataset: {}, _l: {}, _a: {},
  classList: {
    _s: new Set(),
    toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
  },
  addEventListener(t, fn) { (this._l[t] ||= []).push(fn); },
  setAttribute(k, v) { this._a[k] = v; },
  getAttribute(k) { return this._a[k]; },
  appendChild() {}, focus() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 22 }),
  setPointerCapture() {}, releasePointerCapture() {},
});

const nodes = {};
const getById = (id) => (nodes[id] ||= el(id));
const presets = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 8]
  .map((r) => Object.assign(el('p' + r), { dataset: { rate: String(r) } }));
const rateOut = el('rate');

globalThis.document = {
  body: el('body'),
  getElementById: getById,
  querySelector: (s) => (s === '.rate' ? rateOut : null),
  querySelectorAll: (s) => (s === '[data-rate]' ? presets : s === '[data-d]' ? [] : []),
  createElement: () => el('span'),
};

let saved, msgs = [];
globalThis.chrome.storage.local.set = (o) => { saved = o; };
globalThis.chrome.storage.local.get = (k, cb) => cb && cb({ videoSpeed: 1 });
globalThis.chrome.tabs = {
  query: async () => [{ id: 1 }],
  sendMessage: async (id, m) => { msgs.push(m); return null; },
};

new Function(read('popup.js'))();
await sleep(10);

// Log slider: value 470 must land back on exactly 2x, not 1.97x.
nodes.speed.value = '470';
nodes.speed._l.input[0]();
assert.equal(saved.videoSpeed, 2, 'log slider snaps to 2x');

// Stepper walks the ladder rather than adding a blind delta.
getById('up')._l.click[0]();
assert.equal(saved.videoSpeed, 2.5, 'plus steps to the next rung, not a blind +0.25');

// Slow end: 1/16 is Chrome's real floor, so it must be reachable and clamped.
const press = (r) => presets.find((p) => p.dataset.rate === String(r))._l.click[0]();
press(0.25);
assert.equal(saved.videoSpeed, 0.25, '0.25x preset is wired up');
press(0.75);
assert.equal(saved.videoSpeed, 0.75, '0.75x preset is wired up');
nodes.speed.value = '0'; // slider pinned left = the slowest allowed
nodes.speed._l.input[0]();
assert.equal(saved.videoSpeed, 0.0625, 'slider floor is 1/16, not 0.25');

// From the floor, minus stays put instead of going out of range.
getById('down')._l.click[0]();
assert.equal(saved.videoSpeed, 0.0625, 'cannot step below the floor');

// Timecode: hh:mm:ss reaches the page as seconds.
const jump = () => { getById('go')._l.click[0](); return sleep(10); };
nodes.m.value = '3';
nodes.s.value = '27';
await jump();
assert.equal(msgs.at(-1).type, 'seek');
assert.equal(msgs.at(-1).time, 207, '3m27s -> 207s');

nodes.h.value = '1';
nodes.m.value = '2';
nodes.s.value = '3';
await jump();
assert.equal(msgs.at(-1).time, 3723, '1h2m3s -> 3723s');

nodes.h.value = '';
nodes.m.value = '90'; // over 59 is allowed: 90 minutes means 1h30m
nodes.s.value = '';
await jump();
assert.equal(msgs.at(-1).time, 5400, '90m -> 5400s');

console.log('ok');
process.exit(0);
