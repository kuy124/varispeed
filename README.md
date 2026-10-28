# Varispeed

A Chrome extension that sets any HTML5 video from **1/16x to 100x**, and puts seek controls on the video itself.

Varispeed is the broadcast term for variable playback rate. That is the whole job: change how fast a video plays, and let you jump around inside it without leaving the page.

![The Varispeed panel](docs/panel.png)

## Why another speed extension

Most speed extensions stop at 4x, because Chrome clamps `video.playbackRate` to a 1/16 to 16 range. Two things follow from that clamp, and Varispeed handles both:

- **Below 1/16 there is no floor to fight.** Chrome's real minimum is `0.0625`, not the `0.25` most extensions expose. Varispeed opens the full range, so `0.0625x` is available for frame-by-frame study.
- **Above 16x the rate cannot go higher**, so Varispeed switches to fast seeking: it skips forward by `(speed - 16)` seconds of media per second of wall time. `100x` means a 2 hour video finishes in about 72 seconds.

The slider is log-scaled. On a linear `0.0625` to `100` track, everything from slow motion to 4x would be crushed into the first few percent, which is exactly the range people use most.

![Seek controls on the video](docs/overlay.png)

## Install

Chrome does not distribute this in the Web Store, so load it unpacked:

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked** and pick the repo folder.
5. Pin Varispeed to the toolbar if you want the panel one click away.

Built and checked on Chrome 149. The manifest uses `world: "MAIN"` content scripts, so it needs a Chrome new enough to support them.

## Use

**The panel** (toolbar icon) is where you set the rate:

- Drag the slider, or press `-` / `+` to step through the presets.
- Click a preset: `0.25 0.5 0.75 1 1.5 2 3 4 5 8`.
- The rate is saved and reapplied to every video you open after that, including videos in iframes.

**Seeking** works in two places, both of which act on the video that is actually on screen:

- **On the video:** hover it for a bar with a draggable playhead, `-10 -5 +5 +10`, and a live `mm:ss / mm:ss` readout. Works in fullscreen and inside iframes.
- **In the panel:** click the timeline to jump, drag to scrub, or type a time as `hh:mm:ss` and press Enter.

The panel talks to the page over messages rather than acting directly, because a popup runs in its own document and cannot reach a `<video>` in the tab. It picks the largest visible video on the page, so a small muted preview does not get the seek instead of the video you are watching.

## What it does not do

- No per-site memory. The rate is global. Add it if you want 2x on one site and 1x elsewhere.
- No keyboard shortcuts. The obvious candidates (arrow keys, `J`/`K`/`L`) are already bound by YouTube and most players, and overriding them breaks habits.
- No Web Store listing. Loading unpacked means Chrome will not auto-update it.
- No Safari or Firefox build. `world: "MAIN"` content scripts are a Chrome MV3 feature.

## How it works

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, two content scripts, icons |
| `main.js` | Runs in the page's own JS world. Calls `#movie_player.setPlaybackRate()` so YouTube's player keeps the rate instead of resetting it. |
| `content.js` | Isolated world. Finds videos, applies the rate, renders the on-video bar, handles seek messages from the panel. |
| `popup.html` / `popup.js` | The panel: rate slider, presets, transport, timecode jump. |
| `gen_icons.py` | Generates `icon16/32/48/128.png` with Pillow. Run `python gen_icons.py` after changing the artwork. |

Two worlds are needed because a content script in the isolated world can set `video.playbackRate`, but YouTube's player owns that property and resets it on the next load. Only a script running in the page's world can call the player's own setter, so `main.js` relays the rate over `postMessage`.

## Tests

```sh
node test.mjs
```

The suite loads `content.js` and `popup.js` against DOM stubs and asserts the behaviour that is easy to get wrong:

- the log slider round-trips to exact preset values rather than drifting to `1.97x`
- `-` and `+` step through the preset list, and stop at the ends
- the seek target picks the largest visible video, not the first one in the DOM
- the panel converts `hh:mm:ss` to seconds correctly, including values over 60 in a field
- the rate survives a `ratechange` event that a site fires to reset it

No browser is needed. It does not test rendering or real site behaviour, so the screenshots in `docs/` were captured separately in headless Chrome from the real files.

## Icon

Ink ground, one amber signal, and a double fast-forward chevron. The 16px and 32px sizes use a bolder, line-free variant because the speed lines blur into a smudge below roughly 24px.

## License

No license file yet. That means default copyright applies, and nobody can legally reuse it. If you want it to be usable by others, pick one (MIT is the usual choice for an extension like this) and add it as `LICENSE`.
