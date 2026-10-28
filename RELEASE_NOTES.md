Varispeed sets any HTML5 video from **1/16x to 100x** and puts seek controls on the video itself.

![The Varispeed panel](https://raw.githubusercontent.com/kuy124/varispeed/main/docs/panel.png)

## Install

Chrome does not distribute this in the Web Store, so it loads unpacked.

1. Download `varispeed-1.3.0.zip` below and unzip it into a folder you can keep.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked** and pick that folder.
5. Pin Varispeed to the toolbar.

Built and checked on Chrome 149. The manifest uses `world: "MAIN"` content scripts, so it needs a Chrome new enough to support them.

## What this release does

**Slow speeds go lower than most extensions.** Chrome clamps `playbackRate` to a range of 1/16 to 16, so the real slow floor is `0.0625`, not the `0.25` most speed extensions expose. Varispeed opens the whole range. That quarter of the slow range was previously unreachable.

**Presets went from 6 to 10**, in two rows: `0.25 0.5 0.75 1 1.5` and `2 3 4 5 8`.

**Above 16x it fast-seeks.** The rate cannot go past Chrome's clamp, so the extension skips forward by `(speed - 16)` seconds of media per second of wall time instead. At `100x` a two hour video finishes in about 72 seconds.

**Seek lives on the video.** Hover any video for a bar with a draggable playhead, `-10 -5 +5 +10`, a live `mm:ss / mm:ss` readout, and the current rate. It renders inside iframes and survives fullscreen, because each frame gets its own bar.

![Seek controls on the video](https://raw.githubusercontent.com/kuy124/varispeed/main/docs/overlay.png)

**The panel timeline** also seeks: click to jump, drag to scrub, hover to preview the target time, or type `hh:mm:ss` and press Enter. The timecode is one field, so you type `3:27` instead of calculating 207 seconds.

## Details worth knowing

- The slider is log-scaled. On a linear `0.0625` to `100` track, everything from slow motion to 4x would sit in the first few percent, which is the range most people actually use.
- `main.js` runs in the page's own JavaScript world and calls YouTube's `setPlaybackRate()`. A content script in the isolated world can assign `video.playbackRate`, but YouTube's player owns that property and resets it, so the rate would silently fall back to 1x on the next video.
- The seek target is the largest visible video on the page, not the first one in the DOM. Otherwise a small muted preview can take the seek instead of the video you are watching.
- The selected preset is an amber tint rather than a solid block, so it does not outshout the rate numeral. Amber marks the saved setting; the timeline fill is neutral grey because media progress is page state, not a setting.

## Checks

`node test.mjs` passes. It asserts the log slider round-trips to exact preset values, `-` and `+` step the preset list and stop at both ends, the seek target picks the largest visible video, `hh:mm:ss` parses including values over 60 in a field, and the rate survives a `ratechange` event fired by a site.

The suite runs against DOM stubs, so it does not cover rendering or real site behaviour. The screenshots above were captured separately in headless Chrome from the real files.

## Known limits

- **No per-site memory.** The rate is global.
- **No keyboard shortcuts.** Arrow keys and `J`/`K`/`L` are already bound by YouTube and most players, and overriding them breaks habits.
- **No auto-update.** Loading unpacked means Chrome will not update it for you.
- **Chrome only.** `world: "MAIN"` content scripts are an MV3 Chrome feature, so there is no Firefox or Safari build.
- **No license file yet**, which means default copyright applies. Pick one if you want others to reuse it.
