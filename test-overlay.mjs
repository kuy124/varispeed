// Run: node test-overlay.mjs [--screenshots]. Chrome must be installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), 'varispeed-overlay-'));
const profile = join(dir, 'profile');
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let launchError, socket, closeBrowser;
browser.on('error', (error) => { launchError = error; });

try {
  const portFile = join(profile, 'DevToolsActivePort');
  let port;
  // Chrome creates the file before finishing its exclusive Windows write.
  for (let i = 0; i < 200 && !port && !launchError; i++) {
    try {
      const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      if (/^\d+$/.test(lines[0]) && lines[1]?.startsWith('/devtools/browser/')) port = lines[0];
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
    if (!port) await sleep(50);
  }
  assert.ok(port, `Chrome did not start: ${launchError || 'set CHROME_PATH to its executable'}`);
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown' ||
        (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')) {
      errors.push(message.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  closeBrowser = () => send('Browser.close');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    assert.fail(`Timed out: ${expression}`);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 900, deviceScaleFactor: 1, mobile: false });

  const source = readFileSync(new URL('content.js', import.meta.url), 'utf8');
  await evaluate(`(async () => {
    document.body.innerHTML = '<style>body{margin:24px;background:#414b54}.player{position:relative;width:960px;height:540px}video{width:100%;height:100%}.chrome{position:absolute;inset:0;color:white;padding:12px;font:14px system-ui}iframe{display:block;width:320px;height:180px;margin-top:24px;border:0}</style><div class="player html5-video-player"><video></video><div class="chrome">Test player chrome</div></div><iframe></iframe>';
    const changed = [], test = window.test = { rate: 1, failSaving: false, siteKeys: 0 };
    document.addEventListener('keydown', () => test.siteKeys++);
    window.chrome = {
      storage: {
        local: {
          get: async () => ({ videoSpeed: test.rate }),
          set: async ({ videoSpeed }) => {
            if (test.failSaving) throw new Error('Storage unavailable');
            test.rate = videoSpeed;
            changed.forEach((listener) => listener({ videoSpeed: { newValue: videoSpeed } }, 'local'));
          },
        },
        onChanged: { addListener: (listener) => changed.push(listener) },
      },
      runtime: { onMessage: { addListener() {} } },
    };
    const prepare = (video, scope) => {
      Object.defineProperties(video, {
        currentTime: { writable: true, value: 1254 },
        duration: { writable: true, value: 3723 },
        buffered: { value: { length: 2, start: (i) => i ? 2400 : 0, end: (i) => i ? 3000 : 2000 } },
      });
      scope.chrome = window.chrome;
      scope.eval(${JSON.stringify(source)});
    };
    test.video = document.querySelector('video');
    prepare(test.video, window);
    test.frame = document.querySelector('iframe');
    const loaded = new Promise((resolve) => test.frame.onload = resolve);
    test.frame.srcdoc = '<style>body{margin:0}video{width:100%;height:180px;background:#414b54}</style><video></video>';
    await loaded;
    test.frameVideo = test.frame.contentDocument.querySelector('video');
    prepare(test.frameVideo, test.frame.contentWindow);
  })()`);

  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const key = async (key, code = key) => {
    const keyCode = { Home: 36, ArrowDown: 40, ArrowRight: 39, Enter: 13, Escape: 27 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  await move(100, 180);
  await wait("[...document.querySelectorAll('div')].some((node) => node.shadowRoot)");
  await evaluate("test.host = [...document.querySelectorAll('div')].find((node) => node.shadowRoot); test.root = test.host.shadowRoot");
  await wait("test.host.offsetWidth === 620");
  const bounds = (selector) => evaluate(`(() => {
    const r = test.root.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const click = async (selector) => {
    const r = await bounds(selector);
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    await move(x, y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const fits = (host, video) => evaluate(`(() => {
    const h = ${host}, box = h.getBoundingClientRect(), v = ${video}.getBoundingClientRect();
    return box.width >= 200 && box.height > 0 && box.left >= v.left && box.right <= v.right && [...h.shadowRoot.querySelectorAll('button, select, .t, input')].every((node) => {
      const r = node.getBoundingClientRect();
      return !r.width || (r.left >= box.left && r.right <= box.right && r.bottom <= box.bottom);
    });
  })()`);
  assert.ok(await fits('test.host', 'test.video'), 'desktop controls must stay inside the video');
  assert.equal(await evaluate("getComputedStyle(test.root.querySelector('.head')).height"), '13px');
  assert.equal(await evaluate("getComputedStyle(test.root.querySelector('.ghost')).height"), '9px');
  const openingRail = await bounds('.rail');
  await evaluate("test.root.querySelector('input').focus()");
  await key('Escape');
  await move(openingRail.x + openingRail.width / 2, openingRail.y + openingRail.height / 2);
  await sleep(600);
  assert.equal(await evaluate('test.host.style.display'), 'block', 'opening under the pointer must not trigger the short leave timer');
  console.log('PASS: player-chrome hover opens the overlay; playhead and preview marker have their full height');

  for (const seconds of [-10, -5, 5, 10]) {
    const before = await evaluate('test.video.currentTime');
    await click(`[data-d="${seconds}"]`);
    assert.equal(await evaluate('test.video.currentTime'), before + seconds);
    assert.equal(await evaluate('test.frameVideo.currentTime'), 1254, 'skip must affect only its own video');
    console.log(`PASS: ${seconds > 0 ? '+' : ''}${seconds}s seeks only this video`);
  }
  await click('.r');
  await key('Home');
  await key('ArrowDown');
  await key('Enter');
  await wait('test.rate === 0.125');
  assert.equal(await evaluate('test.frameVideo.playbackRate'), 0.125);
  console.log('PASS: native speed selector chooses 0.125x and synchronizes the iframe');

  await evaluate('chrome.storage.local.set({ videoSpeed: 1.03 })');
  await wait("test.root.querySelector('.r').value === 'custom'");
  await evaluate("test.failSaving = true; test.root.querySelector('.r').value = '2'; test.root.querySelector('.r').dispatchEvent(new Event('change'))");
  await wait("!test.root.querySelector('.notice').hidden");
  assert.equal(await evaluate('test.rate'), 1.03, 'failed save must not pretend the new rate was saved');
  await evaluate('test.failSaving = false; chrome.storage.local.set({ videoSpeed: 1 })');
  await wait("test.root.querySelector('.notice').hidden");
  console.log('PASS: custom rates remain visible; failed saves show an error without replacing the saved rate');

  const rail = await bounds('.rail');
  const y = rail.y + rail.height / 2, x = rail.x + rail.width * 0.72;
  const before = await evaluate('test.video.currentTime');
  await move(x, y);
  await wait("!test.root.querySelector('.preview-label').hidden");
  assert.equal(await evaluate('test.video.currentTime'), before, 'hover preview must not seek');
  assert.equal(await evaluate("test.root.querySelector('.rail').dataset.preview"), 'true');
  console.log('PASS: rail hover previews a time without seeking');

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  assert.ok(Math.abs(await evaluate('test.video.currentTime') - 3723 * 0.72) < 3723 / rail.width);
  const thumb = await bounds('.head');
  const tx = thumb.x + thumb.width / 2, ty = thumb.y + thumb.height / 2;
  await move(tx, ty);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x + rail.width * 0.6, y, button: 'left', buttons: 1 });
  await sleep(2300);
  assert.equal(await evaluate('test.host.style.display'), 'block', 'a held drag must not auto-hide');
  const scrubbed = await evaluate("({ time: test.video.currentTime, value: test.root.querySelector('input').value, max: test.root.querySelector('input').max, step: test.root.querySelector('input').step })");
  assert.ok(Math.abs(scrubbed.time - 3723 * 0.6) < 3723 / rail.width, `Native scrub: ${JSON.stringify(scrubbed)}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x + rail.width * 0.6, y, button: 'left', clickCount: 1 });
  await sleep(2300);
  assert.equal(await evaluate('test.host.style.display'), 'none', 'pointer-idle hide must resume after dragging');
  await move(101, 180);
  await wait("test.host.style.display === 'block'");
  console.log('PASS: native scrubbing stays visible during a drag, hides after release, and wakes on movement');

  await evaluate("test.root.querySelector('input').focus(); test.siteKeys = 0");
  const position = await evaluate('test.video.currentTime');
  await key('ArrowRight');
  assert.ok(Math.abs(await evaluate('test.video.currentTime') - position - 0.1) < 0.15);
  assert.match(await evaluate("test.root.querySelector('input').getAttribute('aria-valuetext')"), /\.9 of /);
  assert.equal(await evaluate('test.siteKeys'), 0, 'focused controls must not trigger player shortcuts');
  await sleep(2300);
  assert.equal(await evaluate('test.host.style.display'), 'block', 'keyboard focus must stay visible');
  await key('Escape');
  assert.equal(await evaluate('test.host.style.display'), 'none');
  await evaluate('test.surface = test.video.closest(".html5-video-player"); test.surface.tabIndex = 0; test.surface.focus()');
  await wait("test.host.style.display === 'block'");
  await evaluate('test.surface.blur()');
  console.log('PASS: rail supports arrow-key seeking, keeps keyboard focus visible, and closes with Escape');

  const frame = await evaluate('(() => { const r = test.frame.getBoundingClientRect(); return { x: r.x, y: r.y }; })()');
  await move(frame.x + 100, frame.y + 100);
  await wait("[...test.frame.contentDocument.querySelectorAll('div')].some((node) => node.shadowRoot)");
  await evaluate("test.frameHost = [...test.frame.contentDocument.querySelectorAll('div')].find((node) => node.shadowRoot)");
  for (const width of [320, 240]) {
    await evaluate(`test.frame.style.width = '${width}px'; test.frameVideo.dispatchEvent(new PointerEvent('pointermove'))`);
    await sleep(100);
    assert.ok(await fits('test.frameHost', 'test.frameVideo'), `${width}px iframe must not clip controls`);
    console.log(`PASS: ${width}px iframe controls fit without clipping`);
  }
  await move(107, 180);
  await evaluate('test.video.duration = Infinity');
  await wait("test.root.querySelector('.duration').textContent === 'LIVE'");
  assert.ok(await evaluate("test.root.querySelector('input').disabled && [...test.root.querySelectorAll('button')].every((b) => b.disabled)"));
  await evaluate('test.video.duration = 3723; document.querySelector(".player").requestFullscreen()');
  await wait('document.fullscreenElement === test.host.parentNode');
  await move(100, 180);
  await sleep(100);
  assert.ok(await fits('test.host', 'test.video'), 'fullscreen overlay must fit inside the player');
  await evaluate('document.exitFullscreen()');
  console.log('PASS: LIVE disables unavailable seeks; fullscreen keeps the overlay attached');

  if (process.argv.includes('--screenshots')) {
    await move(113, 180);
    await evaluate('test.video.currentTime = 1254; chrome.storage.local.set({ videoSpeed: 1.5 })');
    await sleep(100);
    const box = await evaluate('(() => { const r = test.host.getBoundingClientRect(); return { x:r.x-4, y:r.y-4, width:r.width+8, height:r.height+8, scale:2 }; })()');
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: box });
    writeFileSync(join(dir, 'overlay.png'), Buffer.from(shot.data, 'base64'));
    console.log(`Screenshot: ${join(dir, 'overlay.png')}`);
    await evaluate('test.frame.scrollIntoView({ block: "center" })');
    const framePosition = await evaluate(`(() => {
      const frame = test.frame.getBoundingClientRect(), video = test.frame.contentDocument.querySelector('video').getBoundingClientRect();
      return { x: frame.x + test.frame.clientLeft + video.x + video.width / 2,
        y: frame.y + test.frame.clientTop + Math.min(video.bottom, test.frame.contentWindow.innerHeight) - 4 };
    })()`);
    await move(framePosition.x, framePosition.y);
    await evaluate('chrome.storage.local.set({ videoSpeed: 0.0625 })');
    await wait("[...test.frame.contentDocument.querySelectorAll('div')].some(d => d.shadowRoot?.querySelector('.wrap') && d.style.display === 'block')");
    await sleep(50);
    const narrowClip = await evaluate(`(() => {
      const frame = test.frame.getBoundingClientRect();
      const host = [...test.frame.contentDocument.querySelectorAll('div')].find(d => d.shadowRoot?.querySelector('.wrap'));
      const r = host.getBoundingClientRect();
      return { x: frame.x + test.frame.clientLeft + r.x - 8, y: frame.y + test.frame.clientTop + r.y - 8,
        width: r.width + 16, height: r.height + 16, scale: 2 };
    })()`);
    const narrowImage = await send('Page.captureScreenshot', { format: 'png', clip: narrowClip });
    writeFileSync(join(dir, 'overlay-narrow.png'), Buffer.from(narrowImage.data, 'base64'));
    console.log(`Screenshot: ${join(dir, 'overlay-narrow.png')}`);
  }
  await wait("test.host.style.display === 'none'");
  await evaluate('test.video.remove()');
  await wait('!test.host.isConnected');
  await evaluate('test.surface.dispatchEvent(new PointerEvent("pointermove", { clientX: 119, clientY: 180 }))');
  assert.equal(await evaluate('[...document.querySelectorAll("div")].filter(d => d.shadowRoot?.querySelector(".wrap")).length'), 0);
  console.log('PASS: removing a video cleans up its overlay without rebuilding it on player hover');
  await evaluate('test.surface.append(test.video)');
  await sleep(100);
  await move(127, 180);
  await wait('[...document.querySelectorAll("div")].some(d => d.shadowRoot?.querySelector(".wrap") && d.style.display === "block")');
  assert.equal(await evaluate('[...document.querySelectorAll("div")].filter(d => d.shadowRoot?.querySelector(".wrap")).length'), 1);
  console.log('PASS: remounting a video creates one working overlay');
  await evaluate(`test.shadow = document.createElement('div');
    test.shadow.style.cssText = 'display:block;width:320px;height:180px';
    test.shadow.attachShadow({ mode: 'open' }); document.body.append(test.shadow);`);
  await sleep(100);
  await evaluate(`test.shadowVideo = document.createElement('video');
    test.shadowVideo.style.cssText = 'width:320px;height:180px';
    Object.defineProperties(test.shadowVideo, { duration: { value: 60 }, currentTime: { value: 12, writable: true } });
    test.shadow.shadowRoot.append(test.shadowVideo); test.shadow.scrollIntoView({ block: 'center' });`);
  await wait('test.shadowVideo.playbackRate === Math.min(16, test.rate)');
  const shadowPosition = await evaluate('(() => { const r = test.shadowVideo.getBoundingClientRect(); return { x: r.x, y: r.y }; })()');
  await move(shadowPosition.x + 40, shadowPosition.y + 120);
  await wait('[...document.querySelectorAll("div")].filter(d => d.shadowRoot?.querySelector(".wrap")).length === 2');
  await evaluate('test.shadowVideo.remove()');
  await wait('[...document.querySelectorAll("div")].filter(d => d.shadowRoot?.querySelector(".wrap")).length === 1');
  await evaluate('test.shadow.remove()');
  console.log('PASS: late-added shadow videos are discovered and cleaned up');
  assert.deepEqual(errors, [], 'browser console must contain no errors');
  console.log('PASS: no browser console errors');
} finally {
  try { await closeBrowser?.(); } catch {}
  socket?.close();
  for (let i = 0; browser.exitCode === null && i < 100; i++) await sleep(20);
  if (browser.exitCode === null) browser.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  if (!process.argv.includes('--screenshots')) rmSync(dir, { recursive: true, force: true });
}
